use std::collections::{HashMap, HashSet};
use std::env;
use std::ffi::OsString;
use std::fs::{create_dir_all, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc, Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::secure_store;

// Native publication claims may include up to 50 MiB of approved media encoded
// as base64. Keep request traffic narrow while allowing that one bounded,
// credential-free response plus JSON metadata.
const MAX_RESPONSE_BYTES: usize = 72 * 1024 * 1024;
// This must stay equal to the engine's own NDJSON line cap
// (`MAX_LINE_BYTES` in apps/engine/src/stdio-entrypoint.ts). A request the
// bridge accepts but the engine rejects would be answered with
// REQUEST_TOO_LARGE against an id the engine could not read, so the two caps
// are only ever changed together.
const MAX_REQUEST_BYTES: usize = 1_000_000;
// A ready engine may legitimately spend longer than a UI round-trip on a
// guarded source fetch (the fetcher itself allows an 8s wall-clock hop), a
// local backup verification, or a PGlite migration.  Five seconds caused the
// bridge to tear down a healthy sidecar while the operation was still
// progressing. Keep the bound finite, but leave enough headroom for those
// bounded local operations.
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
// Catalog projections are rendered while navigating. They must fail fast so a
// stalled PGlite read cannot hold the desktop on a loading screen for the full
// general sidecar timeout.
const CATALOG_RESPONSE_TIMEOUT: Duration = Duration::from_secs(8);
const STARTUP_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
const MAINTENANCE_RESPONSE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
// The desktop owns the sidecar process tree. After a transport timeout it is
// safer to terminate that owned tree promptly than to leave navigation blocked
// while an unresponsive Node process consumes the old shutdown grace period.
const SHUTDOWN_DEADLINE: Duration = Duration::from_secs(1);
const MAX_DIAGNOSTIC_LOG_BYTES: u64 = 256 * 1024;
const MAX_DIAGNOSTIC_LOG_ROTATIONS: usize = 4;
// The Codex CLI can be installed while OPE is already running. Re-probing is
// bounded to this interval so a doctor call issued on every UI poll cannot
// spawn discovery helpers per request.
const CODEX_REDISCOVERY_INTERVAL: Duration = Duration::from_secs(30);
// `CREATE_NO_WINDOW` applies to every helper process started by the desktop
// host. In particular, probing a `.cmd` launcher at app start must never flash
// a Command Prompt behind the Blogbot window.
const WINDOWS_CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn configure_hidden_command(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(WINDOWS_CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

// The engine starts with a deliberately scrubbed environment. On Windows a
// resolved `codex.cmd` still needs these OS bootstrap values to invoke the
// command interpreter safely. Keep this list explicit: user profile, auth,
// proxy, and arbitrary application variables never cross the bridge. ImageGen is the single explicit opt-in exception.
const SIDECAR_ENV_ALLOWLIST: &[&str] = &[
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
    "LOCALAPPDATA",
    // Explicit opt-in only: this enables article-specific ImageGen visuals
    // without persisting the key in the local database or settings.
    "BLOGBOT_IMAGEGEN_API_KEY",
    "BLOGBOT_IMAGEGEN_MODEL",
];

fn sidecar_environment_with<F>(mut lookup: F) -> Vec<(&'static str, OsString)>
where
    F: FnMut(&str) -> Option<OsString>,
{
    SIDECAR_ENV_ALLOWLIST
        .iter()
        .filter_map(|key| lookup(key).map(|value| (*key, value)))
        .collect()
}

fn sidecar_environment() -> Vec<(&'static str, OsString)> {
    sidecar_environment_with(|key| env::var_os(key))
}

pub fn redact_diagnostic_for_persistence(line: &str) -> String {
    let bounded = line.chars().take(4_000).collect::<String>();
    let lower = bounded.to_ascii_lowercase();
    let sensitive_markers = [
        "token",
        "password",
        "passwd",
        "secret",
        "api_key",
        "apikey",
        "authorization",
        "bearer",
        "private_key",
        "cookie",
        "credential",
        "github_pat_",
        "ghp_",
        "sk-",
        "-----begin",
        "eyj",
    ];
    let has_long_opaque_value = bounded
        .split(|character: char| {
            !character.is_ascii_alphanumeric() && character != '-' && character != '_'
        })
        .any(|part| part.len() >= 40);
    let may_contain_identity_or_path = bounded.contains('@')
        || bounded.contains("http://")
        || bounded.contains("https://")
        || bounded.contains("\\Users\\")
        || bounded.contains("/home/");
    if sensitive_markers
        .iter()
        .any(|marker| lower.contains(marker))
        || has_long_opaque_value
        || may_contain_identity_or_path
    {
        return "[redacted sensitive diagnostic line]".to_string();
    }
    bounded
}

pub(crate) fn diagnostic_log_variants(path: &Path) -> Vec<PathBuf> {
    let mut paths = vec![path.to_path_buf()];
    paths.extend(
        (1..=MAX_DIAGNOSTIC_LOG_ROTATIONS)
            .map(|index| PathBuf::from(format!("{}.{}", path.display(), index))),
    );
    paths
}

fn rotate_diagnostic_log(path: &Path) {
    for index in (1..=MAX_DIAGNOSTIC_LOG_ROTATIONS).rev() {
        let source = if index == 1 {
            path.to_path_buf()
        } else {
            PathBuf::from(format!("{}.{}", path.display(), index - 1))
        };
        let target = PathBuf::from(format!("{}.{}", path.display(), index));
        if source.is_file() {
            let _ = std::fs::remove_file(&target);
            let _ = std::fs::rename(&source, &target);
        }
    }
}

/// Append one already-redacted diagnostic line, enforcing the size cap first.
/// Every writer must go through here: the bridge records an event per request,
/// so a healthy session whose sidecar never writes stderr would otherwise grow
/// this file without bound because only the stderr reader checked the cap.
fn append_diagnostic_line(path: &Path, write_lock: &Mutex<()>, line: &str) {
    // A poisoned lock must not silently discard diagnostics; the guarded
    // section only touches the log file.
    let _serialized = write_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(parent) = path.parent() {
        let _ = create_dir_all(parent);
    }
    if std::fs::metadata(path).is_ok_and(|meta| meta.len() > MAX_DIAGNOSTIC_LOG_BYTES) {
        rotate_diagnostic_log(path);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

fn serialize_bounded_request(request: &Value) -> Result<String, String> {
    let serialized = serde_json::to_string(request)
        .map_err(|error| format!("ENGINE_REQUEST_INVALID: {error}"))?;
    if serialized.len() > MAX_REQUEST_BYTES {
        return Err("ENGINE_REQUEST_TOO_LARGE".to_string());
    }
    Ok(serialized)
}

fn should_retry_after_transport_fault(error: &str) -> bool {
    [
        "ENGINE_WRITE_FAILED:",
        "ENGINE_READ_FAILED:",
        "ENGINE_RESPONSE_TIMEOUT:",
        "ENGINE_CLOSED_PIPE",
        "ENGINE_RESPONSE_TOO_LARGE",
        "ENGINE_RESPONSE_INVALID:",
        "ENGINE_RESPONSE_NOT_UTF8",
        "ENGINE_RESPONSE_ID_MISMATCH",
    ]
    .iter()
    .any(|prefix| error.starts_with(prefix))
}

/// A lost response after a mutation is not proof that the engine did not
/// perform its side effect. Retry only protocol-level read requests; mutation
/// commands must surface UNKNOWN/diagnostics and rely on their durable ledger.
fn is_safe_read_retry(request: &Value) -> bool {
    match request.get("kind").and_then(Value::as_str) {
        // These projections only read the durable local store. If the owned
        // sidecar dies or its response channel stalls, replaying them once
        // against a fresh sidecar cannot duplicate an external or local
        // effect. In particular, `source.list` drives the content workspace
        // during navigation, so treating a transient transport loss as final
        // needlessly leaves the editor on a failed refresh.
        Some("doctor") | Some("state") | Some("source.list") => true,
        Some("command") => matches!(
            request
                .get("command")
                .and_then(Value::as_object)
                .and_then(|command| command.get("kind"))
                .and_then(Value::as_str),
            Some("REVISION.LIST") | Some("REVISION.GET") | Some("CANDIDATE.LIST")
        ),
        _ => false,
    }
}

/// Backup operations have explicit archive/file bounds in the engine but can
/// legitimately exceed a normal interactive round trip. Keep all other work
/// on the short timeout so a stalled sidecar is still recovered promptly.
fn response_timeout_for_request(request: &Value, ready: bool) -> Duration {
    if !ready {
        return STARTUP_RESPONSE_TIMEOUT;
    }
    match request.get("kind").and_then(Value::as_str) {
        Some("source.list") | Some("candidate.list") => CATALOG_RESPONSE_TIMEOUT,
        // Match the whole backup family by prefix. The automatic-snapshot
        // kinds (`backup.auto.*`) read, decrypt and hash the same bounded
        // archives as the manual ones, so a new kind must not silently fall
        // back to the interactive timeout and kill a sidecar mid-restore.
        Some(kind) if kind.starts_with("backup.") => MAINTENANCE_RESPONSE_TIMEOUT,
        // A native publication claim may legitimately carry up to 70 MiB of
        // approved media, and media.read streams one approved asset. Timing
        // either out tears down the sidecar, which resets the already
        // committed IN_PROGRESS effect and lets the drainer reclaim it in a
        // loop instead of finishing the publication.
        Some("maintenance.integrity.verify")
        | Some("publication.broker.claim")
        | Some("media.read") => MAINTENANCE_RESPONSE_TIMEOUT,
        _ => RESPONSE_TIMEOUT,
    }
}

/// The runner path is resolved for the sidecar's scrubbed environment, which
/// cannot rely on PATH. Re-probe only while no runner is known, and at most
/// once per interval, so a resolved path stays stable for the session and an
/// absent one does not spawn discovery helpers on every request.
fn should_reprobe_codex_command(
    command: Option<&str>,
    probed_at: Option<Instant>,
    now: Instant,
) -> bool {
    command.is_none()
        && probed_at.is_none_or(|probed_at| {
            now.saturating_duration_since(probed_at) >= CODEX_REDISCOVERY_INTERVAL
        })
}

fn transport_error_for_request(error: &str, request_id: &str) -> String {
    format!("{error} request={request_id}")
}

fn owned_process_tree_kill_args(pid: u32) -> [String; 4] {
    ["/pid".into(), pid.to_string(), "/t".into(), "/f".into()]
}

fn owned_descendant_pids(root_pid: u32, parent_links: &[(u32, u32)]) -> Vec<u32> {
    let mut children_by_parent = HashMap::<u32, Vec<u32>>::new();
    for &(pid, parent_pid) in parent_links {
        children_by_parent.entry(parent_pid).or_default().push(pid);
    }
    let mut descendants = Vec::new();
    let mut seen = HashSet::new();
    let mut pending = children_by_parent.remove(&root_pid).unwrap_or_default();
    while let Some(pid) = pending.pop() {
        if !seen.insert(pid) {
            continue;
        }
        descendants.push(pid);
        if let Some(children) = children_by_parent.remove(&pid) {
            pending.extend(children);
        }
    }
    descendants
}

#[cfg(windows)]
fn owned_process_tree_descendants(root_pid: u32) -> Vec<u32> {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
    };

    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return Vec::new();
    };
    let mut entry = PROCESSENTRY32 {
        dwSize: std::mem::size_of::<PROCESSENTRY32>() as u32,
        ..Default::default()
    };
    let mut links = Vec::new();
    if unsafe { Process32First(snapshot, &mut entry) }.is_ok() {
        loop {
            links.push((entry.th32ProcessID, entry.th32ParentProcessID));
            if unsafe { Process32Next(snapshot, &mut entry) }.is_err() {
                break;
            }
        }
    }
    owned_descendant_pids(root_pid, &links)
}

#[cfg(windows)]
fn terminate_owned_pid(pid: u32) -> bool {
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    let Ok(process) = (unsafe { OpenProcess(PROCESS_TERMINATE, false, pid) }) else {
        return false;
    };
    unsafe { TerminateProcess(process, 1) }.is_ok()
}

pub(crate) fn terminate_owned_process_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        // taskkill /T has proved insufficient for npm/Python launchers that
        // detach their server after start. Snapshot the already-owned tree,
        // stop deepest descendants first, then stop the root. No process is
        // selected by name or outside this root's captured ancestry.
        let mut pids = owned_process_tree_descendants(child.id());
        pids.reverse();
        pids.push(child.id());
        let mut root_stopped = false;
        for pid in pids {
            let stopped = terminate_owned_pid(pid);
            if pid == child.id() {
                root_stopped = stopped;
            }
            if !stopped {
                let mut taskkill = Command::new("taskkill.exe");
                configure_hidden_command(&mut taskkill);
                let status = taskkill
                    .args(owned_process_tree_kill_args(pid))
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
                if pid == child.id() && status.is_ok_and(|result| result.success()) {
                    root_stopped = true;
                }
            }
        }
        if root_stopped {
            return;
        }
    }
    let _ = child.kill();
}

type CodexCommandProbe = Box<dyn Fn() -> Option<String> + Send + Sync>;

/// The resolved runner path plus the moment discovery last ran, so a runner
/// installed after launch can still be picked up without re-probing on every
/// request.
struct CodexRunner {
    command: Option<String>,
    probed_at: Option<Instant>,
}

pub struct EngineBridge {
    executable: Option<PathBuf>,
    fetcher_executable: Option<PathBuf>,
    secure_restore_executable: Option<PathBuf>,
    assets: Option<PathBuf>,
    node_modules: Option<PathBuf>,
    codex_runner: Mutex<CodexRunner>,
    codex_command_probe: CodexCommandProbe,
    codex_home: Option<PathBuf>,
    data_key_hex: Mutex<Vec<String>>,
    data_key_fallback_attempts: Mutex<usize>,
    data_key_recovery_exhausted: AtomicBool,
    stable_data_key_path: Option<PathBuf>,
    diagnostic_log: Option<PathBuf>,
    // Shared with the stderr reader thread so the size-check-and-rotate step is
    // serialised across every diagnostic writer.
    diagnostic_write_lock: Arc<Mutex<()>>,
    process: Mutex<Option<EngineProcess>>,
    request_sequence: AtomicU64,
    last_error: Mutex<Option<String>>,
}

struct EngineProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    pending: Arc<PendingResponses>,
    protocol_fault: Arc<AtomicBool>,
    startup_decrypt_failed: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
    stderr_reader: Option<JoinHandle<()>>,
    ready: bool,
}

#[derive(Default)]
struct PendingResponses {
    senders: Mutex<HashMap<String, mpsc::Sender<Result<String, String>>>>,
}

impl PendingResponses {
    fn register(&self, request_id: &str) -> Result<mpsc::Receiver<Result<String, String>>, String> {
        let (sender, receiver) = mpsc::channel();
        let mut senders = self
            .senders
            .lock()
            .map_err(|_| "ENGINE_PENDING_STATE_UNAVAILABLE".to_string())?;
        if senders.insert(request_id.to_string(), sender).is_some() {
            return Err("ENGINE_REQUEST_ID_COLLISION".to_string());
        }
        Ok(receiver)
    }

    fn cancel(&self, request_id: &str) {
        if let Ok(mut senders) = self.senders.lock() {
            senders.remove(request_id);
        }
    }

    fn resolve_line(&self, line: &str) -> Result<bool, String> {
        let response = serde_json::from_str::<Value>(line)
            .map_err(|error| format!("ENGINE_RESPONSE_INVALID: {error}"))?;
        // The engine gates inbound request versions; without the reverse gate a
        // newer sidecar's response shape would be handed to v1 callers, whose
        // pointer lookups then fail as a misleading payload-shape error instead
        // of naming the protocol skew.
        if response.get("version").and_then(Value::as_u64) != Some(1) {
            return Err("ENGINE_PROTOCOL_VERSION_UNSUPPORTED".to_string());
        }
        let request_id = response
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "ENGINE_RESPONSE_ID_MISSING".to_string())?;
        let sender = self
            .senders
            .lock()
            .ok()
            .and_then(|mut senders| senders.remove(request_id));
        Ok(sender.is_some_and(|sender| sender.send(Ok(line.to_string())).is_ok()))
    }

    fn fail_all(&self, error: &str) {
        let senders = self
            .senders
            .lock()
            .map(|mut values| std::mem::take(&mut *values))
            .unwrap_or_default();
        for sender in senders.into_values() {
            let _ = sender.send(Err(error.to_string()));
        }
    }
}

