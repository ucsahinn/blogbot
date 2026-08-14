use std::collections::HashMap;
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
// proxy, and arbitrary application variables never cross the bridge.
const SIDECAR_ENV_ALLOWLIST: &[&str] = &[
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
    "LOCALAPPDATA",
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
        Some("doctor") | Some("state") => true,
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
        Some("backup.create")
        | Some("backup.auto")
        | Some("backup.verify")
        | Some("backup.restore.preview")
        | Some("backup.restore")
        | Some("maintenance.integrity.verify") => MAINTENANCE_RESPONSE_TIMEOUT,
        _ => RESPONSE_TIMEOUT,
    }
}

fn transport_error_for_request(error: &str, request_id: &str) -> String {
    format!("{error} request={request_id}")
}

fn owned_process_tree_kill_args(pid: u32) -> [String; 4] {
    ["/pid".into(), pid.to_string(), "/t".into(), "/f".into()]
}

pub(crate) fn terminate_owned_process_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let mut taskkill = Command::new("taskkill.exe");
        configure_hidden_command(&mut taskkill);
        let status = taskkill
            .args(owned_process_tree_kill_args(child.id()))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if status.is_ok_and(|result| result.success()) {
            return;
        }
    }
    let _ = child.kill();
}

pub struct EngineBridge {
    executable: Option<PathBuf>,
    fetcher_executable: Option<PathBuf>,
    secure_restore_executable: Option<PathBuf>,
    assets: Option<PathBuf>,
    node_modules: Option<PathBuf>,
    codex_command: Option<String>,
    codex_home: Option<PathBuf>,
    data_key_hex: Option<String>,
    diagnostic_log: Option<PathBuf>,
    process: Mutex<Option<EngineProcess>>,
    request_sequence: AtomicU64,
    last_error: Mutex<Option<String>>,
}

struct EngineProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    pending: Arc<PendingResponses>,
    protocol_fault: Arc<AtomicBool>,
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
        let data_key = secure_store::load_or_create_data_key(app);
        let bridge = Self {
            executable,
            fetcher_executable,
            secure_restore_executable,
            assets,
            node_modules,
            codex_command,
            codex_home,
            data_key_hex: data_key.as_ref().ok().cloned(),
            diagnostic_log: app
                .path()
                .app_data_dir()
                .ok()
                .map(|directory| directory.join("logs").join("engine.stderr.log")),
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
        let mut result = self.request_with_restart(request.clone(), true);
        // A write/read/response fault invalidates the owned sidecar process
        // and request_with_restart drops it. The next request can therefore
        // start a clean process. A lost mutation response is intentionally not
        // replayed: the operator gets a durable status/diagnostic instead.
        // Only explicitly classified reads may restart once.
        if result
            .as_ref()
            .err()
            .is_some_and(|error| should_retry_after_transport_fault(error))
            && is_safe_read_retry(&request)
        {
            result = self.request_with_restart(request, false);
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
            *guard = None;
            drop(guard);
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
            *guard = None;
            drop(guard);
            if !allow_preflight_restart {
                return Err("ENGINE_EXITED_DURING_START".to_string());
            }
            self.ensure_started()?;
            return self.request_with_restart(request, false);
        }

        let response_receiver = process.pending.register(&transport_id)?;
        let process_id = process.child.id();
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
            .as_ref()
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
        let stderr_reader = thread::Builder::new()
            .name("blogbot-engine-stderr".to_string())
            .spawn(move || {
                if let Some(path) = stderr_path {
                    if let Some(parent) = path.parent() {
                        let _ = create_dir_all(parent);
                    }
                    let mut log = OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&path)
                        .ok();
                    let reader = BufReader::new(stderr);
                    for line in reader.lines().map_while(Result::ok) {
                        let redacted = redact_diagnostic_for_persistence(&line);
                        if let Some(file) = log.as_mut() {
                            if file.metadata().map(|meta| meta.len()).unwrap_or(0)
                                > MAX_DIAGNOSTIC_LOG_BYTES
                            {
                                drop(log.take());
                                let _ = std::fs::write(&path, b"[diagnostic log rotated]\n");
                                log = OpenOptions::new()
                                    .create(true)
                                    .append(true)
                                    .open(&path)
                                    .ok();
                            }
                        }
                        if let Some(file) = log.as_mut() {
                            let _ = writeln!(file, "{redacted}");
                        }
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
            if let Some(parent) = path.parent() {
                let _ = create_dir_all(parent);
            }
            if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
                let detail = redact_diagnostic_for_persistence(
                    &self.last_error().unwrap_or_else(|| "unknown".to_string()),
                );
                let _ = writeln!(file, "BRIDGE_ERROR {detail}");
            }
        }
    }

    fn record_diagnostic_event(&self, event: &str) {
        let Some(path) = &self.diagnostic_log else {
            return;
        };
        if let Some(parent) = path.parent() {
            let _ = create_dir_all(parent);
        }
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let detail = redact_diagnostic_for_persistence(event);
            let _ = writeln!(file, "{detail}");
        }
    }

    fn codex_environment(&self) -> Vec<(&'static str, PathBuf)> {
        let mut vars = Vec::new();
        if let Some(command) = &self.codex_command {
            vars.push(("BLOGBOT_CODEX_COMMAND", PathBuf::from(command)));
        }
        if let Some(home) = &self.codex_home {
            vars.push(("BLOGBOT_CODEX_HOME", home.clone()));
        }
        vars
    }
}