impl Drop for EngineProcess {
    fn drop(&mut self) {
        drop(self.stdin.take());
        let deadline = Instant::now() + SHUTDOWN_DEADLINE;
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(25));
                }
                _ => {
                    terminate_owned_process_tree(&mut self.child);
                    let _ = self.child.wait();
                    break;
                }
            }
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        if let Some(reader) = self.stderr_reader.take() {
            let _ = reader.join();
        }
    }
}

impl EngineBridge {
    pub fn discover(app: &AppHandle) -> Self {
        let executable = discover_engine_executable();
        let fetcher_executable = discover_fetcher_executable();
        let secure_restore_executable = discover_secure_restore_executable(app);
        let assets = discover_pglite_assets(app);
        let node_modules = discover_engine_node_modules(app);
        let codex_command = discover_codex_command();
        // Never inherit the user's global Codex session/config. The runner and
        // the explicit login command share only this app-owned directory.
        let codex_home = app
            .path()
            .app_data_dir()
            .ok()
            .map(|directory| directory.join("codex-home"));
        let stable_data_key_path = secure_store::stable_data_key_path(app);
        let data_key = secure_store::load_data_key_candidates(app);
        let bridge = Self {
            executable,
            fetcher_executable,
            secure_restore_executable,
            assets,
            node_modules,
            codex_runner: Mutex::new(CodexRunner {
                command: codex_command,
                probed_at: Some(Instant::now()),
            }),
            codex_command_probe: Box::new(discover_codex_command),
            codex_home,
            data_key_hex: Mutex::new(data_key.as_ref().ok().cloned().unwrap_or_default()),
            data_key_fallback_attempts: Mutex::new(0),
            data_key_recovery_exhausted: AtomicBool::new(false),
            stable_data_key_path,
            diagnostic_log: app
                .path()
                .app_data_dir()
                .ok()
                .map(|directory| directory.join("logs").join("engine.stderr.log")),
            diagnostic_write_lock: Arc::new(Mutex::new(())),
            process: Mutex::new(None),
            request_sequence: AtomicU64::new(1),
            last_error: Mutex::new(data_key.err()),
        };
        if let Err(error) = bridge.ensure_started() {
            bridge.remember_error(error);
        }
        bridge
    }

    pub fn doctor(&self) -> Result<Value, String> {
        // The sidecar reads BLOGBOT_CODEX_COMMAND once, at construction, and
        // only then exposes CODEX.RUNNER. Setup Center's runner check goes
        // through Doctor, so re-probe here: otherwise a Codex CLI installed
        // after launch could never become available and the retry the UI
        // suggests would be one that can never succeed.
        self.refresh_codex_command();
        self.request(json!({
            "version": 1,
            "id": "desktop-doctor",
            "kind": "doctor"
        }))
    }

    pub fn codex_home(&self) -> Option<PathBuf> {
        self.codex_home.clone()
    }

    pub fn diagnostic_log_path(&self) -> Option<PathBuf> {
        self.diagnostic_log.clone()
    }

    pub fn request(&self, request: Value) -> Result<Value, String> {
        let started = Instant::now();
        let request_kind = request
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let request_id = request
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("missing")
            .to_string();
        if self.data_key_recovery_exhausted.load(Ordering::Acquire) {
            self.record_diagnostic_event("LOCAL_DATA_KEY_RECOVERY_REQUIRED");
            return Err("LOCAL_DATA_KEY_RECOVERY_REQUIRED".to_string());
        }
        let mut result = self.request_with_restart(request.clone(), true);
        // A write/read/response fault invalidates the owned sidecar process
        // and request_with_restart drops it. The next request can therefore
        // start a clean process. A lost mutation response is intentionally not
        // replayed: the operator gets a durable status/diagnostic instead.
        // Only explicitly classified reads may restart once.
        let mut fallback_was_used = false;
        if result
            .as_ref()
            .err()
            .is_some_and(|error| should_retry_after_transport_fault(error))
            && is_safe_read_retry(&request)
        {
            result = self.request_with_restart(request.clone(), false);
        }
        // A legacy same-user DPAPI key is attempted only after a read request
        // loses its engine during encrypted-store startup. It cannot replay a
        // mutation and does not alter either key file or user data.
        if result
            .as_ref()
            .err()
            .is_some_and(|error| should_attempt_data_key_fallback(&request, error))
        {
            if self.advance_data_key_candidate() {
                self.stop();
                result = self.request_with_restart(request.clone(), true);
                fallback_was_used = true;
            } else if result
                .as_ref()
                .err()
                .is_some_and(|error| error.contains("LOCAL_DATA_DECRYPT_FAILED"))
            {
                self.data_key_recovery_exhausted
                    .store(true, Ordering::Release);
                self.record_diagnostic_event("LOCAL_DATA_KEY_RECOVERY_REQUIRED");
            }
        }
        if should_promote_data_key_after_fallback(fallback_was_used, result.is_ok()) {
            self.promote_active_data_key_candidate();
        }
        if let Err(error) = &result {
            // Keep the most recent bridge-level failure available to the
            // diagnostics surface.  Sidecar stderr is often empty for
            // protocol timeouts and closed pipes, so relying on that file
            // alone hides the actionable error from the user.
            self.remember_error(error.clone());
        }
        self.record_diagnostic_event(&format!(
            "BRIDGE_REQUEST kind={} id={} duration_ms={} outcome={}",
            request_kind,
            request_id,
            started.elapsed().as_millis(),
            if result.is_ok() { "OK" } else { "ERROR" }
        ));
        result
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok().and_then(|error| error.clone())
    }