fn discover_codex_command() -> Option<String> {
    ["codex.exe", "codex.cmd", "codex"]
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
        discover_engine_executable, has_pglite_assets, is_safe_read_retry,
        redact_diagnostic_for_persistence, response_timeout_for_request, serialize_bounded_request,
        should_retry_after_transport_fault, sidecar_environment_with, transport_error_for_request,
        PendingResponses, MAINTENANCE_RESPONSE_TIMEOUT, RESPONSE_TIMEOUT, STARTUP_RESPONSE_TIMEOUT,
        SHUTDOWN_DEADLINE, WINDOWS_CREATE_NO_WINDOW,
    };
    use serde_json::json;
    use std::path::Path;
    use std::time::Duration;

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
        assert!(is_safe_read_retry(
            &json!({ "kind": "command", "command": { "kind": "REVISION.GET" } })
        ));
        assert!(!is_safe_read_retry(
            &json!({ "kind": "publication.enqueue" })
        ));
        assert!(!is_safe_read_retry(
            &json!({ "kind": "command", "command": { "kind": "APPROVAL.GRANT" } })
        ));
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
            .resolve_line(r#"{"id":"desktop-read-2","ok":true}"#)
            .unwrap());
        assert_eq!(
            second
                .recv_timeout(Duration::from_millis(50))
                .unwrap()
                .unwrap(),
            r#"{"id":"desktop-read-2","ok":true}"#
        );
        assert!(first.try_recv().is_err());

        assert!(pending
            .resolve_line(r#"{"id":"desktop-read-1","ok":true}"#)
            .unwrap());
        assert_eq!(
            first
                .recv_timeout(Duration::from_millis(50))
                .unwrap()
                .unwrap(),
            r#"{"id":"desktop-read-1","ok":true}"#
        );
        assert!(!pending
            .resolve_line(r#"{"id":"late-response","ok":true}"#)
            .unwrap());
    }

    #[test]
    fn scrubbed_sidecar_keeps_only_windows_process_bootstrap_variables() {
        let environment = sidecar_environment_with(|key| match key {
            "SystemRoot" => Some("C:\\Windows".into()),
            "ComSpec" => Some("C:\\Windows\\System32\\cmd.exe".into()),
            "PATH" => Some("C:\\Windows\\System32".into()),
            "PATHEXT" => Some(".COM;.EXE;.BAT;.CMD".into()),
            "TEMP" => Some("C:\\Temp".into()),
            _ => None,
        });
        assert_eq!(environment.len(), 5);
        assert!(environment.iter().any(|(key, _)| *key == "ComSpec"));
        assert!(environment.iter().any(|(key, _)| *key == "PATH"));
        assert!(environment.iter().any(|(key, _)| *key == "PATHEXT"));
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