    pub fn is_running(&self) -> bool {
        self.process
            .lock()
            .ok()
            .and_then(|mut process| {
                process
                    .as_mut()
                    .map(|value| value.child.try_wait().ok().flatten().is_none())
            })
            .unwrap_or(false)
    }

    /// Stops this desktop process' owned sidecar before deliberate local
    /// workspace recovery. Dropping the process performs bounded shutdown.
    pub fn stop(&self) {
        if let Ok(mut process) = self.process.lock() {
            *process = None;
        }
    }

    fn refresh_codex_command(&self) -> bool {
        self.refresh_codex_command_at(Instant::now())
    }

    /// Re-run runner discovery and report whether the live sidecar had to be
    /// dropped. A sidecar spawned without the runner path cannot learn it
    /// later, so the next request must start a replacement process.
    fn refresh_codex_command_at(&self, now: Instant) -> bool {
        let Ok(mut runner) = self.codex_runner.lock() else {
            return false;
        };
        if !should_reprobe_codex_command(runner.command.as_deref(), runner.probed_at, now) {
            return false;
        }
        runner.probed_at = Some(now);
        let discovered = (self.codex_command_probe)();
        if discovered.is_none() || discovered == runner.command {
            return false;
        }
        runner.command = discovered;
        drop(runner);
        self.record_diagnostic_event("CODEX_RUNNER_REDISCOVERED");
        self.stop();
        true
    }

    fn advance_data_key_candidate(&self) -> bool {
        let Ok(mut candidates) = self.data_key_hex.lock() else {
            return false;
        };
        let Ok(mut fallback_attempts) = self.data_key_fallback_attempts.lock() else {
            return false;
        };
        if !can_advance_data_key_candidate(candidates.len(), *fallback_attempts) {
            self.record_diagnostic_event("LOCAL_DATA_KEY_FALLBACK_EXHAUSTED");
            return false;
        }
        candidates.rotate_left(1);
        *fallback_attempts += 1;
        self.record_diagnostic_event("LOCAL_DATA_KEY_FALLBACK_ATTEMPTED");
        true
    }

    fn promote_active_data_key_candidate(&self) {
        let Some(path) = self.stable_data_key_path.as_ref() else {
            self.record_diagnostic_event("LOCAL_DATA_KEY_FALLBACK_PROMOTION_SKIPPED");
            return;
        };
        let candidate = self
            .data_key_hex
            .lock()
            .ok()
            .and_then(|keys| keys.first().cloned());
        let Some(candidate) = candidate else {
            self.record_diagnostic_event("LOCAL_DATA_KEY_FALLBACK_PROMOTION_SKIPPED");
            return;
        };
        match secure_store::promote_confirmed_data_key(path, &candidate) {
            Ok(()) => self.record_diagnostic_event("LOCAL_DATA_KEY_FALLBACK_PROMOTED"),
            Err(_) => self.record_diagnostic_event("LOCAL_DATA_KEY_FALLBACK_PROMOTION_FAILED"),
        }
    }

    fn request_with_restart(
        &self,
        mut request: Value,
        allow_preflight_restart: bool,
    ) -> Result<Value, String> {
        let original_id = request
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "ENGINE_REQUEST_ID_MISSING".to_string())?
            .to_string();
        let suffix = format!(
            ".bridge-{}",
            self.request_sequence.fetch_add(1, Ordering::Relaxed)
        );
        let transport_id = format!(
            "{}{}",
            original_id
                .chars()
                .take(200usize.saturating_sub(suffix.len()))
                .collect::<String>(),
            suffix
        );
        request["id"] = Value::String(transport_id.clone());
        let serialized = serialize_bounded_request(&request)?;
        self.ensure_started()?;
        let mut guard = self
            .process
            .lock()
            .map_err(|_| "ENGINE_STATE_UNAVAILABLE".to_string())?;
        let process = guard
            .as_mut()
            .ok_or_else(|| "ENGINE_NOT_RUNNING".to_string())?;

        if process.protocol_fault.load(Ordering::Acquire) {
            let decrypt_failed = process.startup_decrypt_failed.load(Ordering::Acquire);
            *guard = None;
            drop(guard);
            if decrypt_failed {
                return Err("LOCAL_DATA_DECRYPT_FAILED".to_string());
            }
            if !allow_preflight_restart {
                return Err("ENGINE_PROTOCOL_FAULT".to_string());
            }
            return self.request_with_restart(request, false);
        }
        if process
            .child
            .try_wait()
            .map_err(|error| format!("ENGINE_STATUS_FAILED: {error}"))?
            .is_some()
        {
            let decrypt_failed = process.startup_decrypt_failed.load(Ordering::Acquire);
            *guard = None;
            drop(guard);
            if decrypt_failed {
                return Err("LOCAL_DATA_DECRYPT_FAILED".to_string());
            }
            if !allow_preflight_restart {
                return Err("ENGINE_EXITED_DURING_START".to_string());
            }
            self.ensure_started()?;
            return self.request_with_restart(request, false);
        }

        let response_receiver = process.pending.register(&transport_id)?;
        let process_id = process.child.id();
        let startup_decrypt_failed = Arc::clone(&process.startup_decrypt_failed);
        if let Err(error) = process
            .stdin
            .as_mut()
            .ok_or_else(|| "ENGINE_STDIN_UNAVAILABLE".to_string())?
            .write_all(serialized.as_bytes())
            .and_then(|_| {
                process
                    .stdin
                    .as_mut()
                    .ok_or_else(|| std::io::Error::other("engine stdin closed"))?
                    .write_all(b"\n")
            })
            .and_then(|_| {
                process
                    .stdin
                    .as_mut()
                    .ok_or_else(|| std::io::Error::other("engine stdin closed"))?
                    .flush()
            })
        {
            process.pending.cancel(&transport_id);
            *guard = None;
            return Err(format!("ENGINE_WRITE_FAILED: {error}"));
        }

        let timeout = response_timeout_for_request(&request, process.ready);
        drop(guard);
        let line = match response_receiver.recv_timeout(timeout) {
            Ok(Ok(line)) => line,
            Ok(Err(error)) => {
                if startup_decrypt_failed.load(Ordering::Acquire) {
                    return Err("LOCAL_DATA_DECRYPT_FAILED".to_string());
                }
                return Err(transport_error_for_request(
                    &format!("ENGINE_READ_FAILED: {error}"),
                    &transport_id,
                ));
            }
            Err(error) => {
                if let Ok(mut process) = self.process.lock() {
                    if process
                        .as_ref()
                        .is_some_and(|value| value.child.id() == process_id)
                    {
                        *process = None;
                    }
                }
                return Err(format!("ENGINE_RESPONSE_TIMEOUT: {error}"));
            }
        };
        let response: Value = match serde_json::from_str(&line) {
            Ok(response) => response,
            Err(error) => {
                return Err(format!("ENGINE_RESPONSE_INVALID: {error}"));
            }
        };
        if response.get("id").and_then(Value::as_str) != Some(transport_id.as_str()) {
            return Err("ENGINE_RESPONSE_ID_MISMATCH".to_string());
        }
        if let Ok(mut process) = self.process.lock() {
            if let Some(process) = process
                .as_mut()
                .filter(|value| value.child.id() == process_id)
            {
                process.ready = true;
            }
        }
        Ok(response)
    }

    fn ensure_started(&self) -> Result<(), String> {
        let mut guard = self
            .process
            .lock()
            .map_err(|_| "ENGINE_STATE_UNAVAILABLE".to_string())?;
        if guard.is_some() {
            return Ok(());
        }
        let executable = self
            .executable
            .as_ref()
            .ok_or_else(|| "ENGINE_EXECUTABLE_MISSING".to_string())?;
        let assets = self
            .assets
            .as_ref()
            .ok_or_else(|| "PGLITE_ASSETS_MISSING".to_string())?;
        let node_modules = self
            .node_modules
            .as_ref()
            .ok_or_else(|| "ENGINE_NATIVE_MODULES_MISSING".to_string())?;
        let data_key_hex = self
            .data_key_hex
            .lock()
            .map_err(|_| "LOCAL_DATA_KEY_UNAVAILABLE".to_string())?
            .first()
            .cloned()
            .ok_or_else(|| "LOCAL_DATA_KEY_UNAVAILABLE".to_string())?;
        let fetcher_executable = self
            .fetcher_executable
            .as_ref()
            .ok_or_else(|| "FETCHER_SIDECAR_MISSING".to_string())?;
        let secure_restore_executable = self
            .secure_restore_executable
            .as_ref()
            .ok_or_else(|| "SECURE_RESTORE_SIDECAR_MISSING".to_string())?;
        let mut command = Command::new(executable);
        command.env_clear();
        command
            .envs(sidecar_environment())
            .env("BLOGBOT_PGLITE_ASSETS", assets)
            .env("BLOGBOT_ENGINE_MODULES", node_modules)
            .env("BLOGBOT_FETCHER_BIN", fetcher_executable)
            .env("BLOGBOT_SECURE_RESTORE_BIN", secure_restore_executable)
            .env("BLOGBOT_DATA_KEY_HEX", data_key_hex)
            .envs(self.codex_environment())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_hidden_command(&mut command);
        let mut child = command
            .spawn()
            .map_err(|error| format!("ENGINE_START_FAILED: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "ENGINE_STDIN_UNAVAILABLE".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "ENGINE_STDOUT_UNAVAILABLE".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "ENGINE_STDERR_UNAVAILABLE".to_string())?;
        let stderr_path = self.diagnostic_log.clone();
        let stderr_write_lock = Arc::clone(&self.diagnostic_write_lock);
        let startup_decrypt_failed = Arc::new(AtomicBool::new(false));
        let stderr_decrypt_failed = Arc::clone(&startup_decrypt_failed);
        let stderr_reader = thread::Builder::new()
            .name("blogbot-engine-stderr".to_string())
            .spawn(move || {
                if let Some(path) = stderr_path {
                    let reader = BufReader::new(stderr);
                    for line in reader.lines().map_while(Result::ok) {
                        if line.contains("LOCAL_DATA_DECRYPT_FAILED") {
                            stderr_decrypt_failed.store(true, Ordering::Release);
                        }
                        // Rotation is shared with the bridge's own writers, so
                        // this thread must not keep a handle to a file another
                        // writer may have rotated away underneath it.
                        append_diagnostic_line(
                            &path,
                            &stderr_write_lock,
                            &redact_diagnostic_for_persistence(&line),
                        );
                    }
                }
            })
            .map_err(|error| format!("ENGINE_STDERR_READER_START_FAILED: {error}"))?;
        let pending = Arc::new(PendingResponses::default());
        let reader_pending = Arc::clone(&pending);
        let protocol_fault = Arc::new(AtomicBool::new(false));
        let reader_protocol_fault = Arc::clone(&protocol_fault);
        let reader = thread::Builder::new()
            .name("blogbot-engine-stdout".to_string())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                loop {
                    let mut bytes = Vec::with_capacity(8 * 1024);
                    let read = (&mut reader)
                        .take((MAX_RESPONSE_BYTES + 2) as u64)
                        .read_until(b'\n', &mut bytes);
                    let result = match read {
                        Ok(0) => break,
                        Ok(_) if bytes.last() != Some(&b'\n') => {
                            Err("ENGINE_RESPONSE_TOO_LARGE".to_string())
                        }
                        Ok(_) if bytes.len() > MAX_RESPONSE_BYTES + 1 => {
                            Err("ENGINE_RESPONSE_TOO_LARGE".to_string())
                        }
                        Ok(_) => {
                            bytes.pop();
                            if bytes.last() == Some(&b'\r') {
                                bytes.pop();
                            }
                            String::from_utf8(bytes)
                                .map_err(|_| "ENGINE_RESPONSE_NOT_UTF8".to_string())
                        }
                        Err(error) => Err(error.to_string()),
                    };
                    match result {
                        Ok(line) => match reader_pending.resolve_line(&line) {
                            Ok(true) => {}
                            Ok(false) => {
                                // A timed-out request can leave a late response behind.
                                // Bridge-generated IDs prevent it being delivered to a
                                // newer caller, so it is safe to discard here.
                            }
                            Err(error) => {
                                reader_protocol_fault.store(true, Ordering::Release);
                                reader_pending.fail_all(&error);
                                break;
                            }
                        },
                        Err(error) => {
                            reader_protocol_fault.store(true, Ordering::Release);
                            reader_pending.fail_all(&error);
                            break;
                        }
                    }
                }
                reader_protocol_fault.store(true, Ordering::Release);
                reader_pending.fail_all("ENGINE_CLOSED_PIPE");
            })
            .map_err(|error| format!("ENGINE_READER_START_FAILED: {error}"))?;
        *guard = Some(EngineProcess {
            child,
            stdin: Some(stdin),
            pending,
            protocol_fault,
            startup_decrypt_failed,
            reader: Some(reader),
            stderr_reader: Some(stderr_reader),
            ready: false,
        });
        if let Ok(mut error) = self.last_error.lock() {
            *error = None;
        }
        Ok(())
    }

    fn remember_error(&self, error: String) {
        if let Ok(mut last_error) = self.last_error.lock() {
            *last_error = Some(error);
        }
        if let Some(path) = &self.diagnostic_log {
            let detail = redact_diagnostic_for_persistence(
                &self.last_error().unwrap_or_else(|| "unknown".to_string()),
            );
            append_diagnostic_line(
                path,
                &self.diagnostic_write_lock,
                &format!("BRIDGE_ERROR {detail}"),
            );
        }
    }

    fn record_diagnostic_event(&self, event: &str) {
        let Some(path) = &self.diagnostic_log else {
            return;
        };
        append_diagnostic_line(
            path,
            &self.diagnostic_write_lock,
            &redact_diagnostic_for_persistence(event),
        );
    }

    fn codex_environment(&self) -> Vec<(&'static str, PathBuf)> {
        let mut vars = Vec::new();
        if let Some(command) = self
            .codex_runner
            .lock()
            .ok()
            .and_then(|runner| runner.command.clone())
        {
            vars.push(("BLOGBOT_CODEX_COMMAND", PathBuf::from(command)));
        }
        if let Some(home) = &self.codex_home {
            vars.push(("BLOGBOT_CODEX_HOME", home.clone()));
        }
        vars
    }

    /// A bridge with no discovered sidecar, used to exercise runner discovery
    /// and diagnostic-log bounds without an AppHandle or a live engine.
    #[cfg(test)]
    fn for_local_test(
        codex_command_probe: CodexCommandProbe,
        diagnostic_log: Option<PathBuf>,
    ) -> Self {
        Self {
            executable: None,
            fetcher_executable: None,
            secure_restore_executable: None,
            assets: None,
            node_modules: None,
            codex_runner: Mutex::new(CodexRunner {
                command: None,
                probed_at: None,
            }),
            codex_command_probe,
            codex_home: None,
            data_key_hex: Mutex::new(Vec::new()),
            data_key_fallback_attempts: Mutex::new(0),
            data_key_recovery_exhausted: AtomicBool::new(false),
            stable_data_key_path: None,
            diagnostic_log,
            diagnostic_write_lock: Arc::new(Mutex::new(())),
            process: Mutex::new(None),
            request_sequence: AtomicU64::new(1),
            last_error: Mutex::new(None),
        }
    }
}

fn should_attempt_data_key_fallback(request: &Value, error: &str) -> bool {
    // A decrypt failure can first close stdout, then be normalized to
    // ENGINE_PROTOCOL_FAULT by the bounded safe-read restart above. Both
    // forms mean a same-user legacy key may recover an existing encrypted
    // workspace. This remains read-only and never retries a mutation.
    is_safe_read_retry(request)
        && (error.contains("LOCAL_DATA_DECRYPT_FAILED")
            || error.contains("ENGINE_CLOSED_PIPE")
            || error.starts_with("ENGINE_PROTOCOL_FAULT"))
}

fn should_promote_data_key_after_fallback(
    fallback_was_used: bool,
    request_succeeded: bool,
) -> bool {
    fallback_was_used && request_succeeded
}

fn can_advance_data_key_candidate(candidate_count: usize, fallback_attempts: usize) -> bool {
    // Candidate zero is the canonical key used at startup. Each remaining
    // same-user legacy key is permitted exactly once for this desktop session.
    candidate_count > fallback_attempts.saturating_add(1)
}

fn codex_command_candidates() -> [&'static str; 3] {
    // The supported npm launcher is kept current by Codex updates. A stale
    // standalone codex.exe can remain on PATH, so prefer the .cmd shim; the
    // engine runner resolves it to Node without showing a console window.
    ["codex.cmd", "codex.exe", "codex"]
}

fn discover_codex_command() -> Option<String> {
    codex_command_candidates()
        .into_iter()
        .find(|candidate| {
            let mut probe = Command::new(candidate);
            configure_hidden_command(&mut probe);
            probe
                .arg("--version")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
        })
        .and_then(|candidate| {
            // The sidecar starts with a scrubbed environment and therefore
            // cannot rely on PATH. Resolve the executable before spawning it.
            let mut where_command = Command::new("where.exe");
            configure_hidden_command(&mut where_command);
            let resolved = where_command
                .arg(candidate)
                .stdin(Stdio::null())
                .output()
                .ok()
                .and_then(|output| String::from_utf8(output.stdout).ok())
                .and_then(|output| {
                    output
                        .lines()
                        .map(str::trim)
                        .find(|line| !line.is_empty())
                        .map(PathBuf::from)
                });
            resolved
                .filter(|path| path.is_file())
                .map(|path| path.to_string_lossy().into_owned())
        })
}

fn discover_engine_executable() -> Option<PathBuf> {
    if let Some(path) = env::var_os("BLOGBOT_ENGINE_BIN").map(PathBuf::from) {
        if path.is_file() {
            return Some(path);
        }
    }
    let mut candidates = Vec::new();
    if let Ok(current) = env::current_exe() {
        if let Some(directory) = current.parent() {
            candidates.push(directory.join("blogbot-engine.exe"));
            candidates.push(directory.join("blogbot-engine-x86_64-pc-windows-msvc.exe"));
        }
    }
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join("blogbot-engine-x86_64-pc-windows-msvc.exe"),
    );
    candidates.into_iter().find(|path| path.is_file())
}

fn discover_fetcher_executable() -> Option<PathBuf> {
    if let Some(path) = env::var_os("BLOGBOT_FETCHER_BIN").map(PathBuf::from) {
        if path.is_file() {
            return Some(path);
        }
    }
    let mut candidates = Vec::new();
    if let Ok(current) = env::current_exe() {
        if let Some(directory) = current.parent() {
            candidates.push(directory.join("blogbot-fetcher.exe"));
            candidates.push(directory.join("blogbot-fetcher-x86_64-pc-windows-msvc.exe"));
        }
    }
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join("blogbot-fetcher-x86_64-pc-windows-msvc.exe"),
    );
    candidates.into_iter().find(|path| path.is_file())
}

fn discover_secure_restore_executable(app: &AppHandle) -> Option<PathBuf> {
    if let Some(path) = env::var_os("BLOGBOT_SECURE_RESTORE_BIN").map(PathBuf::from) {
        if path.is_file() {
            return Some(path);
        }
    }
    let mut candidates = Vec::new();
    if let Ok(current) = env::current_exe() {
        if let Some(directory) = current.parent() {
            candidates.push(directory.join("blogbot-secure-restore.exe"));
            candidates.push(directory.join("blogbot-secure-restore-x86_64-pc-windows-msvc.exe"));
        }
    }
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join("blogbot-secure-restore-x86_64-pc-windows-msvc.exe"),
    );
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("secure-restore")
            .join("blogbot-secure-restore.exe"),
    );
    if let Ok(resource_directory) = app.path().resource_dir() {
        candidates.push(
            resource_directory
                .join("resources")
                .join("secure-restore")
                .join("blogbot-secure-restore.exe"),
        );
        candidates.push(
            resource_directory
                .join("secure-restore")
                .join("blogbot-secure-restore.exe"),
        );
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn discover_pglite_assets(app: &AppHandle) -> Option<PathBuf> {
    if let Some(path) = env::var_os("BLOGBOT_PGLITE_ASSETS").map(PathBuf::from) {
        if has_pglite_assets(&path) {
            return Some(path);
        }
    }
    let mut candidates = vec![Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("pglite")];
    if let Ok(resource_directory) = app.path().resource_dir() {
        candidates.push(resource_directory.join("resources").join("pglite"));
        candidates.push(resource_directory.join("pglite"));
    }
    candidates.into_iter().find(|path| has_pglite_assets(path))
}

fn has_pglite_assets(path: &Path) -> bool {
    ["pglite.wasm", "initdb.wasm", "pglite.data"]
        .iter()
        .all(|asset| path.join(asset).is_file())
}

fn discover_engine_node_modules(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = vec![Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("engine-node_modules")
        .join("node_modules")];
    if let Ok(resource_directory) = app.path().resource_dir() {
        candidates.push(
            resource_directory
                .join("resources")
                .join("engine-node_modules")
                .join("node_modules"),
        );
        candidates.push(
            resource_directory
                .join("engine-node_modules")
                .join("node_modules"),
        );
    }
    candidates.into_iter().find(|path| {
        path.join("sharp").join("package.json").is_file()
            && path
                .join("@img")
                .join("sharp-win32-x64")
                .join("lib")
                .join("sharp-win32-x64-0.35.3.node")
                .is_file()
    })
}

#[cfg(test)]
mod tests {
    use super::{
        can_advance_data_key_candidate, codex_command_candidates, diagnostic_log_variants,
        discover_engine_executable, has_pglite_assets, is_safe_read_retry,
        redact_diagnostic_for_persistence, response_timeout_for_request, rotate_diagnostic_log,
        serialize_bounded_request, should_attempt_data_key_fallback,
        should_promote_data_key_after_fallback, should_retry_after_transport_fault,
        sidecar_environment_with, transport_error_for_request, EngineBridge, PendingResponses,
        MAINTENANCE_RESPONSE_TIMEOUT, MAX_DIAGNOSTIC_LOG_BYTES, RESPONSE_TIMEOUT,
        SHUTDOWN_DEADLINE, STARTUP_RESPONSE_TIMEOUT, WINDOWS_CREATE_NO_WINDOW,
    };
    use serde_json::json;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    fn temporary_directory(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("blogbot-{label}-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("fixture directory");
        directory
    }

    #[test]
    fn diagnostic_rotation_preserves_recent_log_segments() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("blogbot-diagnostic-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("diagnostic fixture directory");
        let path = directory.join("engine.stderr.log");
        for (index, variant) in diagnostic_log_variants(&path).iter().enumerate() {
            std::fs::write(variant, format!("segment-{index}")).expect("diagnostic fixture");
        }

        rotate_diagnostic_log(&path);

        let rotated = diagnostic_log_variants(&path);
        assert_eq!(std::fs::read_to_string(&rotated[1]).unwrap(), "segment-0");
        assert_eq!(std::fs::read_to_string(&rotated[2]).unwrap(), "segment-1");
        assert_eq!(std::fs::read_to_string(&rotated[4]).unwrap(), "segment-3");
        assert!(!rotated[0].exists());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn development_engine_binary_is_discoverable_after_sidecar_build() {
        assert!(discover_engine_executable().is_some());
    }

    #[test]
    fn packaged_pglite_asset_set_is_complete() {
        assert!(has_pglite_assets(
            &Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join("pglite")
        ));
    }

    #[test]
    fn ready_engine_timeout_covers_guarded_fetch_deadline() {
        // The fetch boundary allows an 8-second hop. The bridge must not
        // expire sooner than that or valid source tests become false errors.
        assert!(RESPONSE_TIMEOUT >= Duration::from_secs(8));
    }

    #[test]
    fn owned_sidecar_shutdown_targets_only_the_owned_process_tree() {
        assert_eq!(
            super::owned_process_tree_kill_args(4242),
            ["/pid", "4242", "/t", "/f"].map(String::from)
        );
    }

    #[test]
    fn owned_process_tree_expands_only_descendants_of_the_owned_root() {
        assert_eq!(
            super::owned_descendant_pids(10, &[(11, 10), (12, 11), (13, 10), (99, 98)]),
            vec![13, 11, 12]
        );
    }

    #[test]
    fn windows_helper_processes_use_the_no_window_creation_flag() {
        assert_eq!(WINDOWS_CREATE_NO_WINDOW, 0x0800_0000);
    }

    #[test]
    fn transport_fault_classifier_distinguishes_safe_reads_from_mutations() {
        for error in [
            "ENGINE_WRITE_FAILED: broken pipe",
            "ENGINE_READ_FAILED: connection reset",
            "ENGINE_RESPONSE_TIMEOUT: timed out waiting on channel",
            "ENGINE_CLOSED_PIPE",
            "ENGINE_RESPONSE_INVALID: malformed line",
            "ENGINE_RESPONSE_ID_MISMATCH",
        ] {
            assert!(should_retry_after_transport_fault(error), "{error}");
        }
        assert!(!should_retry_after_transport_fault(
            "ENGINE_REQUEST_TOO_LARGE"
        ));
        assert!(!should_retry_after_transport_fault(
            "ENGINE_REQUEST_ID_MISSING"
        ));
        assert!(is_safe_read_retry(&json!({ "kind": "state" })));
        assert!(is_safe_read_retry(&json!({ "kind": "source.list" })));
        assert!(is_safe_read_retry(
            &json!({ "kind": "command", "command": { "kind": "REVISION.GET" } })
        ));
        assert!(!is_safe_read_retry(
            &json!({ "kind": "publication.enqueue" })
        ));
        assert!(!is_safe_read_retry(
            &json!({ "kind": "command", "command": { "kind": "APPROVAL.GRANT" } })
        ));
        assert!(should_attempt_data_key_fallback(
            &json!({ "kind": "state" }),
            "ENGINE_READ_FAILED: ENGINE_CLOSED_PIPE"
        ));
        assert!(should_attempt_data_key_fallback(
            &json!({ "kind": "state" }),
            "ENGINE_PROTOCOL_FAULT"
        ));
        assert!(should_attempt_data_key_fallback(
            &json!({ "kind": "state" }),
            "LOCAL_DATA_DECRYPT_FAILED"
        ));
        assert!(!should_attempt_data_key_fallback(
            &json!({ "kind": "command", "command": { "kind": "APPROVAL.GRANT" } }),
            "ENGINE_READ_FAILED: ENGINE_CLOSED_PIPE"
        ));
        assert!(!should_attempt_data_key_fallback(
            &json!({ "kind": "state" }),
            "ENGINE_RESPONSE_TIMEOUT"
        ));
    }

    #[test]
    fn successful_legacy_key_read_is_the_only_case_that_promotes_the_key() {
        assert!(should_promote_data_key_after_fallback(true, true));
        assert!(!should_promote_data_key_after_fallback(true, false));
        assert!(!should_promote_data_key_after_fallback(false, true));
    }

    #[test]
    fn exhausted_legacy_key_candidates_do_not_restart_every_safe_read() {
        assert!(can_advance_data_key_candidate(2, 0));
        assert!(!can_advance_data_key_candidate(2, 1));
        assert!(can_advance_data_key_candidate(3, 0));
        assert!(can_advance_data_key_candidate(3, 1));
        assert!(!can_advance_data_key_candidate(3, 2));
    }

    #[test]
    fn bounded_backup_requests_get_a_longer_timeout_without_expanding_normal_requests() {
        assert_eq!(
            response_timeout_for_request(&json!({ "kind": "backup.verify" }), true),
            MAINTENANCE_RESPONSE_TIMEOUT
        );
        assert_eq!(
            response_timeout_for_request(&json!({ "kind": "maintenance.integrity.verify" }), true),
            MAINTENANCE_RESPONSE_TIMEOUT
        );
        assert_eq!(
            response_timeout_for_request(&json!({ "kind": "state" }), true),
            RESPONSE_TIMEOUT
        );
        assert_eq!(
            response_timeout_for_request(&json!({ "kind": "backup.restore" }), false),
            STARTUP_RESPONSE_TIMEOUT
        );
    }

    #[test]
    fn local_catalog_reads_fail_fast_instead_of_holding_navigation_for_the_general_timeout() {
        assert_eq!(
            response_timeout_for_request(&json!({ "kind": "source.list" }), true),
            Duration::from_secs(8)
        );
        assert_eq!(
            response_timeout_for_request(&json!({ "kind": "candidate.list" }), true),
            Duration::from_secs(8)
        );
    }

    #[test]
    fn unresponsive_owned_sidecar_shutdown_is_bounded_to_one_second() {
        assert!(SHUTDOWN_DEADLINE <= Duration::from_secs(1));
    }

    #[test]
    fn transport_error_keeps_request_id_for_diagnostics_without_payload_data() {
        assert_eq!(
            transport_error_for_request("ENGINE_RESPONSE_TOO_LARGE", "desktop-workspace-42"),
            "ENGINE_RESPONSE_TOO_LARGE request=desktop-workspace-42"
        );
    }

    #[test]
    fn pending_responses_are_routed_by_request_id_without_cross_talking() {
        let pending = PendingResponses::default();
        let first = pending
            .register("desktop-read-1")
            .expect("first pending response");
        let second = pending
            .register("desktop-read-2")
            .expect("second pending response");

        assert!(pending
            .resolve_line(r#"{"version":1,"id":"desktop-read-2","ok":true}"#)
            .unwrap());
        assert_eq!(
            second
                .recv_timeout(Duration::from_millis(50))
                .unwrap()
                .unwrap(),
            r#"{"version":1,"id":"desktop-read-2","ok":true}"#
        );
        assert!(first.try_recv().is_err());

        assert!(pending
            .resolve_line(r#"{"version":1,"id":"desktop-read-1","ok":true}"#)
            .unwrap());
        assert_eq!(
            first
                .recv_timeout(Duration::from_millis(50))
                .unwrap()
                .unwrap(),
            r#"{"version":1,"id":"desktop-read-1","ok":true}"#
        );
        assert!(!pending
            .resolve_line(r#"{"version":1,"id":"late-response","ok":true}"#)
            .unwrap());
    }

    #[test]
    fn responses_from_an_unsupported_protocol_version_never_reach_the_caller() {
        let pending = PendingResponses::default();
        let waiting = pending
            .register("desktop-read-1")
            .expect("pending response");

        assert_eq!(
            pending
                .resolve_line(r#"{"version":2,"id":"desktop-read-1","ok":true}"#)
                .expect_err("a newer protocol response must be refused"),
            "ENGINE_PROTOCOL_VERSION_UNSUPPORTED"
        );
        assert_eq!(
            pending
                .resolve_line(r#"{"id":"desktop-read-1","ok":true}"#)
                .expect_err("a response without a version must be refused"),
            "ENGINE_PROTOCOL_VERSION_UNSUPPORTED"
        );
        // The reader thread converts this into fail_all, so the waiting caller
        // must never be handed the unsupported payload as a success.
        assert!(waiting.try_recv().is_err());
    }

    #[test]
    fn automatic_backup_access_shares_the_bounded_maintenance_timeout() {
        for kind in [
            "backup.auto.list",
            "backup.auto.verify",
            "backup.auto.restore.preview",
            "backup.auto.restore",
        ] {
            assert_eq!(
                response_timeout_for_request(&json!({ "kind": kind }), true),
                MAINTENANCE_RESPONSE_TIMEOUT,
                "{kind}"
            );
        }
    }

    #[test]
    fn large_media_responses_do_not_expire_on_the_interactive_timeout() {
        for kind in ["publication.broker.claim", "media.read"] {
            assert_eq!(
                response_timeout_for_request(&json!({ "kind": kind }), true),
                MAINTENANCE_RESPONSE_TIMEOUT,
                "{kind}"
            );
        }
    }

    #[test]
    fn codex_discovery_prefers_the_current_npm_launcher() {
        assert_eq!(
            codex_command_candidates(),
            ["codex.cmd", "codex.exe", "codex"],
            "a stale standalone executable must not shadow the current Codex launcher"
        );
    }
    #[test]
    fn a_runner_installed_after_launch_is_rediscovered_and_forces_a_fresh_spawn() {
        let installed = Arc::new(Mutex::new(None::<String>));
        let probed = Arc::clone(&installed);
        let bridge = EngineBridge::for_local_test(
            Box::new(move || probed.lock().expect("probe state").clone()),
            None,
        );

        assert!(!bridge.refresh_codex_command_at(Instant::now()));
        assert!(!bridge
            .codex_environment()
            .iter()
            .any(|(key, _)| *key == "BLOGBOT_CODEX_COMMAND"));

        *installed.lock().expect("probe state") = Some("C:\\tools\\codex.exe".to_string());
        let after_interval = Instant::now() + Duration::from_secs(60);
        assert!(
            bridge.refresh_codex_command_at(after_interval),
            "a newly resolved runner must request a fresh sidecar spawn"
        );
        assert_eq!(
            bridge
                .codex_environment()
                .into_iter()
                .find(|(key, _)| *key == "BLOGBOT_CODEX_COMMAND")
                .map(|(_, value)| value),
            Some(PathBuf::from("C:\\tools\\codex.exe"))
        );
    }

    #[test]
    fn bridge_diagnostic_events_stay_bounded_without_any_stderr_activity() {
        let directory = temporary_directory("diagnostic-events");
        let path = directory.join("engine.stderr.log");
        let bridge = EngineBridge::for_local_test(Box::new(|| None), Some(path.clone()));

        // A healthy session records one line per bridge request and the
        // sidecar may never write stderr at all.
        let event = "BRIDGE_REQUEST kind=state duration_ms=1 outcome=OK ".repeat(20);
        for _ in 0..400 {
            bridge.record_diagnostic_event(&event);
        }

        let live = std::fs::metadata(&path).expect("live diagnostic log").len();
        assert!(
            live <= MAX_DIAGNOSTIC_LOG_BYTES,
            "live diagnostic log grew to {live} bytes"
        );
        assert!(diagnostic_log_variants(&path)[1].is_file());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn sidecar_environment_allows_only_bootstrap_and_explicit_imagegen_variables() {
        let environment = sidecar_environment_with(|key| match key {
            "SystemRoot" => Some("C:\\Windows".into()),
            "ComSpec" => Some("C:\\Windows\\System32\\cmd.exe".into()),
            "PATH" => Some("C:\\Windows\\System32".into()),
            "PATHEXT" => Some(".COM;.EXE;.BAT;.CMD".into()),
            "TEMP" => Some("C:\\Temp".into()),
            "BLOGBOT_IMAGEGEN_API_KEY" => Some("configured-only".into()),
            "BLOGBOT_IMAGEGEN_MODEL" => Some("gpt-image-1".into()),
            _ => None,
        });
        assert_eq!(environment.len(), 7);
        assert!(environment.iter().any(|(key, _)| *key == "ComSpec"));
        assert!(environment.iter().any(|(key, _)| *key == "PATH"));
        assert!(environment.iter().any(|(key, _)| *key == "PATHEXT"));
        assert!(environment
            .iter()
            .any(|(key, _)| *key == "BLOGBOT_IMAGEGEN_API_KEY"));
        assert!(environment
            .iter()
            .any(|(key, _)| *key == "BLOGBOT_IMAGEGEN_MODEL"));
        assert!(!environment.iter().any(|(key, _)| *key == "USERPROFILE"));
    }

    #[test]
    fn oversized_requests_are_rejected_before_sidecar_io() {
        let oversized = json!({
            "version": 1,
            "id": "oversized",
            "kind": "command",
            "payload": "x".repeat(1_000_001)
        });
        assert_eq!(
            serialize_bounded_request(&oversized).unwrap_err(),
            "ENGINE_REQUEST_TOO_LARGE"
        );
    }

    #[test]
    fn diagnostics_are_redacted_before_they_reach_disk() {
        for canary in [
            &format!("Authorization: Bearer {}", "abcdefghijklmnopqrstuvwxyz"),
            "token=top-secret-value",
            concat!("github_", "pat_123456789012345678901234567890"),
            "user@example.com failed",
            r"C:\Users\Person\AppData\Local\auth.json",
            "eyJhbGciOiJIUzI1NiJ9.payload.signature",
        ] {
            assert_eq!(
                redact_diagnostic_for_persistence(canary),
                "[redacted sensitive diagnostic line]"
            );
        }
        assert_eq!(
            redact_diagnostic_for_persistence("ENGINE_RESPONSE_TIMEOUT"),
            "ENGINE_RESPONSE_TIMEOUT"
        );
    }
}
