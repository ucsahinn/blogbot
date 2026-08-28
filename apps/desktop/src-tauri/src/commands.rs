use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;
use tauri_plugin_autostart::ManagerExt;
use thiserror::Error;

use crate::engine_bridge::{terminate_owned_process_tree, EngineBridge};
use crate::github_broker::{drive_publication_broker, GitHubBroker};
use crate::notifications;
use crate::secure_store;

const PROJECT_PAGE_URL: &str = "https://github.com/ucsahinn/blogbot";
static CONNECTOR_CATALOG_MIGRATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn configure_hidden_command(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
// The engine handshake will construct online/degraded states.
#[allow(dead_code)]
pub enum RuntimeMode {
    Online,
    Degraded,
    OfflineReadOnly,
}

pub struct DesktopState {
    runtime: RwLock<RuntimeMode>,
    /// The app-owned Boby/Luna Low session is only considered available after
    /// the explicit, bounded runtime check succeeds. Engine capability alone
    /// proves that the runner can start; it never proves authentication.
    codex_authenticated: RwLock<Option<bool>>,
    onboarding_complete: RwLock<bool>,
    ingestion_paused: RwLock<bool>,
    publishing_paused: RwLock<bool>,
    /// Local-only editorial mutations for capabilities not yet represented by
    /// the engine protocol. These are typed JSON records and remain in the
    /// desktop process; they are never sent to external services.
    editorial_mutations: RwLock<Vec<Value>>,
    preferences: RwLock<Value>,
    local_dev_process: RwLock<Option<Child>>,
    folder_grants: RwLock<Vec<PathBuf>>,
    github_broker: GitHubBroker,
}

impl Default for DesktopState {
    fn default() -> Self {
        Self {
            // Fail closed until the bundled engine sidecar has completed its
            // readiness handshake. The UI must never present placeholder commands
            // as a healthy production runtime.
            runtime: RwLock::new(RuntimeMode::OfflineReadOnly),
            codex_authenticated: RwLock::new(None),
            onboarding_complete: RwLock::new(false),
            ingestion_paused: RwLock::new(false),
            // The native publication drainer is the only writer that runs
            // without a user action, so it must stay closed until bootstrap has
            // rehydrated the engine-owned automation flag. A `false` default let
            // the drainer push real GitHub commits before the desktop had read
            // any persisted automation state.
            publishing_paused: RwLock::new(true),
            editorial_mutations: RwLock::new(Vec::new()),
            preferences: RwLock::new(json!({
                "author": "OPE Editorya",
                "reviewer": "Editör",
                "notifications": true,
                "emailDigest": false,
                "defaultSection": "haberler",
                "showSourceReferences": true
            })),
            local_dev_process: RwLock::new(None),
            folder_grants: RwLock::new(Vec::new()),
            github_broker: GitHubBroker::new(),
        }
    }
}

fn is_path_within_grant(candidate: &Path, grants: &[PathBuf]) -> bool {
    grants.iter().any(|grant| candidate.starts_with(grant))
}

fn register_folder_grant(state: &DesktopState, raw: &str) -> Result<PathBuf, CommandError> {
    let canonical = std::fs::canonicalize(raw)
        .map_err(|_| CommandError::InvalidInput("seçilen klasör doğrulanamadı".into()))?;
    if !canonical.is_dir() {
        return Err(CommandError::InvalidInput(
            "seçilen yol bir klasör değil".into(),
        ));
    }
    let mut grants = write_lock(&state.folder_grants)?;
    if !grants.contains(&canonical) {
        grants.push(canonical.clone());
    }
    Ok(canonical)
}

fn require_granted_directory(state: &DesktopState, raw: &str) -> Result<PathBuf, CommandError> {
    let canonical = std::fs::canonicalize(raw)
        .map_err(|_| CommandError::InvalidInput("klasör bulunamadı".into()))?;
    let grants = state
        .folder_grants
        .read()
        .map_err(|_| CommandError::StateUnavailable)?;
    if !canonical.is_dir() || !is_path_within_grant(&canonical, &grants) {
        return Err(CommandError::InvalidInput(
            "bu klasör önce Windows klasör seçicisiyle yetkilendirilmelidir".into(),
        ));
    }
    Ok(canonical)
}

fn authorize_connector_directory(
    state: &DesktopState,
    connector: &str,
    config: &mut Value,
) -> Result<(), CommandError> {
    let field = match connector {
        "site" => "repositoryPath",
        "backup" => "folder",
        _ => return Ok(()),
    };
    let raw = config
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default();
    let granted = require_granted_directory(state, raw)?;
    let object = config.as_object_mut().ok_or_else(|| {
        CommandError::InvalidInput("setup connector config must be an object".into())
    })?;
    object.insert(
        field.to_string(),
        json!(granted.to_string_lossy().into_owned()),
    );
    Ok(())
}

fn require_granted_restore_target(
    state: &DesktopState,
    raw: &str,
) -> Result<PathBuf, CommandError> {
    let requested = PathBuf::from(raw.trim());
    if !requested.is_absolute() || requested.exists() {
        return Err(CommandError::InvalidInput(
            "geri yükleme hedefi, seçilen klasör altında henüz var olmayan yeni bir klasör olmalıdır".into(),
        ));
    }
    let name = requested
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty() && *value != "." && *value != "..")
        .ok_or_else(|| CommandError::InvalidInput("geri yükleme klasörü adı geçersiz".into()))?;
    if name
        .chars()
        .any(|value| matches!(value, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
    {
        return Err(CommandError::InvalidInput(
            "geri yükleme klasörü adı güvenli değil".into(),
        ));
    }
    let parent = requested
        .parent()
        .ok_or_else(|| CommandError::InvalidInput("geri yükleme üst klasörü eksik".into()))?;
    let granted_parent = require_granted_directory(state, parent.to_string_lossy().as_ref())?;
    let candidate = granted_parent.join(name);
    if candidate.exists() {
        return Err(CommandError::InvalidInput(
            "geri yükleme hedefi zaten var".into(),
        ));
    }
    Ok(candidate)
}

fn require_granted_existing_file(state: &DesktopState, raw: &str) -> Result<PathBuf, CommandError> {
    let canonical = std::fs::canonicalize(raw)
        .map_err(|_| CommandError::InvalidInput("dosya bulunamadı".into()))?;
    let grants = state
        .folder_grants
        .read()
        .map_err(|_| CommandError::StateUnavailable)?;
    if !canonical.is_file() || !is_path_within_grant(&canonical, &grants) {
        return Err(CommandError::InvalidInput(
            "bu dosyanın klasörü önce Windows klasör seçicisiyle yetkilendirilmelidir".into(),
        ));
    }
    Ok(canonical)
}

fn require_granted_output_file(state: &DesktopState, raw: &str) -> Result<PathBuf, CommandError> {
    let requested = PathBuf::from(raw.trim());
    let file_name = requested
        .file_name()
        .ok_or_else(|| CommandError::InvalidInput("yedek çıktı dosyasının adı eksik".into()))?;
    let parent = requested
        .parent()
        .ok_or_else(|| CommandError::InvalidInput("yedek çıktı klasörü eksik".into()))?;
    let canonical_parent = std::fs::canonicalize(parent)
        .map_err(|_| CommandError::InvalidInput("yedek çıktı klasörü bulunamadı".into()))?;
    let candidate = canonical_parent.join(file_name);
    let grants = state
        .folder_grants
        .read()
        .map_err(|_| CommandError::StateUnavailable)?;
    if !is_path_within_grant(&candidate, &grants) {
        return Err(CommandError::InvalidInput(
            "yedek çıktı klasörü önce Windows klasör seçicisiyle yetkilendirilmelidir".into(),
        ));
    }
    Ok(candidate)
}

impl Drop for DesktopState {
    fn drop(&mut self) {
        let _ = stop_local_dev_process(&self.local_dev_process);
    }
}

#[derive(Debug, Error)]
pub enum CommandError {
    #[error("OFFLINE_READ_ONLY: encrypted offline cache cannot be mutated")]
    OfflineReadOnly,
    #[error("ENGINE_DEGRADED: local engine is not ready for mutations")]
    ConnectionNotAuthenticated,
    #[error("ENGINE_UNAVAILABLE: {0}")]
    EngineUnavailable(String),
    #[error("INVALID_INPUT: {0}")]
    InvalidInput(String),
    #[error("STATE_UNAVAILABLE")]
    StateUnavailable,
    #[error("UPDATE_UNAVAILABLE: {0}")]
    UpdateUnavailable(String),
}

impl Serialize for CommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingSettings {
    device_name: String,
    mode: String,
    scan_interval_minutes: u16,
    acknowledge_approval_boundary: bool,
    autostart_enabled: bool,
}

fn read_lock<T>(lock: &RwLock<T>) -> Result<std::sync::RwLockReadGuard<'_, T>, CommandError> {
    lock.read().map_err(|_| CommandError::StateUnavailable)
}

fn write_lock<T>(lock: &RwLock<T>) -> Result<std::sync::RwLockWriteGuard<'_, T>, CommandError> {
    lock.write().map_err(|_| CommandError::StateUnavailable)
}

fn ensure_mutation_allowed(state: &DesktopState) -> Result<(), CommandError> {
    match *read_lock(&state.runtime)? {
        RuntimeMode::OfflineReadOnly => Err(CommandError::OfflineReadOnly),
        RuntimeMode::Degraded => Err(CommandError::ConnectionNotAuthenticated),
        RuntimeMode::Online => Ok(()),
    }
}

pub fn set_engine_ready(state: &DesktopState, ready: bool) {
    if let Ok(mut runtime) = state.runtime.write() {
        *runtime = if ready {
            RuntimeMode::Online
        } else {
            RuntimeMode::OfflineReadOnly
        };
    }
}

fn is_http_url(value: &str) -> bool {
    value.starts_with("https://")
}

#[tauri::command(async)]
pub fn open_project_page() -> Result<Value, CommandError> {
    // A WebView hyperlink cannot reliably create an external browser window
    // under this app's restrictive capability set. Keep the target fixed and
    // launch it through Windows without exposing an arbitrary URL command.
    let mut command = Command::new("explorer.exe");
    configure_hidden_command(&mut command);
    command.arg(PROJECT_PAGE_URL).spawn().map_err(|error| {
        CommandError::EngineUnavailable(format!("PROJECT_PAGE_OPEN_FAILED: {error}"))
    })?;
    Ok(json!({ "opened": true }))
}

fn decode_xml_attribute(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

/// Extracts public feed/site URLs from OPML without executing or fully parsing
/// the document as HTML. Invalid, credentialed, or non-HTTPS values are
/// discarded; the caller still performs the normal source test before saving.
fn parse_opml_urls(input: &str) -> Result<Vec<String>, CommandError> {
    if input.trim().is_empty() {
        return Err(CommandError::InvalidInput("OPML içeriği boş olamaz".into()));
    }
    let mut urls = std::collections::BTreeSet::new();
    for fragment in input.split('<').filter_map(|part| part.split_once('>')) {
        let tag = fragment.0;
        if !tag.trim_start().to_ascii_lowercase().starts_with("outline") {
            continue;
        }
        for attribute in ["xmlurl", "htmlurl"] {
            let lower = tag.to_ascii_lowercase();
            let Some(start) = lower.find(attribute) else {
                continue;
            };
            let after = &tag[start + attribute.len()..];
            let Some((_, quoted)) = after.split_once('=') else {
                continue;
            };
            let quoted = quoted.trim_start();
            let Some(quote) = quoted.chars().next() else {
                continue;
            };
            if quote != '"' && quote != '\'' {
                continue;
            }
            let value = &quoted[quote.len_utf8()..];
            let Some(end) = value.find(quote) else {
                continue;
            };
            let normalized = decode_xml_attribute(&value[..end]).trim().to_string();
            if is_http_url(&normalized) && !normalized.contains('@') {
                urls.insert(normalized);
            }
        }
    }
    Ok(urls.into_iter().collect())
}

fn engine_request(bridge: &EngineBridge, request: Value) -> Result<Value, CommandError> {
    let response = bridge
        .request(request)
        .map_err(CommandError::EngineUnavailable)?;
    if response.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(response);
    }
    let message = response
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| {
            response
                .pointer("/result/error/message")
                .and_then(Value::as_str)
        })
        .unwrap_or("ENGINE_REQUEST_FAILED");
    // A reused idempotency key means the engine already owns a decision for this
    // logical request; the caller must refresh instead of reading it as a
    // transport fault. Surfacing the raw engine sentence made a duplicate click
    // look like an unavailable engine.
    if message.contains("IDEMPOTENCY_KEY_REUSED")
        || message.contains("Idempotency key was already used")
    {
        return Err(CommandError::EngineUnavailable(
            "REQUEST_ALREADY_APPLIED".into(),
        ));
    }
    Err(CommandError::EngineUnavailable(message.to_string()))
}

fn read_engine_local_state(bridge: &EngineBridge, key: &str) -> Option<Value> {
    read_engine_local_state_result(bridge, key).ok().flatten()
}

fn retry_version_conflicted_draft<R, A>(
    mut read_version: R,
    mut attempt: A,
) -> Result<Value, CommandError>
where
    R: FnMut() -> Result<u64, CommandError>,
    A: FnMut(u64) -> Result<Value, CommandError>,
{
    let first_version = read_version()?;
    match attempt(first_version) {
        Err(CommandError::EngineUnavailable(message))
            if message.starts_with("VERSION_CONFLICT:") =>
        {
            attempt(read_version()?)
        }
        result => result,
    }
}

fn doctor_runtime_mode(doctor: Option<&Value>) -> RuntimeMode {
    let ready = doctor.is_some_and(|value| {
        value.get("status").and_then(Value::as_str) == Some("READY")
            && value.get("queue").and_then(Value::as_str) == Some("ready")
    });
    if ready {
        RuntimeMode::Online
    } else {
        RuntimeMode::OfflineReadOnly
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HighRiskApprovalRequest {
    revision_id: String,
    expected_hash: String,
    warning_set_hash: String,
    confirm_reauthenticated: bool,
}

fn read_engine_local_state_result(
    bridge: &EngineBridge,
    key: &str,
) -> Result<Option<Value>, CommandError> {
    engine_request(
        bridge,
        json!({
            "version": 1,
            "id": format!("desktop-local-state-read-{key}"),
            "kind": "local.state.get",
            "key": key
        }),
    )
    .map(|response| {
        response
            .get("value")
            .cloned()
            .filter(|value| !value.is_null())
    })
}

/// Runs one compare-and-set write, re-reading and re-applying the mutation on
/// every attempt. Resending the value that was computed before a
/// VERSION_CONFLICT overwrites whatever the conflicting writer committed, so the
/// read has to live inside the retried attempt rather than outside it.
fn local_state_write<R, V, M, S>(
    read_version: R,
    mut read_value: V,
    mut mutate: M,
    mut send: S,
) -> Result<Value, CommandError>
where
    R: FnMut() -> Result<u64, CommandError>,
    V: FnMut() -> Value,
    M: FnMut(&mut Value) -> Result<(), CommandError>,
    S: FnMut(u64, Value) -> Result<Value, CommandError>,
{
    retry_version_conflicted_draft(read_version, |version| {
        let mut value = read_value();
        mutate(&mut value)?;
        send(version, value)
    })
}

fn send_engine_local_state(
    bridge: &EngineBridge,
    key: &str,
    version: u64,
    value: Value,
) -> Result<Value, CommandError> {
    let request_id = stable_source_key(&format!("local-state:{key}:{version}"));
    engine_request(
        bridge,
        json!({
            "version": 1,
            "id": request_id,
            "kind": "command",
            "command": {
                "version": 1,
                "requestId": request_id,
                "idempotencyKey": request_id,
                "expectedVersion": version,
                "kind": "LOCAL_STATE.SET",
                "payload": { "key": key, "value": value }
            }
        }),
    )
}

fn write_engine_local_state(
    bridge: &EngineBridge,
    key: &str,
    value: Value,
) -> Result<Value, CommandError> {
    local_state_write(
        || {
            read_engine_state(bridge)?
                .pointer("/snapshot/serverCursor")
                .and_then(Value::as_u64)
                .ok_or_else(|| CommandError::EngineUnavailable("STATE_VERSION_MISSING".into()))
        },
        Value::default,
        |current| {
            *current = value.clone();
            Ok(())
        },
        |version, value| send_engine_local_state(bridge, key, version, value),
    )
}

/// Applies `mutate` to the currently stored document instead of to a snapshot
/// the caller read earlier, so a retried attempt appends to the freshly read
/// state.
fn mutate_engine_local_state<M>(
    bridge: &EngineBridge,
    key: &str,
    mut mutate: M,
) -> Result<Value, CommandError>
where
    M: FnMut(&mut Value) -> Result<(), CommandError>,
{
    local_state_write(
        || {
            read_engine_state(bridge)?
                .pointer("/snapshot/serverCursor")
                .and_then(Value::as_u64)
                .ok_or_else(|| CommandError::EngineUnavailable("STATE_VERSION_MISSING".into()))
        },
        || read_engine_local_state(bridge, key).unwrap_or_else(|| json!({})),
        |current| mutate(current),
        |version, value| send_engine_local_state(bridge, key, version, value),
    )
}

/// `desktop.editorial` is one local-state document and the engine rejects any
/// value over 256 000 units (`LOCAL_STATE_TOO_LARGE`). The mutation log was
/// append-only, so a normally used workspace eventually crossed that limit and
/// every later candidate, schedule and preference mutation failed permanently.
const MAX_EDITORIAL_MUTATIONS: usize = 400;
/// Byte budget kept comfortably under the engine limit. Rust measures UTF-8
/// bytes while the engine measures UTF-16 units, and UTF-8 is never smaller for
/// this content, so staying under this bound also stays under the engine's.
const MAX_EDITORIAL_STATE_BYTES: usize = 192 * 1024;

/// Drops the oldest mutations until the document is both short enough and small
/// enough. Only the newest mutation per candidate decides candidate workflow
/// state (`candidate_workflow_state`), and the operations feed shows recent
/// activity, so trimming the oldest entries preserves both readers.
fn bound_editorial_state(object: &mut serde_json::Map<String, Value>) {
    if let Some(mutations) = object.get_mut("mutations").and_then(Value::as_array_mut) {
        if mutations.len() > MAX_EDITORIAL_MUTATIONS {
            let excess = mutations.len() - MAX_EDITORIAL_MUTATIONS;
            mutations.drain(0..excess);
        }
    }
    loop {
        let size = serde_json::to_string(&Value::Object(object.clone()))
            .map(|encoded| encoded.len())
            .unwrap_or(0);
        if size <= MAX_EDITORIAL_STATE_BYTES {
            return;
        }
        let Some(mutations) = object.get_mut("mutations").and_then(Value::as_array_mut) else {
            return;
        };
        if mutations.is_empty() {
            // Nothing left to trim: the remaining fields are already oversized,
            // and the engine's own limit stays the final guard.
            return;
        }
        let drop = (mutations.len() / 4).max(1);
        mutations.drain(0..drop);
    }
}

fn persist_editorial_state(
    bridge: &EngineBridge,
    mutation: Value,
    field: Option<(&str, Value)>,
) -> Result<Value, CommandError> {
    mutate_engine_local_state(bridge, "desktop.editorial", |state| {
        let object = state
            .as_object_mut()
            .ok_or_else(|| CommandError::EngineUnavailable("EDITORIAL_STATE_INVALID".into()))?;
        let mutations = object
            .entry("mutations")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or_else(|| CommandError::EngineUnavailable("EDITORIAL_MUTATIONS_INVALID".into()))?;
        mutations.push(mutation.clone());
        if let Some((key, value)) = field.clone() {
            object.insert(key.to_string(), value);
        }
        bound_editorial_state(object);
        Ok(())
    })
}

fn read_engine_state(bridge: &EngineBridge) -> Result<Value, CommandError> {
    bridge
        .request(json!({
            "version": 1,
            "id": "desktop-state",
            "kind": "state",
            "afterCursor": 0,
            "changeLimit": 50
        }))
        .map_err(CommandError::EngineUnavailable)
}

fn engine_automation(state_response: &Value) -> Result<Value, CommandError> {
    state_response
        .pointer("/snapshot/automation")
        .cloned()
        .ok_or_else(|| CommandError::EngineUnavailable("STATE_SHAPE_INVALID".into()))
}

fn apply_automation_settings(
    bridge: &EngineBridge,
    expected_version: u64,
    settings: Value,
) -> Result<Value, CommandError> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let request_id = format!("desktop-{}-{nonce}", std::process::id());
    let response = bridge
        .request(json!({
            "version": 1,
            "id": request_id,
            "kind": "command",
            "command": {
                "version": 1,
                "requestId": request_id,
                "idempotencyKey": request_id,
                "expectedVersion": expected_version,
                "kind": "AUTOMATION.SET",
                "payload": { "settings": settings }
            }
        }))
        .map_err(CommandError::EngineUnavailable)?;
    if response.get("ok").and_then(Value::as_bool) != Some(true)
        || response.pointer("/result/ok").and_then(Value::as_bool) != Some(true)
    {
        return Err(CommandError::EngineUnavailable(
            response
                .pointer("/result/error/message")
                .and_then(Value::as_str)
                .unwrap_or("ENGINE_COMMAND_FAILED")
                .to_string(),
        ));
    }
    Ok(response)
}

#[tauri::command(async)]
pub fn test_local_engine(
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    let started_at = Instant::now();
    let doctor = bridge.doctor().map_err(CommandError::EngineUnavailable)?;
    let ready = doctor
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| status == "READY");
    *write_lock(&state.runtime)? = if ready {
        RuntimeMode::Online
    } else {
        RuntimeMode::OfflineReadOnly
    };
    Ok(json!({
        "ready": ready,
        "component": "local-engine",
        "latencyMs": started_at.elapsed().as_millis(),
        "detail": if ready {
            "Paketlenmiş yerel engine, PGlite veritabanı ve kalıcı iş kuyruğu hazır."
        } else {
            "Yerel engine başlatılamadı. Doctor ayrıntılarını açıp kurulum bileşenlerini doğrulayın."
        },
        "doctor": doctor
    }))
}

#[tauri::command(async)]
pub fn recover_local_workspace(
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    // A response timeout is not evidence that the encrypted PGlite tree is
    // corrupt. Moving it would turn an availability incident into a silent
    // empty-workspace data-loss incident. Destructive adoption is reserved
    // for a future, explicit corruption verifier.
    let can_recover = bridge
        .last_error()
        .is_some_and(|error| error.contains("ENGINE_DATA_CORRUPTION_CONFIRMED"));
    if !can_recover {
        return Err(CommandError::InvalidInput(
            "Zaman aşımı veri bozulması kanıtı değildir; yerel çalışma alanı taşınmadı. Uygulamayı yeniden başlatın ve tanılama paketi oluşturun.".into(),
        ));
    }

    bridge.stop();
    let root = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| CommandError::EngineUnavailable("LOCALAPPDATA bulunamadı".into()))?
        .join("Blogbot");
    let data_directory = root.join("data").join("pgdata");
    if data_directory.exists() {
        let recovery_root = root.join("recovery");
        std::fs::create_dir_all(&recovery_root).map_err(|error| {
            CommandError::EngineUnavailable(format!("Kurtarma klasörü açılamadı: {error}"))
        })?;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let staged = recovery_root.join(format!("pgdata-{stamp}"));
        std::fs::rename(&data_directory, staged).map_err(|error| {
            CommandError::EngineUnavailable(format!(
                "Yerel çalışma alanı güvenle taşınamadı: {error}"
            ))
        })?;
    }

    let doctor = bridge.doctor().map_err(CommandError::EngineUnavailable)?;
    let ready = doctor.get("status").and_then(Value::as_str) == Some("READY");
    *write_lock(&state.runtime)? = if ready {
        RuntimeMode::Online
    } else {
        RuntimeMode::OfflineReadOnly
    };
    Ok(json!({
        "ready": ready,
        "detail": if ready {
            "Yeni yerel çalışma alanı hazır. Önceki çalışma alanı silinmedi; yalnız kurtarma alanına taşındı."
        } else {
            "Yeni yerel çalışma alanı başlatılamadı. Tanılama paketini oluşturup destek ekibiyle paylaşın."
        }
    }))
}

/// Opens the operating system's folder picker. No arbitrary filesystem path
/// is accepted from the WebView: the returned value is produced by the native
/// dialog and is validated before it is handed to the UI.
#[cfg(windows)]
fn run_folder_picker_on_sta<T, F>(task: F) -> Result<T, CommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, CommandError> + Send + 'static,
{
    let worker = std::thread::Builder::new()
        .name("blogbot-folder-picker".into())
        .spawn(move || {
            use windows::Win32::System::Com::{
                CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
            };

            // SAFETY: this dedicated worker has not initialized COM yet. The
            // matching guard keeps the apartment alive for the complete shell
            // dialog call and balances every successful initialization.
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
                .ok()
                .map_err(|_| CommandError::StateUnavailable)?;
            struct ComApartmentGuard;
            impl Drop for ComApartmentGuard {
                fn drop(&mut self) {
                    // SAFETY: the guard is created only after CoInitializeEx
                    // succeeds and is dropped on that same dedicated thread.
                    unsafe { CoUninitialize() };
                }
            }
            let _apartment = ComApartmentGuard;
            task()
        })
        .map_err(|_| CommandError::StateUnavailable)?;
    worker.join().map_err(|_| CommandError::StateUnavailable)?
}

#[tauri::command(async)]
pub fn pick_local_folder(
    state: tauri::State<'_, DesktopState>,
) -> Result<Option<String>, CommandError> {
    #[cfg(windows)]
    {
        let selected = run_folder_picker_on_sta(|| {
            use windows::core::{PCWSTR, PWSTR};
            use windows::Win32::Foundation::HWND;
            use windows::Win32::System::Com::CoTaskMemFree;
            use windows::Win32::UI::Shell::{
                SHBrowseForFolderW, SHGetPathFromIDListW, BIF_NEWDIALOGSTYLE,
                BIF_RETURNONLYFSDIRS, BROWSEINFOW,
            };

            let title: Vec<u16> = "OPE için bir proje klasörü seçin"
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let mut display_name = [0u16; 260];
            let info = BROWSEINFOW {
                hwndOwner: HWND(std::ptr::null_mut()),
                pszDisplayName: PWSTR(display_name.as_mut_ptr()),
                lpszTitle: PCWSTR(title.as_ptr()),
                ulFlags: BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE,
                ..Default::default()
            };
            // SAFETY: `info` points to stack-owned, NUL-terminated buffers that
            // remain alive for the duration of the synchronous native call.
            let pidl = unsafe { SHBrowseForFolderW(&info) };
            if pidl.is_null() {
                return Ok(None);
            }
            let mut path = [0u16; 260];
            // SAFETY: `pidl` is owned by the shell and `path` is a writable
            // MAX_PATH buffer as required by SHGetPathFromIDListW.
            let found = unsafe { SHGetPathFromIDListW(pidl, &mut path).as_bool() };
            // SAFETY: shell allocates the PIDL with the task allocator.
            unsafe { CoTaskMemFree(Some(pidl.cast())) };
            if !found {
                return Err(CommandError::InvalidInput(
                    "seçilen klasörün yolu okunamadı".into(),
                ));
            }
            let end = path
                .iter()
                .position(|value| *value == 0)
                .unwrap_or(path.len());
            let selected = String::from_utf16_lossy(&path[..end]);
            Ok(Some(selected))
        })?;
        let Some(selected) = selected else {
            return Ok(None);
        };
        validate_folder_selection(&selected)?;
        let granted = register_folder_grant(&state, &selected)?;
        Ok(Some(granted.to_string_lossy().into_owned()))
    }

    #[cfg(not(windows))]
    {
        Err(CommandError::InvalidInput(
            "yerel klasör seçici yalnızca Windows çalışma zamanında kullanılabilir".into(),
        ))
    }
}

/// Validation still touches the filesystem (site format, content model, git
/// remote), so it may only ever inspect a folder the user picked through the
/// native dialog. Without the grant check the WebView could probe any path on
/// disk and read back the project's configured GitHub remote.
#[tauri::command(async)]
pub fn test_setup_connector(
    connector: String,
    config: Value,
    state: tauri::State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    test_setup_connector_with_grants(&state, connector, config)
}

fn test_setup_connector_with_grants(
    state: &DesktopState,
    connector: String,
    config: Value,
) -> Result<Value, CommandError> {
    let allowed = ["codex", "github", "site", "deploy", "backup"];
    if !allowed.contains(&connector.as_str()) {
        return Err(CommandError::InvalidInput("unknown setup connector".into()));
    }
    let object = config.as_object().ok_or_else(|| {
        CommandError::InvalidInput("setup connector config must be an object".into())
    })?;
    let allowed_fields: &[&str] = match connector.as_str() {
        "codex" => &["accountLabel"],
        "github" => &["owner", "repository", "clientId"],
        "site" => &["repositoryPath", "publicSiteUrl", "mode"],
        "deploy" => &["workflowName", "requiredChecks"],
        "backup" => &["folder"],
        _ => &[],
    };
    if object
        .keys()
        .any(|key| !allowed_fields.contains(&key.as_str()))
    {
        return Err(CommandError::InvalidInput(
            "unknown setup connector field".into(),
        ));
    }
    let serialized = serde_json::to_string(&config)
        .map_err(|error| CommandError::InvalidInput(error.to_string()))?
        .to_ascii_lowercase();
    for forbidden in [
        "token",
        "password",
        "privatekey",
        "private_key",
        "secret",
        "credential",
    ] {
        if serialized.contains(forbidden) {
            return Err(CommandError::InvalidInput(
                "secret or credential fields are not accepted by setup".into(),
            ));
        }
    }
    let text = |key: &str| config.get(key).and_then(Value::as_str).map(str::trim);
    let site_mode = text("mode").unwrap_or("LOCAL_ONLY");
    let missing = match connector.as_str() {
        "codex" => text("accountLabel")
            .map(|value| value.is_empty())
            .unwrap_or(true),
        "github" => ["owner", "repository", "clientId"]
            .iter()
            .any(|key| text(key).map(|value| value.is_empty()).unwrap_or(true)),
        "site" => text("repositoryPath")
            .map(|value| value.is_empty())
            .unwrap_or(true),
        "deploy" => {
            text("workflowName")
                .map(|value| value.is_empty())
                .unwrap_or(true)
                || !valid_required_github_checks(config.get("requiredChecks"))
        }
        "backup" => text("folder").map(|value| value.is_empty()).unwrap_or(true),
        _ => true,
    };
    if missing {
        return Ok(json!({
            "connector": connector,
            "ready": false,
            "state": "ATTENTION",
            "detail": "Gerekli gizli olmayan alanları doldurun."
        }));
    }
    // `save_setup_connector` refuses an ungranted folder; validation must not be
    // the weaker door into the same paths, because the checks below stat the
    // directory, read package.json and return the configured git remote.
    match connector.as_str() {
        "site" => {
            require_granted_directory(state, text("repositoryPath").unwrap_or_default())?;
        }
        "backup" => {
            require_granted_directory(state, text("folder").unwrap_or_default())?;
        }
        _ => {}
    }
    let semantic_error = match connector.as_str() {
        "github" => {
            let owner = text("owner").unwrap_or_default();
            let repository = text("repository").unwrap_or_default();
            let client_id = text("clientId").unwrap_or_default();
            (!valid_github_segment(owner)
                || !valid_github_segment(repository)
                || crate::github_broker::validate_client_id(client_id).is_err())
            .then_some("GitHub sahibi, depo adı veya OAuth clientId alanı güvenli değil.")
        }
        "site" => {
            let path = text("repositoryPath").unwrap_or_default();
            let site = text("publicSiteUrl").unwrap_or_default();
            let mode = text("mode").unwrap_or("LOCAL_ONLY");
            if !valid_site_work_mode(mode) {
                return Ok(
                    json!({"connector": connector, "ready": false, "state": "ATTENTION", "detail": "Çalışma biçimi LOCAL_ONLY, LOCAL_DEV veya PUBLISH olmalı."}),
                );
            }
            if mode == "PUBLISH" && site.is_empty() {
                return Ok(
                    json!({"connector": connector, "ready": false, "state": "ATTENTION", "detail": "Yayın biçiminde public adres gerekir; yerel biçimlerde boş bırakılabilir."}),
                );
            }
            let valid_public_url =
                site.is_empty() || (site.starts_with("https://") && site.len() <= 2048);
            if !is_local_path(path) || !Path::new(path).is_dir() || !valid_public_url {
                Some("Site klasörü mevcut bir yerel klasör olmalı. Public adres yayın aşamasında eklenebilir ve https:// ile başlamalıdır.")
            } else if mode == "LOCAL_ONLY" {
                None
            } else if mode == "LOCAL_DEV" {
                if validate_local_dev_project(path).is_err() {
                    Some("Yerel geliştirme biçimi için package.json içinde çalışır bir scripts.dev komutu gerekir.")
                } else {
                    None
                }
            } else {
                match site_adapter_dry_run(path) {
                    Ok(_) => None,
                    Err(_detail) if site.is_empty() => None,
                    Err(detail) => Some(detail),
                }
            }
        }
        "deploy" => {
            let workflow_invalid = !text("workflowName")
                .unwrap_or_default()
                .chars()
                .all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | '.'));
            if workflow_invalid {
                Some("Workflow adı yalnız harf, sayı, tire, alt çizgi ve nokta içerebilir.")
            } else if !valid_required_github_checks(config.get("requiredChecks")) {
                Some("PUBLISH için en az bir benzersiz ve geçerli zorunlu GitHub kontrolü gerekir.")
            } else {
                None
            }
        }
        "backup" => (!is_local_path(text("folder").unwrap_or_default()))
            .then_some("Yedek klasörü yerel ve mutlak bir yol olmalı."),
        _ => None,
    };
    if let Some(detail) = semantic_error {
        return Ok(
            json!({ "connector": connector, "ready": false, "state": "ATTENTION", "detail": detail }),
        );
    }
    let adapter_dry_run = if connector == "site" && site_mode == "PUBLISH" {
        let path = text("repositoryPath").unwrap_or_default();
        Some(match site_adapter_dry_run(path) {
            Ok(value) => value,
            Err(detail) => json!({
                "ok": false,
                "adapterId": "unrecognized",
                "adapterVersion": "0",
                "filesInspected": [],
                "writes": false,
                "network": false,
                "warning": detail
            }),
        })
    } else {
        None
    };
    let local_only = connector == "site" && site_mode != "PUBLISH";
    let adapter_ready = adapter_dry_run
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|value| value.get("ok"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    Ok(json!({
        "connector": connector,
        "ready": true,
        "state": "DRY_RUN_READY",
        "authorizationState": "NOT_CHECKED",
        "contentModel": if connector == "site" { detect_site_content_model(text("repositoryPath").unwrap_or_default()) } else { "N/A" },
        "siteFormat": if connector == "site" { detect_site_format(text("repositoryPath").unwrap_or_default()).unwrap_or("UNKNOWN") } else { "N/A" },
        "repositorySuggestion": if connector == "site" { detect_repository_remote(text("repositoryPath").unwrap_or_default()) } else { None::<String> },
        "adapterDryRun": adapter_dry_run,
        "localOnly": local_only,
        "mode": site_mode,
        "detail": if local_only && !adapter_ready {
            "Yerel proje kaydedilebilir; bu proje için yayın adaptörü bulunamadı. Taslak ve editör kullanılabilir, yayın için adaptör gerekir."
        } else if local_only {
            "Yerel site projesi doğrulandı; public adres ve yayın bağlantısı daha sonra eklenebilir."
        } else {
            "Girdi biçimi doğrulandı; dış bağlantı kurulmadı ve hiçbir credential kaydedilmedi. Gerçek yetkilendirme yayın öncesi ayrı bir adımda yapılır."
        }
    }))
}

fn valid_github_workflow(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && !value.contains("..")
        && (value.ends_with(".yml") || value.ends_with(".yaml"))
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/'))
        && !value.starts_with('/')
        && !value.contains("//")
}

fn valid_required_github_checks(value: Option<&Value>) -> bool {
    let Some(checks) = value.and_then(Value::as_array) else {
        return false;
    };
    if checks.is_empty() || checks.len() > 100 {
        return false;
    }
    let mut unique = std::collections::HashSet::new();
    checks.iter().all(|check| {
        let Some(name) = check.as_str().map(str::trim) else {
            return false;
        };
        !name.is_empty()
            && name.len() <= 200
            && !name.chars().any(char::is_control)
            && unique.insert(name)
    })
}

fn valid_site_work_mode(value: &str) -> bool {
    matches!(value, "LOCAL_ONLY" | "LOCAL_DEV" | "PUBLISH")
}

fn github_preview_payload(
    repository: &str,
    workflow: &str,
    revision_id: &str,
    revision_hash: &str,
) -> Result<Value, CommandError> {
    let mut segments = repository.split('/');
    let owner = segments.next().unwrap_or_default();
    let repo = segments.next().unwrap_or_default();
    if segments.next().is_some() || !valid_github_segment(owner) || !valid_github_segment(repo) {
        return Err(CommandError::InvalidInput(
            "GitHub repository must be owner/name".into(),
        ));
    }
    if !valid_github_workflow(workflow)
        || revision_id.trim().is_empty()
        || revision_hash.len() != 64
        || !revision_hash.chars().all(|ch| ch.is_ascii_hexdigit())
    {
        return Err(CommandError::InvalidInput(
            "GitHub preview intent scope is invalid".into(),
        ));
    }
    Ok(json!({
        "mode": "dry-run",
        "writes": false,
        "network": false,
        "repository": format!("{owner}/{repo}"),
        "workflow": workflow,
        "revisionId": revision_id,
        "revisionHash": revision_hash,
        "steps": ["validate-scope", "preview-pull-request", "record-intent"]
    }))
}

fn github_token_path(app: &tauri::AppHandle) -> Result<PathBuf, CommandError> {
    app.path()
        .app_local_data_dir()
        .map_err(|_| CommandError::StateUnavailable)
        .map(|directory| {
            directory
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or(directory)
                .join("Blogbot")
                .join("secrets")
                .join("github-token.dpapi")
        })
}

fn github_client_id(bridge: &EngineBridge) -> Result<String, CommandError> {
    let connectors = read_engine_local_state_result(bridge, "desktop.connectors")?
        .ok_or_else(|| CommandError::InvalidInput("GitHub connector is not configured".into()))?;
    let client_id = connectors
        .pointer("/github/clientId")
        .and_then(Value::as_str)
        .ok_or_else(|| CommandError::InvalidInput("GitHub clientId is not configured".into()))?;
    crate::github_broker::validate_client_id(client_id).map_err(CommandError::InvalidInput)
}

#[tauri::command(async)]
pub fn github_device_flow_start(
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    let client_id = github_client_id(&bridge)?;
    let result = state
        .github_broker
        .begin_device_authorization(&client_id)
        .map_err(CommandError::EngineUnavailable)?;
    serde_json::to_value(result).map_err(|_| CommandError::StateUnavailable)
}

#[tauri::command(async)]
pub fn github_device_flow_poll(
    state: tauri::State<'_, DesktopState>,
    app: tauri::AppHandle,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    let result = state
        .github_broker
        .poll_device_authorization(&github_token_path(&app)?)
        .map_err(CommandError::EngineUnavailable)?;
    serde_json::to_value(result).map_err(|_| CommandError::StateUnavailable)
}

#[tauri::command(async)]
pub fn github_device_flow_clear(
    state: tauri::State<'_, DesktopState>,
    app: tauri::AppHandle,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    let result = state
        .github_broker
        .clear_authorization(&github_token_path(&app)?)
        .map_err(CommandError::EngineUnavailable)?;
    serde_json::to_value(result).map_err(|_| CommandError::StateUnavailable)
}

#[tauri::command(async)]
pub fn github_device_flow_status(
    state: tauri::State<'_, DesktopState>,
    app: tauri::AppHandle,
) -> Result<Value, CommandError> {
    serde_json::to_value(
        state
            .github_broker
            .status(github_token_path(&app).ok().as_deref()),
    )
    .map_err(|_| CommandError::StateUnavailable)
}

#[tauri::command(async)]
pub fn github_validate_repository(
    owner: String,
    repository: String,
    workflow: String,
) -> Result<Value, CommandError> {
    let owner = owner.trim();
    let repository = repository.trim();
    let workflow = workflow.trim();
    if !valid_github_segment(owner)
        || !valid_github_segment(repository)
        || !valid_github_workflow(workflow)
    {
        return Ok(
            json!({ "valid": false, "repository": format!("{owner}/{repository}"), "workflow": workflow, "writes": false, "detail": "GitHub depo veya workflow adı güvenli değil." }),
        );
    }
    Ok(
        json!({ "valid": true, "repository": format!("{owner}/{repository}"), "workflow": workflow, "writes": false, "network": false }),
    )
}

/// Captures the base-branch tip so a PUBLISH-mode revision can be approved.
///
/// `github_validate_repository` only checks the name grammar and never touches
/// the network, so no code path ever learned a base SHA. Approval binds
/// `targetBaseSha`, so without it the `publication-target` gate stayed NOT_RUN
/// and PUBLISH mode was unreachable. This is an explicit, user-triggered read:
/// it fails closed when GitHub is not authorized and writes only the verified
/// GitHub connector fields into encrypted local state.
/// Branch names are interpolated into GitHub API paths, so the grammar stays
/// deliberately narrow.
fn valid_github_branch(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value == value.trim()
        && !value.starts_with('/')
        && !value.ends_with('/')
        && !value.contains("..")
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'))
}

fn valid_git_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.chars().all(|c| c.is_ascii_hexdigit())
}

fn require_github_publication_readiness(
    readiness: Result<(), String>,
) -> Result<(), CommandError> {
    readiness.map_err(CommandError::EngineUnavailable)
}

fn update_github_base_sha_state(
    connectors: &mut Value,
    owner: &str,
    repository: &str,
    branch: &str,
    base_sha: &str,
) -> Result<(), CommandError> {
    let object = connectors
        .as_object_mut()
        .ok_or_else(|| CommandError::EngineUnavailable("CONNECTOR_STATE_INVALID".into()))?;
    let github = object.entry("github").or_insert_with(|| json!({}));
    let github = github
        .as_object_mut()
        .ok_or_else(|| CommandError::EngineUnavailable("CONNECTOR_STATE_INVALID".into()))?;
    github.insert("owner".into(), Value::String(owner.to_string()));
    github.insert("repository".into(), Value::String(repository.to_string()));
    github.insert("branch".into(), Value::String(branch.to_string()));
    github.insert("baseSha".into(), Value::String(base_sha.to_string()));
    Ok(())
}

fn github_base_sha_capture_result(repository: &str, branch: &str, base_sha: &str) -> Value {
    json!({
        "captured": true,
        "repository": repository,
        "branch": branch,
        "baseSha": base_sha,
        "writes": true,
        "network": true
    })
}

#[tauri::command(async)]
pub fn github_capture_base_sha(
    owner: String,
    repository: String,
    branch: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    let owner = owner.trim().to_string();
    let repository = repository.trim().to_string();
    let branch = if branch.trim().is_empty() { "main".to_string() } else { branch.trim().to_string() };
    if !valid_github_segment(&owner) || !valid_github_segment(&repository) {
        return Err(CommandError::InvalidInput(
            "GitHub depo adı güvenli değil.".into(),
        ));
    }
    if !valid_github_branch(&branch) {
        return Err(CommandError::InvalidInput(
            "GitHub dal adı güvenli değil.".into(),
        ));
    }
    let token_path = github_token_path(&app)?;
    if let Err(reason) = state.github_broker.publication_readiness(&token_path) {
        // Fail closed: never report a captured base SHA without a real read.
        return Ok(json!({
            "captured": false,
            "reason": reason,
            "detail": "Temel SHA okumak için GitHub yetkilendirmesi gerekir."
        }));
    }
    let slug = format!("{owner}/{repository}");
    let base_sha = state
        .github_broker
        .base_sha(&token_path, &slug, &branch)
        .map_err(CommandError::EngineUnavailable)?;
    if !valid_git_object_id(&base_sha) {
        return Err(CommandError::EngineUnavailable(
            "GITHUB_BASE_SHA_INVALID".into(),
        ));
    }
    mutate_engine_local_state(&bridge, "desktop.connectors", |connectors| {
        update_github_base_sha_state(
            connectors,
            &owner,
            &repository,
            &branch,
            &base_sha,
        )
    })?;
    Ok(github_base_sha_capture_result(&slug, &branch, &base_sha))
}

#[tauri::command(async)]
pub fn github_preview_pull_request(
    repository: String,
    workflow: String,
    revision_id: String,
    revision_hash: String,
) -> Result<Value, CommandError> {
    github_preview_payload(
        repository.trim(),
        workflow.trim(),
        revision_id.trim(),
        revision_hash.trim(),
    )
}

fn site_adapter_dry_run(path: &str) -> Result<Value, &'static str> {
    if detect_site_format(path) != Some("ASTRO") {
        return Err("Bu klasörde desteklenen Astro site dosyaları bulunamadı. Farklı bir site türü için ayrı adaptör gerekir.");
    }
    let root = Path::new(path);
    if !root.join("src").is_dir() {
        return Err("Astro sitesi için src klasörü bulunamadı.");
    }
    if !root.join("src").join("content").is_dir() && !root.join("src").join("pages").is_dir() {
        return Err("Astro sitesinde src/content veya src/pages bulunamadı.");
    }
    let has_content_schema = [
        root.join("src").join("content.config.ts"),
        root.join("src").join("content.config.js"),
        root.join("src").join("content").join("config.ts"),
        root.join("src").join("content").join("config.js"),
    ]
    .iter()
    .any(|candidate| candidate.is_file());
    if root.join("src").join("content").is_dir() && !has_content_schema {
        return Err("Astro içerik klasörü bulundu ancak strict içerik şeması bulunamadı; src/content.config.ts veya src/content/config.ts ekleyin.");
    }
    let files = [
        "astro.config.mjs",
        "astro.config.js",
        "astro.config.ts",
        "package.json",
    ]
    .into_iter()
    .filter(|candidate| root.join(candidate).is_file())
    .collect::<Vec<_>>();
    Ok(json!({
        "ok": true,
        "adapterId": "astro-generic",
        "adapterVersion": "1",
        "filesInspected": files,
        "contentSchema": if has_content_schema { "DETECTED" } else { "NOT_REQUIRED" },
        "writes": false,
        "network": false
    }))
}

fn detect_site_format(path: &str) -> Option<&'static str> {
    let root = Path::new(path);
    for name in ["astro.config.mjs", "astro.config.js", "astro.config.ts"] {
        if root.join(name).is_file() {
            return Some("ASTRO");
        }
    }
    let package = root.join("package.json");
    let metadata = std::fs::metadata(&package).ok()?;
    if metadata.len() > 2_000_000 {
        return None;
    }
    let content = std::fs::read_to_string(package).ok()?;
    if content.contains("\"astro\"") {
        Some("ASTRO")
    } else {
        None
    }
}

fn detect_repository_remote(path: &str) -> Option<String> {
    let config_path = Path::new(path).join(".git").join("config");
    let metadata = std::fs::metadata(&config_path).ok()?;
    if metadata.len() > 64 * 1024 {
        return None;
    }
    let content = std::fs::read_to_string(config_path).ok()?;
    content
        .lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix("url = ").map(str::trim))
        .filter(|url| url.starts_with("https://github.com/") || url.starts_with("git@github.com:"))
        .map(str::to_string)
}

fn detect_site_content_model(path: &str) -> &'static str {
    let root = Path::new(path);
    if root.join("src").join("content").is_dir() {
        "ASTRO_CONTENT_COLLECTION"
    } else if root.join("lib").join("editorial-content.ts").is_file()
        || root.join("lib").join("editorial-content.tsx").is_file()
    {
        "TYPESCRIPT_EDITORIAL_DATA"
    } else {
        "UNKNOWN"
    }
}

fn validate_local_dev_project(path: &str) -> Result<std::path::PathBuf, CommandError> {
    let raw = path.trim();
    if raw.is_empty() || !Path::new(raw).is_absolute() {
        return Err(CommandError::InvalidInput(
            "yerel proje klasörü mutlak bir Windows yolu olmalı".into(),
        ));
    }
    let root = std::fs::canonicalize(raw)
        .map_err(|_| CommandError::InvalidInput("yerel proje klasörü bulunamadı".into()))?;
    if !root.is_dir() || !root.join("package.json").is_file() {
        return Err(CommandError::InvalidInput(
            "yerel proje klasöründe package.json bulunamadı".into(),
        ));
    }
    let bytes = std::fs::read(root.join("package.json"))
        .map_err(|_| CommandError::InvalidInput("package.json okunamadı".into()))?;
    if bytes.len() > 2_000_000 {
        return Err(CommandError::InvalidInput("package.json çok büyük".into()));
    }
    let package: Value = serde_json::from_slice(&bytes)
        .map_err(|_| CommandError::InvalidInput("package.json geçerli JSON değil".into()))?;
    let has_dev = package
        .pointer("/scripts/dev")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    if !has_dev {
        return Err(CommandError::InvalidInput(
            "package.json içinde scripts.dev bulunamadı".into(),
        ));
    }
    Ok(root)
}

fn ensure_trusted_local_dev(trusted_project: bool) -> Result<(), CommandError> {
    if !trusted_project {
        return Err(CommandError::InvalidInput(
            "yerel geliştirme komutu yalnız seçtiğiniz projeye güvendiğinizi açıkça onayladığınızda başlatılabilir".into(),
        ));
    }
    Ok(())
}

fn authorize_native_confirmation<F>(
    action: &str,
    fingerprint: &str,
    verifier: F,
) -> Result<(), CommandError>
where
    F: FnOnce(&str, &str) -> Result<(), CommandError>,
{
    if action.trim().is_empty() || fingerprint.trim().is_empty() {
        return Err(CommandError::InvalidInput(
            "native onay işlemi ve doğrulama özeti eksik".into(),
        ));
    }
    verifier(action, fingerprint)
}

/// Truncates by characters, not bytes. The fingerprint is often a canonicalized
/// project path, and Turkish folder names put multi-byte characters at arbitrary
/// offsets; slicing `&fingerprint[..160]` panics on a non-boundary index, which
/// the release profile turns into a silent process abort.
fn native_confirmation_detail(fingerprint: &str) -> String {
    if fingerprint.chars().count() > 160 {
        format!("{}…", fingerprint.chars().take(160).collect::<String>())
    } else {
        fingerprint.to_string()
    }
}

#[cfg(windows)]
fn verify_native_confirmation(action: &str, fingerprint: &str) -> Result<(), CommandError> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_DEFBUTTON2, MB_ICONWARNING, MB_SETFOREGROUND, MB_YESNO,
    };

    let detail = native_confirmation_detail(fingerprint);
    let message = HSTRING::from(format!(
        "{action}\n\nDoğrulama bilgisi:\n{detail}\n\nBu işlemi gerçekten başlatmak istiyor musunuz?"
    ));
    let title = HSTRING::from("OPE · Windows onayı");
    let result = unsafe {
        MessageBoxW(
            None,
            PCWSTR(message.as_ptr()),
            PCWSTR(title.as_ptr()),
            MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2 | MB_SETFOREGROUND,
        )
    };
    if result != IDYES {
        return Err(CommandError::InvalidInput(
            "Windows onayı verilmedi; işlem başlatılmadı".into(),
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn verify_native_confirmation(_action: &str, _fingerprint: &str) -> Result<(), CommandError> {
    Err(CommandError::EngineUnavailable(
        "WINDOWS_NATIVE_CONFIRMATION_UNAVAILABLE".into(),
    ))
}

const LOCAL_DEV_ENV_ALLOWLIST: &[&str] =
    &["SystemRoot", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP"];

fn local_dev_environment_with<F>(mut lookup: F) -> Vec<(OsString, OsString)>
where
    F: FnMut(&str) -> Option<OsString>,
{
    LOCAL_DEV_ENV_ALLOWLIST
        .iter()
        .filter_map(|name| lookup(name).map(|value| (OsString::from(name), value)))
        .collect()
}

fn local_dev_environment() -> Vec<(OsString, OsString)> {
    local_dev_environment_with(|name| std::env::var_os(name))
}

#[tauri::command(async)]
pub fn local_dev_status(state: tauri::State<'_, DesktopState>) -> Result<Value, CommandError> {
    let mut process = write_lock(&state.local_dev_process)?;
    let running = match process.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(Some(_)) => {
                *process = None;
                false
            }
            Ok(None) => true,
            Err(_) => false,
        },
        None => false,
    };
    Ok(json!({ "running": running, "supported": true }))
}

#[tauri::command(async)]
pub fn start_local_dev(
    path: String,
    trusted_project: bool,
    state: tauri::State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    ensure_trusted_local_dev(trusted_project)?;
    let granted = require_granted_directory(&state, &path)?;
    let root = validate_local_dev_project(&granted.to_string_lossy())?;
    authorize_native_confirmation(
        "Seçili yerel projede npm run dev çalıştır",
        root.to_string_lossy().as_ref(),
        verify_native_confirmation,
    )?;
    let mut process = write_lock(&state.local_dev_process)?;
    if let Some(child) = process.as_mut() {
        if child
            .try_wait()
            .map_err(|_| {
                CommandError::EngineUnavailable("yerel geliştirme süreci denetlenemedi".into())
            })?
            .is_none()
        {
            return Ok(json!({ "running": true, "directory": root }));
        }
        *process = None;
    }
    let executable = if cfg!(windows) { "npm.cmd" } else { "npm" };
    let mut command = Command::new(executable);
    configure_hidden_command(&mut command);
    let child = command
        .args(["run", "dev"])
        .current_dir(&root)
        .env_clear()
        .envs(local_dev_environment())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            CommandError::EngineUnavailable(format!(
                "yerel geliştirme süreci başlatılamadı: {error}"
            ))
        })?;
    *process = Some(child);
    Ok(json!({ "running": true, "directory": root }))
}

/// Terminating a child this process owns needs no engine, and a degraded runtime
/// is exactly when the user needs the dev server stopped. Requiring
/// mutation-allowed here left the npm tree running with no way to stop it.
#[tauri::command(async)]
pub fn stop_local_dev(state: tauri::State<'_, DesktopState>) -> Result<Value, CommandError> {
    stop_local_dev_process(&state.local_dev_process)?;
    Ok(json!({ "running": false }))
}

fn stop_local_dev_process(process: &RwLock<Option<Child>>) -> Result<(), CommandError> {
    let mut process = write_lock(process)?;
    if let Some(mut child) = process.take() {
        terminate_owned_process_tree(&mut child);
        let _ = child.wait();
    }
    Ok(())
}

fn configured_site_origin(connectors: &Value) -> Option<String> {
    connectors
        .pointer("/site/publicSiteUrl")
        .and_then(Value::as_str)
        .map(|value| value.trim_end_matches('/').to_string())
}

fn codex_executable() -> Option<&'static str> {
    ["codex.cmd", "codex.exe", "codex"]
        .into_iter()
        .find(|candidate| {
            let mut command = Command::new(candidate);
            configure_hidden_command(&mut command);
            command
                .arg("--version")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
        })
}

fn codex_authenticated(executable: &str, codex_home: Option<&Path>) -> bool {
    let mut command = Command::new(executable);
    configure_hidden_command(&mut command);
    if let Some(home) = codex_home {
        command.env("CODEX_HOME", home);
    }
    command
        .args(["login", "status"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn boby_role_state(
    queue_depth: usize,
    _account_configured: bool,
    runner_ready: bool,
    session_authenticated: bool,
) -> &'static str {
    if queue_depth > 0 {
        "BUSY"
    } else if runner_ready && session_authenticated {
        "READY"
    } else {
        "UNAVAILABLE"
    }
}

fn bootstrap_boby_state(
    queue_depth: usize,
    runner_ready: bool,
    session_authenticated: bool,
) -> &'static str {
    boby_role_state(queue_depth, false, runner_ready, session_authenticated)
}

fn boby_guidance_wait_reason(status: &str) -> Option<&'static str> {
    match status {
        "WAITING_CODEX" => Some("Boby bağlantıyı hazırlıyor; hazır olduğunda yanıtını gösterecek."),
        "RUNNING" => Some("Boby yanıtı hazırlıyor."),
        "QUEUED" => Some("Boby isteğini hazırlıyor."),
        _ => None,
    }
}

fn latest_boby_session_id(jobs: &[Value]) -> Option<String> {
    jobs.iter()
        .enumerate()
        .filter_map(|(index, job)| {
            if job.pointer("/metadata/purpose").and_then(Value::as_str) != Some("BOBY_GUIDANCE") {
                return None;
            }
            let session_id = job.pointer("/metadata/bobySessionId").and_then(Value::as_str)?;
            if session_id.is_empty() || session_id.len() > 128 {
                return None;
            }
            let metadata = job.get("metadata");
            let timestamp = metadata
                .and_then(|value| value.get("completedAtUnixMs"))
                .and_then(Value::as_u64)
                .or_else(|| metadata.and_then(|value| value.get("createdAtUnixMs")).and_then(Value::as_u64))
                .unwrap_or(0);
            Some((timestamp, index, session_id.to_string()))
        })
        .max_by_key(|(timestamp, index, _)| (*timestamp, *index))
        .map(|(_, _, session_id)| session_id)
}

fn boby_guidance_diagnostic_code(job: &Value) -> Option<&'static str> {
    match job.pointer("/metadata/codexDiagnosticCode").and_then(Value::as_str) {
        Some("CODEX_PROTOCOL_REJECTED") => Some("CODEX_PROTOCOL_REJECTED"),
        Some("CODEX_OUTPUT_INVALID") => Some("CODEX_OUTPUT_INVALID"),
        Some("CODEX_OUTPUT_MISSING") => Some("CODEX_OUTPUT_MISSING"),
        Some("CODEX_CLI_INVALID_EVENT") => Some("CODEX_CLI_INVALID_EVENT"),
        Some("CODEX_CLI_INVALID_FINAL_OUTPUT") => Some("CODEX_CLI_INVALID_FINAL_OUTPUT"),
        Some("CODEX_CLI_UNSUPPORTED") => Some("CODEX_CLI_UNSUPPORTED"),
        Some("CODEX_SESSION_RETENTION_FAILED") => Some("CODEX_SESSION_RETENTION_FAILED"),
        Some("CODEX_PROCESS_FAILED") => Some("CODEX_PROCESS_FAILED"),
        Some("CODEX_UNKNOWN_FAILURE") => Some("CODEX_UNKNOWN_FAILURE"),
        _ => None,
    }
}

fn bootstrap_can_read_catalog(runtime: RuntimeMode) -> bool {
    matches!(runtime, RuntimeMode::Online)
}

#[tauri::command(async)]
pub fn test_codex_runtime(
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    let Some(executable) = codex_executable() else {
        return Ok(json!({
            "available": false,
            "authenticated": false,
            "detail": "Yazı üretimi aracı bu bilgisayarda bulunamadı. Kurulum paketindeki bağlantı adımını veya Codex kurulumunu kontrol edin."
        }));
    };
    let mut version_command = Command::new(executable);
    configure_hidden_command(&mut version_command);
    let version = version_command
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .map_err(|error| {
            CommandError::EngineUnavailable(format!("CODEX_VERSION_CHECK_FAILED:{error}"))
        })?;
    let output = String::from_utf8_lossy(&version.stdout)
        .lines()
        .next()
        .unwrap_or("Codex hazır")
        .chars()
        .take(120)
        .collect::<String>();
    let codex_home = bridge.codex_home();
    let authenticated = codex_authenticated(executable, codex_home.as_deref());
    *write_lock(&state.codex_authenticated)? = Some(authenticated);
    let runner_ready = bridge
        .doctor()
        .ok()
        .and_then(|doctor| doctor.get("capabilities").cloned())
        .and_then(|value| value.as_array().cloned())
        .is_some_and(|capabilities| {
            capabilities
                .iter()
                .any(|item| item.as_str() == Some("CODEX.RUNNER"))
        });
    Ok(json!({
        "available": true,
        "authenticated": authenticated,
        "runnerReady": runner_ready,
        "version": output,
        "detail": if !authenticated { "Yazı üretimi aracı bulundu; hesap bağlantısı bekleniyor." } else if runner_ready { "Yazı üretimi aracı ve izole OPE çalışma bileşeni hazır." } else { "Yazı üretimi hesabı hazır; izole OPE çalışma bileşeni başlatılamadı." }
    }))
}

#[tauri::command(async)]
pub fn start_codex_login(
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    let executable = codex_executable()
        .ok_or_else(|| CommandError::EngineUnavailable("CODEX_NOT_INSTALLED".into()))?;
    let mut command = Command::new(executable);
    configure_hidden_command(&mut command);
    if let Some(home) = bridge.codex_home() {
        command.env("CODEX_HOME", home);
    }
    // A new login can change the session state. Do not show a stale green
    // Boby status until the user runs the explicit bounded check again.
    *write_lock(&state.codex_authenticated)? = None;
    command
        .arg("login")
        .stdin(Stdio::null())
        .spawn()
        .map_err(|error| {
            CommandError::EngineUnavailable(format!("CODEX_LOGIN_START_FAILED:{error}"))
        })?;
    Ok(json!({
        "started": true,
        "detail": "Codex giriş penceresi başlatıldı. Giriş tamamlandığında bu ekrandan yeniden test edin."
    }))
}

/// Persist only validated, non-secret setup fields in the encrypted engine
/// local-state store. Authentication tokens, passwords and private keys are
/// rejected by `test_setup_connector` before this command can write anything.
#[tauri::command(async)]
pub fn save_setup_connector(
    connector: String,
    mut config: Value,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    let validation = test_setup_connector_with_grants(&state, connector.clone(), config.clone())?;
    if validation.get("ready").and_then(Value::as_bool) != Some(true) {
        return Ok(validation);
    }
    authorize_connector_directory(&state, &connector, &mut config)?;
    let mut saved =
        read_engine_local_state(&bridge, "desktop.connectors").unwrap_or_else(|| json!({}));
    let object = saved
        .as_object_mut()
        .ok_or_else(|| CommandError::EngineUnavailable("CONNECTOR_STATE_INVALID".into()))?;
    let storage_key = connector.as_str();
    object.insert(storage_key.to_string(), config.clone());
    write_engine_local_state(&bridge, "desktop.connectors", Value::Object(object.clone()))?;
    // The engine workers consume connector-scoped records directly. Mirror
    // only validated, non-secret setup metadata; credentials remain owned by
    // the engine authentication runtime and never pass through this command.
    if matches!(storage_key, "github" | "site" | "deploy") {
        write_engine_local_state(&bridge, &format!("connector.{storage_key}"), config.clone())?;
    }
    let mut checks =
        read_engine_local_state(&bridge, "desktop.connectorChecks").unwrap_or_else(|| json!({}));
    let checks_object = checks
        .as_object_mut()
        .ok_or_else(|| CommandError::EngineUnavailable("CONNECTOR_CHECK_STATE_INVALID".into()))?;
    let site_mode = config
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("LOCAL_ONLY");
    let adapter_verified = if connector == "site" {
        site_mode != "PUBLISH"
            || validation
                .get("adapterDryRun")
                .and_then(Value::as_object)
                .and_then(|value| value.get("ok"))
                .and_then(Value::as_bool)
                == Some(true)
    } else {
        true
    };
    let adapter_dry_run = validation.get("adapterDryRun").cloned().unwrap_or_else(|| {
        json!({
            "ok": true,
            "adapterId": "local-folder-v1",
            "adapterVersion": "1",
            "writes": false,
            "network": false
        })
    });
    checks_object.insert(storage_key.to_string(), json!({
        "ready": adapter_verified,
        "state": if adapter_verified { "DRY_RUN_READY" } else { "ADAPTER_DRY_RUN_REQUIRED" },
        "adapterDryRun": adapter_dry_run,
        "checkedAtUnixMs": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()
    }));
    write_engine_local_state(
        &bridge,
        "desktop.connectorChecks",
        Value::Object(checks_object.clone()),
    )?;
    Ok(json!({
        "connector": connector,
        "ready": true,
        "state": "SAVED",
        "detail": if adapter_verified {
            "Gizli olmayan ayarlar bu bilgisayardaki şifreli yerel duruma kaydedildi. Gerçek yetkilendirme ayrıca yapılır."
        } else {
            "Site ayarları kaydedildi; seçilen adaptörün gerçek dry-run kontrolü tamamlanana kadar yayın kilitli kalır."
        }
    }))
}

const CONNECTOR_SITE_CATALOG_MIGRATION_KEY: &str = "migration:connector-site-catalog:v1";

fn safe_legacy_site_connector(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let repository_path = object.get("repositoryPath")?.as_str()?.trim();
    let mode = object
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("LOCAL_ONLY")
        .trim();
    if !is_local_path(repository_path) || !valid_site_work_mode(mode) {
        return None;
    }
    let public_site_url = object
        .get("publicSiteUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if !(public_site_url.is_empty()
        || public_site_url.starts_with("https://")
        || public_site_url.starts_with("http://"))
    {
        return None;
    }
    Some(json!({
        "repositoryPath": repository_path,
        "publicSiteUrl": public_site_url,
        "mode": mode
    }))
}

#[tauri::command(async)]
pub fn verify_local_integrity(
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    let response = engine_request(
        &bridge,
        json!({
            "version": 1,
            "id": format!("desktop-integrity-verify-{}", std::process::id()),
            "kind": "maintenance.integrity.verify"
        }),
    )?;
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(CommandError::EngineUnavailable(
            response
                .pointer("/message")
                .and_then(Value::as_str)
                .or_else(|| response.pointer("/error/message").and_then(Value::as_str))
                .unwrap_or("LOCAL_INTEGRITY_VERIFY_FAILED")
                .to_string(),
        ));
    }
    Ok(response)
}

fn migrate_legacy_site_connector_catalog(
    connectors: &mut Value,
    checks: &mut Value,
    legacy_site: Option<&Value>,
) -> Result<Value, CommandError> {
    let connectors_object = connectors
        .as_object_mut()
        .ok_or_else(|| CommandError::EngineUnavailable("CONNECTOR_SNAPSHOT_CORRUPT".into()))?;
    let checks_object = checks
        .as_object_mut()
        .ok_or_else(|| CommandError::EngineUnavailable("CONNECTOR_SNAPSHOT_CORRUPT".into()))?;
    let catalog_site = connectors_object.get("site").cloned();
    let legacy_site = legacy_site.and_then(safe_legacy_site_connector);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    match (catalog_site, legacy_site) {
        (_, None) => Ok(json!({ "state": "NO_LEGACY_SITE_RECORD", "completedAtUnixMs": now })),
        (None, Some(legacy)) => {
            connectors_object.insert("site".into(), legacy);
            checks_object.insert(
                "site".into(),
                json!({
                    "ready": false,
                    "state": "MIGRATED_REVALIDATION_REQUIRED",
                    "migrationState": "MIGRATED_REVALIDATION_REQUIRED",
                    "checkedAtUnixMs": now
                }),
            );
            Ok(json!({ "state": "MIGRATED_REVALIDATION_REQUIRED", "completedAtUnixMs": now }))
        }
        (Some(current), Some(legacy))
            if safe_legacy_site_connector(&current).as_ref() == Some(&legacy) =>
        {
            Ok(json!({ "state": "ALREADY_EQUIVALENT", "completedAtUnixMs": now }))
        }
        (Some(_), Some(_)) => {
            checks_object.insert(
                "site".into(),
                json!({
                    "ready": false,
                    "state": "MIGRATION_CONFLICT_REVIEW_REQUIRED",
                    "migrationState": "MIGRATION_CONFLICT_REVIEW_REQUIRED",
                    "checkedAtUnixMs": now
                }),
            );
            Ok(json!({ "state": "MIGRATION_CONFLICT_REVIEW_REQUIRED", "completedAtUnixMs": now }))
        }
    }
}

fn migrate_legacy_site_connector_if_needed(
    bridge: &EngineBridge,
) -> Result<Option<Value>, CommandError> {
    let _migration_guard = CONNECTOR_CATALOG_MIGRATION_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| CommandError::EngineUnavailable("CONNECTOR_MIGRATION_LOCK_UNAVAILABLE".into()))?;
    if read_engine_local_state_result(bridge, CONNECTOR_SITE_CATALOG_MIGRATION_KEY)?.is_some() {
        return Ok(None);
    }
    let mut connectors =
        read_engine_local_state_result(bridge, "desktop.connectors")?.unwrap_or_else(|| json!({}));
    let mut checks = read_engine_local_state_result(bridge, "desktop.connectorChecks")?
        .unwrap_or_else(|| json!({}));
    let legacy_site = read_engine_local_state_result(bridge, "connector.site")?;
    let marker =
        migrate_legacy_site_connector_catalog(&mut connectors, &mut checks, legacy_site.as_ref())?;
    write_engine_local_state(bridge, "desktop.connectors", connectors)?;
    write_engine_local_state(bridge, "desktop.connectorChecks", checks)?;
    write_engine_local_state(bridge, CONNECTOR_SITE_CATALOG_MIGRATION_KEY, marker.clone())?;
    Ok(Some(marker))
}

fn connector_state_for_runtime(runtime: RuntimeMode) -> Option<Value> {
    if matches!(runtime, RuntimeMode::Online) {
        return None;
    }
    // Connector configuration lives in the engine-owned encrypted store. An
    // offline desktop must never wake that store merely to repaint setup or
    // publishing controls: a truthful empty projection keeps those screens
    // responsive and lets the explicit Doctor retry remain the recovery path.
    Some(json!({
        "sourceState": "ABSENT",
        "mode": "LOCAL_ONLY",
        "configured": false,
        "config": {
            "codex": { "accountLabel": "" },
            "github": { "owner": "", "repository": "", "clientId": "" },
            "site": { "repositoryPath": "", "publicSiteUrl": "", "mode": "LOCAL_ONLY" },
            "deploy": { "workflowName": "", "requiredChecks": [] },
            "backup": { "folder": "" }
        },
        "site": {
            "repositoryPath": "",
            "publicSiteUrl": "",
            "adapterId": Value::Null,
            "adapterVersion": Value::Null
        },
        "checks": {},
        "migration": Value::Null,
        "localReadiness": "NOT_CONFIGURED",
        "externalReadiness": "NOT_CONFIGURED"
    }))
}

// The prerequisite screen is opened specifically when recovery is needed.
// Once Doctor has reported an offline runtime, it must not immediately wake
// the encrypted store again just to render configuration-dependent checks.
fn prerequisite_can_read_engine(runtime: RuntimeMode) -> bool {
    workspace_can_read_engine(runtime)
}

#[tauri::command]
pub async fn get_connector_state(
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    if let Some(snapshot) = connector_state_for_runtime(*read_lock(&state.runtime)?) {
        return Ok(snapshot);
    }
    // Legacy catalog migration is opportunistic compatibility work. A normal
    // read must stay available when another local engine action advances the
    // cursor between migration writes; the next connector read retries it.
    let migration = match migrate_legacy_site_connector_if_needed(&bridge) {
        Ok(migration) => migration,
        Err(CommandError::EngineUnavailable(message)) if message.starts_with("VERSION_CONFLICT:") => None,
        Err(error) => return Err(error),
    };
    let connectors_state = read_engine_local_state_result(&bridge, "desktop.connectors")?;
    let checks_state = read_engine_local_state_result(&bridge, "desktop.connectorChecks")?;
    let source_state = if connectors_state.is_none() && checks_state.is_none() {
        "ABSENT"
    } else {
        "AVAILABLE"
    };
    let connectors = connectors_state.unwrap_or_else(|| json!({}));
    let checks = checks_state.unwrap_or_else(|| json!({}));
    if !connectors.is_object() || !checks.is_object() {
        return Err(CommandError::EngineUnavailable(
            "CONNECTOR_SNAPSHOT_CORRUPT".into(),
        ));
    }
    let site = connectors.get("site").cloned().unwrap_or_else(|| json!({}));
    let mode = site
        .get("mode")
        .and_then(Value::as_str)
        .filter(|value| valid_site_work_mode(value))
        .unwrap_or("LOCAL_ONLY");
    let repository_path = site
        .get("repositoryPath")
        .and_then(Value::as_str)
        .unwrap_or("");
    let public_site_url = site
        .get("publicSiteUrl")
        .and_then(Value::as_str)
        .unwrap_or("");
    let site_check = checks.get("site");
    let locally_validated = site_check
        .and_then(|value| value.get("ready"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let configured = !repository_path.trim().is_empty();
    let local_readiness = if locally_validated {
        "LOCAL_VALIDATED"
    } else {
        "NOT_CONFIGURED"
    };
    // A local dry-run never proves that GitHub, CI, or hosting accepted a
    // real write. LIVE_ACCEPTED is intentionally reserved for a separate,
    // approval-gated external acceptance flow.
    let external_readiness = if mode == "PUBLISH" && locally_validated {
        "LOCAL_VALIDATED"
    } else {
        "NOT_CONFIGURED"
    };

    Ok(json!({
        "sourceState": source_state,
        "mode": mode,
        "configured": configured,
        "config": {
            "codex": { "accountLabel": connectors.pointer("/codex/accountLabel").and_then(Value::as_str).unwrap_or("") },
            "github": {
                "owner": connectors.pointer("/github/owner").and_then(Value::as_str).unwrap_or(""),
                "repository": connectors.pointer("/github/repository").and_then(Value::as_str).unwrap_or(""),
                "clientId": connectors.pointer("/github/clientId").and_then(Value::as_str).unwrap_or("")
            },
            "site": {
                "repositoryPath": repository_path,
                "publicSiteUrl": public_site_url,
                "mode": mode
            },
            "deploy": {
                "workflowName": connectors.pointer("/deploy/workflowName").and_then(Value::as_str).unwrap_or(""),
                "requiredChecks": connectors.pointer("/deploy/requiredChecks").and_then(Value::as_array).cloned().unwrap_or_default()
            },
            "backup": { "folder": connectors.pointer("/backup/folder").and_then(Value::as_str).unwrap_or("") }
        },
        "site": {
            "repositoryPath": repository_path,
            "publicSiteUrl": public_site_url,
            "adapterId": site_check.and_then(|value| value.pointer("/adapterDryRun/adapterId")).cloned().unwrap_or(Value::Null),
            "adapterVersion": site_check.and_then(|value| value.pointer("/adapterDryRun/adapterVersion")).cloned().unwrap_or(Value::Null)
        },
        "checks": checks,
        "migration": migration,
        "localReadiness": local_readiness,
        "externalReadiness": external_readiness
    }))
}

fn configured_github_repository(bridge: &EngineBridge) -> Option<String> {
    let connectors = read_engine_local_state(bridge, "desktop.connectors")?;
    let owner = connectors.pointer("/github/owner").and_then(Value::as_str)?.trim();
    let repository = connectors.pointer("/github/repository").and_then(Value::as_str)?.trim();
    if !valid_github_segment(owner) || !valid_github_segment(repository) {
        return None;
    }
    Some(format!("{owner}/{repository}"))
}
fn valid_github_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
}

fn is_local_path(value: &str) -> bool {
    value.len() >= 3
        && value.as_bytes().get(1) == Some(&b':')
        && value
            .as_bytes()
            .get(2)
            .is_some_and(|character| *character == b'\\' || *character == b'/')
        && value
            .chars()
            .all(|character| character != '\0' && character != '"')
}

/// Validates a path returned by the native folder picker before it crosses
/// into the connector store. The picker is the source of truth for existence;
/// this lexical guard still prevents URLs, relative paths, quotes, and NULs
/// from entering the local project configuration.
fn validate_folder_selection(value: &str) -> Result<(), CommandError> {
    if !is_local_path(value) {
        return Err(CommandError::InvalidInput(
            "yalnızca Windows üzerinde seçilmiş yerel bir klasör kullanılabilir".into(),
        ));
    }
    Ok(())
}

fn valid_schedule_slot(slot_id: &str) -> bool {
    let legacy = matches!(
        slot_id,
        "slot-mon" | "slot-tue" | "slot-wed" | "slot-thu" | "slot-fri" | "slot-sat" | "slot-sun"
    );
    if legacy {
        return true;
    }
    let mut parts = slot_id.split('-');
    matches!(
        (parts.next(), parts.next(), parts.next(), parts.next()),
        (
            Some("slot"),
            Some("mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun"),
            Some("1" | "2" | "3" | "4" | "5"),
            None
        )
    )
}

fn valid_recovery_key(value: &str) -> bool {
    value.trim().len() >= 16
}

fn valid_hhmm(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 5
        && bytes[2] == b':'
        && bytes[0].is_ascii_digit()
        && bytes[1].is_ascii_digit()
        && bytes[3].is_ascii_digit()
        && bytes[4].is_ascii_digit()
        && value[0..2].parse::<u8>().is_ok_and(|hour| hour < 24)
        && value[3..5].parse::<u8>().is_ok_and(|minute| minute < 60)
}

fn request_choice(
    request: &Value,
    field: &str,
    allowed: &[&str],
    default: &str,
) -> Result<String, CommandError> {
    let value = request
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or(default);
    if allowed.contains(&value) {
        Ok(value.to_string())
    } else {
        Err(CommandError::InvalidInput(format!("invalid {field}")))
    }
}

/// Every site section declared by `SITE_SECTIONS` in packages/contracts.
pub(crate) const SITE_SECTION_IDS: [&str; 8] = [
    "haberler",
    "analiz",
    "dosyalar",
    "rehberler",
    "teknoloji",
    "ekonomi",
    "kultur",
    "yasam",
];

/// The Instant Create renderer sends the chosen site section as `targetSection`
/// (`InstantCreateCommand` in apps/desktop/src/types.ts). Reading only `section`
/// silently discarded the editor's choice and filed every instant draft under
/// the default section. `section` stays accepted so an older renderer payload is
/// still honoured rather than falling back to the default.
fn request_section(
    request: &Value,
    allowed: &[&str],
    default: &str,
) -> Result<String, CommandError> {
    let field = if request.get("targetSection").is_some() {
        "targetSection"
    } else {
        "section"
    };
    request_choice(request, field, allowed, default)
}

#[tauri::command]
pub async fn get_bootstrap_snapshot(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    let doctor = bridge.doctor().ok();
    let runtime = doctor_runtime_mode(doctor.as_ref());
    *write_lock(&state.runtime)? = runtime;
    let engine_state = if matches!(runtime, RuntimeMode::Online) {
        read_engine_state(&bridge).ok()
    } else {
        None
    };
    let capabilities = doctor
        .as_ref()
        .and_then(|result| result.get("capabilities"))
        .cloned()
        .unwrap_or_else(|| json!([]));
    let automation = engine_state
        .as_ref()
        .and_then(|state| engine_automation(state).ok())
        .unwrap_or_else(|| {
            json!({
                "mode": "OFF",
                "onboardingComplete": false,
                "ingestionPaused": true,
                "publishingPaused": true,
                "timezone": "Europe/Istanbul",
                "scanIntervalMinutes": 30
            })
        });
    let onboarding_complete = automation
        .get("onboardingComplete")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    *write_lock(&state.onboarding_complete)? = onboarding_complete;
    let ingestion_paused = automation
        .get("ingestionPaused")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let publishing_paused = automation
        .get("publishingPaused")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    *write_lock(&state.ingestion_paused)? = ingestion_paused;
    *write_lock(&state.publishing_paused)? = publishing_paused;
    let scan_interval_minutes = automation
        .get("scanIntervalMinutes")
        .and_then(Value::as_u64)
        .unwrap_or(30);
    let automation_mode = automation
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("OFF");
    let revision_materializations = engine_state
        .as_ref()
        .and_then(|value| {
            value
                .pointer("/snapshot/serverCursor")
                .and_then(Value::as_u64)
        })
        .map(|version| read_revision_list_at_version(&bridge, version).unwrap_or_default())
        .unwrap_or_default();
    let revision_queue = build_revision_queue(&revision_materializations);
    let review_count = revision_queue
        .iter()
        .filter(|item| item.get("state").and_then(Value::as_str) == Some("REVIEW_REQUIRED"))
        .count();
    let approved_count = revision_queue
        .iter()
        .filter(|item| item.get("state").and_then(Value::as_str) == Some("APPROVED"))
        .count();
    // Doctor is the readiness boundary. Once it reports an offline runtime,
    // additional catalog reads only create closed-pipe errors and can restart
    // an unhealthy sidecar. Return the honest empty offline projection until
    // the deliberate short bootstrap reconciliation retries Doctor.
    let (source_count, candidates, editorial_mutations) = if bootstrap_can_read_catalog(runtime) {
        let source_count = engine_request(
            &bridge,
            json!({
                "version": 1,
                "id": format!("desktop-bootstrap-source-list-{}", std::process::id()),
                "kind": "source.list"
            }),
        )
        .ok()
        .and_then(|result| {
            result
                .get("sources")
                .and_then(Value::as_array)
                .map(Vec::len)
        })
        .unwrap_or(0);
        let candidates = Vec::new();
        let editorial_mutations = read_engine_local_state(&bridge, "desktop.editorial")
            .and_then(|value| value.get("mutations").and_then(Value::as_array).cloned())
            .unwrap_or_default();
        (source_count, candidates, editorial_mutations)
    } else {
        (0, Vec::new(), Vec::new())
    };
    let scheduled_count = revision_queue
        .iter()
        .filter(|item| item.get("scheduledAt").and_then(Value::as_str).is_some())
        .count();
    let queue_jobs = engine_state
        .as_ref()
        .and_then(|value| value.pointer("/snapshot/jobs").and_then(Value::as_array))
        .cloned()
        .unwrap_or_default();
    let failure_count = queue_jobs
        .iter()
        .filter(|job| {
            matches!(
                job.get("state").and_then(Value::as_str),
                Some("FAILED") | Some("DEAD_LETTER")
            )
        })
        .count()
        + engine_state
            .as_ref()
            .and_then(|value| value.pointer("/snapshot/outbox").and_then(Value::as_array))
            .map(|effects| {
                effects
                    .iter()
                    .filter(|effect| effect.get("state").and_then(Value::as_str) == Some("FAILED"))
                    .count()
            })
            .unwrap_or(0);
    let codex_waiting = queue_jobs
        .iter()
        .filter(|job| {
            matches!(
                job.get("state").and_then(Value::as_str),
                Some("WAITING_CODEX") | Some("QUEUED") | Some("RUNNING")
            ) && matches!(
                job.get("kind").and_then(Value::as_str),
                Some("CODEX") | Some("DRAFT")
            )
        })
        .count();
    let codex_runner_ready = capabilities
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item.as_str() == Some("CODEX.RUNNER")));
    let codex_authenticated = read_lock(&state.codex_authenticated)?.unwrap_or(false);
    let boby_state = bootstrap_boby_state(codex_waiting, codex_runner_ready, codex_authenticated);
    let (discovered_count, researching_count) =
        dashboard_pipeline_counts(&candidates, &editorial_mutations, &queue_jobs);

    let snapshot = json!({
        "onboardingComplete": onboarding_complete,
        "runtime": runtime,
        "capabilities": capabilities,
        "connection": {
            "engineRunning": matches!(runtime, RuntimeMode::Online),
            "engineLabel": if matches!(runtime, RuntimeMode::Online) { "Yerel engine · hazır" } else { "Yerel engine · kullanılamıyor" },
            "bridgeReady": matches!(runtime, RuntimeMode::Online),
            "latencyMs": Value::Null,
            "storageLabel": "PGlite · bu Windows bilgisayarı",
            "lastSyncAt": "1970-01-01T00:00:00.000Z"
        },
        "automation": {
            "mode": automation_mode,
            "ingestionPaused": ingestion_paused,
            "publishingPaused": publishing_paused,
            "scanIntervalMinutes": scan_interval_minutes,
            "timezone": "Europe/Istanbul",
            "nextScanAt": Value::Null
        },
        "codex": {
            "state": boby_state,
            "accountLabel": if boby_state == "READY" { "Boby · Luna Low" } else if boby_state == "BUSY" { "Boby · Luna Low çalışıyor" } else { "Boby henüz hazır değil" },
            "queueDepth": codex_waiting,
            "lastRunAt": Value::Null
        },
        "pipeline": [
            { "label": "Keşfedilen", "count": discovered_count, "tone": "neutral" },
            { "label": "Araştırılan", "count": researching_count, "tone": "blue" },
            { "label": "İnceleme", "count": review_count, "tone": "amber" },
            { "label": "Onaylı", "count": approved_count, "tone": "green" }
        ],
        "queue": revision_queue,
        "sourceCount": source_count,
        "scheduledCount": scheduled_count
    });
    let should_notify = crate::tray::update(
        &app,
        crate::tray::TrayProjection {
            connected: matches!(runtime, RuntimeMode::Online),
            review_count,
            failure_count,
            scheduled_count,
        },
    )
    .unwrap_or(false);
    if should_notify && notifications_enabled(&state, &bridge)? {
        let _ = notifications::show_review_ready(
            &app,
            &format!("İncelemeye hazır taslak sayısı: {review_count}"),
        );
    }
    Ok(snapshot)
}

/// The publication scheduler resolves slots against a hard-coded +03:00 offset.
const PUBLISHING_UTC_OFFSET_MINUTES: i64 = 180;

/// A check that was never executed must never render as done. Only the build
/// architecture is observable here (ARM64 is out of support scope); there is no
/// OS build probe, so the honest state is "not measured" with an action, not
/// READY. `architecture` accepts either the Windows (`ARM64`) or the Rust
/// (`aarch64`) spelling.
fn windows_prerequisite_check(architecture: Option<&str>) -> Value {
    let unsupported = architecture.is_some_and(|value| {
        value.eq_ignore_ascii_case("aarch64") || value.eq_ignore_ascii_case("arm64")
    });
    json!({
        "id": "windows",
        "label": "Desteklenen Windows",
        "state": if unsupported { "BLOCKED" } else { "ATTENTION" },
        "scope": "APP",
        "detail": if unsupported {
            "Bu işlemci mimarisi (ARM64) desteklenmiyor."
        } else {
            "Windows sürüm ve mimari kontrolü bu sürümde çalıştırılmadı; hazır olarak işaretlenmedi."
        },
        "userAction": if unsupported {
            json!("OPE'yi desteklenen bir x64 Windows 10 22H2 veya Windows 11 bilgisayarında çalıştırın.")
        } else {
            json!("Windows 10 22H2 veya Windows 11 x64 kullandığınızı elle doğrulayın.")
        }
    })
}

/// Windows reports the host architecture in `PROCESSOR_ARCHITEW6432` while a
/// process runs under emulation, and in `PROCESSOR_ARCHITECTURE` otherwise; the
/// compiled target is only the last resort, because an x64 build reports x86_64
/// even on an ARM64 machine.
fn windows_host_architecture_with<F>(mut lookup: F) -> String
where
    F: FnMut(&str) -> Option<OsString>,
{
    lookup("PROCESSOR_ARCHITEW6432")
        .or_else(|| lookup("PROCESSOR_ARCHITECTURE"))
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| std::env::consts::ARCH.to_string())
}

/// `local_offset_minutes` is the measured local UTC offset. No local clock probe
/// is wired into this binary yet, so `None` keeps the row honest instead of
/// reporting a scheduling prerequisite nobody checked.
fn clock_prerequisite_check(local_offset_minutes: Option<i64>) -> Value {
    let state = match local_offset_minutes {
        Some(offset) if offset == PUBLISHING_UTC_OFFSET_MINUTES => "READY",
        _ => "ATTENTION",
    };
    json!({
        "id": "clock",
        "label": "Yerel zamanlayıcı",
        "state": state,
        "scope": "PUBLISH",
        "detail": match local_offset_minutes {
            Some(offset) if offset == PUBLISHING_UTC_OFFSET_MINUTES => "Yerel saat dilimi yayın zaman dilimiyle (+03:00) uyumlu.",
            Some(_) => "Yerel saat dilimi yayın zaman diliminden (+03:00) farklı; planlanan yayınlar beklenen saatte çalışmaz.",
            None => "Sistem saati ve saat dilimi kontrolü çalıştırılmadı; hazır olarak işaretlenmedi."
        },
        "userAction": if state == "READY" {
            Value::Null
        } else {
            json!("Windows saatini otomatik eşitlemeye alın ve saat dilimini Europe/Istanbul (+03:00) olarak doğrulayın.")
        }
    })
}

/// A stored deploy form is not proof that the native setup check ran. Keep the
/// PUBLISH prerequisite closed unless both the persisted workflow contract and
/// its local validation record are present and valid. This check deliberately
/// reports no live GitHub authorization or workflow-run claim.
fn deploy_prerequisite_check(config: Option<&Value>, verification: Option<&Value>) -> Value {
    let workflow_name = config
        .and_then(|value| value.get("workflowName"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let required_checks_value = config.and_then(|value| value.get("requiredChecks"));
    let required_checks = required_checks_value
        .and_then(Value::as_array)
        .map(|checks| {
            checks
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let contract_valid =
        valid_github_workflow(workflow_name) && valid_required_github_checks(required_checks_value);
    let locally_checked = verification
        .and_then(|value| value.get("ready"))
        .and_then(Value::as_bool)
        == Some(true);
    let ready = contract_valid && locally_checked;
    let configured = config.is_some();
    json!({
        "id": "deploy",
        "checkPassed": ready,
        "localValidationRecorded": locally_checked,
        "workflowName": if workflow_name.is_empty() { Value::Null } else { json!(workflow_name) },
        "requiredChecks": required_checks,
        "authorizationState": "NOT_CHECKED",
        "label": "GitHub Actions yayın sözleşmesi",
        "state": if ready { "READY" } else if configured { "ATTENTION" } else { "BLOCKED" },
        "scope": "PUBLISH",
        "detail": if ready {
            format!(
                "{workflow_name} workflow'u ve {} zorunlu kontrol yerel olarak doğrulandı; canlı GitHub çalıştırma sonucu yayın sırasında ayrıca izlenir.",
                required_checks.len()
            )
        } else if contract_valid {
            "Yayın workflow sözleşmesi kaydedildi; yerel doğrulama kaydı bulunmadığı için hazır sayılmadı.".to_string()
        } else if configured {
            "Workflow dosyası ile benzersiz, boş olmayan zorunlu kontrol listesi geçerli değil.".to_string()
        } else {
            "GitHub Actions yayın workflow'u ve zorunlu kontroller henüz yapılandırılmadı.".to_string()
        },
        "userAction": if ready {
            Value::Null
        } else {
            json!("Geçerli bir .yml/.yaml workflow dosyası ve en az bir benzersiz zorunlu kontrol girip yerel doğrulamayı yeniden çalıştırın.")
        }
    })
}

/// Configuration is not a passed check: the row only turns READY once a recovery
/// key verification *and* a restore preview were actually recorded.
fn backup_prerequisite_check(backup_configured: bool, verification: Option<&Value>) -> Value {
    let archive_sha256 = verification
        .and_then(|record| record.get("archiveSha256"))
        .and_then(Value::as_str)
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let verified_at = verification
        .and_then(|record| record.get("verifiedAtUnixMs"))
        .and_then(Value::as_u64);
    let restore_preview_at = verification
        .and_then(|record| record.get("restorePreviewAtUnixMs"))
        .and_then(Value::as_u64);
    let complete = archive_sha256.is_some() && verified_at.is_some() && restore_preview_at.is_some();
    json!({
        "id": "backup",
        "label": "İsteğe bağlı şifreli yedek",
        "state": if complete {
            "READY"
        } else if backup_configured || verified_at.is_some() {
            "ATTENTION"
        } else {
            "MISSING"
        },
        "scope": "APP",
        "detail": if complete {
            "Şifreli yedek recovery key ile doğrulandı ve geri yükleme testi tamamlandı."
        } else if verified_at.is_some() {
            "Yedek recovery key ile doğrulandı; boş klasöre geri yükleme testi bekleniyor."
        } else if backup_configured {
            "Yedek klasörü kaydedildi; recovery key ile doğrulama bekleniyor."
        } else {
            "Şifreli yedek klasörü henüz seçilmedi."
        },
        "userAction": if complete {
            Value::Null
        } else {
            json!("Recovery key oluşturun ve boş klasöre geri yükleme testini tamamlayın.")
        }
    })
}

#[tauri::command(async)]
pub fn get_prerequisite_status(
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
    app: tauri::AppHandle,
) -> Result<Value, CommandError> {
    let secure_store = secure_store::status(&app);
    let engine_doctor = bridge.doctor().ok();
    let engine_ready = engine_doctor
        .as_ref()
        .and_then(|value| value.get("status").and_then(Value::as_str))
        == Some("READY");
    let queue_ready = engine_doctor
        .as_ref()
        .and_then(|value| value.get("queue").and_then(Value::as_str))
        == Some("ready");
    let runtime = doctor_runtime_mode(engine_doctor.as_ref());
    *write_lock(&state.runtime)? = runtime;
    let checked_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let connectors = if prerequisite_can_read_engine(runtime) {
        read_engine_local_state(&bridge, "desktop.connectors").unwrap_or_else(|| json!({}))
    } else {
        json!({})
    };
    let codex_configured = connectors
        .pointer("/codex/accountLabel")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    let codex_runner_ready = engine_doctor
        .as_ref()
        .and_then(|value| value.get("capabilities"))
        .and_then(Value::as_array)
        .is_some_and(|capabilities| {
            capabilities
                .iter()
                .any(|item| item.as_str() == Some("CODEX.RUNNER"))
        });
    // Prerequisite reads must never spawn codex.cmd or run `login status`.
    // Those checks can take seconds and belong to the explicit Codex test
    // action. The engine capability is the last observed authenticated runner
    // result. Do not even perform executable discovery here: that helper runs
    // `codex.cmd --version`, which is still an external process launch.
    let codex_available = codex_runner_ready || codex_configured;
    let codex_authenticated = read_lock(&state.codex_authenticated)?.unwrap_or(false);
    let github_configured = connectors
        .pointer("/github/owner")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
        && connectors
            .pointer("/github/repository")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty());
    let github_auth_status = serde_json::to_value(
        app.state::<DesktopState>()
            .github_broker
            .status(github_token_path(&app).ok().as_deref()),
    )
    .unwrap_or_else(|_| json!({"status": "degraded"}));
    let github_authorized =
        github_auth_status.get("status").and_then(Value::as_str) == Some("authorized");
    let site_configured = connectors
        .pointer("/site/repositoryPath")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    let backup_configured = connectors
        .pointer("/backup/folder")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    let connector_checks = if prerequisite_can_read_engine(runtime) {
        read_engine_local_state(&bridge, "desktop.connectorChecks").unwrap_or_else(|| json!({}))
    } else {
        json!({})
    };
    let site_check_ready = connector_checks
        .pointer("/site/ready")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let backup_verification = connector_checks.get("backupVerification");
    let deploy_config = connectors.get("deploy");
    let deploy_verification = connector_checks.get("deploy");

    Ok(json!({
        "checkedAtUnixMs": checked_at_unix_ms,
        "checks": [
            windows_prerequisite_check(Some(&windows_host_architecture_with(|name| {
                std::env::var_os(name)
            }))),
            {
                "id": "webview2",
                "label": "Microsoft Edge WebView2",
                "state": "READY",
                "scope": "APP",
                "detail": "Bu ekran çalıştığı için WebView2 çalışma zamanı hazır.",
                "userAction": null
            },
            {
                "id": "secure-store",
                "label": "Windows güvenli anahtar deposu",
                "state": if secure_store.ready { "READY" } else { "MISSING" },
                "scope": "APP",
                "detail": secure_store.detail,
                "userAction": if secure_store.ready {
                    Value::Null
                } else {
                    json!("Windows kullanıcı profilini ve DPAPI erişimini onarın.")
                }
            },
            {
                "id": "local-engine",
                "label": "Yerel engine",
                "state": if engine_ready { "READY" } else { "MISSING" },
                "scope": "WRITE",
                "detail": if engine_ready {
                    "Paketlenmiş yerel engine el sıkışması tamamlandı."
                } else {
                    "Paketlenmiş yerel engine henüz başlatılmadı."
                },
                "userAction": if engine_ready {
                    Value::Null
                } else {
                    json!("Uygulamayı yeniden başlatın veya kurulum paketindeki engine bileşenini onarın.")
                }
            },
            {
                "id": "local-database",
                "label": "Yerel PGlite veritabanı",
                "state": if engine_ready { "READY" } else { "MISSING" },
                "scope": "WRITE",
                "detail": if engine_ready { "Şifreli yerel veri deposu açıldı." } else { "Engine hazır olduğunda yerel veri deposu test edilecek." },
                "userAction": if engine_ready { Value::Null } else { json!("Önce yerel engine'i yeniden test edin.") }
            },
            {
                "id": "local-queue",
                "label": "Yerel iş kuyruğu",
                "state": if queue_ready { "READY" } else { "MISSING" },
                "scope": "WRITE",
                "detail": if queue_ready { "Retry, zamanlama ve dead-letter kuyruğu hazır." } else { "Engine hazır olduğunda yerel kuyruk test edilecek." },
                "userAction": if queue_ready { Value::Null } else { json!("Önce yerel engine'i yeniden test edin.") }
            },
            {
                "id": "codex",
                "label": "Codex çalışma zamanı",
                "state": if codex_runner_ready && codex_authenticated && codex_configured { "READY" } else if codex_available { "ATTENTION" } else { "BLOCKED" },
                "scope": "WRITE",
                "detail": if !codex_configured { "Yazı üretimi hesabı henüz seçilmedi." } else if !codex_authenticated { "Codex bağlantısı henüz açıkça test edilmedi." } else if !codex_runner_ready { "Hesap hazır; izole yerel runner henüz başlatılmadı." } else { "Codex hesabı ve izole yerel runner hazır." },
                "userAction": if codex_runner_ready && codex_authenticated && codex_configured { Value::Null } else { json!("Codex hesabını bağlayıp izole runner testini tamamlayın.") }
            },
            clock_prerequisite_check(None),
            {
                "id": "github",
                "label": "GitHub yayın bağlantısı",
                "state": if github_configured && github_authorized { "READY" } else { "BLOCKED" },
                "scope": "PUBLISH",
                "detail": if !github_configured { "GitHub depo hedefi henüz yapılandırılmadı." } else if github_authorized { "GitHub App broker ve depo yetkisi hazır." } else { "GitHub depo hedefi kaydedildi; GitHub App broker yapılandırılmadığı için yayın kilitli." },
                "userAction": if github_configured && github_authorized { Value::Null } else { json!("GitHub App broker yapılandırması ve gerçek erişim için ayrı onay gerekir; aksi halde PR ve yayın işlemleri kilitli kalır.") }
            },
            backup_prerequisite_check(backup_configured, backup_verification),
            {
                "id": "site-adapter",
                "checkPassed": site_check_ready,
                "label": "Site yayın adaptörü",
                "state": if site_check_ready { "READY" } else if site_configured { "ATTENTION" } else { "BLOCKED" },
                "scope": "PUBLISH",
                "detail": if site_check_ready { "Seçilen site adaptörü ve yayın sözleşmesi doğrulandı." } else if site_configured { "Site klasörü kaydedildi; format ve route dry-run doğrulaması bekleniyor." } else { "Yayın yapılacak site henüz seçilmedi." },
                "userAction": if site_check_ready { Value::Null } else { json!("Yayın yapılacak siteyi seçin ve format/route dry-run testini çalıştırın.") }
            },
            deploy_prerequisite_check(deploy_config, deploy_verification)
        ]
    }))
}

#[tauri::command(async)]
pub fn list_sources(
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    // Opening the content workspace must not re-open a sidecar that Doctor
    // already marked offline. Returning the typed recovery state is more
    // honest than presenting an empty catalog as if every source were gone.
    if !workspace_can_read_engine(*read_lock(&state.runtime)?) {
        return Err(CommandError::EngineUnavailable("OFFLINE_READ_ONLY".into()));
    }
    let response = engine_request(
        &bridge,
        json!({
            "version": 1,
            "id": format!("desktop-source-list-{}", std::process::id()),
            "kind": "source.list"
        }),
    )?;
    let sources = response
        .get("sources")
        .and_then(Value::as_array)
        .ok_or_else(|| CommandError::EngineUnavailable("SOURCE_LIST_SHAPE_INVALID".into()))?;
    Ok(json!({
        "sources": sources.iter().map(|source| {
            let url = source.get("url").and_then(Value::as_str).unwrap_or_default();
            let enabled = source.get("status").and_then(Value::as_str) == Some("ACTIVE");
            let publishable = source.pointer("/capabilities/canPublish").and_then(Value::as_bool)
                == Some(true);
            json!({
                "id": source.get("id").cloned().unwrap_or(Value::Null),
                "name": source.get("title").and_then(Value::as_str).filter(|title| !title.is_empty()).unwrap_or(url),
                "url": url,
                "kind": source.get("kind").cloned().unwrap_or(json!("SITE")),
                "health": if !enabled { "DISABLED" } else if publishable { "HEALTHY" } else { "WARNING" },
                "section": source.get("defaultSection").and_then(Value::as_str).unwrap_or("haberler"),
                "articleType": source.get("defaultArticleType").and_then(Value::as_str).unwrap_or("news"),
                "lastCheckedAt": source.pointer("/lastTest/testedAt").cloned().unwrap_or(Value::Null),
                "lastItemAt": source.get("lastItemAt").cloned().unwrap_or(Value::Null),
                "discoveredFeeds": source.get("discoveredFeeds").cloned().unwrap_or_else(|| json!([])),
                "enabled": enabled,
                "version": source.get("version").cloned().unwrap_or(json!(1)),
                "language": source.get("language").cloned().unwrap_or(json!("unknown")),
                "trustStatus": source.get("trustStatus").cloned().unwrap_or(json!("PENDING")),
                "rightsStatus": source.get("rightsStatus").cloned().unwrap_or(json!("PENDING")),
                "trustReview": source.get("trustReview").cloned().unwrap_or(Value::Null),
                "rightsReview": source.get("rightsReview").cloned().unwrap_or(Value::Null),
                "canPublish": publishable,
                "blockers": source.pointer("/capabilities/blockers").cloned().unwrap_or_else(|| json!([]))
            })
        }).collect::<Vec<_>>()
    }))
}

#[tauri::command(async)]
pub fn review_source(
    source_id: String,
    expected_version: u64,
    trust_status: String,
    rights_status: String,
    rationale: String,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    let valid_status = |value: &str| value == "APPROVED" || value == "REJECTED";
    if source_id.trim().is_empty()
        || !valid_status(&trust_status)
        || !valid_status(&rights_status)
        || rationale.trim().chars().count() < 10
        || rationale.chars().count() > 1_000
    {
        return Err(CommandError::InvalidInput(
            "kaynak incelemesi için iki karar ve 10-1000 karakter gerekçe gereklidir".into(),
        ));
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| CommandError::StateUnavailable)?
        .as_millis();
    let request_token = format!("desktop-source-review-{}-{timestamp}", std::process::id());
    let response = engine_request(
        &bridge,
        json!({
            "version": 1,
            "id": request_token,
            "kind": "command",
            "command": {
                "version": 1,
                "requestId": request_token,
                "idempotencyKey": request_token,
                "expectedVersion": expected_version,
                "kind": "SOURCE.REVIEW",
                "payload": {
                    "sourceId": source_id,
                    "trustStatus": trust_status,
                    "rightsStatus": rights_status,
                    "rationale": rationale.trim()
                }
            }
        }),
    )?;
    let source = response
        .pointer("/result/value")
        .ok_or_else(|| CommandError::EngineUnavailable("SOURCE_REVIEW_SHAPE_INVALID".into()))?;
    Ok(json!({ "source": source }))
}

#[tauri::command(async)]
pub fn test_source(
    url: String,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    if !is_http_url(&url) {
        return Err(CommandError::InvalidInput(
            "source URL must use HTTPS".into(),
        ));
    }
    let response = bridge.request(json!({
        "version": 1,
        "id": format!("desktop-source-test-{}", std::process::id()),
        "kind": "source.test",
        "url": url
    })).map_err(CommandError::EngineUnavailable)?;
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        // A guarded fetch can reject one remote source for DNS, TLS, timeout,
        // or document-policy reasons. That is source health, not a failed
        // local engine; keeping the error typed prevents one bad URL from
        // turning the whole desktop into an offline workspace.
        let error_message = response.get("message").and_then(Value::as_str).unwrap_or("");
        let access_forbidden = error_message.contains("403") || error_message.to_ascii_lowercase().contains("forbidden");
        return Ok(json!({
            "url": url,
            "kind": "SITE",
            "title": if access_forbidden { "Kaynak otomatik erişimi engelledi" } else { "Kaynak doğrulanamadı" },
            "reachable": false,
            "statusCode": if access_forbidden { 403 } else { 0 },
            "discoveredFeeds": [],
            "recommendation": if access_forbidden {
                "Bu site otomatik erişimi engelliyor (HTTP 403). Kaynağı daha sonra yeniden deneyin veya izin verilen RSS/birincil kaynak kullanın; diğer kaynaklar çalışmaya devam eder."
            } else {
                "Bu kaynak şu anda güvenli olarak doğrulanamadı. Adresi ve erişimi kontrol edin; diğer kaynaklar kullanılmaya devam eder."
            }
        }));
    }
    let probe = response
        .get("probe")
        .ok_or_else(|| CommandError::EngineUnavailable("SOURCE_TEST_SHAPE_INVALID".into()))?;
    Ok(json!({
        "url": probe.get("finalUrl").cloned().unwrap_or(Value::Null),
        "kind": probe.get("kind").cloned().unwrap_or(json!("SITE")),
        "title": probe.get("title").cloned().unwrap_or(json!("Kaynak önizlemesi")),
        "reachable": true,
        "statusCode": 200,
        "discoveredFeeds": probe.get("discoveredFeeds").cloned().unwrap_or_else(|| json!([])),
        "recommendation": "Kaynak güvenli yerel fetcher ile doğrulandı; kaydetmeden önce güven ve kullanım hakkı incelemesini tamamlayın."
    }))
}

fn build_source_scan_command(
    sources: &[Value],
    selected_source_id: Option<&str>,
    request_token: &str,
) -> Result<Value, CommandError> {
    let mut targets = Vec::new();
    for source in sources {
        let source_id = source.get("id").and_then(Value::as_str).unwrap_or_default();
        if let Some(selected) = selected_source_id {
            if source_id != selected {
                continue;
            }
        } else if source.get("status").and_then(Value::as_str) != Some("ACTIVE") {
            continue;
        }
        let expected_version = source
            .get("version")
            .and_then(Value::as_u64)
            .ok_or_else(|| CommandError::EngineUnavailable("SOURCE_VERSION_MISSING".into()))?;
        targets.push(json!({
            "sourceId": source_id,
            "expectedVersion": expected_version
        }));
    }
    if selected_source_id.is_some() && targets.is_empty() {
        return Err(CommandError::InvalidInput(
            "seçilen kaynak yerel katalogda bulunamadı".into(),
        ));
    }
    if targets.is_empty() {
        return Err(CommandError::InvalidInput(
            "taranabilecek etkin kaynak bulunmuyor".into(),
        ));
    }
    Ok(json!({
        "version": 1,
        "requestId": request_token,
        "idempotencyKey": request_token,
        "expectedVersion": 0,
        "kind": "SOURCE.SCAN",
        "payload": { "targets": targets }
    }))
}

/// The token is the scan's idempotency key *and* its status handle. Two parallel
/// scans used to share a millisecond, which made the engine reject the second
/// batch as a reused key and made one scan's status page report the other's runs.
/// Nanoseconds plus a process-local sequence keep every scan distinct.
fn source_scan_request_token() -> Result<String, CommandError> {
    static SCAN_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| CommandError::StateUnavailable)?
        .as_nanos();
    let sequence = SCAN_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    Ok(format!(
        "desktop-scan-{}-{nanos}-{sequence}",
        std::process::id()
    ))
}

fn scan_sources(
    selected_source_id: Option<&str>,
    state: &DesktopState,
    bridge: &EngineBridge,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(state)?;
    let catalog = engine_request(
        bridge,
        json!({
            "version": 1,
            "id": format!("desktop-source-list-{}", std::process::id()),
            "kind": "source.list"
        }),
    )?;
    let sources = catalog
        .get("sources")
        .and_then(Value::as_array)
        .ok_or_else(|| CommandError::EngineUnavailable("SOURCE_LIST_SHAPE_INVALID".into()))?;
    let request_token = source_scan_request_token()?;
    let command = build_source_scan_command(sources, selected_source_id, &request_token)?;
    let response = engine_request(
        bridge,
        json!({
            "version": 1,
            "id": request_token,
            "kind": "command",
            "command": command
        }),
    )?;
    let accepted = response
        .pointer("/result/value")
        .ok_or_else(|| CommandError::EngineUnavailable("SOURCE_SCAN_SHAPE_INVALID".into()))?;
    accepted
        .get("batchKey")
        .and_then(Value::as_str)
        .ok_or_else(|| CommandError::EngineUnavailable("SOURCE_SCAN_BATCH_MISSING".into()))?;
    let accepted_count = accepted
        .get("scans")
        .and_then(Value::as_array)
        .map(|scans| {
            scans
                .iter()
                .filter(|scan| scan.get("accepted").and_then(Value::as_bool) == Some(true))
                .count()
        })
        .unwrap_or(0);
    Ok(json!({
        "accepted": accepted_count > 0,
        "operationId": request_token,
        "detail": format!(
            "{accepted_count} kaynak yerel tarama kuyruğuna alındı. Sonuçlar kaynak kartlarına işlenecek."
        )
    }))
}

#[tauri::command(async)]
pub fn scan_source(
    source_id: String,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    scan_sources(Some(&source_id), &state, &bridge)
}

#[tauri::command(async)]
pub fn scan_all_sources(
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    scan_sources(None, &state, &bridge)
}

#[tauri::command(async)]
pub fn get_source_scan_status(
    operation_id: String,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    let response = engine_request(
        &bridge,
        json!({
            "version": 1,
            "id": format!("desktop-source-scan-status-{}", std::process::id()),
            "kind": "source.scan.status",
            "idempotencyKey": operation_id
        }),
    )?;
    let runs = response
        .get("runs")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            CommandError::EngineUnavailable("SOURCE_SCAN_STATUS_SHAPE_INVALID".into())
        })?;
    let count = |state: &str| {
        runs.iter()
            .filter(|run| run.get("state").and_then(Value::as_str) == Some(state))
            .count()
    };
    let queued = count("QUEUED");
    let running = count("RUNNING");
    let succeeded = count("SUCCEEDED");
    let failed = count("FAILED");
    let rejected = count("REJECTED");
    let complete = !runs.is_empty() && queued == 0 && running == 0 && failed == 0;
    let detail = if complete {
        format!("Tarama tamamlandı: {succeeded} başarılı, {rejected} reddedildi.")
    } else if failed > 0 {
        format!(
            "Tarama yeniden denenecek: {succeeded} başarılı, {failed} geçici hata, {queued} sırada."
        )
    } else {
        format!("Tarama sürüyor: {running} çalışıyor, {queued} sırada.")
    };
    Ok(json!({
        "operationId": operation_id,
        "complete": complete,
        "queued": queued,
        "running": running,
        "succeeded": succeeded,
        "failed": failed,
        "rejected": rejected,
        "detail": detail
    }))
}

#[tauri::command(async)]
pub fn preview_opml(
    input: String,
    _state: tauri::State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    let urls = parse_opml_urls(&input)?;
    if urls.is_empty() {
        return Err(CommandError::InvalidInput(
            "OPML içinde herkese açık HTTPS kaynak bulunamadı".into(),
        ));
    }
    Ok(json!({ "urls": urls, "count": urls.len(), "writes": false }))
}

#[tauri::command(async)]
pub fn save_sources(
    sources: Vec<Value>,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    if sources.is_empty() {
        return Err(CommandError::InvalidInput(
            "en az bir kaynak gereklidir".into(),
        ));
    }
    let mut saved = Vec::with_capacity(sources.len());
    for (index, source) in sources.iter().enumerate() {
        let url = source
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| CommandError::InvalidInput("kaynak URL'si gereklidir".into()))?;
        if !is_http_url(url) {
            return Err(CommandError::InvalidInput(
                "her kaynak HTTPS kullanmalıdır".into(),
            ));
        }
        let section = source
            .get("section")
            .and_then(Value::as_str)
            .ok_or_else(|| CommandError::InvalidInput("kaynak bölümü gereklidir".into()))?;
        let article_type = source
            .get("articleType")
            .and_then(Value::as_str)
            .ok_or_else(|| CommandError::InvalidInput("içerik türü gereklidir".into()))?;
        let expected_version = source.get("version").and_then(Value::as_u64).unwrap_or(0);
        let stable_key = stable_source_key(&format!("{expected_version}:{source}"));
        let response = engine_request(
            &bridge,
            json!({
                "version": 1,
                "id": format!("desktop-source-save-{}-{index}", std::process::id()),
                "kind": "command",
                "command": {
                    "version": 1,
                    "requestId": format!("desktop-source-save-{}-{index}", std::process::id()),
                    "idempotencyKey": stable_key,
                    "expectedVersion": expected_version,
                    "kind": "SOURCE.SAVE",
                    "payload": {
                        "source": {
                            "url": url,
                            "section": section,
                            "articleType": article_type,
                            "kind": source.get("kind").and_then(Value::as_str).unwrap_or("SITE"),
                            "language": source.get("language").and_then(Value::as_str).unwrap_or("unknown"),
                            "title": source.get("title").and_then(Value::as_str).unwrap_or("")
                        }
                    }
                }
            }),
        )?;
        let value = response
            .pointer("/result/value")
            .ok_or_else(|| CommandError::EngineUnavailable("SOURCE_SAVE_SHAPE_INVALID".into()))?;
        let publishable = value.get("status").and_then(Value::as_str) == Some("ACTIVE")
            && value.get("trustStatus").and_then(Value::as_str) == Some("APPROVED")
            && value.get("rightsStatus").and_then(Value::as_str) == Some("APPROVED");
        saved.push(json!({
            "id": value.get("id").cloned().unwrap_or(Value::Null),
            "name": value.get("title").and_then(Value::as_str).filter(|title| !title.is_empty()).unwrap_or(url),
            "url": value.get("url").cloned().unwrap_or_else(|| json!(url)),
            "kind": value.get("kind").cloned().unwrap_or(json!("SITE")),
            "health": "WARNING",
            "section": value.get("defaultSection").cloned().unwrap_or_else(|| json!(section)),
            "articleType": value.get("defaultArticleType").cloned().unwrap_or_else(|| json!(article_type)),
            "lastCheckedAt": Value::Null,
            "lastItemAt": value.get("lastItemAt").cloned().unwrap_or(Value::Null),
            "discoveredFeeds": value.get("discoveredFeeds").cloned().unwrap_or_else(|| json!([])),
                "enabled": true,
                "version": value.get("version").cloned().unwrap_or(json!(1)),
                "language": value.get("language").cloned().unwrap_or(json!("unknown")),
                "trustStatus": value.get("trustStatus").cloned().unwrap_or(json!("PENDING")),
                "rightsStatus": value.get("rightsStatus").cloned().unwrap_or(json!("PENDING")),
                "canPublish": publishable,
                "blockers": if publishable {
                    json!([])
                } else {
                    json!(["TRUST_REVIEW_REQUIRED", "RIGHTS_REVIEW_REQUIRED"])
                }
        }));
    }
    Ok(json!({ "sources": saved }))
}

fn stable_source_key(url: &str) -> String {
    let hash = url
        .as_bytes()
        .iter()
        .fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        });
    format!("source-save-{hash:016x}")
}

fn read_revision_list(bridge: &EngineBridge) -> Result<Vec<Value>, CommandError> {
    let engine_state = read_engine_state(bridge)?;
    let expected_version = engine_state
        .pointer("/snapshot/serverCursor")
        .and_then(Value::as_u64)
        .ok_or_else(|| CommandError::EngineUnavailable("STATE_VERSION_MISSING".into()))?;
    read_revision_list_at_version(bridge, expected_version)
}

#[tauri::command]
pub async fn check_unsigned_update(
) -> Result<crate::unsigned_updater::UnsignedUpdateCheck, CommandError> {
    crate::unsigned_updater::check_unsigned_update().await
}

#[tauri::command]
pub async fn install_unsigned_update(
    app: tauri::AppHandle,
    request: crate::unsigned_updater::InstallUnsignedUpdateRequest,
) -> Result<(), CommandError> {
    crate::unsigned_updater::install_unsigned_update(app, request).await
}

fn read_revision_list_at_version(
    bridge: &EngineBridge,
    expected_version: u64,
) -> Result<Vec<Value>, CommandError> {
    let request_id = format!(
        "desktop-revision-list-{}-{expected_version}",
        std::process::id()
    );
    let response = engine_request(
        bridge,
        json!({
            "version": 1,
            "id": request_id,
            "kind": "command",
            "command": {
                "version": 1,
                "requestId": request_id,
                "idempotencyKey": format!("revision-list-{expected_version}"),
                "expectedVersion": expected_version,
                "kind": "REVISION.LIST",
                "payload": { "summaryOnly": true }
            }
        }),
    )?;
    response
        .pointer("/result/value")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| CommandError::EngineUnavailable("REVISION_LIST_SHAPE_INVALID".into()))
}

fn read_revision_at_version(
    bridge: &EngineBridge,
    expected_version: u64,
    revision_id: &str,
) -> Result<Value, CommandError> {
    let request_id = format!(
        "desktop-revision-get-{}-{expected_version}-{revision_id}",
        std::process::id()
    );
    let response = engine_request(
        bridge,
        json!({
            "version": 1,
            "id": request_id,
            "kind": "command",
            "command": {
                "version": 1,
                "requestId": request_id,
                "idempotencyKey": format!("revision-get-{expected_version}-{revision_id}"),
                "expectedVersion": expected_version,
                "kind": "REVISION.GET",
                "payload": { "revisionId": revision_id }
            }
        }),
    )?;
    response
        .pointer("/result/value")
        .cloned()
        .ok_or_else(|| CommandError::InvalidInput("revizyon bulunamadı".into()))
}

fn build_revision_queue(materializations: &[Value]) -> Vec<Value> {
    materializations
        .iter()
        .filter_map(|item| {
            let revision = item.get("revision")?;
            let id = revision.get("id")?.as_str()?;
            let title = revision.pointer("/tr/title")?.as_str()?;
            let has_editorial_approval = item
                .get("editorialApproval")
                .is_some_and(|value| !value.is_null());
            let high_risk = revision.get("riskLevel").and_then(Value::as_str) == Some("HIGH");
            let has_high_risk_approval = item
                .get("highRiskApproval")
                .is_some_and(|value| !value.is_null());
            let fully_approved = has_editorial_approval && (!high_risk || has_high_risk_approval);
            let state = if fully_approved {
                "APPROVED"
            } else {
                "REVIEW_REQUIRED"
            };
            let source_count = revision
                .get("sources")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            let blockers = revision
                .get("claims")
                .and_then(Value::as_array)
                .map(|claims| {
                    claims
                        .iter()
                        .filter(|claim| {
                            claim.get("status").and_then(Value::as_str) != Some("VERIFIED")
                        })
                        .count()
                })
                .unwrap_or(0)
                + usize::from(high_risk && has_editorial_approval && !has_high_risk_approval);
            Some(json!({
                "id": id,
                "revisionHash": item.get("revisionHash").cloned().unwrap_or(Value::Null),
                "title": title,
                "section": revision.get("section").cloned().unwrap_or(json!("haberler")),
                "slug": revision.pointer("/tr/slug").cloned().unwrap_or(json!(id)),
                "state": state,
                "sourceCount": source_count,
                "updatedAt": revision.get("scheduledAt").cloned().unwrap_or(Value::Null),
                "scheduledAt": revision.get("scheduledAt").cloned().unwrap_or(Value::Null),
                "dueLabel": "İnceleme bekliyor",
                "blockers": blockers
            }))
        })
        .collect()
}

fn dashboard_pipeline_counts(
    candidates: &[Value],
    editorial_mutations: &[Value],
    jobs: &[Value],
) -> (usize, usize) {
    let discovered = candidates
        .iter()
        .filter(|candidate| {
            let latest_state =
                candidate
                    .get("id")
                    .and_then(Value::as_str)
                    .and_then(|candidate_id| {
                        editorial_mutations.iter().rev().find_map(|mutation| {
                            if mutation.get("candidateId").and_then(Value::as_str)
                                != Some(candidate_id)
                            {
                                return None;
                            }
                            match mutation.get("kind").and_then(Value::as_str) {
                                Some("CANDIDATE.DISMISS") => Some("DISMISSED"),
                                Some("CANDIDATE.PROMOTE") => Some("RESEARCH_QUEUED"),
                                _ => None,
                            }
                        })
                    });
            latest_state.is_none()
        })
        .count();
    let researching = jobs
        .iter()
        .filter(|job| {
            job.get("kind").and_then(Value::as_str) == Some("DRAFT")
                && matches!(
                    job.get("state").and_then(Value::as_str),
                    Some("QUEUED") | Some("RUNNING") | Some("WAITING_CODEX")
                )
        })
        .count();
    (discovered, researching)
}

fn downgrade_invalid_v3_review_projection(projected: &mut Value) {
    projected["state"] = json!("REVIEW_REQUIRED");
    projected["editorialApproved"] = json!(false);
    projected["highRiskApproved"] = json!(false);
    if let Some(object) = projected.as_object_mut() {
        object.remove("packageVersion");
        object.remove("publicationSources");
        object.remove("approvalRequirements");
    }
}

fn build_review_revision(item: &Value) -> Result<Value, CommandError> {
    build_review_revision_with_predecessor(item, None)
}

/// `predecessor` is the materialization of the revision this one supersedes. Only
/// a real predecessor may feed the review diff; the current content used to be
/// emitted on both sides, so every diff showed identical removed and added text.
fn build_review_revision_with_predecessor(
    item: &Value,
    predecessor: Option<&Value>,
) -> Result<Value, CommandError> {
    let revision = item
        .get("revision")
        .ok_or_else(|| CommandError::EngineUnavailable("REVISION_SHAPE_INVALID".into()))?;
    let tr = revision
        .get("tr")
        .ok_or_else(|| CommandError::EngineUnavailable("REVISION_TR_MISSING".into()))?;
    let en = revision
        .get("en")
        .ok_or_else(|| CommandError::EngineUnavailable("REVISION_EN_MISSING".into()))?;
    let locale_content = |value: &Value| {
        json!({
            "title": value.get("title").cloned().unwrap_or(Value::Null),
            "description": value.get("description").cloned().unwrap_or(Value::Null),
            "slug": value.get("slug").cloned().unwrap_or(Value::Null),
            "bodyMarkdown": value.get("bodyMarkdown").cloned().unwrap_or(Value::Null)
        })
    };
    let claims = revision
        .get("claims")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|claim| {
                    json!({
                        "id": claim.get("id").cloned().unwrap_or(Value::Null),
                        "text": claim.get("text").cloned().unwrap_or(Value::Null),
                        "locale": claim.get("locale").cloned().unwrap_or(json!("both")),
                        "status": claim.get("status").cloned().unwrap_or(json!("NEEDS_SOURCE")),
                        "sourceIds": claim.get("sourceIds").cloned().unwrap_or_else(|| json!([]))
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let sources = revision
        .get("sources")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .enumerate()
                .map(|(index, source)| {
                    json!({
                        "id": source.get("id").cloned().unwrap_or(Value::Null),
                        "title": source.get("title").cloned().unwrap_or(Value::Null),
                        "url": source.get("url").cloned().unwrap_or(Value::Null),
                        "fetchedAt": source.get("fetchedAt").cloned().unwrap_or(Value::Null),
                        "contentHash": source.get("contentHash").cloned().unwrap_or(Value::Null),
                        "primary": index == 0
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let media = revision
        .get("media")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .enumerate()
                .map(|(index, asset)| {
                    let filename = asset
                        .get("path")
                        .and_then(Value::as_str)
                        .and_then(|path| path.rsplit('/').next())
                        .unwrap_or("asset");
                    json!({
                        "id": format!("media-{index}"),
                        "role": asset.get("role").cloned().unwrap_or(json!("inline")),
                        "filename": filename,
                        "width": asset.get("width").cloned().unwrap_or(json!(0)),
                        "height": asset.get("height").cloned().unwrap_or(json!(0)),
                        "sha256": asset.get("sha256").cloned().unwrap_or(Value::Null),
                        "byteSize": asset.get("byteSize").cloned().unwrap_or(Value::Null),
                        "contentBase64": asset.get("contentBase64").cloned().unwrap_or(Value::Null),
                        "altTr": tr.get("heroImageAlt").cloned().unwrap_or(Value::Null),
                        "altEn": en.get("heroImageAlt").cloned().unwrap_or(Value::Null)
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let has_editorial_approval = item
        .get("editorialApproval")
        .is_some_and(|value| !value.is_null());
    let high_risk = revision.get("riskLevel").and_then(Value::as_str) == Some("HIGH");
    let has_high_risk_approval = item
        .get("highRiskApproval")
        .is_some_and(|value| !value.is_null());
    let approved = has_editorial_approval && (!high_risk || has_high_risk_approval);
    let gate_label = |id: &str| {
        match id {
            "claims" => "İddia ve kanıt bütünlüğü",
            "parity" => "TR/EN anlam eşitliği",
            "immutable-package" => "Değişmez yayın paketi",
            "seo" => "SEO uygunluğu",
            "safety" => "İçerik güvenliği",
            "media" => "Medya uygunluğu",
            _ => id,
        }
        .to_string()
    };
    let gates = revision
        .get("qualityGates")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|gate| {
                    let id = gate.get("id").and_then(Value::as_str).unwrap_or("unknown");
                    json!({
                        "id": id,
                        "label": gate_label(id),
                        "detail": gate.get("detail").cloned().unwrap_or(json!("Kontrol ayrıntısı sağlanmadı.")),
                        "state": gate.get("state").cloned().unwrap_or(json!("NOT_RUN")),
                        "group": gate.get("group").cloned().unwrap_or(json!("editorial")),
                        "policyVersion": gate.get("policyVersion").cloned().unwrap_or(json!("unknown")),
                        "reasonCode": gate.get("reasonCode").cloned().unwrap_or(Value::Null)
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let predecessor_content = predecessor
        .and_then(|materialization| materialization.get("revision"))
        .and_then(|previous| {
            let previous_tr = previous.get("tr")?;
            let previous_en = previous.get("en")?;
            Some(json!({
                "tr": locale_content(previous_tr),
                "en": locale_content(previous_en)
            }))
        });

    let mut projected = json!({
        "id": revision.get("id").cloned().unwrap_or(Value::Null),
        "revisionHash": item.get("revisionHash").cloned().unwrap_or(Value::Null),
        "articleId": revision.get("translationKey").cloned().unwrap_or(Value::Null),
        "state": if approved { "APPROVED" } else { "REVIEW_REQUIRED" },
        "riskLevel": revision.get("riskLevel").cloned().unwrap_or(json!("STANDARD")),
        "editorialApproved": has_editorial_approval,
        "highRiskApproved": has_high_risk_approval,
        "section": revision.get("section").cloned().unwrap_or(Value::Null),
        "articleType": revision.get("articleType").cloned().unwrap_or(Value::Null),
        "author": revision.get("author").cloned().unwrap_or(Value::Null),
        "tags": revision.get("tags").cloned().unwrap_or_else(|| json!([])),
        "scheduledAt": revision.get("scheduledAt").cloned().unwrap_or(Value::Null),
        "adapterVersion": revision.get("adapterVersion").cloned().unwrap_or(Value::Null),
        "tr": locale_content(tr),
        "en": locale_content(en),
        // `hasPrevious` tells the review screen whether the diff pane describes a
        // real predecessor. When it is false the `previous` fields only mirror the
        // current content so the existing screen keeps rendering; they are not a
        // diff and must not be presented as one.
        "hasPrevious": predecessor_content.is_some(),
        "previous": predecessor_content.unwrap_or_else(|| json!({
            "tr": locale_content(tr),
            "en": locale_content(en)
        })),
        "claims": claims,
        "sources": sources,
        "gates": gates,
        "media": media
    });

    match revision.get("packageVersion") {
        None | Some(Value::Null) => {}
        Some(version) if version.as_u64() == Some(3) => {
            let Some(public_sources) = revision
                .get("publicationSources")
                .and_then(Value::as_array) else {
                    downgrade_invalid_v3_review_projection(&mut projected);
                    return Ok(projected);
                };
            if public_sources.is_empty() {
                downgrade_invalid_v3_review_projection(&mut projected);
                return Ok(projected);
            }
            let mut projected_sources = Vec::with_capacity(public_sources.len());
            let mut source_ids = std::collections::HashSet::new();
            for source in public_sources {
                let id = source.get("id").and_then(Value::as_str).unwrap_or("");
                let title = source.get("title").and_then(Value::as_str).unwrap_or("");
                let url = source.get("url").and_then(Value::as_str).unwrap_or("");
                let role = source.get("role").and_then(Value::as_str).unwrap_or("");
                if id.is_empty()
                    || id.len() > 128
                    || !id.chars().all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
                    || title.trim().is_empty()
                    || title.len() > 4_096
                    || url.trim().is_empty()
                    || url.len() > 4_096
                    || !matches!(role, "primary" | "independent" | "supporting")
                    || !source_ids.insert(id.to_string())
                {
                    downgrade_invalid_v3_review_projection(&mut projected);
                    return Ok(projected);
                }
                // Rebuild from the four public fields. Evidence excerpts,
                // anchors, capture ids and hashes remain engine-owned.
                projected_sources.push(json!({
                    "id": id,
                    "title": title,
                    "url": url,
                    "role": role
                }));
            }
            let Some(assessment) = revision
                .get("editorialAssessment")
                .and_then(Value::as_object) else {
                    downgrade_invalid_v3_review_projection(&mut projected);
                    return Ok(projected);
                };
            let Some(is_ymyl) = assessment
                .get("isYmyl")
                .and_then(Value::as_bool) else {
                    downgrade_invalid_v3_review_projection(&mut projected);
                    return Ok(projected);
                };
            let Some(sensitive_topic) = assessment
                .get("sensitiveTopic")
                .and_then(Value::as_bool) else {
                    downgrade_invalid_v3_review_projection(&mut projected);
                    return Ok(projected);
                };
            let mut requirements = vec![json!("EDITORIAL_REVIEW")];
            if is_ymyl {
                requirements.push(json!("EXPERT_REVIEW"));
            }
            if sensitive_topic {
                requirements.push(json!("ETHICS_REVIEW"));
            }
            projected["packageVersion"] = json!(3);
            projected["publicationSources"] = Value::Array(projected_sources);
            projected["approvalRequirements"] = Value::Array(requirements);
        }
        Some(_) => downgrade_invalid_v3_review_projection(&mut projected),
    }

    Ok(projected)
}

#[tauri::command(async)]
pub fn create_instant_draft(
    request: Value,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    let instruction = request
        .get("instruction")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let source_ids = request
        .get("sourceIds")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let urls = request
        .get("urls")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|url| is_http_url(url))
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if instruction.len() < 10 || (source_ids.is_empty() && urls.is_empty()) {
        return Err(CommandError::InvalidInput(
            "anlık içerik için talimat ve en az bir kaynak gerekir".into(),
        ));
    }
    // Must stay in step with `SITE_SECTIONS` in packages/contracts. Accepting
    // only half of them rejected every draft filed under the other four, even
    // though the renderer offers all eight. `site_sections_match_the_contract`
    // in tests/unit/desktop-command-contract.test.ts pins this list.
    let section = request_section(&request, &SITE_SECTION_IDS, "haberler")?;
    let article_type = request_choice(
        &request,
        "articleType",
        &["news", "analysis", "deep_dive", "guide"],
        "news",
    )?;
    let urgency = request_choice(&request, "urgency", &["normal", "urgent"], "normal")?;
    let tone = request_choice(
        &request,
        "tone",
        &["neutral", "technical", "accessible"],
        "neutral",
    )?;
    let length = request_choice(&request, "length", &["standard", "deep"], "standard")?;
    // New draft creation always has an explicit hero-media path. Existing
    // no-media revisions remain recoverable through the dedicated repair flow.
    let visual_policy = request_choice(
        &request,
        "visualPolicy",
        &["GENERATE", "LOCAL_RENDERER"],
        "GENERATE",
    )?;
    let schedule_intent = request_choice(
        &request,
        "scheduleIntent",
        &["NEXT_SLOT", "UNSCHEDULED"],
        "UNSCHEDULED",
    )?;
    let editorial_preferences = read_engine_local_state(&bridge, "desktop.editorial")
        .and_then(|value| value.get("preferences").cloned())
        .unwrap_or_else(|| json!({}));
    let preferred_author = editorial_preferences
        .get("author")
        .and_then(Value::as_str)
        .filter(|value| (2..=120).contains(&value.trim().len()))
        .unwrap_or("OPE Editorya")
        .trim()
        .to_string();
    let preferred_reviewer = editorial_preferences
        .get("reviewer")
        .and_then(Value::as_str)
        .filter(|value| (2..=120).contains(&value.trim().len()))
        .unwrap_or("Editör")
        .trim()
        .to_string();
    let engine_state = read_engine_state(&bridge)?;
    let version = engine_state
        .pointer("/snapshot/serverCursor")
        .and_then(Value::as_u64)
        .ok_or_else(|| CommandError::EngineUnavailable("STATE_VERSION_MISSING".into()))?;
    let request_fingerprint = serde_json::to_string(&request)
        .map_err(|error| CommandError::InvalidInput(error.to_string()))?;
    let draft_id = format!("draft-{}", stable_source_key(&request_fingerprint));
    let key = stable_source_key(&format!("draft-create:{draft_id}:{version}"));
    let response = engine_request(
        &bridge,
        json!({
            "version": 1,
            "id": key,
            "kind": "command",
            "command": {
                "version": 1,
                "requestId": key,
                "idempotencyKey": key,
                "expectedVersion": version,
                "kind": "DRAFT.CREATE",
                "payload": {
                    "draftId": draft_id,
                    "instruction": instruction,
                    "sourceIds": source_ids,
                    "urls": urls,
                    "section": section,
                    "articleType": article_type,
                    "urgency": urgency,
                    "tone": tone,
                    "length": length,
                    "visualPolicy": visual_policy,
                    "scheduleIntent": schedule_intent,
                    "preferredAuthor": preferred_author,
                    "preferredReviewer": preferred_reviewer
                }
            }
        }),
    )?;
    let queued = response
        .pointer("/result/value")
        .cloned()
        .ok_or_else(|| CommandError::EngineUnavailable("DRAFT_CREATE_SHAPE_INVALID".into()))?;
    let queue_state = queued
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("WAITING_CODEX");
    Ok(json!({
        "id": queued.get("id").cloned().unwrap_or_else(|| json!(draft_id)),
        "state": if queue_state == "WAITING_CODEX" { "WAITING_CODEX" } else { "RESEARCHING" },
        "queueState": queue_state
    }))
}

#[tauri::command(async)]
pub fn request_boby_guidance(
    request: Value,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    let question = request.get("question").and_then(Value::as_str).map(str::trim).unwrap_or("");
    let active_page = request.get("activePage").and_then(Value::as_str).map(str::trim).unwrap_or("");
    let runtime_state = request.get("runtimeState").and_then(Value::as_str).unwrap_or("");
    let summary = request.get("safeWorkspaceSummary").and_then(Value::as_object);
    let count = |key: &str| summary
        .and_then(|value| value.get(key))
        .and_then(Value::as_u64)
        .filter(|value| *value <= 100_000)
        .unwrap_or(0);
    if question.is_empty() || question.len() > 600 || active_page.is_empty() || active_page.len() > 64
        || !matches!(runtime_state, "ONLINE" | "DEGRADED" | "OFFLINE") {
        return Err(CommandError::InvalidInput("Boby için kısa bir soru ve geçerli yerel durum gerekir".into()));
    }
    let engine_state = read_engine_state(&bridge)?;
    let version = engine_state
        .pointer("/snapshot/serverCursor")
        .and_then(Value::as_u64)
        .ok_or_else(|| CommandError::EngineUnavailable("STATE_VERSION_MISSING".into()))?;
    // A Boby conversation is a single local Codex thread. The persisted job
    // metadata contains only the opaque thread id, never question text or
    // model output, and lets the next message resume that same thread.
    let session_id = engine_state
        .pointer("/snapshot/jobs")
        .and_then(Value::as_array)
        .and_then(|jobs| latest_boby_session_id(jobs));
    // Each message must be its own durable job. Reusing a hash of the question
    // can reconnect a new user message to an old interrupted WAITING_CODEX job,
    // leaving Boby visibly stuck even though the local Codex runner is healthy.
    let guidance_id = boby_guidance_request_token()?;
    let key = stable_source_key(&format!("boby-guidance:{guidance_id}"));
    let response = engine_request(&bridge, json!({
        "version": 1,
        "id": key,
        "kind": "command",
        "command": {
            "version": 1,
            "requestId": key,
            "idempotencyKey": key,
            "expectedVersion": version,
            "kind": "BOBY.GUIDE",
            "payload": {
                "guidanceId": guidance_id,
                "sessionId": session_id,
                "question": question,
                "activePage": active_page,
                "runtimeState": runtime_state,
                "safeWorkspaceSummary": {
                    "draftCount": count("draftCount"),
                    "reviewCount": count("reviewCount"),
                    "sourceCount": count("sourceCount")
                }
            }
        }
    }))?;
    let queued = response.pointer("/result/value").ok_or_else(|| CommandError::EngineUnavailable("BOBY_GUIDANCE_SHAPE_INVALID".into()))?;
    Ok(json!({
        "id": queued.get("id").cloned().unwrap_or_else(|| json!(guidance_id)),
        "state": queued.get("state").and_then(Value::as_str).unwrap_or("WAITING_CODEX")
    }))
}

/// Boby chat is conversational, so duplicate text still represents a new turn.
/// A time-plus-process-plus-sequence token avoids sharing a stale durable job.
fn boby_guidance_request_token() -> Result<String, CommandError> {
    static BOBY_GUIDANCE_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| CommandError::StateUnavailable)?
        .as_nanos();
    let sequence = BOBY_GUIDANCE_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    Ok(format!("boby-{}-{nanos}-{sequence}", std::process::id()))
}
#[tauri::command(async)]
pub fn get_boby_guidance(
    guidance_id: String,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    if !guidance_id.starts_with("boby-") || guidance_id.len() > 128 {
        return Err(CommandError::InvalidInput("geçerli Boby rehberlik kimliği gerekir".into()));
    }
    let state = read_engine_state(&bridge)?;
    let job = state.pointer("/snapshot/jobs").and_then(Value::as_array)
        .and_then(|jobs| jobs.iter().find(|job| job.get("id").and_then(Value::as_str) == Some(guidance_id.as_str())))
        .ok_or_else(|| CommandError::InvalidInput("Boby rehberlik isteği bulunamadı".into()))?;
    if job.pointer("/metadata/purpose").and_then(Value::as_str) != Some("BOBY_GUIDANCE") {
        return Err(CommandError::InvalidInput("Boby rehberlik isteği bulunamadı".into()));
    }
    let status = job.get("state").and_then(Value::as_str).unwrap_or("FAILED");
    Ok(json!({
        "id": guidance_id,
        "state": status,
        "waitReason": boby_guidance_wait_reason(status),
        "diagnosticCode": boby_guidance_diagnostic_code(job),
        "reply": job.pointer("/metadata/bobyReply").cloned(),
        "suggestedActions": job.pointer("/metadata/bobyActions").cloned().unwrap_or_else(|| json!([]))
    }))
}

#[tauri::command(async)]
pub fn get_review_revision(
    revision_id: String,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    let expected_version = read_engine_state(&bridge)?
        .pointer("/snapshot/serverCursor")
        .and_then(Value::as_u64)
        .ok_or_else(|| CommandError::EngineUnavailable("STATE_VERSION_MISSING".into()))?;
    let materialization = read_revision_at_version(&bridge, expected_version, &revision_id)?;
    // The engine records the superseded revision id, so the review diff can be
    // built from the real predecessor instead of from this revision's own text.
    let predecessor = materialization
        .pointer("/revision/supersedesRevisionId")
        .and_then(Value::as_str)
        .and_then(|previous_id| {
            read_revision_at_version(&bridge, expected_version, previous_id).ok()
        });
    build_review_revision_with_predecessor(&materialization, predecessor.as_ref())
}

/// Reads one engine-owned image only for the active review surface. The bytes
/// are verified before they cross into the WebView and are never persisted in
/// the publication preview state.
#[tauri::command(async)]
pub fn read_revision_media(
    revision_id: String,
    sha256: String,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    if revision_id.is_empty()
        || revision_id.len() > 128
        || !revision_id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '-')
        || sha256.len() != 64
        || !sha256.chars().all(|value| value.is_ascii_hexdigit())
    {
        return Err(CommandError::InvalidInput(
            "geçerli revizyon medya kimliği gerekir".into(),
        ));
    }
    let revision = read_revision_at_version(
        &bridge,
        read_engine_state(&bridge)?
            .pointer("/snapshot/serverCursor")
            .and_then(Value::as_u64)
            .ok_or_else(|| CommandError::EngineUnavailable("STATE_VERSION_MISSING".into()))?,
        &revision_id,
    )?;
    let media = revision
        .get("media")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().find(|asset| {
                asset
                    .get("sha256")
                    .and_then(Value::as_str)
                    .is_some_and(|value| value.eq_ignore_ascii_case(&sha256))
            })
        })
        .ok_or_else(|| CommandError::InvalidInput("revizyon medyası bulunamadı".into()))?;
    let byte_size = bounded_media_size(
        media
            .get("byteSize")
            .and_then(Value::as_u64)
            .ok_or_else(|| CommandError::EngineUnavailable("REVISION_MEDIA_SIZE_MISSING".into()))?,
    )?;
    let bytes = read_engine_media_bytes(
        &bridge,
        &revision_id,
        &sha256.to_ascii_lowercase(),
        byte_size,
    )?;
    let path = media
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mime_type = if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        "image/jpeg"
    } else {
        "image/webp"
    };
    Ok(
        json!({ "contentBase64": base64::engine::general_purpose::STANDARD.encode(bytes), "mimeType": mime_type }),
    )
}

#[tauri::command(async)]
pub fn repair_revision_media(
    revision_id: String,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    if revision_id.trim().is_empty()
        || revision_id.len() > 128
        || !revision_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
    {
        return Err(CommandError::InvalidInput(
            "geçerli bir revizyon kimliği gerekir".into(),
        ));
    }
    let expected_version = read_engine_state(&bridge)?
        .pointer("/snapshot/serverCursor")
        .and_then(Value::as_u64)
        .ok_or_else(|| CommandError::EngineUnavailable("STATE_VERSION_MISSING".into()))?;
    let revision_id = revision_id.trim().to_string();
    let key = stable_source_key(&format!(
        "revision-media-repair:{revision_id}:{expected_version}"
    ));
    let response = engine_request(
        &bridge,
        json!({
            "version": 1,
            "id": key,
            "kind": "command",
            "command": {
                "version": 1,
                "requestId": key,
                "idempotencyKey": key,
                "expectedVersion": expected_version,
                "kind": "REVISION.REPAIR_MEDIA",
                "payload": { "revisionId": revision_id }
            }
        }),
    )?;
    let value = response.pointer("/result/value").cloned().ok_or_else(|| {
        CommandError::EngineUnavailable("REVISION_MEDIA_REPAIR_SHAPE_INVALID".into())
    })?;
    let successor_id = value
        .pointer("/revision/id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            CommandError::EngineUnavailable("REVISION_MEDIA_REPAIR_ID_MISSING".into())
        })?;
    let revision_hash = value
        .get("revisionHash")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            CommandError::EngineUnavailable("REVISION_MEDIA_REPAIR_HASH_MISSING".into())
        })?;
    let mutation = json!({
        "kind": "REVISION.MEDIA_REPAIR",
        "revisionId": revision_id,
        "successorRevisionId": successor_id
    });
    persist_editorial_state(&bridge, mutation.clone(), None)?;
    write_lock(&state.editorial_mutations)?.push(mutation);
    Ok(json!({
        "revision": {
            "id": successor_id,
            "revisionHash": revision_hash
        }
    }))
}

fn build_approval_command(
    revision_id: &str,
    expected_hash: &str,
    warning_set_hash: &str,
    attestation: &Value,
    expected_version: u64,
) -> Result<Value, CommandError> {
    if revision_id.is_empty()
        || revision_id.len() > 128
        || !revision_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
        || expected_hash.len() != 64
        || !expected_hash
            .chars()
            .all(|character| character.is_ascii_hexdigit())
        || warning_set_hash.len() != 64
        || !warning_set_hash
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(CommandError::InvalidInput(
            "revizyon kimliği veya exact hash geçersiz".into(),
        ));
    }
    validate_editorial_attestation_v3(attestation)?;
    // A changed warning acceptance or human attestation is a new logical
    // approval even when the immutable revision and engine cursor are unchanged.
    // Bind those values into the request key so a corrected form is not mistaken
    // for an idempotent replay of an earlier, different decision.
    let attestation_bytes = serde_json::to_vec(attestation)
        .map_err(|_| CommandError::InvalidInput("EDITORIAL_ATTESTATION_INVALID".into()))?;
    let attestation_digest = format!("{:x}", Sha256::digest(attestation_bytes));
    let request_key = stable_source_key(&format!(
        "{revision_id}:{expected_hash}:{warning_set_hash}:{attestation_digest}:{expected_version}"
    ));
    Ok(json!({
        "version": 1,
        "requestId": request_key,
        "idempotencyKey": request_key,
        "expectedVersion": expected_version,
        "kind": "APPROVAL.GRANT",
        "payload": {
            "packageVersion": 3,
            "revisionId": revision_id,
            "revisionHash": expected_hash.to_ascii_lowercase(),
            "warningSetHash": warning_set_hash.to_ascii_lowercase(),
            "deviceId": "windows-local-device-v1",
            "attestation": attestation
        }
    }))
}

fn exact_json_keys(value: &serde_json::Map<String, Value>, expected: &[&str]) -> bool {
    value.len() == expected.len() && expected.iter().all(|key| value.contains_key(*key))
}

fn bounded_human_text(value: Option<&Value>, maximum: usize) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| !text.trim().is_empty() && text.len() <= maximum)
}

fn validate_editorial_attestation_v3(attestation: &Value) -> Result<(), CommandError> {
    let invalid = || CommandError::InvalidInput("EDITORIAL_ATTESTATION_INVALID".into());
    let root = attestation.as_object().ok_or_else(invalid)?;
    if !exact_json_keys(root, &["editorialReview", "expertReview", "ethicsReview"]) {
        return Err(invalid());
    }
    let editorial = root
        .get("editorialReview")
        .and_then(Value::as_object)
        .ok_or_else(invalid)?;
    if !exact_json_keys(editorial, &["reviewer", "sourceRoles"])
        || !bounded_human_text(editorial.get("reviewer"), 256)
    {
        return Err(invalid());
    }
    let source_roles = editorial
        .get("sourceRoles")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    if source_roles.is_empty() || source_roles.len() > 1_000 {
        return Err(invalid());
    }
    let mut source_ids = std::collections::HashSet::new();
    for source_role in source_roles {
        let source_role = source_role.as_object().ok_or_else(invalid)?;
        let source_id = source_role.get("sourceId").and_then(Value::as_str).unwrap_or("");
        let role = source_role.get("role").and_then(Value::as_str).unwrap_or("");
        if !exact_json_keys(source_role, &["sourceId", "role"])
            || source_id.is_empty()
            || source_id.len() > 128
            || !source_id.chars().all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
            || !matches!(role, "primary" | "independent" | "supporting")
            || !source_ids.insert(source_id.to_string())
        {
            return Err(invalid());
        }
    }

    if let Some(expert) = root.get("expertReview").filter(|value| !value.is_null()) {
        let expert = expert.as_object().ok_or_else(invalid)?;
        if !exact_json_keys(expert, &["reviewer", "qualifications", "reviewScope"])
            || !bounded_human_text(expert.get("reviewer"), 256)
            || !bounded_human_text(expert.get("qualifications"), 1_000)
            || !bounded_human_text(expert.get("reviewScope"), 2_000)
        {
            return Err(invalid());
        }
    }
    if let Some(ethics) = root.get("ethicsReview").filter(|value| !value.is_null()) {
        let ethics = ethics.as_object().ok_or_else(invalid)?;
        if !exact_json_keys(ethics, &["reviewer", "reviewScope", "rationale"])
            || !bounded_human_text(ethics.get("reviewer"), 256)
            || !bounded_human_text(ethics.get("reviewScope"), 2_000)
            || !bounded_human_text(ethics.get("rationale"), 4_000)
        {
            return Err(invalid());
        }
    }
    Ok(())
}

fn validate_editorial_attestation_for_revision_v3(
    materialization: &Value,
    attestation: &Value,
) -> Result<(), CommandError> {
    let invalid = || CommandError::InvalidInput("EDITORIAL_ATTESTATION_INVALID".into());
    validate_editorial_attestation_v3(attestation)?;
    let revision = materialization.get("revision").ok_or_else(invalid)?;
    let public_sources = revision
        .get("publicationSources")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    let acknowledged = attestation
        .pointer("/editorialReview/sourceRoles")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    if public_sources.len() != acknowledged.len() {
        return Err(invalid());
    }
    let expected = public_sources
        .iter()
        .filter_map(|source| {
            Some((
                source.get("id")?.as_str()?.to_string(),
                source.get("role")?.as_str()?.to_string(),
            ))
        })
        .collect::<std::collections::HashSet<_>>();
    let actual = acknowledged
        .iter()
        .filter_map(|source| {
            Some((
                source.get("sourceId")?.as_str()?.to_string(),
                source.get("role")?.as_str()?.to_string(),
            ))
        })
        .collect::<std::collections::HashSet<_>>();
    if expected.len() != public_sources.len() || actual.len() != acknowledged.len() || expected != actual {
        return Err(invalid());
    }
    let assessment = revision
        .get("editorialAssessment")
        .and_then(Value::as_object)
        .ok_or_else(invalid)?;
    if assessment.get("isYmyl").and_then(Value::as_bool) == Some(true)
        && matches!(attestation.get("expertReview"), None | Some(Value::Null))
    {
        return Err(invalid());
    }
    if assessment.get("sensitiveTopic").and_then(Value::as_bool) == Some(true)
        && matches!(attestation.get("ethicsReview"), None | Some(Value::Null))
    {
        return Err(invalid());
    }
    Ok(())
}

fn build_approval_revoke_command(
    revision_id: &str,
    expected_hash: &str,
    reason: &str,
    expected_version: u64,
) -> Result<Value, CommandError> {
    let reason = reason.trim();
    if revision_id.is_empty()
        || revision_id.len() > 128
        || !revision_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
        || expected_hash.len() != 64
        || !expected_hash.chars().all(|character| character.is_ascii_hexdigit())
        || reason.is_empty()
        || reason.chars().count() > 512
    {
        return Err(CommandError::InvalidInput(
            "APPROVAL_REVOCATION_INVALID".into(),
        ));
    }
    let normalized_hash = expected_hash.to_ascii_lowercase();
    let request_key = stable_source_key(&format!(
        "approval-revoke:{revision_id}:{normalized_hash}:{reason}:{expected_version}"
    ));
    let request = json!({
        "version": 1,
        "requestId": request_key,
        "idempotencyKey": request_key,
        "expectedVersion": expected_version,
        "kind": "APPROVAL.REVOKE",
        "payload": {
            "revisionId": revision_id,
            "revisionHash": normalized_hash,
            "deviceId": "windows-local-device-v1",
            "reason": reason
        }
    });
    Ok(request)
}

fn build_high_risk_approval_command(
    revision_id: &str,
    expected_hash: &str,
    checklist_hash: &str,
    warning_set_hash: &str,
    expected_version: u64,
) -> Result<Value, CommandError> {
    if revision_id.is_empty()
        || revision_id.len() > 128
        || !revision_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
        || expected_hash.len() != 64
        || !expected_hash
            .chars()
            .all(|character| character.is_ascii_hexdigit())
        || checklist_hash.len() != 64
        || !checklist_hash
            .chars()
            .all(|character| character.is_ascii_hexdigit())
        || warning_set_hash.len() != 64
        || !warning_set_hash
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(CommandError::InvalidInput(
            "revizyon, exact hash veya risk kontrol hash'i geçersiz".into(),
        ));
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let request_key = stable_source_key(&format!(
        "high-risk:{revision_id}:{expected_hash}:{checklist_hash}:{now}"
    ));
    let reauthenticated_at = chrono_like_iso(now)?;
    Ok(json!({
        "version": 1,
        "requestId": request_key,
        "idempotencyKey": request_key,
        "expectedVersion": expected_version,
        "kind": "APPROVAL.GRANT_HIGH_RISK",
        "payload": {
            "revisionId": revision_id,
            "revisionHash": expected_hash.to_ascii_lowercase(),
            "deviceId": "windows-local-device-v1",
            "riskChecklistHash": checklist_hash.to_ascii_lowercase(),
            "warningSetHash": warning_set_hash.to_ascii_lowercase(),
            "windowsReauthenticatedAt": reauthenticated_at
        }
    }))
}

fn trusted_high_risk_checklist_hash(
    bridge: &EngineBridge,
    expected_version: u64,
    revision_id: &str,
) -> Result<String, CommandError> {
    let materialization = read_revision_at_version(bridge, expected_version, revision_id)?;
    let gates = materialization
        .pointer("/revision/qualityGates")
        .and_then(Value::as_array)
        .ok_or_else(|| CommandError::EngineUnavailable("RISK_CHECKLIST_UNAVAILABLE".into()))?;
    let mut security_gates = Vec::new();
    for gate in gates {
        if gate.get("group").and_then(Value::as_str) != Some("security") {
            continue;
        }
        let id = gate.get("id").and_then(Value::as_str).ok_or_else(|| {
            CommandError::EngineUnavailable("RISK_CHECKLIST_INVALID".into())
        })?;
        let state = gate.get("state").and_then(Value::as_str).ok_or_else(|| {
            CommandError::EngineUnavailable("RISK_CHECKLIST_INVALID".into())
        })?;
        let detail = gate.get("detail").and_then(Value::as_str).ok_or_else(|| {
            CommandError::EngineUnavailable("RISK_CHECKLIST_INVALID".into())
        })?;
        security_gates.push((id.to_string(), state.to_string(), detail.to_string()));
    }
    security_gates.sort_by(|left, right| left.0.cmp(&right.0));
    if security_gates.is_empty() {
        return Err(CommandError::EngineUnavailable(
            "RISK_CHECKLIST_UNAVAILABLE".into(),
        ));
    }
    let canonical = serde_json::to_vec(&security_gates)
        .map_err(|_| CommandError::EngineUnavailable("RISK_CHECKLIST_INVALID".into()))?;
    Ok(format!("{:x}", Sha256::digest(canonical)))
}

#[cfg(windows)]
fn verify_windows_user_consent(revision_hash: &str) -> Result<(), CommandError> {
    use windows::core::HSTRING;
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    };

    let availability = UserConsentVerifier::CheckAvailabilityAsync()
        .and_then(|operation| operation.get())
        .map_err(|error| {
            CommandError::EngineUnavailable(format!("WINDOWS_REAUTH_UNAVAILABLE:{error}"))
        })?;
    if availability != UserConsentVerifierAvailability::Available {
        return Err(CommandError::EngineUnavailable(
            "WINDOWS_REAUTH_NOT_CONFIGURED".into(),
        ));
    }
    let suffix = revision_hash
        .get(revision_hash.len().saturating_sub(8)..)
        .unwrap_or(revision_hash);
    let message = HSTRING::from(format!("OPE yüksek risk onayı · revizyon …{suffix}"));
    let result = UserConsentVerifier::RequestVerificationAsync(&message)
        .and_then(|operation| operation.get())
        .map_err(|error| {
            CommandError::EngineUnavailable(format!("WINDOWS_REAUTH_FAILED:{error}"))
        })?;
    if result != UserConsentVerificationResult::Verified {
        return Err(CommandError::InvalidInput(
            "Windows kullanıcı doğrulaması tamamlanmadı; yüksek risk onayı verilmedi".into(),
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn verify_windows_user_consent(_revision_hash: &str) -> Result<(), CommandError> {
    Err(CommandError::EngineUnavailable(
        "WINDOWS_REAUTH_UNAVAILABLE".into(),
    ))
}

fn chrono_like_iso(unix_ms: u128) -> Result<String, CommandError> {
    let seconds = unix_ms / 1_000;
    let millis = unix_ms % 1_000;
    let datetime = std::time::UNIX_EPOCH
        .checked_add(std::time::Duration::from_secs(seconds as u64))
        .and_then(|value| value.checked_add(std::time::Duration::from_millis(millis as u64)))
        .ok_or_else(|| CommandError::InvalidInput("local clock is out of range".into()))?;
    let system_time = datetime
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| CommandError::InvalidInput("local clock is before epoch".into()))?;
    // The engine accepts exact UTC ISO strings. Use a small, dependency-free
    // Gregorian conversion so the desktop does not need a time crate.
    let days = (system_time.as_secs() / 86_400) as i64;
    let day_seconds = system_time.as_secs() % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = day_seconds / 3_600;
    let minute = (day_seconds % 3_600) / 60;
    let second = day_seconds % 60;
    Ok(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{:03}Z",
        system_time.subsec_millis()
    ))
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    (year, m, d)
}

/// Takes human consent first and reads the compare-and-set version afterwards.
/// The Windows confirmation dialog blocks for as long as the reviewer takes, so a
/// version captured before it opened is stale by the time the command is sent: any
/// background engine activity during the wait turned a granted approval into
/// VERSION_CONFLICT.
fn command_after_consent<C, V, B>(
    consent: C,
    read_version: V,
    build: B,
) -> Result<Value, CommandError>
where
    C: FnOnce() -> Result<(), CommandError>,
    V: FnOnce() -> Result<u64, CommandError>,
    B: FnOnce(u64) -> Result<Value, CommandError>,
{
    consent()?;
    build(read_version()?)
}

#[tauri::command(async)]
pub fn approve_revision(
    revision_id: String,
    expected_hash: String,
    warning_set_hash: String,
    package_version: u8,
    attestation: Value,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    if package_version != 3 {
        return Err(CommandError::InvalidInput("REVISION_REVIEW_UPGRADE_REQUIRED".into()));
    }
    let inspection_version = read_engine_state(&bridge)?
        .pointer("/snapshot/serverCursor")
        .and_then(Value::as_u64)
        .ok_or_else(|| CommandError::EngineUnavailable("STATE_VERSION_MISSING".into()))?;
    let materialization = read_revision_at_version(&bridge, inspection_version, &revision_id)?;
    if materialization
        .pointer("/revision/packageVersion")
        .and_then(Value::as_u64)
        != Some(3)
    {
        return Err(CommandError::InvalidInput("REVISION_REVIEW_UPGRADE_REQUIRED".into()));
    }
    validate_editorial_attestation_for_revision_v3(&materialization, &attestation)?;
    let command = command_after_consent(
        || {
            authorize_native_confirmation(
                "İncelediğiniz içerik revizyonunu onayla",
                &expected_hash,
                verify_native_confirmation,
            )
        },
        || {
            read_engine_state(&bridge)?
                .pointer("/snapshot/serverCursor")
                .and_then(Value::as_u64)
                .ok_or_else(|| CommandError::EngineUnavailable("STATE_VERSION_MISSING".into()))
        },
        |expected_version| {
            build_approval_command(
                &revision_id,
                &expected_hash,
                &warning_set_hash,
                &attestation,
                expected_version,
            )
        },
    )?;
    let expected_version = command
        .get("expectedVersion")
        .and_then(Value::as_u64)
        .ok_or(CommandError::StateUnavailable)?;
    let request_id = command
        .get("requestId")
        .and_then(Value::as_str)
        .ok_or(CommandError::StateUnavailable)?
        .to_string();
    let response = engine_request(
        &bridge,
        json!({
            "version": 1,
            "id": request_id,
            "kind": "command",
            "command": command
        }),
    )?;
    let approval = response
        .pointer("/result/value")
        .cloned()
        .ok_or_else(|| CommandError::EngineUnavailable("APPROVAL_SHAPE_INVALID".into()))?;
    // Approval advances the engine cursor. Re-read the cursor after the mutation
    // instead of asking the immutable materializer for the pre-approval snapshot.
    let committed_version = read_engine_state(&bridge)?
        .pointer("/snapshot/serverCursor")
        .and_then(Value::as_u64)
        .ok_or_else(|| CommandError::EngineUnavailable("STATE_VERSION_MISSING".into()))?;
    if committed_version < expected_version {
        return Err(CommandError::EngineUnavailable(
            "APPROVAL_CURSOR_REGRESSED".into(),
        ));
    }
    let materialization = read_revision_at_version(&bridge, committed_version, &revision_id)
        .map_err(|error| match error {
            CommandError::InvalidInput(_) => {
                CommandError::EngineUnavailable("APPROVED_REVISION_MISSING".into())
            }
            other => other,
        })?;
    let review_revision = build_review_revision(&materialization)?;
    Ok(json!({
        "approvedAt": approval.get("approvedAt").cloned().unwrap_or(Value::Null),
        "revisionHash": approval.get("revisionHash").cloned().unwrap_or(Value::Null),
        "state": review_revision.get("state").cloned().unwrap_or(json!("REVIEW_REQUIRED"))
    }))
}

#[tauri::command(async)]
pub fn revoke_revision_approval(
    revision_id: String,
    expected_hash: String,
    reason: String,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    let command = command_after_consent(
        || {
            authorize_native_confirmation(
                "Revizyon onayını geri çek",
                &expected_hash,
                verify_native_confirmation,
            )
        },
        || {
            read_engine_state(&bridge)?
                .pointer("/snapshot/serverCursor")
                .and_then(Value::as_u64)
                .ok_or_else(|| CommandError::EngineUnavailable("STATE_VERSION_MISSING".into()))
        },
        |expected_version| {
            build_approval_revoke_command(
                &revision_id,
                &expected_hash,
                &reason,
                expected_version,
            )
        },
    )?;
    let request_id = command
        .get("requestId")
        .and_then(Value::as_str)
        .ok_or(CommandError::StateUnavailable)?
        .to_string();
    let response = engine_request(
        &bridge,
        json!({ "version": 1, "id": request_id, "kind": "command", "command": command }),
    )?;
    let result = response
        .pointer("/result/value")
        .ok_or_else(|| CommandError::EngineUnavailable("APPROVAL_REVOCATION_SHAPE_INVALID".into()))?;
    let revocation = result
        .get("revocation")
        .ok_or_else(|| CommandError::EngineUnavailable("APPROVAL_REVOCATION_SHAPE_INVALID".into()))?;
    Ok(json!({
        "revokedAt": revocation.get("revokedAt").cloned().unwrap_or(Value::Null),
        "revisionHash": revocation.get("revisionHash").cloned().unwrap_or(Value::Null),
        "state": "REVIEW_REQUIRED",
        "recalledEffectIds": result.get("recalledEffectIds").cloned().unwrap_or_else(|| json!([]))
    }))
}

fn authorize_high_risk_consent<F>(
    confirm_reauthenticated: bool,
    secure_store_ready: bool,
    expected_hash: &str,
    verifier: F,
) -> Result<(), CommandError>
where
    F: FnOnce(&str) -> Result<(), CommandError>,
{
    if !confirm_reauthenticated {
        return Err(CommandError::InvalidInput(
            "Windows yeniden doğrulaması açıkça onaylanmalı".into(),
        ));
    }
    if !secure_store_ready {
        return Err(CommandError::EngineUnavailable(
            "SECURE_STORE_NOT_READY".into(),
        ));
    }
    verifier(expected_hash)
}

#[tauri::command(async)]
pub fn approve_high_risk_revision(
    request: HighRiskApprovalRequest,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
    app: tauri::AppHandle,
) -> Result<Value, CommandError> {
    let HighRiskApprovalRequest {
        revision_id,
        expected_hash,
        warning_set_hash,
        confirm_reauthenticated,
    } = request;
    ensure_mutation_allowed(&state)?;
    authorize_high_risk_consent(
        confirm_reauthenticated,
        secure_store::status(&app).ready,
        &expected_hash,
        verify_windows_user_consent,
    )?;
    let engine_state = read_engine_state(&bridge)?;
    let expected_version = engine_state
        .pointer("/snapshot/serverCursor")
        .and_then(Value::as_u64)
        .ok_or_else(|| CommandError::EngineUnavailable("STATE_VERSION_MISSING".into()))?;
    let risk_checklist_hash = trusted_high_risk_checklist_hash(
        &bridge,
        expected_version,
        &revision_id,
    )?;
    let command = build_high_risk_approval_command(
        &revision_id,
        &expected_hash,
        &risk_checklist_hash,
        &warning_set_hash,
        expected_version,
    )?;
    let request_id = command
        .get("requestId")
        .and_then(Value::as_str)
        .ok_or(CommandError::StateUnavailable)?
        .to_string();
    let response = engine_request(
        &bridge,
        json!({ "version": 1, "id": request_id, "kind": "command", "command": command }),
    )?;
    response
        .pointer("/result/value")
        .cloned()
        .ok_or_else(|| CommandError::EngineUnavailable("HIGH_RISK_APPROVAL_SHAPE_INVALID".into()))
}

/// Publication is always a durable enqueue. GitHub reconciliation belongs only
/// to the native background drainer because its round trips may block.
fn ensure_publishing_active(publishing_paused: bool) -> Result<(), CommandError> {
    if publishing_paused {
        return Err(CommandError::EngineUnavailable("PUBLISHING_PAUSED".into()));
    }
    Ok(())
}

fn persist_publication_enqueue<F>(request: Value, mut persist: F) -> Result<Value, CommandError>
where
    F: FnMut(Value) -> Result<Value, CommandError>,
{
    persist(request)?
        .get("value")
        .cloned()
        .ok_or_else(|| CommandError::EngineUnavailable("PUBLICATION_ENQUEUE_SHAPE_INVALID".into()))
}

#[tauri::command(async)]
pub fn enqueue_publication(
    revision_id: String,
    revision_hash: String,
    preview_hash: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    let publishing_paused = read_lock(&state.publishing_paused)
        .map(|flag| *flag)
        .unwrap_or(true);
    ensure_publishing_active(publishing_paused)?;
    if revision_id.trim().is_empty()
        || !revision_hash.chars().all(|value| value.is_ascii_hexdigit())
        || revision_hash.len() != 64
        || !preview_hash.chars().all(|value| value.is_ascii_hexdigit())
        || preview_hash.len() != 64
    {
        return Err(CommandError::InvalidInput(
            "revizyon kimliği, tam revizyon özeti ve yayın önizleme özeti gerekir".into(),
        ));
    }
    let connector_mode = read_engine_local_state(&bridge, "desktop.connectors")
        .and_then(|value| {
            value
                .pointer("/site/mode")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "LOCAL_ONLY".to_string());
    if connector_mode == "PUBLISH" {
        let token_path = github_token_path(&app)?;
        require_github_publication_readiness(
            state.github_broker.publication_readiness(&token_path),
        )?;
        configured_github_repository(&bridge).ok_or_else(|| {
            CommandError::EngineUnavailable("GITHUB_REPOSITORY_NOT_CONFIGURED".into())
        })?;
    }
    let version = read_engine_state(&bridge)?
        .pointer("/snapshot/serverCursor")
        .and_then(Value::as_u64)
        .ok_or_else(|| CommandError::EngineUnavailable("STATE_VERSION_MISSING".into()))?;
    // The engine fingerprints publication.enqueue with previewHash and
    // expectedVersion, so both belong in the key. Without them a re-preview or a
    // retry after a lost response reached the engine as the same key with a
    // different request and was rejected outright.
    let idempotency_key = stable_source_key(&format!(
        "publication:{revision_id}:{revision_hash}:{preview_hash}:{version}"
    ));
    persist_publication_enqueue(
        json!({
            "version": 1,
            "id": idempotency_key,
            "kind": "publication.enqueue",
            "revisionId": revision_id,
            "revisionHash": revision_hash,
            "previewHash": preview_hash,
            "expectedVersion": version,
            "idempotencyKey": idempotency_key
        }),
        |request| engine_request(&bridge, request),
    )
}

fn reconcile_pending_publications<F>(effect_ids: &[Value], mut reconcile: F)
where
    F: FnMut(&str) -> Result<Value, String>,
{
    for effect_id in effect_ids.iter().filter_map(Value::as_str).take(16) {
        match reconcile(effect_id) {
            Ok(_) => clear_broker_fault(effect_id),
            Err(error) => record_broker_fault(effect_id, &error),
        }
    }
}

pub fn start_native_publication_drainer(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(30));
        let state = app.state::<DesktopState>();
        if read_lock(&state.publishing_paused)
            .map(|value| *value)
            .unwrap_or(true)
        {
            continue;
        }
        // The durable outbox exists to finish already-approved publications, so
        // this loop is not gated on mutation permission. It must still stop once
        // Doctor has put the desktop into the offline projection: every UI action
        // is refused in that state, and pushing commits from a background tick
        // would contradict it.
        if read_lock(&state.runtime)
            .map(|value| matches!(*value, RuntimeMode::OfflineReadOnly))
            .unwrap_or(true)
        {
            continue;
        }
        let bridge = app.state::<EngineBridge>();
        let trusted_repository = match configured_github_repository(&bridge) {
            Some(repository) => repository,
            None => continue,
        };
        let token_path = match github_token_path(&app) {
            Ok(path) if path.is_file() => path,
            _ => continue,
        };
        let pending = match engine_request(
            &bridge,
            json!({
                "version": 1,
                "id": format!(
                    "native-pending-{}",
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis()
                ),
                "kind": "publication.broker.pending"
            }),
        ) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let effect_ids = pending
            .pointer("/value/effectIds")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let effects = state
            .github_broker
            .publication_effects(&token_path, &trusted_repository);
        reconcile_pending_publications(&effect_ids, |effect_id| {
            drive_publication_broker(effect_id, |request| bridge.request(request), &effects)
        });
    });
}

/// Bounded, token-free record of background broker faults. The drainer used to
/// drop every error, so a rejected claim or a lost completion left no trace at
/// all — not in the log and not in the diagnostics bundle.
static BROKER_FAULTS: OnceLock<Mutex<Vec<(String, String, u32)>>> = OnceLock::new();
const MAX_BROKER_FAULTS: usize = 16;

fn broker_faults() -> &'static Mutex<Vec<(String, String, u32)>> {
    BROKER_FAULTS.get_or_init(|| Mutex::new(Vec::new()))
}

/// Keeps only the leading constant error code. Broker errors can carry engine
/// sentences, and the diagnostics bundle must never grow a token-shaped value.
fn broker_fault_code(error: &str) -> String {
    error
        .split(|character: char| character == ':' || character.is_whitespace())
        .find(|token| {
            !token.is_empty()
                && token
                    .chars()
                    .all(|character| character.is_ascii_uppercase() || character == '_')
        })
        .unwrap_or("PUBLICATION_BROKER_FAILED")
        .to_string()
}

fn record_broker_fault(effect_id: &str, error: &str) {
    let code = broker_fault_code(error);
    let Ok(mut faults) = broker_faults().lock() else {
        return;
    };
    if let Some(entry) = faults
        .iter_mut()
        .find(|entry| entry.0 == effect_id && entry.1 == code)
    {
        entry.2 = entry.2.saturating_add(1);
        return;
    }
    if faults.len() >= MAX_BROKER_FAULTS {
        faults.remove(0);
    }
    faults.push((effect_id.to_string(), code, 1));
}

fn clear_broker_fault(effect_id: &str) {
    if let Ok(mut faults) = broker_faults().lock() {
        faults.retain(|entry| entry.0 != effect_id);
    }
}

fn broker_fault_report() -> Vec<Value> {
    broker_faults()
        .lock()
        .map(|faults| {
            faults
                .iter()
                .map(|(effect_id, code, count)| {
                    json!({
                        "effectId": effect_id,
                        "code": code,
                        "consecutiveFailures": count
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
struct PreviewMaterializationFile {
    destination: PathBuf,
    content: Vec<u8>,
    backup: Option<PathBuf>,
}

fn preview_file_bytes(file: &Value) -> Result<Vec<u8>, CommandError> {
    let content = file.get("content").ok_or_else(|| {
        CommandError::EngineUnavailable("PUBLICATION_FILE_CONTENT_MISSING".into())
    })?;
    if let Some(text) = content.as_str() {
        return Ok(text.as_bytes().to_vec());
    }
    let values: Vec<&Value> = if let Some(values) = content.as_array() {
        values.iter().collect()
    } else if let Some(object) = content.as_object() {
        let mut indexed = object
            .iter()
            .map(|(index, value)| {
                index
                    .parse::<usize>()
                    .map(|index| (index, value))
                    .map_err(|_| {
                        CommandError::EngineUnavailable("PUBLICATION_FILE_CONTENT_INVALID".into())
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        indexed.sort_by_key(|(index, _)| *index);
        if indexed
            .iter()
            .enumerate()
            .any(|(expected, (actual, _))| expected != *actual)
        {
            return Err(CommandError::EngineUnavailable(
                "PUBLICATION_FILE_CONTENT_INVALID".into(),
            ));
        }
        indexed.into_iter().map(|(_, value)| value).collect()
    } else {
        return Err(CommandError::EngineUnavailable(
            "PUBLICATION_FILE_CONTENT_INVALID".into(),
        ));
    };
    values
        .into_iter()
        .map(|value| {
            value
                .as_u64()
                .filter(|value| *value <= u8::MAX as u64)
                .map(|value| value as u8)
                .ok_or_else(|| {
                    CommandError::EngineUnavailable("PUBLICATION_FILE_CONTENT_INVALID".into())
                })
        })
        .collect()
}

/// `symlink_metadata` alone is insufficient on Windows: directory junctions
/// are reparse points but are not always reported as symbolic links. Reject
/// both forms before a local preview can touch an untrusted path.
#[cfg(test)]
fn is_reparse_point(path: &Path) -> std::io::Result<bool> {
    #[cfg(windows)]
    {
        use std::iter::once;
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::{
            GetFileAttributesW, FILE_ATTRIBUTE_REPARSE_POINT, INVALID_FILE_ATTRIBUTES,
        };

        let wide = path
            .as_os_str()
            .encode_wide()
            .chain(once(0))
            .collect::<Vec<_>>();
        // SAFETY: the buffer is NUL-terminated and lives for the duration of
        // the synchronous Win32 call.
        let attributes = unsafe { GetFileAttributesW(PCWSTR(wide.as_ptr())) };
        if attributes == INVALID_FILE_ATTRIBUTES {
            return Err(std::io::Error::last_os_error());
        }
        Ok(attributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Ok(false)
    }
}

const ENGINE_MEDIA_CHUNK_BYTES: u64 = 64 * 1024;
const ENGINE_MEDIA_MAX_BYTES: u64 = 32 * 1024 * 1024;

fn preview_file_media_reference(
    content: &Value,
    revision_id: &str,
) -> Result<Option<(String, u64)>, CommandError> {
    if content.get("kind").and_then(Value::as_str) != Some("engine-media-ref") {
        return Ok(None);
    }
    let reference_revision = content
        .get("revisionId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let sha256 = content
        .get("sha256")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let byte_size = content
        .get("byteSize")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    if reference_revision != revision_id
        || sha256.len() != 64
        || !sha256.chars().all(|value| value.is_ascii_hexdigit())
        || byte_size == 0
        || byte_size > ENGINE_MEDIA_MAX_BYTES
    {
        return Err(CommandError::EngineUnavailable(
            "PUBLICATION_MEDIA_REFERENCE_INVALID".into(),
        ));
    }
    Ok(Some((sha256.to_ascii_lowercase(), byte_size)))
}

/// A record-supplied `byteSize` must be inside the engine media bound before it
/// can size an allocation: `Vec::with_capacity` on a corrupt value aborts the
/// process outright, because the release profile disables unwinding.
fn bounded_media_size(expected_size: u64) -> Result<u64, CommandError> {
    if expected_size == 0 || expected_size > ENGINE_MEDIA_MAX_BYTES {
        return Err(CommandError::EngineUnavailable(
            "REVISION_MEDIA_SIZE_INVALID".into(),
        ));
    }
    Ok(expected_size)
}

fn read_engine_media_bytes(
    bridge: &EngineBridge,
    revision_id: &str,
    sha256: &str,
    expected_size: u64,
) -> Result<Vec<u8>, CommandError> {
    let expected_size = bounded_media_size(expected_size)?;
    let mut output = Vec::with_capacity(expected_size as usize);
    let mut offset = 0u64;
    loop {
        let response = engine_request(
            bridge,
            json!({
                "version": 1,
                "id": format!("desktop-media-read:{revision_id}:{sha256}:{offset}"),
                "kind": "media.read",
                "revisionId": revision_id,
                "sha256": sha256,
                "offset": offset,
                "length": ENGINE_MEDIA_CHUNK_BYTES
            }),
        )?;
        let value = response
            .get("value")
            .ok_or_else(|| CommandError::EngineUnavailable("MEDIA_READ_SHAPE_INVALID".into()))?;
        let returned_offset = value.get("offset").and_then(Value::as_u64);
        let total = value.get("totalBytes").and_then(Value::as_u64);
        let encoded = value.get("contentBase64").and_then(Value::as_str);
        let eof = value.get("eof").and_then(Value::as_bool);
        if returned_offset != Some(offset) || total != Some(expected_size) || eof.is_none() {
            return Err(CommandError::EngineUnavailable(
                "MEDIA_READ_SHAPE_INVALID".into(),
            ));
        }
        let chunk = base64::engine::general_purpose::STANDARD
            .decode(encoded.unwrap_or_default())
            .map_err(|_| CommandError::EngineUnavailable("MEDIA_READ_ENCODING_INVALID".into()))?;
        if chunk.is_empty() && eof != Some(true) {
            return Err(CommandError::EngineUnavailable("MEDIA_READ_STALLED".into()));
        }
        output.extend_from_slice(&chunk);
        offset = offset
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| CommandError::EngineUnavailable("MEDIA_READ_SIZE_INVALID".into()))?;
        if offset > expected_size {
            return Err(CommandError::EngineUnavailable(
                "MEDIA_READ_SIZE_INVALID".into(),
            ));
        }
        if eof == Some(true) {
            break;
        }
    }
    if output.len() as u64 != expected_size {
        return Err(CommandError::EngineUnavailable(
            "MEDIA_READ_SIZE_INVALID".into(),
        ));
    }
    let actual = format!("{:x}", Sha256::digest(&output));
    if actual != sha256 {
        return Err(CommandError::EngineUnavailable(
            "MEDIA_READ_INTEGRITY_FAILURE".into(),
        ));
    }
    Ok(output)
}

#[cfg(test)]
fn materialize_preview_bundle_with<F>(
    root: &Path,
    files: &[(String, Vec<u8>)],
    backup_root: &Path,
    mut write_file: F,
) -> Result<usize, CommandError>
where
    F: FnMut(&Path, &[u8]) -> std::io::Result<()>,
{
    let mut validated = Vec::with_capacity(files.len());
    for (relative, content) in files {
        if relative.is_empty()
            || relative.contains('\\')
            || relative
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(CommandError::InvalidInput(
                "önizleme içinde güvensiz dosya yolu var".into(),
            ));
        }
        let destination = root.join(relative);
        if !destination.starts_with(root) {
            return Err(CommandError::InvalidInput(
                "dosya yolu hedef klasör dışına çıkıyor".into(),
            ));
        }
        let mut ancestor = destination.parent();
        while let Some(path) = ancestor {
            if path == root {
                break;
            }
            if let Ok(metadata) = std::fs::symlink_metadata(path) {
                if metadata.file_type().is_symlink()
                    || !metadata.is_dir()
                    || is_reparse_point(path).unwrap_or(true)
                {
                    return Err(CommandError::InvalidInput(
                        "hedef klasörde güvenli olmayan bir yol var".into(),
                    ));
                }
            }
            ancestor = path.parent();
        }
        let backup = if destination.exists() {
            let metadata = std::fs::symlink_metadata(&destination)
                .map_err(|_| CommandError::InvalidInput("hedef dosya doğrulanamadı".into()))?;
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || is_reparse_point(&destination).unwrap_or(true)
            {
                return Err(CommandError::InvalidInput(
                    "hedefteki dosya güvenli değil".into(),
                ));
            }
            Some(backup_root.join(relative))
        } else {
            None
        };
        validated.push(PreviewMaterializationFile {
            destination,
            content: content.clone(),
            backup,
        });
    }

    // Stage every original before writing anything so a backup failure cannot
    // leave a partly materialized project behind.
    for file in &validated {
        if let Some(backup) = &file.backup {
            if let Some(parent) = backup.parent() {
                std::fs::create_dir_all(parent).map_err(|_| {
                    CommandError::EngineUnavailable("yerel geri alma alanı hazırlanamadı".into())
                })?;
            }
            std::fs::copy(&file.destination, backup).map_err(|_| {
                CommandError::EngineUnavailable("yerel geri alma kopyası oluşturulamadı".into())
            })?;
        }
    }

    let mut applied = Vec::new();
    for file in &validated {
        if let Some(parent) = file.destination.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                rollback_preview_bundle(&applied);
                return Err(CommandError::EngineUnavailable(
                    "yerel önizleme yazımı geri alındı".into(),
                ));
            }
        }
        // Register before invoking the writer: a replacement can fail after
        // removing the old destination but before its rename completes.
        applied.push((file.destination.clone(), file.backup.clone()));
        if write_file(&file.destination, &file.content).is_err() {
            rollback_preview_bundle(&applied);
            return Err(CommandError::EngineUnavailable(
                "yerel önizleme yazımı geri alındı".into(),
            ));
        }
    }
    Ok(validated.len())
}

#[cfg(test)]
fn rollback_preview_bundle(applied: &[(PathBuf, Option<PathBuf>)]) {
    for (destination, backup) in applied.iter().rev() {
        let _ = std::fs::remove_file(destination);
        if let Some(backup) = backup {
            let _ = std::fs::copy(backup, destination);
        }
    }
}

/// Writes only the exact, already approved preview bundle into the user's
/// selected local project. The WebView never supplies file contents or paths.
#[tauri::command(async)]
pub fn materialize_local_preview(
    revision_id: String,
    revision_hash: String,
    preview_hash: String,
    target_directory: String,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    if revision_id.trim().is_empty()
        || !revision_hash.chars().all(|value| value.is_ascii_hexdigit())
        || revision_hash.len() != 64
        || !preview_hash.chars().all(|value| value.is_ascii_hexdigit())
        || preview_hash.len() != 64
        || !is_local_path(&target_directory)
    {
        return Err(CommandError::InvalidInput(
            "approved revision, preview hash ve yerel hedef klasör gerekir".into(),
        ));
    }
    let root = require_granted_directory(&state, &target_directory)?;
    // Setup persists the selected site in the encrypted connector catalog.
    // Retain the former key as a read-only migration fallback.
    let configured_root = read_engine_local_state(&bridge, "desktop.connectors")
        .and_then(|value| {
            value
                .pointer("/site/repositoryPath")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .or_else(|| {
            read_engine_local_state(&bridge, "connector.site").and_then(|value| {
                value
                    .get("repositoryPath")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
        })
        .ok_or_else(|| {
            CommandError::InvalidInput("önce Kurulum Merkezi'nden site klasörünü kaydedin".into())
        })?;
    let configured_root = std::fs::canonicalize(configured_root).map_err(|error| {
        CommandError::InvalidInput(format!("kayıtlı site klasörü okunamadı: {error}"))
    })?;
    if root != configured_root {
        return Err(CommandError::InvalidInput(
            "yalnız Kurulum Merkezi'nde seçilen site klasörüne yazılabilir".into(),
        ));
    }
    let state_value =
        read_engine_local_state(&bridge, &format!("publication.preview:{revision_id}"))
            .ok_or_else(|| CommandError::EngineUnavailable("PUBLICATION_PREVIEW_MISSING".into()))?;
    let preview_now_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    if state_value.get("revisionHash").and_then(Value::as_str) != Some(revision_hash.as_str())
        || state_value.get("previewHash").and_then(Value::as_str) != Some(preview_hash.as_str())
        || state_value
            .get("expiresAtUnixMs")
            .and_then(Value::as_u64)
            .is_none_or(|expires_at| u128::from(expires_at) <= preview_now_unix_ms)
    {
        return Err(CommandError::InvalidInput(
            "önizleme artık onaylı revizyonla eşleşmiyor".into(),
        ));
    }
    let snapshot = read_engine_state(&bridge)?;
    let revision = snapshot
        .pointer("/snapshot/revisions")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(revision_id.as_str()))
        })
        .ok_or_else(|| CommandError::InvalidInput("onaylı revizyon bulunamadı".into()))?;
    if !matches!(
        revision.get("state").and_then(Value::as_str),
        Some("REVIEW_REQUIRED" | "APPROVED" | "PR_READY" | "SCHEDULED")
    ) {
        return Err(CommandError::InvalidInput(
            "revizyon yayınlanabilir durumda değil".into(),
        ));
    }
    let parity_ready = revision
        .pointer("/translationParity/status")
        .and_then(Value::as_str)
        == Some("MATCHED");
    if !parity_ready {
        return Err(CommandError::InvalidInput(
            "TR/EN doğruluk eşleşmesi tamamlanmadan yazılamaz".into(),
        ));
    }
    let claims_ready = revision
        .get("claims")
        .and_then(Value::as_array)
        .is_some_and(|claims| {
            claims.iter().all(|claim| {
                claim.get("status").and_then(Value::as_str) == Some("VERIFIED")
                    && claim
                        .get("evidenceAnchors")
                        .and_then(Value::as_array)
                        .is_some_and(|anchors| {
                            !anchors.is_empty()
                                && anchors.iter().all(|anchor| {
                                    anchor.get("quoteHash").and_then(Value::as_str).is_some_and(
                                        |hash| {
                                            hash.len() == 64
                                                && hash
                                                    .chars()
                                                    .all(|value| value.is_ascii_hexdigit())
                                        },
                                    )
                                })
                        })
            })
        });
    if !claims_ready {
        return Err(CommandError::InvalidInput(
            "kaynak kanıtları doğrulanmadan yazılamaz".into(),
        ));
    }
    let approved = snapshot
        .pointer("/snapshot/approvals")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                item.get("revisionId").and_then(Value::as_str) == Some(revision_id.as_str())
                    && item.get("revisionHash").and_then(Value::as_str)
                        == Some(revision_hash.as_str())
            })
        });
    if !approved {
        return Err(CommandError::InvalidInput(
            "yerel klasöre yazmak için insan onayı gerekir".into(),
        ));
    }
    if revision.get("riskLevel").and_then(Value::as_str) == Some("HIGH") {
        let high_risk = snapshot
            .pointer("/snapshot/highRiskApprovals")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items.iter().any(|item| {
                    item.get("revisionId").and_then(Value::as_str) == Some(revision_id.as_str())
                        && item.get("revisionHash").and_then(Value::as_str)
                            == Some(revision_hash.as_str())
                })
            });
        if !high_risk {
            return Err(CommandError::InvalidInput(
                "yüksek riskli yazı için ikinci onay gerekir".into(),
            ));
        }
    }
    let files = state_value
        .pointer("/payload/files")
        .and_then(Value::as_array)
        .ok_or_else(|| CommandError::EngineUnavailable("PUBLICATION_FILES_MISSING".into()))?;
    let backup_root = root
        .join(".blogbot")
        .join("backups")
        .join(&preview_hash[..12]);
    let bundle = files
        .iter()
        .map(|file| {
            let path = file
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    CommandError::EngineUnavailable("PUBLICATION_FILE_PATH_INVALID".into())
                })?
                .to_owned();
            let content = file.get("content").ok_or_else(|| {
                CommandError::EngineUnavailable("PUBLICATION_FILE_CONTENT_MISSING".into())
            })?;
            let bytes = match preview_file_media_reference(content, &revision_id)? {
                Some((sha256, byte_size)) => {
                    read_engine_media_bytes(&bridge, &revision_id, &sha256, byte_size)?
                }
                None => preview_file_bytes(file)?,
            };
            Ok((path, bytes))
        })
        .collect::<Result<Vec<_>, CommandError>>()?;
    let backup_prefix = format!(".blogbot/backups/{}", &preview_hash[..12]);
    let written = crate::secure_preview_fs::materialize(&root, &bundle, &backup_prefix)
        .map_err(|_| CommandError::EngineUnavailable("yerel önizleme yazımı geri alındı".into()))?;
    Ok(
        json!({"written": written, "targetDirectory": root, "backupDirectory": if written > 0 { Some(backup_root) } else { None::<std::path::PathBuf> }}),
    )
}

#[tauri::command(async)]
pub fn preview_publication(
    revision_id: String,
    revision_hash: String,
    payload: Value,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    if revision_id.trim().is_empty()
        || !revision_id.split('-').all(|segment| {
            !segment.is_empty() && segment.chars().all(|value| value.is_ascii_alphanumeric())
        })
        || !revision_hash.chars().all(|value| value.is_ascii_hexdigit())
        || revision_hash.len() != 64
    {
        return Err(CommandError::InvalidInput(
            "revision id and exact revision hash are required".into(),
        ));
    }
    if !payload.is_object() {
        return Err(CommandError::InvalidInput(
            "publication preview payload must be an object".into(),
        ));
    }
    let mut preview_payload = payload;
    if let Some(object) = preview_payload.as_object_mut() {
        // The editor supplies only the immutable bundle. Target details come
        // from the locally saved, non-secret site/GitHub connector metadata.
        // Never invent a host or repository: an unconfigured site remains
        // blocked by the engine's connector validation.
        if let Some(connectors) = read_engine_local_state(&bridge, "desktop.connectors") {
            if object
                .get("siteOrigin")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .is_empty()
            {
                if let Some(origin) = configured_site_origin(&connectors) {
                    object.insert("siteOrigin".into(), Value::String(origin));
                }
            }
            if object
                .get("targetRepository")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .is_empty()
            {
                let owner = connectors
                    .pointer("/github/owner")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let repository = connectors
                    .pointer("/github/repository")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !owner.is_empty() && !repository.is_empty() {
                    object.insert(
                        "targetRepository".into(),
                        Value::String(format!("{owner}/{repository}")),
                    );
                }
            }
            if object
                .get("baseBranch")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .is_empty()
            {
                object.insert("baseBranch".into(), Value::String("main".into()));
            }
            if object
                .get("contentRoot")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .is_empty()
            {
                // The publisher's contentRoot is a logical deployment root,
                // not the user's Windows checkout path. Keep it generic and
                // POSIX-safe; the actual site adapter owns its file layout.
                if object.get("siteOrigin").and_then(Value::as_str).is_some()
                    && object
                        .get("targetRepository")
                        .and_then(Value::as_str)
                        .is_some()
                {
                    object.insert("contentRoot".into(), Value::String("/site".into()));
                }
            }
        }
    }
    let version = read_engine_state(&bridge)?
        .pointer("/snapshot/serverCursor")
        .and_then(Value::as_u64)
        .ok_or_else(|| CommandError::EngineUnavailable("STATE_VERSION_MISSING".into()))?;
    let idempotency_key = stable_source_key(&format!(
        "publication-preview:{revision_id}:{revision_hash}:{}",
        serde_json::to_string(&preview_payload)
            .map_err(|error| CommandError::InvalidInput(error.to_string()))?
    ));
    let response = engine_request(
        &bridge,
        json!({
            "version": 1,
            "id": idempotency_key,
            "kind": "publication.preview",
            "revisionId": revision_id,
            "revisionHash": revision_hash,
            "expectedVersion": version,
            "idempotencyKey": idempotency_key,
            "payload": preview_payload
        }),
    )?;
    let value = response.get("value").cloned().ok_or_else(|| {
        CommandError::EngineUnavailable("PUBLICATION_PREVIEW_SHAPE_INVALID".into())
    })?;
    if value.get("previewHash").and_then(Value::as_str).is_none() {
        return Err(CommandError::EngineUnavailable(
            "PUBLICATION_PREVIEW_HASH_MISSING".into(),
        ));
    }
    Ok(value)
}

fn operations_job_is_visible_work(job: &Value) -> bool {
    matches!(
        job.get("state").and_then(Value::as_str),
        Some("QUEUED" | "RUNNING" | "RETRY_SCHEDULED" | "WAITING_CODEX")
    ) && job.pointer("/metadata/purpose").and_then(Value::as_str) != Some("BOBY_GUIDANCE")
}

#[tauri::command(async)]
pub fn get_operations(
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    if let Some(snapshot) = operations_for_runtime(*read_lock(&state.runtime)?) {
        return Ok(snapshot);
    }
    let state = read_engine_state(&bridge)?;
    let jobs = state
        .pointer("/snapshot/jobs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let outbox = state
        .pointer("/snapshot/outbox")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let changes = state
        .pointer("/snapshot/changes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut events: Vec<Value> = changes
        .iter()
        .rev()
        .take(20)
        .filter_map(|change| {
            let cursor = change.get("cursor")?.as_u64()?;
            let kind = change.get("kind")?.as_str()?;
            let entity_id = change.get("entityId")?.as_str()?;
            Some(json!({
                "id": format!("change-{cursor}"),
                "at": format!("cursor:{cursor}"),
                "title": "Yerel kayıt güncellendi",
                "detail": format!("{kind} · {entity_id}"),
                "state": "SUCCESS",
                "level": "DEBUG",
                "correlationId": format!("cursor-{cursor}")
            }))
        })
        .collect();
    let editorial_mutations = read_engine_local_state(&bridge, "desktop.editorial")
        .and_then(|value| value.get("mutations").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    events.splice(0..0, editorial_operation_events(&editorial_mutations));
    for job in jobs.iter().filter(|job| {
        matches!(
            job.get("state").and_then(Value::as_str),
            Some("FAILED" | "DEAD_LETTER")
        )
    }) {
        let id = job
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("unknown-job");
        let state = job.get("state").and_then(Value::as_str).unwrap_or("FAILED");
        let detail = sanitize_operation_error(
            job.get("lastError")
                .and_then(Value::as_str)
                .unwrap_or("İş hata durumunda."),
        );
        events.insert(
            0,
            json!({
                "id": format!("job-{id}"),
                "at": "şimdi",
                "title": "İş başarısız",
                "detail": format!("{state} · {detail}"),
                "state": "BLOCKED",
                "level": "ERROR",
                "correlationId": id
            }),
        );
    }
    events.truncate(30);
    let queue_depth = jobs
        .iter()
        .filter(|job| operations_job_is_visible_work(job))
        .count();
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i128;
    let oldest_job_minutes = jobs
        .iter()
        .filter(|job| operations_job_is_visible_work(job))
        .filter_map(|job| {
            job.pointer("/metadata/lastQueuedAtUnixMs")
                .or_else(|| job.pointer("/metadata/createdAtUnixMs"))
                .and_then(Value::as_u64)
        })
        .map(|created| ((now_ms - created as i128).max(0) / 60_000) as u64)
        .max()
        .unwrap_or(0);
    let outbox_pending = outbox
        .iter()
        .filter(|effect| {
            matches!(
                effect.get("state").and_then(Value::as_str),
                Some("PENDING" | "IN_PROGRESS" | "UNKNOWN")
            )
        })
        .count();
    let revision_queue = build_revision_queue(&read_revision_list(&bridge).unwrap_or_default());
    let schedule = scheduled_operation_items(&revision_queue);
    let doctor = bridge.doctor().ok();
    let publisher_capable = doctor
        .as_ref()
        .and_then(|value| value.get("capabilities"))
        .map(has_publication_capability)
        .unwrap_or(false);
    let publisher_state = if !publisher_capable {
        "BLOCKED"
    } else if outbox_pending == 0 {
        "READY"
    } else {
        "PAUSED"
    };
    Ok(json!({
        "events": events,
        "schedule": schedule,
        "worker": {
            "state": "HEALTHY",
            "queueDepth": queue_depth,
            "oldestJobMinutes": oldest_job_minutes
        },
        "publisher": {
            "state": publisher_state,
            "outboxPending": outbox_pending,
            "lastReconciledAt": null
        }
    }))
}

// Operations is also the recovery screen. When the sidecar is closed it must
// remain usable for diagnostics instead of retrying encrypted state reads on
// every tab activation. The explicit local-engine test is the only recovery
// action that is allowed to re-probe the sidecar from this state.
fn operations_for_runtime(runtime: RuntimeMode) -> Option<Value> {
    if workspace_can_read_engine(runtime) {
        return None;
    }
    Some(json!({
        "events": [],
        "schedule": [],
        "worker": {
            "state": "OFFLINE",
            "queueDepth": 0,
            "oldestJobMinutes": 0
        },
        "publisher": {
            "state": "BLOCKED",
            "outboxPending": 0,
            "lastReconciledAt": Value::Null
        }
    }))
}

#[tauri::command(async)]
pub fn get_engine_diagnostics(
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    let path = bridge.diagnostic_log_path();
    let mut lines = read_recent_diagnostic_lines(path.as_deref());
    if let Some(error) = bridge.last_error() {
        lines.insert(0, format!("[bridge] {}", sanitize_operation_error(&error)));
    }
    let bridge_error = bridge
        .last_error()
        .map(|error| sanitize_operation_error(&error));
    Ok(json!({
        "path": path.and_then(|value| value.file_name().map(|name| name.to_string_lossy().into_owned())),
        "lines": lines,
        "bridgeError": bridge_error
    }))
}

fn diagnostic_bundle_path() -> Result<PathBuf, CommandError> {
    let root = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| CommandError::EngineUnavailable("LOCALAPPDATA bulunamadı".into()))?
        .join("Blogbot")
        .join("diagnostics");
    std::fs::create_dir_all(&root).map_err(|error| {
        CommandError::EngineUnavailable(format!("Tanılama klasörü açılamadı: {error}"))
    })?;
    // One-second granularity let two exports share a directory, and the log
    // copies below append, so each file received a second full copy while the
    // manifest reported the doubled byte counts as one run.
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| CommandError::EngineUnavailable(error.to_string()))?
        .as_millis();
    Ok(root.join(format!(
        "blogbot-diagnostics-{stamp}-{}",
        std::process::id()
    )))
}

fn reveal_diagnostic_directory(directory: &Path) -> Result<(), CommandError> {
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("explorer.exe");
        configure_hidden_command(&mut command);
        command.arg(directory);
        command.spawn().map_err(|error| {
            CommandError::EngineUnavailable(format!("Tanılama klasörü açılamadı: {error}"))
        })?;
    }
    Ok(())
}

fn write_redacted_diagnostic_copy(source: Option<&Path>, target: &Path) {
    let Some(source) = source else {
        return;
    };
    let Ok(text) = std::fs::read_to_string(source) else {
        return;
    };
    let redacted = text
        .lines()
        .map(redact_diagnostic_line)
        .collect::<Vec<_>>()
        .join("\n");
    append_diagnostic_text(target, &redacted, false);
}

/// `continued` distinguishes the first write to a bundle file from the further
/// rotations that are deliberately concatenated into it. A plain append truncated
/// nothing, so a second export into the same directory silently doubled every log.
fn append_diagnostic_text(target: &Path, text: &str, continued: bool) {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.create(true).write(true);
    if continued {
        options.append(true);
    } else {
        options.truncate(true);
    }
    if let Ok(mut file) = options.open(target) {
        let _ = writeln!(file, "{text}");
    }
}

fn write_diagnostic_lines<F>(source: Option<&Path>, target: &Path, continued: bool, include: F)
where
    F: Fn(&str) -> bool,
{
    let Some(source) = source else {
        return;
    };
    let Ok(text) = std::fs::read_to_string(source) else {
        return;
    };
    let redacted = text
        .lines()
        .filter(|line| include(line))
        .map(redact_diagnostic_line)
        .collect::<Vec<_>>()
        .join("\n");
    append_diagnostic_text(target, &redacted, continued);
}

fn diagnostic_file_size(path: &Path) -> u64 {
    std::fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

fn read_recent_diagnostic_lines(path: Option<&Path>) -> Vec<String> {
    let Some(path) = path else {
        return Vec::new();
    };
    let mut lines = Vec::new();
    for variant in crate::engine_bridge::diagnostic_log_variants(path).into_iter().rev() {
        if let Ok(text) = std::fs::read_to_string(variant) {
            lines.extend(text.lines().map(redact_diagnostic_line));
        }
    }
    lines.into_iter().rev().take(500).collect()
}

fn redact_diagnostic_line(line: &str) -> String {
    crate::engine_bridge::redact_diagnostic_for_persistence(line)
}

/// A one-way correlation stub for a title that must not leave the workspace.
fn diagnostic_title_digest(title: &str) -> String {
    format!("{:x}", Sha256::digest(title.as_bytes()))
        .chars()
        .take(12)
        .collect()
}

/// Projects the operations snapshot down to identifiers, states and timestamps.
/// The snapshot carries the schedule straight from the revision queue, whose
/// titles are the Turkish article headlines; splicing it verbatim put user article
/// text into a bundle whose manifest promised none was included. A short digest
/// keeps rows correlatable with the workspace without carrying the headline.
fn diagnostic_operations_projection(operations: &Value) -> Value {
    let events = operations
        .get("events")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|event| {
                    json!({
                        "id": event.get("id").cloned().unwrap_or(Value::Null),
                        "state": event.get("state").cloned().unwrap_or(Value::Null),
                        "level": event.get("level").cloned().unwrap_or(Value::Null),
                        "correlationId": event.get("correlationId").cloned().unwrap_or(Value::Null),
                        // The persistence redactor, not the user-facing collapse:
                        // event details are engine change kinds, entity ids and
                        // already-sanitized job errors, and support needs them
                        // readable.
                        "detail": event
                            .get("detail")
                            .and_then(Value::as_str)
                            .map(redact_diagnostic_line)
                            .map(Value::from)
                            .unwrap_or(Value::Null)
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let schedule = operations
        .get("schedule")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    json!({
                        "id": item.get("id").cloned().unwrap_or(Value::Null),
                        "section": item.get("section").cloned().unwrap_or(Value::Null),
                        "state": item.get("state").cloned().unwrap_or(Value::Null),
                        "at": item.get("at").cloned().unwrap_or(Value::Null),
                        "titleDigest": item
                            .get("title")
                            .and_then(Value::as_str)
                            .map(diagnostic_title_digest)
                            .map(Value::from)
                            .unwrap_or(Value::Null)
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({
        "events": events,
        "schedule": schedule,
        "worker": operations.get("worker").cloned().unwrap_or(Value::Null),
        "publisher": operations.get("publisher").cloned().unwrap_or(Value::Null)
    })
}

#[tauri::command(async)]
pub fn export_diagnostics(
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    let engine_path = bridge.diagnostic_log_path();
    let operations = get_operations(state, bridge.clone()).unwrap_or_else(|_| {
        json!({
            "events": [],
            "worker": {"state": "UNKNOWN"},
            "publisher": {"state": "UNKNOWN"}
        })
    });
    let payload = json!({
        "format": "blogbot-diagnostics-v1",
        "generatedAtUnixMs": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
        "runtime": {
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "engineRunning": bridge.is_running(),
            "bridgeError": bridge.last_error().map(|value| sanitize_operation_error(&value))
        },
        "operations": diagnostic_operations_projection(&operations),
        "publicationBrokerFaults": broker_fault_report(),
        "logs": {
            "engine": {
                "path": engine_path.as_ref().and_then(|value| value.file_name().map(|name| name.to_string_lossy().into_owned())),
                "lines": read_recent_diagnostic_lines(engine_path.as_deref())
            }
        },
        "notice": "Bu paket sır, anahtar, token ve ham kaynak metni içerecek şekilde tasarlanmamıştır."
    });
    let bytes = serde_json::to_vec_pretty(&payload)
        .map_err(|error| CommandError::EngineUnavailable(error.to_string()))?;
    let directory = diagnostic_bundle_path()?;
    // `create_dir` on the leaf: a collision must fail loudly instead of merging two
    // exports into one directory.
    std::fs::create_dir(&directory).map_err(|error| {
        CommandError::EngineUnavailable(format!("Tanılama klasörü oluşturulamadı: {error}"))
    })?;
    let path = directory.join("diagnostics.json");
    std::fs::write(&path, &bytes).map_err(|error| {
        CommandError::EngineUnavailable(format!("Tanılama paketi yazılamadı: {error}"))
    })?;
    let log_variants = engine_path
        .as_deref()
        .map(crate::engine_bridge::diagnostic_log_variants)
        .unwrap_or_default();
    for (index, source) in log_variants.iter().enumerate() {
        let name = if index == 0 {
            "engine.stderr.log".to_string()
        } else {
            format!("engine.stderr.log.{index}")
        };
        write_redacted_diagnostic_copy(Some(source), &directory.join(name));
    }
    let bridge_event_target = directory.join("bridge-events.log");
    for (index, source) in log_variants.iter().rev().enumerate() {
        write_diagnostic_lines(
            Some(source),
            &bridge_event_target,
            index > 0,
            |line| line.starts_with("BRIDGE_") || line.starts_with("ENGINE_"),
        );
    }
    if let Some(startup) = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|root| {
            root.join("Blogbot")
                .join("diagnostics")
                .join("startup-state.log")
        })
    {
        write_redacted_diagnostic_copy(Some(&startup), &directory.join("startup-state.log"));
    }
    let mut file_names = vec!["diagnostics.json".to_string()];
    file_names.extend((0..log_variants.len()).map(|index| {
        if index == 0 {
            "engine.stderr.log".to_string()
        } else {
            format!("engine.stderr.log.{index}")
        }
    }));
    file_names.extend(["bridge-events.log".to_string(), "startup-state.log".to_string()]);
    let files = file_names
    .into_iter()
    .filter_map(|name| {
        let file = directory.join(&name);
        file.is_file()
            .then(|| json!({ "name": name, "bytes": diagnostic_file_size(&file) }))
    })
    .collect::<Vec<_>>();
    let manifest = json!({
        "format": "blogbot-diagnostics-manifest-v2",
        "generatedAtUnixMs": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
        "appVersion": env!("CARGO_PKG_VERSION"),
        "processId": std::process::id(),
        "engineRunning": bridge.is_running(),
        "files": files,
        "redaction": {
            "applied": true,
            "policy": "Log lines pass the persistence redactor (sensitive markers, opaque long values, identities and absolute paths). The operations snapshot is projected to identifiers, states and timestamps; article titles are replaced by a short digest.",
            "rawSourceIncluded": false,
            "articleTextIncluded": false
        }
    });
    let _ = std::fs::write(
        directory.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).unwrap_or_default(),
    );
    reveal_diagnostic_directory(&directory)?;
    Ok(json!({
        "path": path.to_string_lossy().to_string(),
        "directory": directory.to_string_lossy().to_string(),
        "bytes": bytes.len(),
        "included": ["runtime", "operations", "engine", "bridge-events", "startup", "manifest"],
        "opened": true
    }))
}

fn sanitize_operation_error(value: &str) -> String {
    let redacted = crate::engine_bridge::redact_diagnostic_for_persistence(value);
    if redacted == "[redacted sensitive diagnostic line]" {
        return "İş başarısız oldu; ayrıntı güvenlik nedeniyle gizlendi.".to_string();
    }
    if redacted
        .split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
        .any(|token| {
            token.len() >= 5
                && token.contains('_')
                && token.chars().all(|character| {
                    character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
                })
        })
    {
        return "İş tamamlanamadı. Ayrıntı kullanıcıya gösterilmedi; Operasyonlar’dan tanılama paketi oluşturabilirsiniz.".to_string();
    }
    redacted.chars().take(512).collect()
}

fn editorial_operation_events(mutations: &[Value]) -> Vec<Value> {
    mutations
        .iter()
        .rev()
        .filter_map(|mutation| {
            let kind = mutation.get("kind").and_then(Value::as_str)?;
            let (title, detail, correlation) = match kind {
                "CANDIDATE.PROMOTE" => (
                    "Araştırma işi kuyruğa alındı",
                    "Seçilen haber adayı kalıcı yerel kuyruğa yazıldı. Taslağı Editoryal Masa’da takip edebilirsiniz.",
                    mutation
                        .pointer("/draftJob/id")
                        .or_else(|| mutation.get("candidateId"))
                        .and_then(Value::as_str)
                        .unwrap_or("candidate-research"),
                ),
                "CANDIDATE.DISMISS" => (
                    "Haber adayı akıştan kapatıldı",
                    "Aday yerel içerik akışından kaldırıldı; yayın veya dış sistem değişikliği yapılmadı.",
                    mutation.get("candidateId").and_then(Value::as_str).unwrap_or("candidate-dismiss"),
                ),
                "REVISION.EDIT_REQUEST" => (
                    "Yeni revizyon isteği kuyruğa alındı",
                    "Seçilen revizyon için yeni, değişmez bir inceleme taslağı hazırlanacak.",
                    mutation
                        .pointer("/draftJob/id")
                        .or_else(|| mutation.get("revisionId"))
                        .and_then(Value::as_str)
                        .unwrap_or("revision-edit"),
                ),
                "SCHEDULE.SLOT" => (
                    "Haftalık yayın slotu güncellendi",
                    "Takvim tercihi yerel çalışma alanına kaydedildi; mevcut onayları değiştirmez.",
                    mutation.get("slotId").and_then(Value::as_str).unwrap_or("schedule-slot"),
                ),
                _ => return None,
            };
            Some(json!({
                "id": format!("editorial-{kind}-{correlation}"),
                "at": "yerel kayıt",
                "title": title,
                "detail": detail,
                "state": "SUCCESS",
                "level": "INFO",
                "correlationId": correlation
            }))
        })
        .take(10)
        .collect()
}

fn workspace_failures(jobs: &[Value]) -> Vec<Value> {
    jobs
        .iter()
        .filter(|job| matches!(job.get("state").and_then(Value::as_str), Some("FAILED" | "DEAD_LETTER")))
        .map(|job| {
            let retry_mode = if job.get("state").and_then(Value::as_str) == Some("DEAD_LETTER") {
                "MANUAL"
            } else {
                "SAFE"
            };
            json!({
            "id": job.get("id").cloned().unwrap_or(Value::Null),
            "title": "Yerel iş",
            "jobType": job.get("kind").cloned().unwrap_or(json!("UNKNOWN")),
            "message": sanitize_operation_error(job.get("lastError").and_then(Value::as_str).unwrap_or("İş başarısız oldu.")),
            "attempts": job.get("attempts").cloned().unwrap_or(json!(0)),
            "lastAttemptAt": Value::Null,
            "retryMode": retry_mode,
            "state": "ACTION_REQUIRED"
            })
        })
        .collect()
}

/// Maps only persisted outbox states to the UI publication state. An absent
/// effect means no publication intent exists yet and must remain blocked.
fn publication_observability(effect_state: Option<&str>) -> (&'static str, &'static str) {
    match effect_state {
        Some("SUCCEEDED") => ("PASSED", "READY"),
        Some("IN_PROGRESS") => ("RUNNING", "PUBLISHING"),
        Some("FAILED") => ("FAILED", "BLOCKED"),
        Some("PENDING" | "UNKNOWN") | None => ("NOT_STARTED", "BLOCKED"),
        Some(_) => ("NOT_STARTED", "BLOCKED"),
    }
}

fn workspace_engine_state(
    runtime: RuntimeMode,
    result: Result<Value, CommandError>,
) -> Result<Option<Value>, CommandError> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if matches!(runtime, RuntimeMode::Online) => Err(error),
        Err(_) => Ok(None),
    }
}

fn workspace_can_read_engine(runtime: RuntimeMode) -> bool {
    matches!(runtime, RuntimeMode::Online)
}

fn has_publication_capability(capabilities: &Value) -> bool {
    capabilities
        .as_array()
        .map(|values| {
            values
                .iter()
                .any(|item| item.as_str() == Some("PUBLICATION.ENQUEUE"))
        })
        .unwrap_or(false)
}

fn scheduled_operation_items(revisions: &[Value]) -> Vec<Value> {
    revisions
        .iter()
        .filter(|revision| revision.get("state").and_then(Value::as_str) == Some("APPROVED"))
        .filter_map(|revision| {
            let id = revision.get("id")?.as_str()?;
            let title = revision.get("title")?.as_str()?;
            let at = revision.get("scheduledAt")?.as_str()?;
            if at.trim().is_empty() {
                return None;
            }
            Some(json!({
                "id": id,
                "title": title,
                "at": at,
                "section": revision.get("section").cloned().unwrap_or(json!("haberler")),
                "state": "APPROVED"
            }))
        })
        .collect()
}

fn candidate_workflow_state(
    candidate_id: &str,
    mutations: &[Value],
    jobs: &[Value],
) -> &'static str {
    // Closing a candidate only removes it from the discovery inbox; it does
    // not delete an already-created draft job. Therefore the latest explicit
    // dismiss must win over that job's durable workflow state. A later promote
    // mutation still re-opens the candidate and continues through the job
    // projection below.
    if mutations.iter().rev().find(|mutation| {
        mutation.get("candidateId").and_then(Value::as_str) == Some(candidate_id)
    }).is_some_and(|mutation| {
        mutation.get("kind").and_then(Value::as_str) == Some("CANDIDATE.DISMISS")
    }) {
        return "DISMISSED";
    }

    if let Some(job) = jobs.iter().rev().find(|job| {
        job.get("kind").and_then(Value::as_str) == Some("DRAFT")
            && job.pointer("/metadata/candidateId").and_then(Value::as_str) == Some(candidate_id)
    }) {
        match job.get("state").and_then(Value::as_str) {
            Some("FAILED" | "DEAD_LETTER") => return "RESEARCH_FAILED",
            Some("SUCCEEDED") => return "PROMOTED",
            // A live draft job is durable proof that this candidate was promoted.
            // Deriving the state from the job keeps the card correct even when the
            // separate local-state mutation write did not land.
            Some("QUEUED" | "RUNNING" | "WAITING_CODEX") => return "RESEARCH_QUEUED",
            _ => {}
        }
    }
    mutations
        .iter()
        .rev()
        .find_map(|mutation| {
            if mutation.get("candidateId").and_then(Value::as_str) != Some(candidate_id) {
                return None;
            }
            match mutation.get("kind").and_then(Value::as_str) {
                Some("CANDIDATE.DISMISS") => Some("DISMISSED"),
                Some("CANDIDATE.PROMOTE") => match mutation.get("state").and_then(Value::as_str) {
                    Some("RESEARCH_QUEUED") => Some("RESEARCH_QUEUED"),
                    _ => Some("PROMOTED"),
                },
                _ => None,
            }
        })
        .unwrap_or("NEW")
}

/// Projects only observations the local engine has durably recorded. The
/// Codex CLI does not expose token or subscription quota data, so this must
/// never invent a meter from queued work.
fn codex_usage_from_jobs(jobs: &[Value], now_unix_ms: u128) -> Result<Vec<Value>, CommandError> {
    let active_default = jobs
        .iter()
        .filter(|job| job.get("kind").and_then(Value::as_str) == Some("DRAFT"))
        .filter(|job| {
            matches!(
                job.get("state").and_then(Value::as_str),
                Some("QUEUED" | "RUNNING" | "WAITING_CODEX")
            )
        })
        .count();
    let utc_day_start = (now_unix_ms / 86_400_000) * 86_400_000;
    let successes = jobs
        .iter()
        .filter(|job| job.get("kind").and_then(Value::as_str) == Some("DRAFT"))
        .filter(|job| job.get("state").and_then(Value::as_str) == Some("SUCCEEDED"))
        .filter_map(|job| {
            job.pointer("/metadata/completedAtUnixMs")
                .and_then(Value::as_u64)
        })
        .map(u128::from)
        .collect::<Vec<_>>();
    let completed_today = successes
        .iter()
        .filter(|completed_at| **completed_at >= utc_day_start && **completed_at <= now_unix_ms)
        .count();
    let last_success_at = successes
        .into_iter()
        .filter(|completed_at| *completed_at <= now_unix_ms)
        .max()
        .map(chrono_like_iso)
        .transpose()?;
    Ok(vec![
        json!({ "role": "FAST", "label": "Sınıflandırma ve tekrar analizi", "queueDepth": 0, "completedToday": Value::Null, "lastSuccessAt": Value::Null }),
        json!({ "role": "DEFAULT", "label": "Araştırma, Türkçe ve İngilizce", "queueDepth": active_default, "completedToday": if completed_today == 0 { Value::Null } else { json!(completed_today) }, "lastSuccessAt": last_success_at }),
        json!({ "role": "DEEP_REVIEW", "label": "Çelişki ve son kalite denetimi", "queueDepth": 0, "completedToday": Value::Null, "lastSuccessAt": Value::Null }),
    ])
}

fn codex_role_state_for_usage(
    role: &str,
    default_queue_depth: usize,
    runtime_state: &str,
) -> &'static str {
    if role == "DEFAULT" && default_queue_depth > 0 {
        return "BUSY";
    }
    match runtime_state {
        "BUSY" => "READY",
        "READY" => "READY",
        "LIMITED" => "LIMITED",
        _ => "UNAVAILABLE",
    }
}

#[tauri::command]
pub async fn get_editorial_workspace(
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
    include_candidates: Option<bool>,
) -> Result<Value, CommandError> {
    let runtime = *read_lock(&state.runtime)?;
    // Do not probe a sidecar after Doctor has already put this desktop into an
    // offline projection. Rust evaluates function arguments eagerly, so the
    // former workspace_engine_state(runtime, read_engine_state(...)) shape
    // still issued a closed-pipe request even though the helper discarded it.
    // The empty projection below keeps navigation responsive and reserves the
    // next deliberate bootstrap retry as the only recovery probe.
    let engine_state = if workspace_can_read_engine(runtime) {
        workspace_engine_state(runtime, read_engine_state(&bridge))?
    } else {
        None
    };
    let materializations = engine_state
        .as_ref()
        .and_then(|value| {
            value
                .pointer("/snapshot/serverCursor")
                .and_then(Value::as_u64)
        })
        .map(|version| read_revision_list_at_version(&bridge, version).unwrap_or_default())
        .unwrap_or_default();
    let revision_queue = build_revision_queue(&materializations);
    let jobs = engine_state
        .as_ref()
        .and_then(|value| value.pointer("/snapshot/jobs").and_then(Value::as_array))
        .cloned()
        .unwrap_or_default();
    let outbox = engine_state
        .as_ref()
        .and_then(|value| value.pointer("/snapshot/outbox").and_then(Value::as_array))
        .cloned()
        .unwrap_or_default();
    let sequence = engine_state
        .as_ref()
        .and_then(|value| {
            value
                .pointer("/snapshot/serverCursor")
                .and_then(Value::as_u64)
        })
        .unwrap_or(0);
    let stale = engine_state.is_none() || !matches!(runtime, RuntimeMode::Online);
    let now_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let generated_at = chrono_like_iso(now_unix_ms)?;
    let mut drafts = revision_queue
        .iter()
        .map(|item| {
            json!({
                "id": item.get("id").cloned().unwrap_or(Value::Null),
                "titleTr": item.get("title").cloned().unwrap_or(Value::Null),
                "titleEn": item.get("title").cloned().unwrap_or(Value::Null),
                "section": item.get("section").cloned().unwrap_or(json!("haberler")),
                "completion": Value::Null,
                "blockers": item.get("blockers").cloned().unwrap_or(json!(0)),
                "updatedAt": item.get("updatedAt").cloned().unwrap_or(Value::Null),
                "scheduledAt": item.get("scheduledAt").cloned().unwrap_or(Value::Null),
                "state": item.get("state").cloned().unwrap_or(json!("REVIEW_REQUIRED")),
                "reviewable": true,
                "detail": "TR / EN incelemesine hazır."
            })
        })
        .collect::<Vec<_>>();
    let failures = workspace_failures(&jobs);
    let codex_usage = codex_usage_from_jobs(&jobs, now_unix_ms)?;
    let codex_depth = codex_usage
        .iter()
        .find(|role| role.get("role").and_then(Value::as_str) == Some("DEFAULT"))
        .and_then(|role| role.get("queueDepth").and_then(Value::as_u64))
        .unwrap_or(0) as usize;
    let connectors = if workspace_can_read_engine(runtime) {
        read_engine_local_state(&bridge, "desktop.connectors").unwrap_or_else(|| json!({}))
    } else {
        json!({})
    };
    let connector_checks = if workspace_can_read_engine(runtime) {
        read_engine_local_state(&bridge, "desktop.connectorChecks").unwrap_or_else(|| json!({}))
    } else {
        json!({})
    };
    let codex_configured = connectors
        .pointer("/codex/accountLabel")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    let codex_runner_ready = workspace_can_read_engine(runtime)
        && bridge
            .doctor()
            .ok()
            .and_then(|value| value.get("capabilities").cloned())
            .and_then(|value| value.as_array().cloned())
            .is_some_and(|capabilities| {
                capabilities
                    .iter()
                    .any(|item| item.as_str() == Some("CODEX.RUNNER"))
            });
    // Workspace reads must remain local and bounded. Running codex.cmd --version
    // and `login status` here blocks the Tauri command thread. The explicit
    // test owns that probe; its last in-process result is the truthful session
    // signal, while the engine capability only proves the runner is present.
    let codex_available = codex_runner_ready || codex_configured;
    let codex_authenticated = read_lock(&state.codex_authenticated)?.unwrap_or(false);
    let codex_role_state = boby_role_state(
        codex_depth,
        codex_configured,
        codex_runner_ready,
        codex_authenticated,
    );
    let site_configured = connectors
        .pointer("/site/repositoryPath")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    let site_ready = connector_checks
        .pointer("/site/ready")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let github_configured = connectors
        .pointer("/github/owner")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
        && connectors
            .pointer("/github/repository")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty());
    let checked_at = generated_at.clone();
    let candidate_values = if include_candidates.unwrap_or(false) && workspace_can_read_engine(runtime) {
        engine_request(
            &bridge,
            json!({
                "version": 1,
                "id": format!("desktop-candidate-list-{}", std::process::id()),
                "kind": "candidate.list"
            }),
        )
        .ok()
        .and_then(|response| response.get("candidates").cloned())
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
    } else {
        Vec::new()
    };
    let persisted_editorial = if workspace_can_read_engine(runtime) {
        read_engine_local_state(&bridge, "desktop.editorial").unwrap_or_else(|| json!({}))
    } else {
        json!({})
    };
    let candidate_mutations = persisted_editorial
        .get("mutations")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let candidates = candidate_values
        .into_iter()
        .map(|candidate| {
            let id = candidate
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let state = candidate_workflow_state(id, &candidate_mutations, &jobs);
            json!({
                "id": candidate.get("id").cloned().unwrap_or(Value::Null),
                "sourceId": candidate.get("sourceId").cloned().unwrap_or(Value::Null),
                "title": candidate.get("title").cloned().unwrap_or(json!("Başlıksız aday")),
                "summary": candidate.get("summary").cloned().unwrap_or(Value::Null),
                "primarySource": candidate.get("primarySource").cloned().unwrap_or(Value::Null),
                "sourceCount": candidate.get("sourceCount").cloned().unwrap_or(json!(1)),
                "section": candidate.get("section").cloned().unwrap_or(json!("haberler")),
                "articleType": candidate.get("articleType").cloned().unwrap_or(json!("news")),
                "confidence": candidate.get("confidence").cloned().unwrap_or(json!(0)),
                "duplicateScore": candidate.get("duplicateScore").cloned().unwrap_or(json!(0)),
                "sourceSufficiencyScore": candidate.get("sourceSufficiencyScore").cloned().unwrap_or(Value::Null),
                "freshnessScore": candidate.get("freshnessScore").cloned().unwrap_or(Value::Null),
                "originalityScore": candidate.get("originalityScore").cloned().unwrap_or(Value::Null),
                "topicFitScore": candidate.get("topicFitScore").cloned().unwrap_or(Value::Null),
                "rankingScore": candidate.get("rankingScore").cloned().unwrap_or(Value::Null),
                "scoreReasons": candidate.get("scoreReasons").cloned().unwrap_or_else(|| json!([])),
                "publishedAt": candidate.get("publishedAt").cloned().unwrap_or(Value::Null),
                "discoveredAt": candidate.get("discoveredAt").cloned().unwrap_or(Value::Null),
                "state": state
            })
        })
        .collect::<Vec<_>>();
    drafts = append_pending_draft_jobs(drafts, &jobs);
    // Hiding a row is a local desk preference, not deletion. Immutable
    // revisions, durable jobs and their approval history remain available to
    // Operations and can never be silently destroyed by a list action.
    let hidden_draft_ids = persisted_editorial
        .get("hiddenDraftIds")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_str).collect::<std::collections::HashSet<_>>())
        .unwrap_or_default();
    let hidden_draft_count = hidden_draft_ids.len();
    drafts.retain(|draft| {
        draft
            .get("id")
            .and_then(Value::as_str)
            .is_none_or(|id| !hidden_draft_ids.contains(id))
    });
    let health_state = if stale { "OFFLINE" } else { "HEALTHY" };
    // Schedule and preference commands are intentionally local-only until the
    // corresponding engine contracts exist. Rehydrate their durable desktop
    // state so a restart does not make a successful UI mutation appear lost.
    let persisted_schedule = persisted_editorial.get("schedule").cloned();
    let weekly_days = [
        ("mon", "Pazartesi", "10:00"),
        ("tue", "Salı", "16:30"),
        ("wed", "Çarşamba", "10:00"),
        ("thu", "Perşembe", "16:30"),
        ("fri", "Cuma", "10:00"),
        ("sat", "Cumartesi", "11:00"),
        ("sun", "Pazar", "11:00"),
    ];
    let mut weekly_slots = weekly_days
        .iter()
        .flat_map(|(day, label, default_time)| {
            (1..=5).map(move |position| json!({
            "id": format!("slot-{day}-{position}"), "dayLabel": label, "time": default_time,
            "enabled": position == 1, "articleId": null, "articleTitle": null, "state": "EMPTY"
        }))
        })
        .collect::<Vec<_>>();
    if let Some(saved) = persisted_schedule.as_ref().and_then(Value::as_object) {
        let mut apply_slot = |slot_value: &Value| {
            if let Some(slot_id) = slot_value.get("slotId").and_then(Value::as_str) {
                let canonical_slot_id = match slot_id {
                    "slot-mon" => "slot-mon-1",
                    "slot-tue" => "slot-tue-1",
                    "slot-wed" => "slot-wed-1",
                    "slot-thu" => "slot-thu-1",
                    "slot-fri" => "slot-fri-1",
                    "slot-sat" => "slot-sat-1",
                    "slot-sun" => "slot-sun-1",
                    value => value,
                };
                if let Some(slot) = weekly_slots
                    .iter_mut()
                    .find(|slot| slot.get("id").and_then(Value::as_str) == Some(canonical_slot_id))
                {
                    if let Some(object) = slot.as_object_mut() {
                        if let Some(time) = slot_value.get("time").and_then(Value::as_str) {
                            object.insert("time".into(), json!(time));
                        }
                        if let Some(enabled) = slot_value.get("enabled").and_then(Value::as_bool) {
                            object.insert("enabled".into(), json!(enabled));
                        }
                        let article_id = slot_value.get("articleId").and_then(Value::as_str);
                        let article_title = slot_value.get("articleTitle").and_then(Value::as_str);
                        if let Some(article_id) = article_id {
                            object.insert("articleId".into(), json!(article_id));
                            object.insert(
                                "articleTitle".into(),
                                json!(article_title.unwrap_or("Onaylı post")),
                            );
                            object.insert("state".into(), json!("READY"));
                        } else if slot_value.get("articleId").is_some() {
                            object.insert("articleId".into(), Value::Null);
                            object.insert("articleTitle".into(), Value::Null);
                            object.insert("state".into(), json!("EMPTY"));
                        }
                    }
                }
            }
        };
        if let Some(slots) = saved.get("slots").and_then(Value::as_object) {
            for slot_value in slots.values() {
                apply_slot(slot_value);
            }
        } else {
            apply_slot(&Value::Object(saved.clone()));
        }
    }
    let preferences = persisted_editorial
        .get("preferences")
        .cloned()
        .unwrap_or_else(|| {
            json!({
                "author": "OPE Editorya",
                "reviewer": "Editör",
                "notifications": true,
                "emailDigest": false,
                "defaultSection": "haberler",
                "showSourceReferences": true
            })
        });
    let site_origin = configured_site_origin(&connectors);
    let history = outbox
        .iter()
        .filter(|effect| effect.get("state").and_then(Value::as_str) == Some("SUCCEEDED"))
        .filter_map(|effect| {
            let revision_id = effect.get("aggregateId").and_then(Value::as_str)?;
            let revision = revision_queue.iter().find(|item| item.get("id").and_then(Value::as_str) == Some(revision_id))?;
            let public_url = site_origin.as_ref().map(|origin| format!("{origin}/{}/{}{}", revision.get("section").and_then(Value::as_str).unwrap_or("haberler"), revision.get("slug").and_then(Value::as_str).unwrap_or(revision_id), "/"));
            Some(json!({
                "id": revision_id,
                "title": revision.get("title").cloned().unwrap_or(json!("Başlıksız yazı")),
                "section": revision.get("section").cloned().unwrap_or(json!("haberler")),
                "publishedAt": effect.get("completedAt").cloned().unwrap_or(Value::Null),
                "url": public_url,
                "revisionHash": revision.get("revisionHash").cloned().unwrap_or(Value::Null),
                "verificationState": if effect.get("completedAt").and_then(Value::as_str).is_some() { "VERIFIED" } else { "UNVERIFIED" }
            }))
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "sync": {
            "sequence": sequence,
            "snapshotId": format!("native-local-{sequence}"),
            "generatedAt": generated_at,
            "stale": stale
        },
        "today": revision_queue.iter().filter(|item| item.get("state").and_then(Value::as_str) == Some("REVIEW_REQUIRED")).map(|item| json!({
            "id": item.get("id").cloned().unwrap_or(Value::Null),
            "title": item.get("title").cloned().unwrap_or(Value::Null),
            "detail": "İnceleme ve kaynak kontrolü bekliyor.",
            "dueLabel": "Bugünün incelemesi",
            "priority": if item.get("blockers").and_then(Value::as_u64).unwrap_or(0) > 0 { "HIGH" } else { "NORMAL" },
            "state": "OPEN",
            "target": "editorial"
        })).collect::<Vec<_>>(),
        "candidates": candidates,
        "drafts": drafts,
        "hiddenDraftCount": hidden_draft_count,
        "weeklySlots": weekly_slots,
        "scheduled": revision_queue.iter().filter(|item| {
            item.get("state").and_then(Value::as_str) == Some("APPROVED")
                && item.get("scheduledAt").and_then(Value::as_str).is_some()
        }).map(|item| {
            let revision_id = item.get("id").and_then(Value::as_str).unwrap_or_default();
            let effect = outbox.iter().find(|candidate| candidate.get("aggregateId").and_then(Value::as_str) == Some(revision_id));
            let effect_state = effect.and_then(|candidate| candidate.get("state")).and_then(Value::as_str);
            let (ci_state, publication_state) = publication_observability(effect_state);
            json!({
            "id": item.get("id").cloned().unwrap_or(Value::Null),
            "title": item.get("title").cloned().unwrap_or(Value::Null),
            "section": item.get("section").cloned().unwrap_or(json!("haberler")),
            "scheduledAt": item.get("scheduledAt").cloned().unwrap_or(Value::Null),
            "revisionHash": item.get("revisionHash").cloned().unwrap_or(Value::Null),
            "targetPath": item.get("slug").and_then(Value::as_str).map(|slug| format!("src/content/articles/tr/{}/{slug}.md", item.get("section").and_then(Value::as_str).unwrap_or("haberler"))).unwrap_or_default(),
            "ciState": ci_state,
            "state": publication_state
        })
        }).collect::<Vec<_>>(),
        "history": history,
        "failures": failures,
        "codexRoles": codex_usage.into_iter().map(|mut role| {
            let role_name = role.get("role").and_then(Value::as_str).unwrap_or_default();
            let role_state = codex_role_state_for_usage(role_name, codex_depth, codex_role_state);
            role.as_object_mut().expect("Codex usage role is an object").insert("state".into(), json!(role_state));
            role
        }).collect::<Vec<_>>(),
        "preferences": preferences,
        "systemHealth": [
            { "id": "engine", "label": "Yerel engine", "state": health_state, "detail": if stale { "Yerel engine bağlantısı şu anda kullanılamıyor." } else { "Paketlenmiş sidecar stdio üzerinden çalışıyor." }, "checkedAt": checked_at },
            { "id": "pglite", "label": "PGlite ve kalıcı kuyruk", "state": health_state, "detail": if stale { "PGlite durumu engine yeniden bağlanınca doğrulanacak." } else { "Yerel veri ve pg-boss kuyruğu hazır." }, "checkedAt": checked_at },
            { "id": "codex", "label": "Codex çalışma zamanı", "state": if codex_role_state == "READY" || codex_role_state == "BUSY" { "HEALTHY" } else if codex_available { "DEGRADED" } else { "NOT_CONFIGURED" }, "detail": if codex_role_state == "READY" { "Codex hesabı ve izole yerel runner hazır." } else if codex_role_state == "BUSY" { "Codex runner yerel iş kuyruğunu işliyor." } else if codex_available { "Codex bulundu; hesap veya izole runner doğrulaması bekleniyor." } else { "Codex çalışma zamanı bu bilgisayarda bulunamadı." }, "checkedAt": checked_at },
            { "id": "github", "label": "GitHub yayıncısı", "state": if github_configured { "DEGRADED" } else { "NOT_CONFIGURED" }, "detail": if github_configured { "Depo hedefi kayıtlı; depo ile sınırlandırılmış güvenli yetki aracısı hazır olmadığı için yayın kilitli." } else { "GitHub depo hedefi yapılandırılmadı; güvenli yetki aracısı olmadan yetkilendirme yapılmaz." }, "checkedAt": checked_at },
            { "id": "site-adapter", "label": "Site adaptörü", "state": if site_ready { "HEALTHY" } else if site_configured { "DEGRADED" } else { "NOT_CONFIGURED" }, "detail": if site_ready { "Seçilen site adaptörü ve route dry-run doğrulandı." } else if site_configured { "Site hedefi kayıtlı; biçim doğrulaması bekleniyor." } else { "Seçilen site hedefi henüz yapılandırılmadı." }, "checkedAt": checked_at }
        ]
    }))
}

/// The engine treats an absent `visualPolicy` as GENERATE, and GENERATE without a
/// configured ImageGen key produces a revision with empty media, which forces the
/// media quality gate to BLOCK and makes the draft permanently un-approvable. The
/// engine receives its ImageGen key from this process's environment, so the same
/// lookup decides the policy: fall back to the offline local renderer, which the
/// manual Instant Create screen already selects.
fn automated_visual_policy_with<F>(mut lookup: F) -> &'static str
where
    F: FnMut(&str) -> Option<OsString>,
{
    let configured = lookup("BLOGBOT_IMAGEGEN_API_KEY").is_some_and(|value| !value.is_empty());
    if configured {
        "GENERATE"
    } else {
        "LOCAL_RENDERER"
    }
}

fn automated_visual_policy() -> &'static str {
    automated_visual_policy_with(|name| std::env::var_os(name))
}

fn candidate_draft_payload(candidate_id: &str, candidate: &Value) -> Result<Value, CommandError> {
    let source_ids = candidate
        .get("sourceIds")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .take(12)
                .collect::<Vec<_>>()
        })
        .filter(|values| !values.is_empty())
        .or_else(|| {
            candidate
                .get("sourceId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(|value| vec![value])
        })
        .ok_or_else(|| CommandError::EngineUnavailable("CANDIDATE_SOURCE_MISSING".into()))?;
    let urls = candidate
        .get("sourceUrls")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .filter(|url| is_http_url(url))
                .take(12)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(json!({
        "draftId": format!("draft-candidate-{candidate_id}"),
        "candidateId": candidate_id,
        "candidateTitle": candidate.get("title").and_then(Value::as_str).unwrap_or("Araştırma bekleyen içerik"),
        "sourceIds": source_ids,
        "urls": urls,
        "candidateUrl": candidate.get("sourceUrl").and_then(Value::as_str).filter(|url| is_http_url(url)),
        "instruction": "Bu adayı kaynak kanıtlarıyla araştır ve insan incelemesine hazırla.",
        "section": candidate.get("section").and_then(Value::as_str).unwrap_or("haberler"),
        "articleType": candidate.get("articleType").and_then(Value::as_str).unwrap_or("news"),
        "visualPolicy": automated_visual_policy(),
        "scheduleIntent": "UNSCHEDULED"
    }))
}

fn append_pending_draft_jobs(mut drafts: Vec<Value>, jobs: &[Value]) -> Vec<Value> {
    let now_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    for job in jobs {
        if job.get("kind").and_then(Value::as_str) != Some("DRAFT") {
            continue;
        }
        let job_state = job.get("state").and_then(Value::as_str).unwrap_or_default();
        if !matches!(
            job_state,
            "QUEUED" | "RUNNING" | "WAITING_CODEX" | "RETRY_SCHEDULED"
        ) {
            continue;
        }
        let id = match job
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            Some(value) => value,
            None => continue,
        };
        let metadata = job.get("metadata").and_then(Value::as_object);
        let title = metadata
            .and_then(|value| value.get("candidateTitle"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                metadata
                    .and_then(|value| value.get("instruction"))
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
            })
            .map(|value| value.chars().take(240).collect::<String>())
            .unwrap_or_else(|| "Araştırma bekleyen içerik".to_string());
        let section = match metadata
            .and_then(|value| value.get("section"))
            .and_then(Value::as_str)
        {
            Some("analiz") => "analiz",
            Some("dosyalar") => "dosyalar",
            Some("rehberler") => "rehberler",
            _ => "haberler",
        };
        let recovered_after_restart = metadata
            .and_then(|value| value.get("recoveryCount"))
            .and_then(Value::as_u64)
            .is_some_and(|value| value > 0);
        let retrying_codex = metadata
            .and_then(|value| value.get("progressStage"))
            .and_then(Value::as_str)
            == Some("RETRYING_CODEX");
        let wait_reason = metadata
            .and_then(|value| value.get("codexWaitReason"))
            .and_then(Value::as_str);
        let retry_overdue = job_state == "RETRY_SCHEDULED"
            && metadata
                .and_then(|value| {
                    value
                        .get("finalReviewRetryAtUnixMs")
                        .or_else(|| value.get("codexRetryAtUnixMs"))
                })
                .and_then(Value::as_u64)
                .is_some_and(|retry_at| retry_at <= now_unix_ms);
        let waiting_detail = match metadata
            .and_then(|value| value.get("codexWaitReason"))
            .and_then(Value::as_str) {
                Some("RUNNER_TIMEOUT") => "Yazı üretimi zaman sınırına ulaştı. İş durduruldu; Operasyonlar'dan güvenle yeniden deneyin.",
                Some("RUNNER_REQUIRES_RETRY") => "Codex çıktısı güvenlik ve biçim kontrolünden geçmedi. İş yayınlanmadı; Operasyonlar'dan yeniden deneyin.",
                Some("RETRY_LIMIT_REACHED") => "Yazı üretimi üç kez güvenle denendi ancak tamamlanamadı. İş durduruldu; yeniden denemeden önce tanı paketini inceleyin.",
                _ => "Codex hesabı veya izole runner bekleniyor."
            };
        // The durable queue records a phase, not a measured percentage.
        // Until the engine emits a real progress metric, never invent one in
        // the editor UI: indeterminate progress communicates the truth.
        let running_detail = match metadata
            .and_then(|value| value.get("progressStage"))
            .and_then(Value::as_str)
        {
            Some("PREPARING_SOURCES") => "Kaynak kanıtları hazırlanıyor.",
            Some("RUNNING_CODEX") => "Codex özgün Türkçe ve İngilizce taslağı üretiyor.",
            Some("FINAL_REVIEW_QUEUED") => {
                "Taslak hazırlandı; son kalite incelemesi yerel kuyruğa alındı."
            }
            Some("FINAL_REVIEW") => {
                "Taslak, kaynak ve iki dil için son kalite incelemesinden geçiyor."
            }
            Some("FINAL_REVIEW_RETRYING") => {
                "Son kalite incelemesi geçici bir hatadan sonra otomatik yeniden denenecek."
            }
            _ => "Kaynaklar araştırılıyor ve taslak hazırlanıyor.",
        };
        let (blockers, detail) = match job_state {
            "RUNNING" => (0, running_detail),
            "RETRY_SCHEDULED" if retry_overdue => (
                1,
                "Son kalite incelemesi için planlanan tekrar zamanı geçti. İş kaybolmadı; yeniden denemek için düğmeyi kullanın.",
            ),
            "RETRY_SCHEDULED" => (0, running_detail),
            "QUEUED" if recovered_after_restart => (0, "Uygulama yeniden açıldığında iş güvenle yerel kuyruğa alındı."),
            "QUEUED" if retrying_codex => (0, "Yazı üretimi kesintiye uğradı; iş kaybolmadı ve güvenli yerel kuyrukta yeniden deneniyor."),
            "QUEUED" => (0, "Araştırma güvenli yerel kuyruğa alındı."),
            _ => (1, waiting_detail),
        };
        let (execution_state, next_action, reason_code) = match job_state {
            "RUNNING" => ("RUNNING", "NONE", Value::Null),
            "RETRY_SCHEDULED" if retry_overdue => {
                ("FAILED", "RETRY", json!("RETRY_OVERDUE"))
            }
            "RETRY_SCHEDULED" => {
                ("RETRY_SCHEDULED", "NONE", json!("EXECUTION_FAILED"))
            }
            "QUEUED" if retrying_codex => ("RETRY_SCHEDULED", "NONE", json!("EXECUTION_FAILED")),
            "QUEUED" => ("QUEUED", "NONE", Value::Null),
            _ => match wait_reason {
                Some("RUNNER_TIMEOUT") => ("FAILED", "RETRY", json!("RUNNER_TIMEOUT")),
                Some("RUNNER_REQUIRES_RETRY") => {
                    ("FAILED", "RETRY", json!("RUNNER_REQUIRES_RETRY"))
                }
                Some("RETRY_LIMIT_REACHED") => ("FAILED", "RETRY", json!("RETRY_LIMIT_REACHED")),
                Some("RATE_LIMIT") => ("WAITING", "NONE", json!("RATE_LIMIT")),
                Some("USAGE_LIMIT") => ("WAITING", "NONE", json!("USAGE_LIMIT")),
                Some("PAID_FALLBACK_DISABLED") => {
                    ("WAITING", "NONE", json!("PAID_FALLBACK_DISABLED"))
                }
                Some("AUTH_REQUIRED") => ("WAITING", "CONNECT_CODEX", json!("AUTH_REQUIRED")),
                _ => ("WAITING", "CONNECT_CODEX", json!("CODEX_UNAVAILABLE")),
            },
        };
        if let Some(draft) = drafts
            .iter_mut()
            .find(|draft| draft.get("id").and_then(Value::as_str) == Some(id))
        {
            draft["completion"] = Value::Null;
            draft["blockers"] = json!(blockers);
            draft["state"] = json!("DRAFTING");
            draft["reviewable"] = json!(false);
            draft["detail"] = json!(detail);
            draft["executionState"] = json!(execution_state);
            draft["nextAction"] = json!(next_action);
            draft["reasonCode"] = reason_code;
            continue;
        }
        drafts.push(json!({
            "id": id,
            "titleTr": title,
            "titleEn": "Research is being prepared",
            "section": section,
            "completion": Value::Null,
            "blockers": blockers,
            "updatedAt": "Yerel kuyruk",
            "scheduledAt": metadata.and_then(|value| value.get("scheduledAt")).cloned().unwrap_or(Value::Null),
            "state": "DRAFTING",
            "reviewable": false,
            "detail": detail,
            "executionState": execution_state,
            "nextAction": next_action,
            "reasonCode": reason_code
        }));
    }
    drafts
}

#[tauri::command(async)]
pub fn promote_candidate(
    candidate_id: String,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    if candidate_id.trim().is_empty()
        || candidate_id.len() > 200
        || !candidate_id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | ':' | '.'))
    {
        return Err(CommandError::InvalidInput(
            "candidate id is required".into(),
        ));
    }
    let candidate = engine_request(
        &bridge,
        json!({
            "version": 1,
            "id": format!("candidate-promote-read-{candidate_id}"),
            "kind": "candidate.list"
        }),
    )?
    .get("candidates")
    .and_then(Value::as_array)
    .and_then(|items| {
        items
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(candidate_id.as_str()))
    })
    .cloned()
    .ok_or_else(|| {
        CommandError::InvalidInput("aday yerel çalışma bileşeninde bulunamadı".into())
    })?;
    let payload = candidate_draft_payload(&candidate_id, &candidate)?;
    let response = retry_version_conflicted_draft(
        || {
            read_engine_state(&bridge)?
                .pointer("/snapshot/serverCursor")
                .and_then(Value::as_u64)
                .ok_or_else(|| CommandError::EngineUnavailable("STATE_VERSION_MISSING".into()))
        },
        |version| {
            // The engine fingerprints DRAFT.CREATE with expectedVersion, so a
            // version-free key made the retry below — and every later Promote
            // click — arrive as the same key with a different request and be
            // rejected as reused. Binding the key to the attempted version keeps
            // each attempt a distinct logical request.
            let key = stable_source_key(&format!("candidate-draft:{candidate_id}:{version}"));
            engine_request(
                &bridge,
                json!({
                    "version": 1,
                    "id": key.clone(),
                    "kind": "command",
                    "command": {
                        "version": 1,
                        "requestId": key.clone(),
                        "idempotencyKey": key,
                        "expectedVersion": version,
                        "kind": "DRAFT.CREATE",
                        "payload": payload.clone()
                    }
                }),
            )
        },
    )?;
    let job = response
        .pointer("/result/value/backendJob")
        .cloned()
        .unwrap_or(Value::Null);
    let mutation = json!({
        "kind": "CANDIDATE.PROMOTE",
        "candidateId": candidate_id,
        "state": "RESEARCH_QUEUED",
        "draftJob": job
    });
    persist_editorial_state(&bridge, mutation.clone(), None)?;
    write_lock(&state.editorial_mutations)?.push(mutation);
    Ok(json!({ "ok": true, "state": "RESEARCH_QUEUED", "job": job }))
}

#[tauri::command(async)]
pub fn dismiss_candidate(
    candidate_id: String,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    if candidate_id.trim().is_empty() {
        return Err(CommandError::InvalidInput(
            "candidate id is required".into(),
        ));
    }
    let mutation = json!({
        "kind": "CANDIDATE.DISMISS",
        "candidateId": candidate_id,
        "state": "DISMISSED"
    });
    persist_editorial_state(&bridge, mutation.clone(), None)?;
    write_lock(&state.editorial_mutations)?.push(mutation);
    Ok(json!({ "ok": true, "state": "DISMISSED" }))
}

#[tauri::command(async)]
pub fn hide_drafts(
    draft_ids: Vec<String>,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    let ids = draft_ids
        .into_iter()
        .filter(|id| !id.trim().is_empty() && id.len() <= 128)
        .collect::<std::collections::HashSet<_>>();
    if ids.is_empty() || ids.len() > 100 {
        return Err(CommandError::InvalidInput("select between 1 and 100 draft ids".into()));
    }
    let current_hidden = read_engine_local_state(&bridge, "desktop.editorial")
        .and_then(|value| value.get("hiddenDraftIds").and_then(Value::as_array).cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(str::to_string))
        .filter(|id| id.len() <= 128)
        .collect::<std::collections::HashSet<_>>();
    let hidden = current_hidden
        .into_iter()
        .chain(ids.iter().cloned())
        .collect::<std::collections::BTreeSet<_>>();
    let stored = hidden.into_iter().take(500).collect::<Vec<_>>();
    let mutation = json!({
        "kind": "DRAFT.HIDE",
        "draftIds": ids.iter().collect::<Vec<_>>()
    });
    persist_editorial_state(&bridge, mutation.clone(), Some(("hiddenDraftIds", json!(stored))))?;
    write_lock(&state.editorial_mutations)?.push(mutation);
    Ok(json!({ "ok": true, "hidden": ids.len() }))
}

#[tauri::command(async)]
pub fn restore_hidden_drafts(
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    let restored = read_engine_local_state(&bridge, "desktop.editorial")
        .and_then(|value| value.get("hiddenDraftIds").and_then(Value::as_array).map(Vec::len))
        .unwrap_or(0);
    let mutation = json!({ "kind": "DRAFT.RESTORE_HIDDEN" });
    persist_editorial_state(&bridge, mutation.clone(), Some(("hiddenDraftIds", json!([]))))?;
    write_lock(&state.editorial_mutations)?.push(mutation);
    Ok(json!({ "ok": true, "restored": restored }))
}

#[tauri::command(async)]
pub fn retry_job(
    job_id: String,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    if job_id.trim().is_empty() || job_id.len() > 128 {
        return Err(CommandError::InvalidInput("invalid job id".into()));
    }
    let version = read_engine_state(&bridge)?
        .pointer("/snapshot/serverCursor")
        .and_then(Value::as_u64)
        .ok_or_else(|| CommandError::EngineUnavailable("STATE_VERSION_MISSING".into()))?;
    let key = stable_source_key(&format!("retry:{job_id}:{version}"));
    let response = engine_request(
        &bridge,
        json!({
            "version": 1,
            "id": key,
            "kind": "command",
            "command": {
                "version": 1,
                "requestId": key,
                "idempotencyKey": key,
                "expectedVersion": version,
                "kind": "JOB.RETRY",
                "payload": { "jobId": job_id }
            }
        }),
    )?;
    response
        .pointer("/result/value")
        .cloned()
        .ok_or_else(|| CommandError::EngineUnavailable("JOB_RETRY_SHAPE_INVALID".into()))
}

fn revision_edit_payload(
    revision_id: &str,
    instruction: &str,
    base_revision: Value,
    title: Option<&str>,
) -> Result<Value, CommandError> {
    let source_urls = base_revision
        .get("sources")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("url").and_then(Value::as_str))
                .filter(|url| is_http_url(url))
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if source_urls.is_empty() {
        return Err(CommandError::InvalidInput(
            "revizyonda yeniden kullanılabilir kaynak kanıtı yok".into(),
        ));
    }
    Ok(json!({
        "draftId": format!("draft-edit-{revision_id}-{}", &stable_source_key(&format!("{revision_id}:{instruction}"))[..12]),
        "revisionId": revision_id,
        "sourceIds": [],
        "urls": source_urls,
        "sources": base_revision.get("sources").cloned().unwrap_or_else(|| json!([])),
        "instruction": instruction,
        "candidateTitle": title,
        "section": base_revision.get("section").and_then(Value::as_str).unwrap_or("haberler"),
        "articleType": base_revision.get("articleType").and_then(Value::as_str).unwrap_or("news"),
        "visualPolicy": automated_visual_policy(),
        "baseRevision": base_revision,
        "scheduleIntent": "UNSCHEDULED"
    }))
}

#[tauri::command(async)]
pub fn request_revision_edit(
    revision_id: String,
    instruction: String,
    title: Option<String>,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    let title = title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if revision_id.trim().is_empty()
        || revision_id.len() > 200
        || !revision_id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | ':' | '.'))
        || instruction.trim().len() < 3
        || instruction.len() > 20_000
        || title.is_some_and(|value| value.len() > 160)
    {
        return Err(CommandError::InvalidInput(
            "revision id and edit instruction are required".into(),
        ));
    }
    let version = read_engine_state(&bridge)?
        .pointer("/snapshot/serverCursor")
        .and_then(Value::as_u64)
        .ok_or_else(|| CommandError::EngineUnavailable("STATE_VERSION_MISSING".into()))?;
    let materialized =
        read_revision_at_version(&bridge, version, &revision_id).map_err(|error| match error {
            CommandError::InvalidInput(_) => {
                CommandError::InvalidInput("revizyon yerel çalışma bileşeninde bulunamadı".into())
            }
            other => other,
        })?;
    let base_revision = build_review_revision(&materialized)?;
    let payload = revision_edit_payload(&revision_id, instruction.trim(), base_revision, title)?;
    // Includes the read version for the same reason as the other DRAFT.CREATE
    // callers: the engine fingerprint carries expectedVersion, so a version-free
    // key turns a retry into a permanent reused-key rejection.
    let key = stable_source_key(&format!(
        "revision-edit:{revision_id}:{instruction}:{version}"
    ));
    let response = engine_request(
        &bridge,
        json!({
            "version": 1,
            "id": key,
            "kind": "command",
            "command": {
                "version": 1,
                "requestId": key,
                "idempotencyKey": key,
                "expectedVersion": version,
                "kind": "DRAFT.CREATE",
                "payload": payload
            }
        }),
    )?;
    let job = response
        .pointer("/result/value/backendJob")
        .cloned()
        .unwrap_or(Value::Null);
    let mutation = json!({
        "kind": "REVISION.EDIT_REQUEST",
        "revisionId": revision_id,
        "instruction": instruction,
        "state": "RESEARCH_QUEUED",
        "draftJob": job
    });
    persist_editorial_state(&bridge, mutation.clone(), None)?;
    write_lock(&state.editorial_mutations)?.push(mutation);
    Ok(json!({ "ok": true, "state": "RESEARCH_QUEUED", "job": job }))
}

#[tauri::command(async)]
pub fn update_schedule_slot(
    slot_id: String,
    enabled: bool,
    time: String,
    article_id: Option<String>,
    article_title: Option<String>,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    if !valid_schedule_slot(slot_id.trim()) || !valid_hhmm(time.trim()) {
        return Err(CommandError::InvalidInput(
            "known weekly slot and valid HH:MM time are required".into(),
        ));
    }
    let slot_id = slot_id.trim().to_string();
    let time = time.trim().to_string();
    if article_id
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
        || article_title
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
    {
        return Err(CommandError::InvalidInput(
            "weekly cadence cannot assign an approved article; create a new NEXT_SLOT draft instead".into(),
        ));
    }
    let mutation = json!({
        "kind": "SCHEDULE.SLOT",
        "slotId": slot_id,
        "enabled": enabled,
        "time": time
    });
    let mut schedule_state =
        read_engine_local_state(&bridge, "desktop.editorial").unwrap_or_else(|| json!({}));
    let slots = schedule_state
        .as_object_mut()
        .ok_or_else(|| CommandError::EngineUnavailable("EDITORIAL_STATE_INVALID".into()))?
        .entry("schedule")
        .or_insert_with(|| json!({ "slots": {} }));
    let slots_object = slots
        .as_object_mut()
        .ok_or_else(|| CommandError::EngineUnavailable("SCHEDULE_STATE_INVALID".into()))?
        .entry("slots")
        .or_insert_with(|| json!({}));
    let slots_object = slots_object
        .as_object_mut()
        .ok_or_else(|| CommandError::EngineUnavailable("SCHEDULE_SLOTS_INVALID".into()))?;
    // Preserve historical assignments for display only. They never schedule
    // or approve a revision, and a cadence edit must not silently erase them.
    let legacy_assignment = slots_object
        .get(&slot_id)
        .and_then(Value::as_object)
        .map(|slot| {
            (
                slot.get("articleId").cloned(),
                slot.get("articleTitle").cloned(),
            )
        });
    let mut persisted = mutation.clone();
    if let (Some((article_id, article_title)), Some(object)) =
        (legacy_assignment, persisted.as_object_mut())
    {
        if let Some(article_id) = article_id {
            object.insert("articleId".into(), article_id);
        }
        if let Some(article_title) = article_title {
            object.insert("articleTitle".into(), article_title);
        }
    }
    slots_object.insert(slot_id.clone(), persisted);
    persist_editorial_state(
        &bridge,
        mutation.clone(),
        Some((
            "schedule",
            schedule_state
                .get("schedule")
                .cloned()
                .unwrap_or_else(|| json!({"slots": {}})),
        )),
    )?;
    write_lock(&state.editorial_mutations)?.push(mutation);
    Ok(json!({ "ok": true, "slotId": slot_id, "enabled": enabled, "time": time }))
}

#[tauri::command(async)]
pub fn save_desktop_preferences(
    preferences: Value,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    if !preferences.is_object() {
        return Err(CommandError::InvalidInput(
            "desktop preferences must be an object".into(),
        ));
    }
    let mutation = json!({ "kind": "PREFERENCES.SET", "preferences": preferences });
    persist_editorial_state(
        &bridge,
        mutation,
        Some(("preferences", preferences.clone())),
    )?;
    *write_lock(&state.preferences)? = preferences.clone();
    Ok(json!({ "ok": true, "preferences": preferences }))
}

#[tauri::command(async)]
pub fn complete_onboarding(
    settings: OnboardingSettings,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
    app: tauri::AppHandle,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    if settings.device_name.trim().chars().count() < 3
        || settings.scan_interval_minutes < 5
        || !settings.acknowledge_approval_boundary
        || !matches!(
            settings.mode.as_str(),
            "INGEST_ONLY" | "DRAFT_ONLY" | "PUBLISH_APPROVED"
        )
    {
        return Err(CommandError::InvalidInput(
            "onboarding settings are incomplete".into(),
        ));
    }
    let engine_state = read_engine_state(&bridge)?;
    let expected_version = engine_state
        .pointer("/snapshot/serverCursor")
        .and_then(Value::as_u64)
        .ok_or_else(|| CommandError::EngineUnavailable("STATE_VERSION_MISSING".into()))?;
    let current = engine_automation(&engine_state)?;
    let autostart = app.autolaunch();
    let previous_autostart = autostart
        .is_enabled()
        .map_err(|error| CommandError::InvalidInput(error.to_string()))?;
    if settings.autostart_enabled != previous_autostart {
        if settings.autostart_enabled {
            autostart.enable()
        } else {
            autostart.disable()
        }
        .map_err(|error| CommandError::InvalidInput(error.to_string()))?;
    }
    let engine_result = apply_automation_settings(
        &bridge,
        expected_version,
        json!({
            "mode": settings.mode,
            "onboardingComplete": true,
            "ingestionPaused": current
                .get("ingestionPaused")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            "publishingPaused": current
                .get("publishingPaused")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            "timezone": "Europe/Istanbul",
            "scanIntervalMinutes": settings.scan_interval_minutes
        }),
    );
    if let Err(error) = engine_result {
        if settings.autostart_enabled != previous_autostart {
            let _ = if previous_autostart {
                autostart.enable()
            } else {
                autostart.disable()
            };
        }
        return Err(error);
    }
    *write_lock(&state.onboarding_complete)? = true;
    Ok(json!({ "completed": true }))
}

#[tauri::command(async)]
pub fn set_runtime_pause(
    target: String,
    paused: bool,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    let engine_state = read_engine_state(&bridge)?;
    let expected_version = engine_state
        .pointer("/snapshot/serverCursor")
        .and_then(Value::as_u64)
        .ok_or_else(|| CommandError::EngineUnavailable("STATE_VERSION_MISSING".into()))?;
    let mut automation = engine_automation(&engine_state)?;
    match target.as_str() {
        "ingestion" => {
            automation["ingestionPaused"] = json!(paused);
        }
        "publishing" => {
            automation["publishingPaused"] = json!(paused);
        }
        _ => {
            return Err(CommandError::InvalidInput(
                "pause target must be ingestion or publishing".into(),
            ))
        }
    }
    apply_automation_settings(&bridge, expected_version, automation)?;
    match target.as_str() {
        "ingestion" => *write_lock(&state.ingestion_paused)? = paused,
        "publishing" => *write_lock(&state.publishing_paused)? = paused,
        _ => unreachable!("target was validated before engine mutation"),
    }
    Ok(json!({ "paused": paused }))
}

fn notifications_enabled(
    state: &DesktopState,
    bridge: &EngineBridge,
) -> Result<bool, CommandError> {
    let persisted = read_engine_local_state(bridge, "desktop.editorial")
        .and_then(|value| value.pointer("/preferences/notifications").cloned())
        .and_then(|value| value.as_bool());
    match persisted {
        Some(value) => Ok(value),
        None => state
            .preferences
            .read()
            .map_err(|_| CommandError::StateUnavailable)
            .map(|preferences| {
                preferences
                    .get("notifications")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            }),
    }
}

#[tauri::command(async)]
pub fn send_test_notification(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    // The in-memory copy is seeded with defaults on every start and is only
    // written by `save_desktop_preferences`, so after a restart it claimed
    // notifications were on again. The engine-persisted value is the truth;
    // the in-memory copy is only the fallback when local state cannot be read.
    let persisted = read_engine_local_state(&bridge, "desktop.editorial")
        .and_then(|value| value.pointer("/preferences/notifications").cloned())
        .and_then(|value| value.as_bool());
    let enabled = match persisted {
        Some(value) => value,
        None => state
            .preferences
            .read()
            .map_err(|_| CommandError::StateUnavailable)?
            .get("notifications")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    };
    if !enabled {
        return Err(CommandError::InvalidInput(
            "Windows bildirimleri ayarlardan kapalı".into(),
        ));
    }
    notifications::show_review_ready(&app, "Bildirimler doğru çalışıyor.")
        .map_err(CommandError::InvalidInput)?;
    Ok(json!({ "shown": true }))
}

#[tauri::command(async)]
pub fn autostart_status(app: tauri::AppHandle) -> Result<Value, CommandError> {
    let enabled = app
        .autolaunch()
        .is_enabled()
        .map_err(|error| CommandError::InvalidInput(error.to_string()))?;
    Ok(json!({ "enabled": enabled }))
}

#[tauri::command(async)]
pub fn set_autostart(enabled: bool, app: tauri::AppHandle) -> Result<Value, CommandError> {
    let manager = app.autolaunch();
    if enabled {
        manager
            .enable()
            .map_err(|error| CommandError::InvalidInput(error.to_string()))?;
    } else {
        manager
            .disable()
            .map_err(|error| CommandError::InvalidInput(error.to_string()))?;
    }
    Ok(json!({ "enabled": enabled }))
}

#[tauri::command(async)]
pub fn backup_create(
    source_directory: String,
    relative_paths: Vec<String>,
    output_path: String,
    recovery_key: String,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    if source_directory.trim().is_empty()
        || output_path.trim().is_empty()
        || !valid_recovery_key(&recovery_key)
        || relative_paths.is_empty()
        || relative_paths.len() > 256
    {
        return Err(CommandError::InvalidInput(
            "backup source, output, recovery key, and bounded file list are required".into(),
        ));
    }
    let source_directory = require_granted_directory(&state, &source_directory)?;
    let output_path = require_granted_output_file(&state, &output_path)?;
    engine_request(
        &bridge,
        json!({
            "version": 1,
            "id": format!("desktop-backup-create-{}", std::process::id()),
            "kind": "backup.create",
            "payload": {
                "sourceDirectory": source_directory,
                "relativePaths": relative_paths,
                "outputPath": output_path,
                "recoveryKey": recovery_key
            }
        }),
    )
}

#[tauri::command(async)]
pub fn backup_verify(
    archive_path: String,
    recovery_key: String,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    if archive_path.trim().is_empty() || !valid_recovery_key(&recovery_key) {
        return Err(CommandError::InvalidInput(
            "archive path and recovery key are required".into(),
        ));
    }
    let archive_path = require_granted_existing_file(&state, &archive_path)?;
    let response = engine_request(
        &bridge,
        json!({
            "version": 1,
            "id": format!("desktop-backup-verify-{}", std::process::id()),
            "kind": "backup.verify",
            "payload": { "archivePath": archive_path, "recoveryKey": recovery_key }
        }),
    )?;
    record_backup_check(&bridge, "verifiedAtUnixMs", &archive_path, &response);
    Ok(response)
}

/// Records that a backup step actually ran, so the prerequisite row can be derived
/// from an observation instead of being hard-coded. Only the archive file name and
/// the timestamp are stored: the absolute path and the recovery key never enter
/// local state. A failed record keeps the check unproven, which is the safe side.
fn update_backup_verification_record(
    record: &mut Value,
    field: &str,
    archive_name: &str,
    archive_sha256: &str,
    recorded_at: u64,
) -> Result<(), CommandError> {
    if !matches!(field, "verifiedAtUnixMs" | "restorePreviewAtUnixMs")
        || archive_name.is_empty()
        || archive_name.len() > 255
        || archive_sha256.len() != 64
        || !archive_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(CommandError::EngineUnavailable(
            "BACKUP_VERIFICATION_STATE_INVALID".into(),
        ));
    }
    let record = record.as_object_mut().ok_or_else(|| {
        CommandError::EngineUnavailable("BACKUP_VERIFICATION_STATE_INVALID".into())
    })?;
    let normalized_sha256 = archive_sha256.to_ascii_lowercase();
    if record.get("archiveSha256").and_then(Value::as_str) != Some(normalized_sha256.as_str()) {
        // Both observations are one proof only when the engine computed the
        // same content digest. File names and paths can both be reused.
        record.remove("verifiedAtUnixMs");
        record.remove("restorePreviewAtUnixMs");
    }
    record.insert("archiveName".to_string(), json!(archive_name));
    record.insert("archiveSha256".to_string(), json!(normalized_sha256));
    record.insert(field.to_string(), json!(recorded_at));
    Ok(())
}

fn record_backup_check(
    bridge: &EngineBridge,
    field: &str,
    archive_path: &Path,
    response: &Value,
) {
    let archive_name = archive_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let Some(archive_sha256) = response.get("archiveSha256").and_then(Value::as_str) else {
        return;
    };
    let recorded_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let _ = mutate_engine_local_state(bridge, "desktop.connectorChecks", |checks| {
        let object = checks.as_object_mut().ok_or_else(|| {
            CommandError::EngineUnavailable("CONNECTOR_CHECK_STATE_INVALID".into())
        })?;
        let record = object
            .entry("backupVerification")
            .or_insert_with(|| json!({}));
        update_backup_verification_record(
            record,
            field,
            &archive_name,
            archive_sha256,
            recorded_at,
        )
    });
}

#[tauri::command(async)]
pub fn backup_restore_preview(
    archive_path: String,
    target_directory: String,
    recovery_key: String,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    if archive_path.trim().is_empty()
        || target_directory.trim().is_empty()
        || !valid_recovery_key(&recovery_key)
    {
        return Err(CommandError::InvalidInput(
            "archive path, target directory, and recovery key are required".into(),
        ));
    }
    let archive_path = require_granted_existing_file(&state, &archive_path)?;
    let target_directory = require_granted_restore_target(&state, &target_directory)?;
    let response = engine_request(
        &bridge,
        json!({
            "version": 1,
            "id": format!("desktop-backup-preview-{}", std::process::id()),
            "kind": "backup.restore.preview",
            "payload": {
                "archivePath": archive_path,
                "targetDirectory": target_directory,
                "recoveryKey": recovery_key
            }
        }),
    )?;
    record_backup_check(
        &bridge,
        "restorePreviewAtUnixMs",
        &archive_path,
        &response,
    );
    Ok(response)
}

#[tauri::command(async)]
pub fn backup_restore_apply(
    archive_path: String,
    target_directory: String,
    recovery_key: String,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    if archive_path.trim().is_empty()
        || target_directory.trim().is_empty()
        || !valid_recovery_key(&recovery_key)
    {
        return Err(CommandError::InvalidInput(
            "archive path, target directory, and recovery key are required".into(),
        ));
    }
    let archive_path = require_granted_existing_file(&state, &archive_path)?;
    let target_directory = require_granted_restore_target(&state, &target_directory)?;
    engine_request(
        &bridge,
        json!({
            "version": 1,
            "id": format!("desktop-backup-restore-{}", std::process::id()),
            "kind": "backup.restore",
            "payload": { "archivePath": archive_path, "targetDirectory": target_directory, "recoveryKey": recovery_key }
        }),
    )
}

fn valid_automatic_backup_name(value: &str) -> bool {
    let name = value.trim();
    name.starts_with("automatic-")
        && name.ends_with(".backup")
        && name.len() <= 160
        && name.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '.'
        })
}

#[tauri::command(async)]
pub fn automatic_backup_list(
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    engine_request(
        &bridge,
        json!({
            "version": 1,
            "id": format!("desktop-automatic-backup-list-{}", std::process::id()),
            "kind": "backup.auto.list",
            "payload": {}
        }),
    )
}

#[tauri::command(async)]
pub fn automatic_backup_verify(
    backup_name: String,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    if !valid_automatic_backup_name(&backup_name) {
        return Err(CommandError::InvalidInput(
            "automatic backup selection is invalid".into(),
        ));
    }
    engine_request(
        &bridge,
        json!({
            "version": 1,
            "id": format!("desktop-automatic-backup-verify-{}", std::process::id()),
            "kind": "backup.auto.verify",
            "payload": { "backupName": backup_name.trim() }
        }),
    )
}

#[tauri::command(async)]
pub fn automatic_backup_restore_preview(
    backup_name: String,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    if !valid_automatic_backup_name(&backup_name) {
        return Err(CommandError::InvalidInput(
            "automatic backup selection is invalid".into(),
        ));
    }
    engine_request(
        &bridge,
        json!({
            "version": 1,
            "id": format!("desktop-automatic-backup-preview-{}", std::process::id()),
            "kind": "backup.auto.restore.preview",
            "payload": { "backupName": backup_name.trim() }
        }),
    )
}

fn automatic_backup_restore_request(
    backup_name: &str,
    confirm_replace_local_data: bool,
) -> Result<Value, CommandError> {
    if !valid_automatic_backup_name(backup_name) {
        return Err(CommandError::InvalidInput(
            "automatic backup selection is invalid".into(),
        ));
    }
    if !confirm_replace_local_data {
        return Err(CommandError::InvalidInput(
            "automatic backup restore requires explicit replacement confirmation".into(),
        ));
    }
    Ok(json!({
        "version": 1,
        "id": format!("desktop-automatic-backup-restore-{}", std::process::id()),
        "kind": "backup.auto.restore",
        "payload": {
            "backupName": backup_name.trim(),
            "confirmReplaceLocalData": true
        }
    }))
}

#[tauri::command(async)]
pub fn automatic_backup_restore_apply(
    backup_name: String,
    confirm_replace_local_data: bool,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    let request = automatic_backup_restore_request(&backup_name, confirm_replace_local_data)?;
    engine_request(&bridge, request)
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use std::net::{TcpListener, TcpStream};
    use std::path::PathBuf;
    #[cfg(windows)]
    use std::process::{Child, Command, Stdio};
    #[cfg(windows)]
    use std::thread;
    #[cfg(windows)]
    use std::time::{Duration, Instant};

    use serde_json::{json, Value};

    use super::{
        append_pending_draft_jobs, authorize_connector_directory, authorize_high_risk_consent,
        authorize_native_confirmation, build_approval_command, build_approval_revoke_command,
        build_high_risk_approval_command,
        build_review_revision, build_revision_queue, build_source_scan_command,
        boby_guidance_request_token, boby_guidance_wait_reason, boby_role_state, bootstrap_boby_state, bootstrap_can_read_catalog, candidate_draft_payload, candidate_workflow_state, configured_site_origin,
        dashboard_pipeline_counts, doctor_runtime_mode, editorial_operation_events,
        ensure_mutation_allowed, ensure_trusted_local_dev, github_preview_payload,
        has_publication_capability, is_local_path, is_path_within_grant, is_reparse_point,
        local_dev_environment_with, materialize_preview_bundle_with,
        latest_boby_session_id, migrate_legacy_site_connector_catalog, preview_file_bytes, preview_file_media_reference,
        bound_editorial_state, publication_observability, register_folder_grant, request_choice,
        request_section, valid_git_object_id, valid_github_branch, MAX_EDITORIAL_MUTATIONS,
        MAX_EDITORIAL_STATE_BYTES, SITE_SECTION_IDS,
        require_granted_directory, require_granted_restore_target, retry_version_conflicted_draft,
        revision_edit_payload, scheduled_operation_items, valid_github_segment,
        valid_github_workflow, valid_hhmm, valid_recovery_key, valid_schedule_slot,
        valid_site_work_mode, validate_folder_selection, validate_local_dev_project,
        connector_state_for_runtime, operations_for_runtime, operations_job_is_visible_work,
        prerequisite_can_read_engine, workspace_can_read_engine, workspace_engine_state, write_lock,
        CommandError, DesktopState, RuntimeMode,
    };

    #[cfg(windows)]
    fn descendant_http_fixture() -> (Child, u16) {
        let port = TcpListener::bind(("127.0.0.1", 0))
            .expect("reserve fixture port")
            .local_addr()
            .expect("fixture address")
            .port();
        let script = format!(
            "import subprocess,sys,time; subprocess.Popen([sys.executable,'-m','http.server','{port}','--bind','127.0.0.1'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(300)"
        );
        let mut child = Command::new("python")
            .args(["-c", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn fixture parent");
        let deadline = Instant::now() + Duration::from_secs(30);
        while TcpStream::connect(("127.0.0.1", port)).is_err() {
            if let Ok(Some(status)) = child.try_wait() {
                panic!("descendant HTTP fixture exited before listening: {status}");
            }
            assert!(
                Instant::now() < deadline,
                "descendant HTTP server did not start within 30 seconds"
            );
            thread::sleep(Duration::from_millis(50));
        }
        (child, port)
    }

    #[test]
    fn boby_is_not_marked_ready_until_its_app_owned_session_is_verified() {
        assert_eq!(boby_role_state(0, true, true, false), "UNAVAILABLE");
        assert_eq!(boby_role_state(0, true, true, true), "READY");
        assert_eq!(boby_role_state(0, false, true, true), "READY");
        assert_eq!(boby_role_state(1, true, true, false), "BUSY");
    }

    #[test]
    fn bootstrap_exposes_the_verified_boby_session_state() {
        assert_eq!(bootstrap_boby_state(0, true, false), "UNAVAILABLE");
        assert_eq!(bootstrap_boby_state(0, true, true), "READY");
        assert_eq!(bootstrap_boby_state(1, true, true), "BUSY");
    }

    #[test]
    fn boby_guidance_messages_always_receive_distinct_durable_handles() {
        let first = boby_guidance_request_token().expect("first Boby handle");
        let second = boby_guidance_request_token().expect("second Boby handle");
        assert!(first.starts_with("boby-"));
        assert!(second.starts_with("boby-"));
        assert!(first.len() <= 128 && second.len() <= 128);
        assert_ne!(first, second, "a repeated question must not inherit a stale Boby job");
    }
    #[test]
    fn boby_waiting_states_expose_safe_editor_reasons() {
        assert_eq!(boby_guidance_wait_reason("WAITING_CODEX"), Some("Boby bağlantıyı hazırlıyor; hazır olduğunda yanıtını gösterecek."));
        assert_eq!(boby_guidance_wait_reason("RUNNING"), Some("Boby yanıtı hazırlıyor."));
        assert_eq!(boby_guidance_wait_reason("QUEUED"), Some("Boby isteğini hazırlıyor."));
        assert_eq!(boby_guidance_wait_reason("FAILED"), None);
    }

    #[test]
    fn boby_diagnostic_code_is_allowlisted() {
        assert_eq!(
            super::boby_guidance_diagnostic_code(&json!({ "metadata": { "codexDiagnosticCode": "CODEX_PROCESS_FAILED" } })),
            Some("CODEX_PROCESS_FAILED")
        );
        assert_eq!(
            super::boby_guidance_diagnostic_code(&json!({ "metadata": { "codexDiagnosticCode": "untrusted-detail" } })),
            None
        );
    }

    #[test]
    fn boby_resumes_the_latest_completed_session_not_job_id_order() {
        let jobs = vec![
            json!({
                "id": "boby-z-old",
                "metadata": {
                    "purpose": "BOBY_GUIDANCE",
                    "bobySessionId": "boby-old-session",
                    "completedAtUnixMs": 100
                }
            }),
            json!({
                "id": "boby-a-new",
                "metadata": {
                    "purpose": "BOBY_GUIDANCE",
                    "bobySessionId": "boby-new-session",
                    "completedAtUnixMs": 200
                }
            }),
        ];

        assert_eq!(
            latest_boby_session_id(&jobs).as_deref(),
            Some("boby-new-session")
        );
    }

    #[test]
    fn offline_bootstrap_never_reads_catalog_projections() {
        assert!(!bootstrap_can_read_catalog(RuntimeMode::OfflineReadOnly));
        assert!(!bootstrap_can_read_catalog(RuntimeMode::Degraded));
        assert!(bootstrap_can_read_catalog(RuntimeMode::Online));
    }

    #[test]
    fn offline_editorial_workspace_never_probes_a_closed_engine() {
        assert!(!workspace_can_read_engine(RuntimeMode::OfflineReadOnly));
        assert!(!workspace_can_read_engine(RuntimeMode::Degraded));
        assert!(workspace_can_read_engine(RuntimeMode::Online));
    }

    #[test]
    fn offline_prerequisite_screen_never_reopens_the_encrypted_engine_store() {
        assert!(!prerequisite_can_read_engine(RuntimeMode::OfflineReadOnly));
        assert!(!prerequisite_can_read_engine(RuntimeMode::Degraded));
        assert!(prerequisite_can_read_engine(RuntimeMode::Online));
    }

    #[test]
    fn offline_operations_screen_returns_a_truthful_non_retrying_projection() {
        let snapshot = operations_for_runtime(RuntimeMode::OfflineReadOnly).expect("offline projection");
        assert_eq!(snapshot.pointer("/worker/state").and_then(Value::as_str), Some("OFFLINE"));
        assert_eq!(snapshot.pointer("/publisher/state").and_then(Value::as_str), Some("BLOCKED"));
        assert_eq!(snapshot.get("events").and_then(Value::as_array).map(Vec::len), Some(0));
        assert!(operations_for_runtime(RuntimeMode::Online).is_none());
    }

    #[test]
    fn conversational_boby_jobs_do_not_inflate_the_editorial_worker_queue() {
        assert!(!operations_job_is_visible_work(&json!({
            "kind": "CODEX",
            "state": "RETRY_SCHEDULED",
            "metadata": { "purpose": "BOBY_GUIDANCE" }
        })));
        assert!(operations_job_is_visible_work(&json!({
            "kind": "DRAFT",
            "state": "RETRY_SCHEDULED",
            "metadata": { "progressStage": "FINAL_REVIEW_RETRYING" }
        })));
    }

    #[test]
    fn offline_content_catalog_is_recovery_gated_before_sidecar_io() {
        assert!(!workspace_can_read_engine(RuntimeMode::OfflineReadOnly));
        assert!(!workspace_can_read_engine(RuntimeMode::Degraded));
    }

    #[test]
    fn offline_connector_read_returns_the_safe_empty_snapshot() {
        let snapshot = connector_state_for_runtime(RuntimeMode::OfflineReadOnly).expect("offline snapshot");
        assert_eq!(snapshot.get("sourceState").and_then(Value::as_str), Some("ABSENT"));
        assert_eq!(snapshot.get("mode").and_then(Value::as_str), Some("LOCAL_ONLY"));
        assert_eq!(snapshot.pointer("/config/site/mode").and_then(Value::as_str), Some("LOCAL_ONLY"));
    }

    #[cfg(windows)]
    fn assert_port_closes(port: u16) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while TcpStream::connect(("127.0.0.1", port)).is_ok() {
            assert!(
                Instant::now() < deadline,
                "descendant HTTP server survived termination"
            );
            thread::sleep(Duration::from_millis(25));
        }
    }

    #[cfg(windows)]
    #[test]
    fn stopping_local_dev_terminates_its_owned_descendant_process_tree() {
        let (child, port) = descendant_http_fixture();
        let process = std::sync::RwLock::new(Some(child));

        super::stop_local_dev_process(&process).expect("stop local dev fixture");

        assert_port_closes(port);
    }

    #[cfg(windows)]
    #[test]
    fn dropping_desktop_state_terminates_local_dev_descendants() {
        let (child, port) = descendant_http_fixture();
        let state = super::DesktopState::default();
        *state
            .local_dev_process
            .write()
            .expect("local dev process lock") = Some(child);

        drop(state);

        assert_port_closes(port);
    }

    #[test]
    fn bootstrap_runtime_requires_ready_doctor_handshake() {
        assert_eq!(doctor_runtime_mode(None), RuntimeMode::OfflineReadOnly);
        assert_eq!(
            doctor_runtime_mode(Some(&json!({"status": "DEGRADED", "queue": "ready"}))),
            RuntimeMode::OfflineReadOnly
        );
        assert_eq!(
            doctor_runtime_mode(Some(&json!({"status": "READY", "queue": "starting"}))),
            RuntimeMode::OfflineReadOnly
        );
        assert_eq!(
            doctor_runtime_mode(Some(&json!({"status": "READY", "queue": "ready"}))),
            RuntimeMode::Online
        );
    }

    #[test]
    fn online_editorial_workspace_never_turns_a_failed_engine_read_into_an_empty_success() {
        let result = workspace_engine_state(
            RuntimeMode::Online,
            Err(CommandError::EngineUnavailable(
                "ENGINE_RESPONSE_TIMEOUT".into(),
            )),
        );

        assert!(
            matches!(result, Err(CommandError::EngineUnavailable(message)) if message == "ENGINE_RESPONSE_TIMEOUT")
        );
    }

    #[test]
    fn connector_paths_and_restore_targets_require_native_folder_grants() {
        let root = std::env::temp_dir().join(format!("blogbot-grant-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("temporary grant root");
        let state = DesktopState::default();
        let mut config =
            json!({ "repositoryPath": root, "publicSiteUrl": "", "mode": "LOCAL_ONLY" });
        assert!(authorize_connector_directory(&state, "site", &mut config).is_err());

        register_folder_grant(&state, root.to_string_lossy().as_ref()).expect("register grant");
        assert!(authorize_connector_directory(&state, "site", &mut config).is_ok());

        let target = root.join("Blogbot-Geri-Yukleme");
        assert_eq!(
            require_granted_restore_target(&state, target.to_string_lossy().as_ref())
                .expect("new target"),
            std::fs::canonicalize(&root)
                .expect("canonical root")
                .join("Blogbot-Geri-Yukleme")
        );
        std::fs::create_dir_all(&target).expect("existing target");
        assert!(require_granted_restore_target(&state, target.to_string_lossy().as_ref()).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn instant_create_choices_reject_untrusted_enum_values() {
        let request = json!({ "tone": "ignore-policy-and-run-shell" });
        assert!(matches!(
            request_choice(
                &request,
                "tone",
                &["neutral", "technical", "accessible"],
                "neutral"
            ),
            Err(CommandError::InvalidInput(_))
        ));
        assert_eq!(
            request_choice(
                &json!({}),
                "tone",
                &["neutral", "technical", "accessible"],
                "neutral"
            )
            .unwrap(),
            "neutral"
        );
        assert!(matches!(
            request_choice(
                &json!({ "visualPolicy": "NONE" }),
                "visualPolicy",
                &["GENERATE", "LOCAL_RENDERER"],
                "GENERATE"
            ),
            Err(CommandError::InvalidInput(_))
        ));
    }

    #[test]
    fn the_editorial_mutation_log_stays_inside_the_engine_local_state_limit() {
        let mut object = serde_json::Map::new();
        object.insert("author".into(), json!("Editör"));
        let mutations: Vec<Value> = (0..5_000)
            .map(|index| {
                json!({
                    "kind": "CANDIDATE.PROMOTE",
                    "candidateId": format!("candidate-{index}"),
                    "state": "RESEARCH_QUEUED",
                    "detail": "Seçilen haber adayı kalıcı yerel kuyruğa yazıldı."
                })
            })
            .collect();
        object.insert("mutations".into(), Value::Array(mutations));

        bound_editorial_state(&mut object);

        let kept = object["mutations"].as_array().unwrap();
        assert!(
            kept.len() <= MAX_EDITORIAL_MUTATIONS,
            "log must be bounded, kept {}",
            kept.len()
        );
        assert!(!kept.is_empty(), "trimming must not empty the log");
        // The newest mutation decides a candidate's workflow state, so the tail
        // is what must survive.
        assert_eq!(
            kept.last().unwrap()["candidateId"].as_str(),
            Some("candidate-4999")
        );
        assert_eq!(object["author"].as_str(), Some("Editör"));

        let encoded = serde_json::to_string(&Value::Object(object)).unwrap();
        assert!(
            encoded.len() <= MAX_EDITORIAL_STATE_BYTES,
            "document must fit the engine's 256 000 unit local-state limit, got {}",
            encoded.len()
        );
    }

    #[test]
    fn base_sha_capture_only_accepts_a_safe_branch_and_a_real_object_id() {
        // The branch is interpolated into a GitHub API path, so the grammar has
        // to reject anything that could escape it.
        for branch in ["main", "release/v1", "feature-1.2"] {
            assert!(valid_github_branch(branch), "must accept: {branch}");
        }
        for branch in ["", " main", "/main", "main/", "a..b", "main?x", "main#1", "main branch"] {
            assert!(!valid_github_branch(branch), "must reject: {branch}");
        }

        // Approval binds this value, so a response that is not an object id must
        // never be written into the connector as if it were verified.
        assert!(valid_git_object_id(&"a".repeat(40)));
        assert!(valid_git_object_id(&"b".repeat(64)));
        for invalid in ["", "abc", &"a".repeat(39), &"a".repeat(41), &"z".repeat(40)] {
            assert!(!valid_git_object_id(invalid), "must reject: {invalid}");
        }
    }

    #[test]
    fn base_sha_capture_reapplies_to_the_latest_connectors_and_reports_a_write() {
        let stored = std::cell::RefCell::new(json!({
            "site": { "mode": "LOCAL_ONLY" },
            "github": { "workflow": "deploy.yml" }
        }));
        let attempts = std::cell::Cell::new(0_u32);

        let result = super::local_state_write(
            || Ok(40),
            || stored.borrow().clone(),
            |connectors| {
                super::update_github_base_sha_state(
                    connectors,
                    "owner",
                    "site",
                    "main",
                    &"a".repeat(40),
                )
            },
            |_version, value| {
                attempts.set(attempts.get() + 1);
                if attempts.get() == 1 {
                    *stored.borrow_mut() = json!({
                        "site": { "mode": "PUBLISH" },
                        "backup": { "folder": "D:\\Backups" },
                        "github": { "workflow": "deploy.yml" }
                    });
                    return Err(CommandError::EngineUnavailable(
                        "VERSION_CONFLICT:40:41".into(),
                    ));
                }
                Ok(value)
            },
        )
        .expect("base SHA connector mutation");

        assert_eq!(result["site"]["mode"], "PUBLISH");
        assert_eq!(result["backup"]["folder"], "D:\\Backups");
        assert_eq!(result["github"]["workflow"], "deploy.yml");
        assert_eq!(result["github"]["baseSha"], "a".repeat(40));

        let response = super::github_base_sha_capture_result(
            "owner/site",
            "main",
            &"a".repeat(40),
        );
        assert_eq!(response["writes"], true);
        assert_eq!(response["network"], true);
    }

    #[test]
    fn instant_create_keeps_the_section_the_editor_chose() {
        let allowed = SITE_SECTION_IDS;

        // Every contract section must be accepted. Half of them used to be
        // rejected while the renderer still offered all eight.
        assert_eq!(allowed.len(), 8);
        for section in ["teknoloji", "ekonomi", "kultur", "yasam"] {
            assert_eq!(
                request_section(&json!({ "targetSection": section }), &allowed, "haberler").unwrap(),
                section
            );
        }

        // The renderer's field name is `targetSection`; reading only `section`
        // filed every instant draft under the default section instead.
        assert_eq!(
            request_section(&json!({ "targetSection": "analiz" }), &allowed, "haberler").unwrap(),
            "analiz"
        );
        // An older renderer payload is still honoured.
        assert_eq!(
            request_section(&json!({ "section": "dosyalar" }), &allowed, "haberler").unwrap(),
            "dosyalar"
        );
        assert_eq!(
            request_section(&json!({}), &allowed, "haberler").unwrap(),
            "haberler"
        );
        // An untrusted value is still rejected rather than silently defaulted.
        assert!(matches!(
            request_section(&json!({ "targetSection": "../etc" }), &allowed, "haberler"),
            Err(CommandError::InvalidInput(_))
        ));
    }

    #[test]
    fn legacy_site_connector_migrates_once_and_requires_revalidation() {
        let mut connectors = json!({});
        let mut checks = json!({});
        let marker = migrate_legacy_site_connector_catalog(&mut connectors, &mut checks, Some(&json!({
            "repositoryPath": r"C:\Blogbot\Site", "publicSiteUrl": "https://example.org", "mode": "PUBLISH"
        }))).unwrap();

        assert_eq!(marker["state"], "MIGRATED_REVALIDATION_REQUIRED");
        assert_eq!(connectors["site"]["repositoryPath"], r"C:\Blogbot\Site");
        assert_eq!(checks["site"]["ready"], false);
        assert_eq!(
            checks["site"]["migrationState"],
            "MIGRATED_REVALIDATION_REQUIRED"
        );
    }

    #[test]
    fn conflicting_legacy_site_connector_keeps_catalog_and_fails_closed() {
        let mut connectors = json!({ "site": {
            "repositoryPath": r"C:\Catalog\Site", "publicSiteUrl": "", "mode": "LOCAL_ONLY"
        }});
        let mut checks = json!({ "site": { "ready": true, "state": "DRY_RUN_READY" } });
        let marker = migrate_legacy_site_connector_catalog(
            &mut connectors,
            &mut checks,
            Some(&json!({
                "repositoryPath": r"C:\Legacy\Site", "publicSiteUrl": "", "mode": "LOCAL_ONLY"
            })),
        )
        .unwrap();

        assert_eq!(marker["state"], "MIGRATION_CONFLICT_REVIEW_REQUIRED");
        assert_eq!(connectors["site"]["repositoryPath"], r"C:\Catalog\Site");
        assert_eq!(checks["site"]["ready"], false);
    }

    #[test]
    fn native_folder_grants_reject_sibling_and_parent_paths() {
        let grant = PathBuf::from(r"C:\Blogbot\Selected");
        assert!(is_path_within_grant(
            &PathBuf::from(r"C:\Blogbot\Selected\blogbot.backup"),
            std::slice::from_ref(&grant)
        ));
        assert!(!is_path_within_grant(
            &PathBuf::from(r"C:\Blogbot\Sibling\blogbot.backup"),
            std::slice::from_ref(&grant)
        ));
        assert!(!is_path_within_grant(
            &PathBuf::from(r"C:\Blogbot"),
            &[grant]
        ));
    }

    #[test]
    fn native_folder_grant_requires_an_explicit_picker_registration() {
        let root =
            std::env::temp_dir().join(format!("blogbot-folder-grant-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let state = DesktopState::default();
        assert!(require_granted_directory(&state, &root.to_string_lossy()).is_err());
        let granted = register_folder_grant(&state, &root.to_string_lossy()).unwrap();
        assert_eq!(
            require_granted_directory(&state, &root.to_string_lossy()).unwrap(),
            granted
        );
        std::fs::remove_dir(&root).unwrap();
    }

    #[test]
    fn candidate_promotion_uses_the_catalog_source_not_the_candidate_id() {
        let payload = candidate_draft_payload(
            "candidate-1",
            &json!({
                "sourceId": "source-real-1",
                "title": "Kaynak katalogundan gelen aday başlığı",
                "section": "analiz",
                "articleType": "analysis"
            }),
        )
        .unwrap();
        assert_eq!(payload["candidateId"], "candidate-1");
        assert_eq!(
            payload["candidateTitle"],
            "Kaynak katalogundan gelen aday başlığı"
        );
        assert_eq!(payload["sourceIds"], json!(["source-real-1"]));
        assert!(payload["candidateUrl"].is_null());
        assert_eq!(payload["section"], "analiz");
        assert!(candidate_draft_payload("candidate-1", &json!({})).is_err());
    }

    #[test]
    fn candidate_promotion_binds_research_to_the_selected_story_url() {
        let payload = candidate_draft_payload(
            "candidate-story-1",
            &json!({
                "sourceId": "source-real-1",
                "sourceUrl": "https://news.example/stories/selected",
                "title": "Seçili haber"
            }),
        )
        .unwrap();

        assert_eq!(
            payload["candidateUrl"],
            "https://news.example/stories/selected"
        );
        assert_eq!(payload["urls"], json!([]));
    }

    #[test]
    fn candidate_promotion_preserves_bounded_corroborating_sources() {
        let payload = candidate_draft_payload(
            "candidate-story-2",
            &json!({
                "sourceId": "source-primary",
                "sourceIds": ["source-primary", "source-independent"],
                "sourceUrl": "https://primary.example/story",
                "sourceUrls": ["https://primary.example/story", "https://independent.example/story"],
                "title": "Birden fazla kaynakla doğrulanan haber"
            }),
        )
        .unwrap();

        assert_eq!(
            payload["sourceIds"],
            json!(["source-primary", "source-independent"])
        );
        assert_eq!(
            payload["urls"],
            json!([
                "https://primary.example/story",
                "https://independent.example/story"
            ])
        );
        assert_eq!(payload["candidateUrl"], "https://primary.example/story");
    }

    #[test]
    fn candidate_draft_retries_one_safe_version_conflict_with_the_same_payload() {
        let mut versions = vec![41_u64, 42_u64].into_iter();
        let mut attempted_versions = Vec::new();
        let result = retry_version_conflicted_draft(
            || Ok(versions.next().expect("a fresh version is available")),
            |version| {
                attempted_versions.push(version);
                if version == 41 {
                    return Err(CommandError::EngineUnavailable("VERSION_CONFLICT:41:42".into()));
                }
                Ok(json!({ "result": { "value": { "backendJob": { "id": "draft-candidate-1" } } } }))
            },
        )
        .expect("the retried draft command is accepted");

        assert_eq!(attempted_versions, vec![41, 42]);
        assert_eq!(
            result
                .pointer("/result/value/backendJob/id")
                .and_then(serde_json::Value::as_str),
            Some("draft-candidate-1")
        );
    }

    #[test]
    fn failed_candidate_draft_is_not_projected_as_a_healthy_research_queue() {
        let mutations = [json!({
            "kind": "CANDIDATE.PROMOTE",
            "candidateId": "candidate-failed",
            "state": "RESEARCH_QUEUED"
        })];
        let jobs = [json!({
            "id": "draft-candidate-failed",
            "kind": "DRAFT",
            "state": "FAILED",
            "metadata": { "candidateId": "candidate-failed" }
        })];

        assert_eq!(
            candidate_workflow_state("candidate-failed", &mutations, &jobs),
            "RESEARCH_FAILED"
        );
        assert_eq!(
            candidate_workflow_state("candidate-other", &mutations, &jobs),
            "NEW"
        );
    }

    #[test]
    fn completed_candidate_draft_is_not_left_in_the_research_queue() {
        let mutations = [json!({
            "kind": "CANDIDATE.PROMOTE",
            "candidateId": "candidate-complete",
            "state": "RESEARCH_QUEUED"
        })];
        let jobs = [json!({
            "id": "draft-candidate-complete",
            "kind": "DRAFT",
            "state": "SUCCEEDED",
            "metadata": { "candidateId": "candidate-complete" }
        })];

        assert_eq!(
            candidate_workflow_state("candidate-complete", &mutations, &jobs),
            "PROMOTED"
        );
    }
    #[test]
    fn dismissing_a_candidate_hides_it_even_when_its_draft_job_still_exists() {
        let mutations = [
            json!({
                "kind": "CANDIDATE.PROMOTE",
                "candidateId": "candidate-closed",
                "state": "RESEARCH_QUEUED"
            }),
            json!({
                "kind": "CANDIDATE.DISMISS",
                "candidateId": "candidate-closed",
                "state": "DISMISSED"
            }),
        ];
        let jobs = [json!({
            "id": "draft-candidate-closed",
            "kind": "DRAFT",
            "state": "QUEUED",
            "metadata": { "candidateId": "candidate-closed" }
        })];

        assert_eq!(
            candidate_workflow_state("candidate-closed", &mutations, &jobs),
            "DISMISSED"
        );
    }


    #[test]
    fn codex_usage_projects_only_observed_local_draft_activity() {
        let now = 1_785_600_000_000_u128;
        let usage = super::codex_usage_from_jobs(
            &[
                json!({
                    "id": "draft-running",
                    "kind": "DRAFT",
                    "state": "RUNNING"
                }),
                json!({
                    "id": "draft-complete",
                    "kind": "DRAFT",
                    "state": "SUCCEEDED",
                    "metadata": { "completedAtUnixMs": now - 1_000 }
                }),
                json!({
                    "id": "source-complete",
                    "kind": "SOURCE_SCAN",
                    "state": "SUCCEEDED",
                    "metadata": { "completedAtUnixMs": now - 1_000 }
                }),
            ],
            now,
        )
        .expect("usage");

        assert_eq!(usage[0]["role"], "FAST");
        assert!(usage[0]["completedToday"].is_null());
        assert_eq!(usage[1]["role"], "DEFAULT");
        assert_eq!(usage[1]["queueDepth"], 1);
        assert_eq!(usage[1]["completedToday"], 1);
        assert_eq!(usage[1]["lastSuccessAt"], "2026-08-01T15:59:59.000Z");
        assert!(usage[2]["completedToday"].is_null());
    }

    #[test]
    fn codex_role_state_marks_only_the_role_with_observed_work_busy() {
        assert_eq!(
            super::codex_role_state_for_usage("DEFAULT", 2, "BUSY"),
            "BUSY"
        );
        assert_eq!(
            super::codex_role_state_for_usage("FAST", 2, "BUSY"),
            "READY"
        );
        assert_eq!(
            super::codex_role_state_for_usage("DEEP_REVIEW", 2, "BUSY"),
            "READY"
        );
        assert_eq!(
            super::codex_role_state_for_usage("FAST", 0, "UNAVAILABLE"),
            "UNAVAILABLE"
        );
    }

    #[test]
    fn operations_schedule_projects_approved_revisions_not_weekly_slot_preferences() {
        let schedule = scheduled_operation_items(&[
            json!({
                "id": "revision-scheduled",
                "title": "Planlanmış yerel yazı",
                "section": "analiz",
                "scheduledAt": "2026-08-09T15:45:00.000Z",
                "state": "APPROVED"
            }),
            json!({
                "id": "revision-pending",
                "title": "İnceleme bekleyen yazı",
                "section": "haberler",
                "scheduledAt": "2026-08-10T10:00:00.000Z",
                "state": "REVIEW_REQUIRED"
            }),
            json!({
                "slotId": "slot-sun",
                "time": "18:45",
                "enabled": true
            }),
        ]);

        assert_eq!(schedule.len(), 1);
        assert_eq!(schedule[0]["id"], "revision-scheduled");
        assert_eq!(schedule[0]["at"], "2026-08-09T15:45:00.000Z");
        assert_eq!(schedule[0]["section"], "analiz");
        assert_eq!(schedule[0]["state"], "APPROVED");
        assert!(schedule[0].get("time").is_none());
    }

    #[test]
    fn waiting_candidate_draft_job_stays_visible_on_the_editorial_desk_without_opening_review() {
        let drafts = append_pending_draft_jobs(
            Vec::new(),
            &[json!({
                "id": "draft-candidate-1",
                "kind": "DRAFT",
                "state": "WAITING_CODEX",
                "metadata": {
                    "candidateId": "candidate-1",
                    "candidateTitle": "Tedarik zinciri açığını araştır",
                    "section": "analiz",
                    "createdAtUnixMs": 1
                }
            })],
        );

        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0]["id"], "draft-candidate-1");
        assert_eq!(drafts[0]["titleTr"], "Tedarik zinciri açığını araştır");
        assert_eq!(drafts[0]["state"], "DRAFTING");
        assert_eq!(drafts[0]["reviewable"], false);
        assert!(drafts[0]["completion"].is_null());
        assert_eq!(drafts[0]["executionState"], "WAITING");
        assert_eq!(drafts[0]["nextAction"], "CONNECT_CODEX");
        assert_eq!(drafts[0]["reasonCode"], "CODEX_UNAVAILABLE");
        assert_eq!(
            drafts[0]["detail"],
            "Codex hesabı veya izole runner bekleniyor."
        );
    }

    #[test]
    fn retrying_codex_draft_explains_that_the_durable_queue_kept_the_work() {
        let drafts = append_pending_draft_jobs(
            Vec::new(),
            &[json!({
                "id": "draft-retry-1",
                "kind": "DRAFT",
                "state": "QUEUED",
                "metadata": {
                    "candidateTitle": "Bağlantı kesintisi test taslağı",
                    "section": "haberler",
                    "progressStage": "RETRYING_CODEX",
                    "codexRetryReason": "EXECUTION_FAILED"
                }
            })],
        );

        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0]["detail"], "Yazı üretimi kesintiye uğradı; iş kaybolmadı ve güvenli yerel kuyrukta yeniden deneniyor.");
        assert_eq!(drafts[0]["executionState"], "RETRY_SCHEDULED");
        assert_eq!(drafts[0]["nextAction"], "NONE");
        assert_eq!(drafts[0]["reviewable"], false);
    }

    #[test]
    fn scheduled_final_review_retry_stays_visible_on_the_editorial_desk() {
        let drafts = append_pending_draft_jobs(
            Vec::new(),
            &[json!({
                "id": "draft-final-review-retry-1",
                "kind": "DRAFT",
                "state": "RETRY_SCHEDULED",
                "metadata": {
                    "candidateTitle": "Son kalite yeniden denemesi",
                    "section": "analiz",
                    "progressStage": "FINAL_REVIEW_RETRYING",
                    "finalReviewRetryReason": "EXECUTION_FAILED",
                    "finalReviewRetryAtUnixMs": u64::MAX
                }
            })],
        );

        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0]["id"], "draft-final-review-retry-1");
        assert_eq!(drafts[0]["state"], "DRAFTING");
        assert_eq!(drafts[0]["reviewable"], false);
        assert_eq!(drafts[0]["executionState"], "RETRY_SCHEDULED");
        assert_eq!(drafts[0]["nextAction"], "NONE");
        assert_eq!(
            drafts[0]["detail"],
            "Son kalite incelemesi geçici bir hatadan sonra otomatik yeniden denenecek."
        );
    }

    #[test]
    fn overdue_final_review_retry_offers_a_visible_recovery_action() {
        let drafts = append_pending_draft_jobs(
            Vec::new(),
            &[json!({
                "id": "draft-final-review-overdue-1",
                "kind": "DRAFT",
                "state": "RETRY_SCHEDULED",
                "metadata": {
                    "candidateTitle": "Gecikmiş son kalite incelemesi",
                    "section": "analiz",
                    "progressStage": "FINAL_REVIEW_RETRYING",
                    "finalReviewRetryReason": "EXECUTION_FAILED",
                    "finalReviewRetryAtUnixMs": 1
                }
            })],
        );

        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0]["executionState"], "FAILED");
        assert_eq!(drafts[0]["nextAction"], "RETRY");
        assert_eq!(drafts[0]["reasonCode"], "RETRY_OVERDUE");
        assert_eq!(drafts[0]["blockers"], 1);
        assert_eq!(
            drafts[0]["detail"],
            "Son kalite incelemesi için planlanan tekrar zamanı geçti. İş kaybolmadı; yeniden denemek için düğmeyi kullanın."
        );
    }

    #[test]
    fn materialized_revision_keeps_its_pending_final_review_status_visible() {
        let drafts = append_pending_draft_jobs(
            vec![json!({
                "id": "draft-final-review-collision-1",
                "state": "REVIEW_REQUIRED",
                "reviewable": true,
                "blockers": 0,
                "detail": "Ready for review"
            })],
            &[json!({
                "id": "draft-final-review-collision-1",
                "kind": "DRAFT",
                "state": "RETRY_SCHEDULED",
                "metadata": {
                    "progressStage": "FINAL_REVIEW_RETRYING",
                    "finalReviewRetryReason": "EXECUTION_FAILED",
                    "finalReviewRetryAtUnixMs": 1
                }
            })],
        );

        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0]["state"], "DRAFTING");
        assert_eq!(drafts[0]["reviewable"], false);
        assert_eq!(drafts[0]["executionState"], "FAILED");
        assert_eq!(drafts[0]["nextAction"], "RETRY");
        assert_eq!(drafts[0]["reasonCode"], "RETRY_OVERDUE");
        assert_eq!(drafts[0]["blockers"], 1);
    }

    #[test]
    fn final_quality_stage_is_visible_as_a_distinct_editorial_phase() {
        let drafts = append_pending_draft_jobs(
            Vec::new(),
            &[json!({
                "id": "draft-final-review-1",
                "kind": "DRAFT",
                "state": "RUNNING",
                "metadata": {
                    "candidateTitle": "Son kalite testi",
                    "section": "analiz",
                    "progressStage": "FINAL_REVIEW"
                }
            })],
        );

        assert_eq!(
            drafts[0]["detail"],
            "Taslak, kaynak ve iki dil için son kalite incelemesinden geçiyor."
        );
        assert_eq!(drafts[0]["reviewable"], false);
    }

    #[test]
    fn dashboard_pipeline_counts_new_candidates_and_only_active_draft_research() {
        let (discovered, researching) = dashboard_pipeline_counts(
            &[
                json!({ "id": "candidate-new" }),
                json!({ "id": "candidate-promoted" }),
                json!({ "id": "candidate-dismissed" }),
            ],
            &[
                json!({ "kind": "CANDIDATE.PROMOTE", "candidateId": "candidate-promoted", "state": "RESEARCH_QUEUED" }),
                json!({ "kind": "CANDIDATE.DISMISS", "candidateId": "candidate-dismissed", "state": "DISMISSED" }),
            ],
            &[
                json!({ "kind": "DRAFT", "state": "WAITING_CODEX" }),
                json!({ "kind": "DRAFT", "state": "RUNNING" }),
                json!({ "kind": "DRAFT", "state": "FAILED" }),
                json!({ "kind": "CODEX", "state": "QUEUED" }),
            ],
        );

        assert_eq!(discovered, 1);
        assert_eq!(researching, 2);
    }

    #[test]
    fn editorial_mutations_are_projected_as_user_facing_operation_events() {
        let events = editorial_operation_events(&[
            json!({ "kind": "CANDIDATE.PROMOTE", "candidateId": "candidate-1", "draftJob": { "id": "draft-candidate-1" } }),
            json!({ "kind": "SCHEDULE.SLOT", "slotId": "slot-sun" }),
            json!({ "kind": "UNKNOWN_INTERNAL_EVENT", "candidateId": "ignored" }),
        ]);

        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["title"], "Haftalık yayın slotu güncellendi");
        assert_eq!(events[0]["correlationId"], "slot-sun");
        assert_eq!(events[1]["title"], "Araştırma işi kuyruğa alındı");
        assert_eq!(events[1]["correlationId"], "draft-candidate-1");
        assert!(events[1]["detail"]
            .as_str()
            .unwrap_or_default()
            .contains("Editoryal Masa"));
    }

    #[test]
    fn waiting_instant_draft_uses_the_editor_instruction_as_its_editorial_title() {
        let drafts = append_pending_draft_jobs(
            Vec::new(),
            &[json!({
                "id": "draft-instant-1",
                "kind": "DRAFT",
                "state": "WAITING_CODEX",
                "metadata": {
                    "instruction": "Yapay zeka düzenlemesini kaynaklarla karşılaştır",
                    "section": "analiz",
                    "createdAtUnixMs": 1
                }
            })],
        );

        assert_eq!(drafts.len(), 1);
        assert_eq!(
            drafts[0]["titleTr"],
            "Yapay zeka düzenlemesini kaynaklarla karşılaştır"
        );
        assert_eq!(drafts[0]["reviewable"], false);
    }

    #[test]
    fn revision_edit_carries_the_selected_revision_and_its_source_evidence() {
        let base = json!({
            "id": "revision-1",
            "section": "dosyalar",
            "articleType": "deep_dive",
            "tr": { "bodyMarkdown": "Özgün metin" },
            "sources": [{
                "id": "source-1",
                "url": "https://example.org/evidence",
                "evidenceAnchors": [{ "sourceId": "source-1", "quoteHash": "a".repeat(64) }]
            }]
        });
        let payload = revision_edit_payload(
            "revision-1",
            "Başlığı ve sonucu netleştir",
            base.clone(),
            Some("Kapsamlı yeniden oluşturma işleniyor"),
        )
        .unwrap();
        assert_eq!(payload["revisionId"], "revision-1");
        assert_eq!(payload["urls"], json!(["https://example.org/evidence"]));
        assert_eq!(payload["section"], "dosyalar");
        assert_eq!(
            payload["candidateTitle"],
            "Kapsamlı yeniden oluşturma işleniyor"
        );
        assert_eq!(payload["baseRevision"], base);
        assert_eq!(
            payload["sources"][0]["evidenceAnchors"][0]["quoteHash"],
            "a".repeat(64)
        );
        assert!(
            revision_edit_payload("revision-1", "Düzenle", json!({ "sources": [] }), None).is_err()
        );
    }

    #[test]
    fn high_risk_consent_fails_before_verification_when_prerequisites_are_missing() {
        let mut called = false;
        let rejected = authorize_high_risk_consent(false, true, &"a".repeat(64), |_| {
            called = true;
            Ok(())
        });
        assert!(matches!(rejected, Err(CommandError::InvalidInput(_))));
        assert!(!called);

        let unavailable = authorize_high_risk_consent(true, false, &"a".repeat(64), |_| {
            called = true;
            Ok(())
        });
        assert!(matches!(
            unavailable,
            Err(CommandError::EngineUnavailable(_))
        ));
        assert!(!called);

        let cancelled = authorize_high_risk_consent(true, true, &"a".repeat(64), |_| {
            Err(CommandError::InvalidInput("cancelled".into()))
        });
        assert!(matches!(cancelled, Err(CommandError::InvalidInput(_))));
    }

    #[test]
    fn native_confirmation_is_fail_closed_and_bound_to_visible_details() {
        let mut observed = None;
        let rejected =
            authorize_native_confirmation("İçeriği onayla", "abc123", |action, fingerprint| {
                observed = Some((action.to_string(), fingerprint.to_string()));
                Err(CommandError::InvalidInput("cancelled".into()))
            });
        assert!(matches!(rejected, Err(CommandError::InvalidInput(_))));
        assert_eq!(
            observed,
            Some(("İçeriği onayla".to_string(), "abc123".to_string()))
        );
        assert!(authorize_native_confirmation("", "abc123", |_, _| Ok(())).is_err());
        assert!(authorize_native_confirmation("İçeriği onayla", "", |_, _| Ok(())).is_err());
    }

    #[test]
    fn local_engine_is_writable_and_external_failure_can_be_read_only() {
        let state = DesktopState::default();
        assert!(matches!(
            ensure_mutation_allowed(&state),
            Err(CommandError::OfflineReadOnly)
        ));

        *write_lock(&state.runtime).expect("runtime lock") = RuntimeMode::Degraded;
        assert!(matches!(
            ensure_mutation_allowed(&state),
            Err(CommandError::ConnectionNotAuthenticated)
        ));

        *write_lock(&state.runtime).expect("runtime lock") = RuntimeMode::Online;
        assert!(ensure_mutation_allowed(&state).is_ok());
    }

    #[test]
    fn source_scan_command_uses_catalog_versions_and_selected_source() {
        let command = build_source_scan_command(
            &[
                json!({ "id": "source-a", "version": 2, "status": "ACTIVE" }),
                json!({ "id": "source-b", "version": 7, "status": "DISABLED" }),
            ],
            Some("source-a"),
            "scan-request-1",
        )
        .expect("scan command");

        assert_eq!(command["kind"], "SOURCE.SCAN");
        assert_eq!(
            command["payload"]["targets"],
            json!([{ "sourceId": "source-a", "expectedVersion": 2 }])
        );
    }

    #[test]
    fn setup_connector_validation_rejects_whitespace_and_unsafe_paths() {
        assert!(!valid_github_segment("  "));
        assert!(valid_github_segment("ucsahinn"));
        assert!(is_local_path(r"C:\Blogbot"));
        assert!(!is_local_path("https://example.com"));
        assert!(!is_local_path(r"C:relative"));
        assert!(valid_schedule_slot("slot-mon"));
        assert!(valid_schedule_slot("slot-mon-3"));
        assert!(valid_schedule_slot("slot-sun-5"));
        assert!(!valid_schedule_slot("slot-any"));
        assert!(!valid_schedule_slot("slot-mon-6"));
        assert!(valid_hhmm("23:59"));
        assert!(!valid_hhmm("99:99"));
        assert!(!valid_hhmm("ab:cd"));
        assert!(!valid_recovery_key("short"));
        assert!(!valid_recovery_key("                "));
        assert!(valid_recovery_key("correct horse 2026"));
    }

    #[test]
    fn publish_deploy_connector_fails_closed_without_explicit_required_checks() {
        let state = DesktopState::default();
        let missing = super::test_setup_connector_with_grants(
            &state,
            "deploy".into(),
            json!({ "workflowName": "deploy.yml", "requiredChecks": [] }),
        )
        .expect("validation result");
        assert_eq!(missing["ready"], false);

        let omitted = super::test_setup_connector_with_grants(
            &state,
            "deploy".into(),
            json!({ "workflowName": "deploy.yml" }),
        )
        .expect("validation result");
        assert_eq!(omitted["ready"], false);
    }

    #[test]
    fn publish_deploy_connector_accepts_only_unique_bounded_check_names() {
        let state = DesktopState::default();
        let valid = super::test_setup_connector_with_grants(
            &state,
            "deploy".into(),
            json!({ "workflowName": "deploy.yml", "requiredChecks": ["build", "test / windows"] }),
        )
        .expect("validation result");
        assert_eq!(valid["ready"], true);

        for required_checks in [
            json!(["build", "build"]),
            json!(["build", "  "]),
            json!(["x".repeat(201)]),
        ] {
            let invalid = super::test_setup_connector_with_grants(
                &state,
                "deploy".into(),
                json!({ "workflowName": "deploy.yml", "requiredChecks": required_checks }),
            )
            .expect("validation result");
            assert_eq!(invalid["ready"], false);
        }
    }

    #[test]
    fn native_folder_selection_accepts_only_absolute_windows_paths() {
        assert!(validate_folder_selection(r"C:\Users\editor\site").is_ok());
        assert!(validate_folder_selection("https://example.com/site").is_err());
        assert!(validate_folder_selection(r"C:relative\site").is_err());
        assert!(validate_folder_selection("C:\\unsafe\"quote").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn native_folder_picker_worker_owns_an_sta_com_apartment() {
        let sta_available = super::run_folder_picker_on_sta(|| {
            use windows::Win32::System::Com::{
                CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
            };

            // A second STA initialization succeeds only when the worker is
            // already in the required apartment. Balance its S_FALSE count.
            let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            let available = initialized.is_ok();
            if available {
                unsafe { CoUninitialize() };
            }
            Ok(available)
        })
        .expect("folder picker worker");

        assert!(sta_available);
    }

    #[test]
    fn site_work_mode_is_explicit_and_limited_to_three_choices() {
        assert!(valid_site_work_mode("LOCAL_ONLY"));
        assert!(valid_site_work_mode("LOCAL_DEV"));
        assert!(validate_local_dev_project("relative-project").is_err());
        assert!(valid_site_work_mode("PUBLISH"));
        assert!(!valid_site_work_mode("REMOTE_HOST"));
    }

    #[test]
    fn github_bridge_contracts_are_local_only_and_scope_safe() {
        assert!(valid_github_workflow("deploy.yml"));
        assert!(!valid_github_workflow("../deploy.yml"));
        assert!(
            github_preview_payload("owner/site", "deploy.yml", "rev-1", &"a".repeat(64)).is_ok()
        );
        assert!(github_preview_payload("owner/site", "deploy.yml", "rev-1", "secret").is_err());
    }

    #[test]
    fn publication_observability_never_marks_missing_intent_ready() {
        assert_eq!(publication_observability(None), ("NOT_STARTED", "BLOCKED"));
        assert_eq!(
            publication_observability(Some("PENDING")),
            ("NOT_STARTED", "BLOCKED")
        );
        assert_eq!(
            publication_observability(Some("IN_PROGRESS")),
            ("RUNNING", "PUBLISHING")
        );
        assert_eq!(
            publication_observability(Some("FAILED")),
            ("FAILED", "BLOCKED")
        );
        assert_eq!(
            publication_observability(Some("SUCCEEDED")),
            ("PASSED", "READY")
        );
    }

    #[test]
    fn local_dev_requires_explicit_trust_and_scrubs_the_child_environment() {
        assert!(matches!(
            ensure_trusted_local_dev(false),
            Err(CommandError::InvalidInput(_))
        ));
        assert!(ensure_trusted_local_dev(true).is_ok());

        let environment = local_dev_environment_with(|name| match name {
            "SystemRoot" => Some(r"C:\Windows".into()),
            "PATH" => Some(r"C:\Windows\System32".into()),
            "GITHUB_TOKEN" => Some("must-not-pass".into()),
            "BLOGBOT_DATA_KEY_HEX" => Some("must-not-pass".into()),
            "APPDATA" => Some(r"C:\Users\editor\AppData\Roaming".into()),
            "USERPROFILE" => Some(r"C:\Users\editor".into()),
            _ => None,
        });
        let names = environment
            .iter()
            .map(|(name, _)| name.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["SystemRoot", "PATH"]);
    }

    #[test]
    fn local_preview_rolls_back_prior_files_when_a_later_write_fails() {
        let root =
            std::env::temp_dir().join(format!("blogbot-preview-rollback-{}", std::process::id()));
        let backup = root.join(".blogbot").join("backups").join("preview");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("existing.md"), "old content").unwrap();
        let files = vec![
            ("existing.md".to_string(), b"new content".to_vec()),
            ("new.md".to_string(), b"new file".to_vec()),
        ];
        let mut writes = 0;
        let result =
            materialize_preview_bundle_with(&root, &files, &backup, |destination, content| {
                writes += 1;
                if writes == 2 {
                    return Err(std::io::Error::other("simulated write failure"));
                }
                std::fs::write(destination, content)
            });

        assert!(matches!(result, Err(CommandError::EngineUnavailable(_))));
        assert_eq!(
            std::fs::read_to_string(root.join("existing.md")).unwrap(),
            "old content"
        );
        assert!(!root.join("new.md").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn regular_preview_paths_are_not_windows_reparse_points() {
        let path =
            std::env::temp_dir().join(format!("blogbot-preview-reparse-{}", std::process::id()));
        std::fs::write(&path, "regular file").unwrap();
        assert!(!is_reparse_point(&path).unwrap());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn preview_file_bytes_preserves_json_binary_content() {
        assert_eq!(
            preview_file_bytes(&json!({ "content": [0, 1, 2, 255] })).unwrap(),
            vec![0, 1, 2, 255]
        );
        assert_eq!(
            preview_file_bytes(&json!({ "content": { "0": 82, "1": 73, "2": 70, "3": 70 } }))
                .unwrap(),
            b"RIFF".to_vec()
        );
        assert!(preview_file_bytes(&json!({ "content": { "0": 82, "2": 70 } })).is_err());
    }

    #[test]
    fn preview_file_media_reference_requires_exact_revision_and_integrity_metadata() {
        let reference = json!({
            "kind": "engine-media-ref",
            "revisionId": "revision-1",
            "sha256": "a".repeat(64),
            "byteSize": 512
        });
        assert_eq!(
            preview_file_media_reference(&reference, "revision-1").unwrap(),
            Some(("a".repeat(64), 512))
        );
        assert!(preview_file_media_reference(&reference, "revision-2").is_err());
        assert!(preview_file_media_reference(&json!({ "kind": "engine-media-ref", "revisionId": "revision-1", "sha256": "bad", "byteSize": 0 }), "revision-1").is_err());
    }

    #[test]
    fn publisher_readiness_uses_the_real_engine_capability() {
        assert!(has_publication_capability(&json!(["PUBLICATION.ENQUEUE"])));
        assert!(!has_publication_capability(&json!(["PUBLISH"])));
        assert!(!has_publication_capability(&json!([])));
    }

    #[test]
    fn configured_site_origin_uses_only_the_active_generic_connector() {
        assert_eq!(
            configured_site_origin(&json!({
                "site": { "publicSiteUrl": "https://example.org/" },
                "legacySite": { "publicSiteUrl": "https://legacy.example/" }
            })),
            Some("https://example.org".to_string())
        );
        assert_eq!(
            configured_site_origin(&json!({
                "legacySite": { "publicSiteUrl": "https://legacy.example/" }
            })),
            None
        );
    }

    #[test]
    fn high_risk_approval_command_binds_both_hashes_and_exact_utc_time() {
        let command = build_high_risk_approval_command(
            "revision-high-risk",
            &"a".repeat(64),
            &"b".repeat(64),
            &"c".repeat(64),
            4,
        )
        .expect("high-risk command");
        assert_eq!(command["kind"], "APPROVAL.GRANT_HIGH_RISK");
        assert_eq!(command["payload"]["revisionHash"], "a".repeat(64));
        assert_eq!(command["payload"]["riskChecklistHash"], "b".repeat(64));
        assert_eq!(command["payload"]["warningSetHash"], "c".repeat(64));
        assert!(command["payload"]["windowsReauthenticatedAt"]
            .as_str()
            .unwrap()
            .ends_with('Z'));
    }

    #[test]
    fn opml_preview_extracts_unique_https_feed_urls_without_executing_markup() {
        let urls = super::parse_opml_urls(r#"<opml><body>
          <outline text="one" xmlUrl="https://example.com/feed.xml" />
          <outline text="duplicate" xmlUrl="https://example.com/feed.xml" />
          <outline text="unsafe" xmlUrl="http://localhost/feed.xml" />
          <outline text="atom" htmlUrl="https://example.org" xmlUrl="https://example.org/atom.xml" />
        </body></opml>"#)
        .expect("OPML URLs");

        assert_eq!(
            urls,
            vec![
                "https://example.com/feed.xml".to_string(),
                "https://example.org".to_string(),
                "https://example.org/atom.xml".to_string()
            ]
        );
    }

    #[test]
    fn operation_error_details_are_redacted_and_bounded() {
        assert!(super::sanitize_operation_error("Authorization: Bearer abc")
            .contains("güvenlik nedeniyle"));
        let opaque = super::sanitize_operation_error(&"x".repeat(600));
        assert!(opaque.contains("güvenlik nedeniyle"));
        assert!(opaque.chars().count() <= 512);
        assert_eq!(
            super::sanitize_operation_error("NO_VALID_PUBLICATION_PREVIEW"),
            "İş tamamlanamadı. Ayrıntı kullanıcıya gösterilmedi; Operasyonlar’dan tanılama paketi oluşturabilirsiniz."
        );
    }

    #[test]
    fn editorial_workspace_failures_redact_persisted_job_errors() {
        let simulated_authorization_error = format!(
            "Authorization: Bearer {}",
            ["should", "not", "reach", "the", "webview"].join("-")
        );
        let failures = super::workspace_failures(&[json!({
            "id": "job-secret",
            "kind": "DRAFT",
            "state": "FAILED",
            "lastError": simulated_authorization_error,
            "attempts": 2
        })]);

        assert_eq!(failures.len(), 1);
        let message = failures[0]["message"].as_str().unwrap_or_default();
        assert!(message.contains("güvenlik nedeniyle"));
        assert!(!message.contains("Bearer"));
    }

    #[test]
    fn editorial_workspace_marks_dead_letter_jobs_for_manual_review() {
        let failures = super::workspace_failures(&[json!({
            "id": "job-dead-letter",
            "kind": "PUBLISH",
            "state": "DEAD_LETTER",
            "lastError": "Persistent publication failure",
            "attempts": 3
        })]);

        assert_eq!(failures[0]["retryMode"], "MANUAL");
    }

    #[test]
    fn revision_queue_is_derived_from_persisted_editorial_packages() {
        let queue = build_revision_queue(&[json!({
            "revision": {
                "id": "revision-1",
                "state": "REVIEW_REQUIRED",
                "section": "haberler",
                "scheduledAt": "2026-07-30T12:00:00.000Z",
                "tr": { "title": "Kalıcı revizyon" },
                "sources": [{ "id": "source-1" }],
                "claims": [
                    { "status": "VERIFIED" },
                    { "status": "NEEDS_SOURCE" }
                ]
            },
            "revisionHash": "a".repeat(64),
            "editorialApproval": null,
            "highRiskApproval": null
        })]);

        assert_eq!(queue[0]["id"], "revision-1");
        assert_eq!(queue[0]["title"], "Kalıcı revizyon");
        assert_eq!(queue[0]["state"], "REVIEW_REQUIRED");
        assert_eq!(queue[0]["sourceCount"], 1);
        assert_eq!(queue[0]["blockers"], 1);
        assert_eq!(queue[0]["scheduledAt"], "2026-07-30T12:00:00.000Z");
    }

    #[test]
    fn high_risk_revision_stays_in_review_until_both_approvals_exist() {
        let materialization = json!({
            "revision": {
                "id": "revision-high-risk",
                "translationKey": "story-high-risk",
                "state": "REVIEW_REQUIRED",
                "section": "haberler",
                "articleType": "news",
                "author": "Ulaş Şahin",
                "tags": ["güvenlik"],
                "scheduledAt": "2026-07-30T12:00:00.000Z",
                "adapterVersion": "2.0.0",
                "riskLevel": "HIGH",
                "translationParity": { "status": "MATCHED" },
                "qualityGates": [{
                    "id": "claims",
                    "group": "editorial",
                    "state": "PASS",
                    "detail": "Kanıt doğrulandı.",
                    "policyVersion": "1"
                }],
                "tr": {
                    "title": "Yüksek riskli revizyon",
                    "description": "Türkçe özet",
                    "slug": "yuksek-riskli-revizyon",
                    "bodyMarkdown": "Doğrulanmış içerik",
                    "heroImageAlt": "Kapak"
                },
                "en": {
                    "title": "High-risk revision",
                    "description": "English summary",
                    "slug": "high-risk-revision",
                    "bodyMarkdown": "Verified content",
                    "heroImageAlt": "Cover"
                },
                "sources": [{
                    "id": "source-1",
                    "title": "Source",
                    "url": "https://example.com/report",
                    "fetchedAt": "2026-07-30T08:00:00.000Z",
                    "contentHash": "b".repeat(64)
                }],
                "claims": [{
                    "id": "claim-1",
                    "text": "Claim",
                    "locale": "both",
                    "status": "VERIFIED",
                    "sourceIds": ["source-1"],
                    "evidenceAnchors": [{ "sourceId": "source-1" }]
                }],
                "media": [{
                    "role": "hero",
                    "path": "cover.webp",
                    "sha256": "c".repeat(64),
                    "width": 1600,
                    "height": 900
                }]
            },
            "revisionHash": "a".repeat(64),
            "editorialApproval": {
                "revisionId": "revision-high-risk",
                "revisionHash": "a".repeat(64)
            },
            "highRiskApproval": null
        });

        let queue = build_revision_queue(std::slice::from_ref(&materialization));
        assert_eq!(queue[0]["state"], "REVIEW_REQUIRED");
        assert_eq!(queue[0]["blockers"], 1);

        let review = build_review_revision(&materialization).expect("review revision");
        assert_eq!(review["state"], "REVIEW_REQUIRED");
        assert_eq!(review["gates"].as_array().map(Vec::len), Some(1));
        assert_eq!(review["gates"][0]["id"], "claims");
        assert_eq!(review["gates"][0]["state"], "PASS");

        let fully_approved = json!({
            "revision": materialization["revision"].clone(),
            "revisionHash": "a".repeat(64),
            "editorialApproval": materialization["editorialApproval"].clone(),
            "highRiskApproval": {
                "revisionId": "revision-high-risk",
                "revisionHash": "a".repeat(64)
            }
        });
        let queue = build_revision_queue(std::slice::from_ref(&fully_approved));
        assert_eq!(queue[0]["state"], "APPROVED");
        let review = build_review_revision(&fully_approved).expect("approved review revision");
        assert_eq!(review["state"], "APPROVED");
        assert_eq!(review["gates"].as_array().map(Vec::len), Some(1));
        assert_eq!(review["gates"][0]["state"], "PASS");
    }

    #[test]
    fn approval_command_is_exact_hash_and_version_bound() {
        let attestation = json!({
            "editorialReview": {
                "reviewer": "Deniz Editor",
                "sourceRoles": [{ "sourceId": "source-1", "role": "primary" }]
            },
            "expertReview": null,
            "ethicsReview": null
        });
        let command = build_approval_command(
            "revision-1",
            &"a".repeat(64),
            &"b".repeat(64),
            &attestation,
            7,
        )
        .expect("approval command");
        assert_eq!(command["kind"], "APPROVAL.GRANT");
        assert_eq!(command["expectedVersion"], 7);
        assert_eq!(command["payload"]["packageVersion"], 3);
        assert_eq!(command["payload"]["revisionId"], "revision-1");
        assert_eq!(command["payload"]["revisionHash"], "a".repeat(64));
        assert_eq!(command["payload"]["warningSetHash"], "b".repeat(64));
        assert_eq!(command["payload"]["deviceId"], "windows-local-device-v1");
        assert_eq!(command["payload"]["attestation"], attestation);
        assert_eq!(command["payload"].as_object().map(|value| value.len()), Some(6));
    }

    #[test]
    fn approval_revoke_command_is_exact_hash_bound_and_stable() {
        let first = build_approval_revoke_command(
            "revision-1",
            &"A".repeat(64),
            "  Kaynak doğrulaması yeniden yapılacak.  ",
            7,
        )
        .expect("revoke command");
        let replay = build_approval_revoke_command(
            "revision-1",
            &"a".repeat(64),
            "Kaynak doğrulaması yeniden yapılacak.",
            7,
        )
        .expect("replayed command");
        assert_eq!(first, replay);
        assert_eq!(first["kind"], json!("APPROVAL.REVOKE"));
        assert_eq!(first["payload"], json!({
            "revisionId": "revision-1",
            "revisionHash": "a".repeat(64),
            "deviceId": "windows-local-device-v1",
            "reason": "Kaynak doğrulaması yeniden yapılacak."
        }));
        assert_eq!(first.as_object().map(|value| value.len()), Some(6));
    }

    #[test]
    fn approval_revoke_command_rejects_unbounded_or_malformed_inputs() {
        assert!(build_approval_revoke_command("../revision", &"a".repeat(64), "geçerli gerekçe", 1).is_err());
        assert!(build_approval_revoke_command("revision-1", "short", "geçerli gerekçe", 1).is_err());
        assert!(build_approval_revoke_command("revision-1", &"a".repeat(64), "   ", 1).is_err());
        assert!(build_approval_revoke_command("revision-1", &"a".repeat(64), &"g".repeat(513), 1).is_err());
    }

    #[test]
    fn approval_command_rejects_model_fields_and_duplicate_source_roles() {
        let model_authored = json!({
            "editorialReview": { "reviewer": "Deniz Editor", "sourceRoles": [{ "sourceId": "source-1", "role": "primary" }] },
            "expertReview": null,
            "ethicsReview": null,
            "model": "codex"
        });
        assert!(build_approval_command("revision-1", &"a".repeat(64), &"b".repeat(64), &model_authored, 7).is_err());

        let duplicate_source = json!({
            "editorialReview": {
                "reviewer": "Deniz Editor",
                "sourceRoles": [
                    { "sourceId": "source-1", "role": "primary" },
                    { "sourceId": "source-1", "role": "supporting" }
                ]
            },
            "expertReview": null,
            "ethicsReview": null
        });
        assert!(build_approval_command("revision-1", &"a".repeat(64), &"b".repeat(64), &duplicate_source, 7).is_err());
    }

    #[test]
    fn native_attestation_must_match_the_immutable_v3_source_roles_and_requirements() {
        let materialization = json!({
            "revision": {
                "packageVersion": 3,
                "publicationSources": [
                    { "id": "source-1", "title": "Primary", "url": "https://example.com/1", "role": "primary" },
                    { "id": "source-2", "title": "Independent", "url": "https://example.com/2", "role": "independent" }
                ],
                "editorialAssessment": { "isYmyl": true, "sensitiveTopic": false }
            }
        });
        let complete = json!({
            "editorialReview": {
                "reviewer": "Deniz Editor",
                "sourceRoles": [
                    { "sourceId": "source-2", "role": "independent" },
                    { "sourceId": "source-1", "role": "primary" }
                ]
            },
            "expertReview": { "reviewer": "Dr. Ada", "qualifications": "Alan uzmani", "reviewScope": "Yuksek etkili iddialar" },
            "ethicsReview": null
        });
        super::validate_editorial_attestation_for_revision_v3(&materialization, &complete)
            .expect("same immutable source-role set is accepted regardless of display order");

        let wrong_role = json!({
            "editorialReview": {
                "reviewer": "Deniz Editor",
                "sourceRoles": [
                    { "sourceId": "source-1", "role": "supporting" },
                    { "sourceId": "source-2", "role": "independent" }
                ]
            },
            "expertReview": complete["expertReview"].clone(),
            "ethicsReview": null
        });
        assert!(super::validate_editorial_attestation_for_revision_v3(&materialization, &wrong_role).is_err());

        let missing_expert = json!({
            "editorialReview": complete["editorialReview"].clone(),
            "expertReview": null,
            "ethicsReview": null
        });
        assert!(super::validate_editorial_attestation_for_revision_v3(&materialization, &missing_expert).is_err());
    }

    #[test]
    fn v3_review_projection_exposes_only_public_source_metadata_and_human_requirements() {
        let materialization = json!({
            "revision": {
                "id": "revision-v3", "packageVersion": 3, "translationKey": "article-v3",
                "section": "haberler", "articleType": "news", "author": "Yerel Editorya",
                "tags": ["guvenlik"], "scheduledAt": "2026-08-20T12:00:00.000Z",
                "adapterVersion": "astro-generic@1", "riskLevel": "STANDARD",
                "tr": { "title": "TR", "description": "TR", "slug": "tr", "bodyMarkdown": "TR" },
                "en": { "title": "EN", "description": "EN", "slug": "en", "bodyMarkdown": "EN" },
                "claims": [{ "id": "claim-1", "text": "Olgu", "locale": "both", "status": "VERIFIED", "sourceIds": ["source-1"] }],
                "sources": [{
                    "id": "source-1", "title": "Private snapshot title", "url": "https://example.com/private",
                    "fetchedAt": "2026-08-20T10:00:00.000Z", "contentHash": "c".repeat(64),
                    "evidenceExcerpt": "must never reach the WebView",
                    "evidenceAnchors": [{ "sourceId": "source-1", "quoteHash": "d".repeat(64) }]
                }],
                "publicationSources": [{
                    "id": "source-1", "title": "Official report", "url": "https://example.com/report",
                    "role": "primary", "evidenceExcerpt": "must be dropped", "contentHash": "c".repeat(64)
                }],
                "editorialAssessment": { "isYmyl": true, "sensitiveTopic": true },
                "qualityGates": [{ "id": "claims", "state": "PASS", "detail": "ok", "group": "editorial", "policyVersion": "3" }],
                "media": []
            },
            "revisionHash": "a".repeat(64), "editorialApproval": null, "highRiskApproval": null
        });

        let review = build_review_revision(&materialization).expect("V3 review projection");
        assert_eq!(review["packageVersion"], 3);
        assert_eq!(review["approvalRequirements"], json!(["EDITORIAL_REVIEW", "EXPERT_REVIEW", "ETHICS_REVIEW"]));
        assert_eq!(review["publicationSources"], json!([{
            "id": "source-1", "title": "Official report", "url": "https://example.com/report", "role": "primary"
        }]));
        assert_eq!(review["publicationSources"][0].as_object().map(|value| value.len()), Some(4));
        assert!(review["sources"][0].get("evidenceExcerpt").is_none());
        assert!(review["sources"][0].get("evidenceAnchors").is_none());
        assert!(review.get("editorialContext").is_none());
        assert!(review.get("editorialAssessment").is_none());
        assert!(review.get("editorialApproval").is_none());
    }

    #[test]
    fn invalid_legacy_v3_source_stays_reviewable_but_cannot_be_approved_or_published() {
        let materialization = json!({
            "revision": {
                "id": "revision-legacy-v3",
                "packageVersion": 3,
                "translationKey": "article-legacy-v3",
                "section": "haberler",
                "articleType": "news",
                "author": "Yerel Editorya",
                "tags": [],
                "scheduledAt": "2026-08-20T12:00:00.000Z",
                "adapterVersion": "astro-generic@1",
                "riskLevel": "STANDARD",
                "tr": { "title": "TR", "description": "TR", "slug": "tr", "bodyMarkdown": "TR" },
                "en": { "title": "EN", "description": "EN", "slug": "en", "bodyMarkdown": "EN" },
                "claims": [],
                "sources": [],
                "publicationSources": [{
                    "id": "source-1",
                    "title": "Legacy source",
                    "url": "https://example.com/report",
                    "role": "official"
                }],
                "editorialAssessment": { "isYmyl": false, "sensitiveTopic": false },
                "qualityGates": [],
                "media": []
            },
            "revisionHash": "a".repeat(64),
            "editorialApproval": {
                "revisionId": "revision-legacy-v3",
                "revisionHash": "a".repeat(64)
            },
            "highRiskApproval": null
        });

        let review = build_review_revision(&materialization)
            .expect("legacy content remains available for a replacement request");
        assert_eq!(review["state"], "REVIEW_REQUIRED");
        assert_eq!(review["editorialApproved"], false);
        assert_eq!(review["highRiskApproved"], false);
        assert_eq!(review["tr"]["title"], "TR");
        assert!(review.get("packageVersion").is_none());
        assert!(review.get("publicationSources").is_none());
        assert!(review.get("approvalRequirements").is_none());
    }

    #[test]
    fn diagnostics_bundle_never_carries_article_titles_or_headlines() {
        let title = "X Bankası'nda doğrulanmamış sızıntı iddiası";
        let operations = json!({
            "events": [{
                "id": "job-draft-1",
                "at": "şimdi",
                "title": "İş başarısız",
                "detail": "JOB_UPDATED · draft-1",
                "state": "BLOCKED",
                "level": "ERROR",
                "correlationId": "draft-1"
            }],
            "schedule": [{
                "id": "rev-1",
                "title": title,
                "at": "2026-08-25T09:00:00.000Z",
                "section": "haberler",
                "state": "APPROVED"
            }],
            "worker": { "state": "HEALTHY", "queueDepth": 1 },
            "publisher": { "state": "READY", "outboxPending": 0 }
        });

        let projected = super::diagnostic_operations_projection(&operations);
        let encoded = serde_json::to_string(&projected).expect("projection encodes");

        assert!(!encoded.contains("X Bankası"));
        assert!(!encoded.contains(title));
        assert!(!encoded.contains("İş başarısız"));
        assert_eq!(projected["schedule"][0]["id"], "rev-1");
        assert_eq!(projected["schedule"][0]["section"], "haberler");
        assert_eq!(projected["schedule"][0]["at"], "2026-08-25T09:00:00.000Z");
        assert_eq!(projected["schedule"][0]["state"], "APPROVED");
        assert_eq!(
            projected["schedule"][0]["titleDigest"],
            json!(super::diagnostic_title_digest(title))
        );
        assert!(projected["schedule"][0].get("title").is_none());
        assert_eq!(projected["events"][0]["correlationId"], "draft-1");
        // The support-relevant part of an event stays readable; only the
        // workspace's own text is withheld.
        assert_eq!(projected["events"][0]["detail"], "JOB_UPDATED · draft-1");
        assert_eq!(projected["worker"]["queueDepth"], 1);
    }

    #[test]
    fn a_live_draft_job_projects_the_candidate_as_queued_without_a_mutation_record() {
        let jobs = vec![json!({
            "id": "draft-1",
            "kind": "DRAFT",
            "state": "QUEUED",
            "metadata": { "candidateId": "c1" }
        })];

        assert_eq!(candidate_workflow_state("c1", &[], &jobs), "RESEARCH_QUEUED");
        assert_eq!(candidate_workflow_state("c2", &[], &jobs), "NEW");
    }

    #[test]
    fn unprobed_windows_and_clock_prerequisites_are_never_reported_ready() {
        let windows = super::windows_prerequisite_check(Some("x86_64"));
        assert_eq!(windows["id"], "windows");
        assert_ne!(windows["state"], "READY");
        assert!(!windows["userAction"].is_null());
        assert_eq!(
            super::windows_prerequisite_check(Some("aarch64"))["state"],
            "BLOCKED"
        );
        // Windows reports the host architecture through the environment, so an
        // emulated x64 build on an ARM64 machine is still detected as unsupported.
        assert_eq!(
            super::windows_host_architecture_with(|name| (name == "PROCESSOR_ARCHITEW6432")
                .then(|| std::ffi::OsString::from("ARM64"))),
            "ARM64"
        );

        let clock = super::clock_prerequisite_check(None);
        assert_eq!(clock["id"], "clock");
        assert_ne!(clock["state"], "READY");
        assert!(!clock["userAction"].is_null());
        assert_eq!(
            super::clock_prerequisite_check(Some(super::PUBLISHING_UTC_OFFSET_MINUTES))["state"],
            "READY"
        );
        assert_eq!(
            super::clock_prerequisite_check(Some(60))["state"],
            "ATTENTION"
        );
    }

    #[test]
    fn deploy_prerequisite_requires_a_valid_locally_checked_publish_contract() {
        let absent = super::deploy_prerequisite_check(None, None);
        assert_eq!(absent["id"], "deploy");
        assert_eq!(absent["state"], "BLOCKED");

        let config = json!({
            "workflowName": "deploy.yml",
            "requiredChecks": ["build", "test / windows"]
        });
        let unchecked = super::deploy_prerequisite_check(Some(&config), None);
        assert_eq!(unchecked["state"], "ATTENTION");

        let checked = json!({ "ready": true, "state": "DRY_RUN_READY" });
        let ready = super::deploy_prerequisite_check(Some(&config), Some(&checked));
        assert_eq!(ready["state"], "READY");
        assert_eq!(ready["workflowName"], "deploy.yml");
        assert_eq!(ready["requiredChecks"], json!(["build", "test / windows"]));
        assert_eq!(ready["checkPassed"], true);

        let duplicate_checks = json!({
            "workflowName": "deploy.yml",
            "requiredChecks": ["build", "build"]
        });
        let invalid =
            super::deploy_prerequisite_check(Some(&duplicate_checks), Some(&checked));
        assert_ne!(invalid["state"], "READY");
        assert_eq!(invalid["checkPassed"], false);
    }

    #[test]
    fn the_backup_prerequisite_follows_recorded_verifications_not_a_literal() {
        assert_eq!(
            super::backup_prerequisite_check(false, None)["state"],
            "MISSING"
        );
        assert_eq!(
            super::backup_prerequisite_check(true, None)["state"],
            "ATTENTION"
        );
        assert_eq!(
            super::backup_prerequisite_check(true, Some(&json!({ "verifiedAtUnixMs": 10_u64 })))
                ["state"],
            "ATTENTION"
        );

        let complete = super::backup_prerequisite_check(
            true,
            Some(&json!({
                "archiveName": "blogbot-backup.opebak",
                "archiveSha256": "a".repeat(64),
                "verifiedAtUnixMs": 10_u64,
                "restorePreviewAtUnixMs": 20_u64
            })),
        );
        assert_eq!(complete["state"], "READY");
        assert!(complete["userAction"].is_null());
    }

    #[test]
    fn backup_observations_from_different_archives_never_combine_into_ready() {
        let mut record = json!({});
        super::update_backup_verification_record(
            &mut record,
            "verifiedAtUnixMs",
            "first.opebak",
            &"a".repeat(64),
            10,
        )
        .expect("record first verification");
        super::update_backup_verification_record(
            &mut record,
            "restorePreviewAtUnixMs",
            "second.opebak",
            &"b".repeat(64),
            20,
        )
        .expect("record second preview");

        assert_eq!(record["archiveSha256"], "b".repeat(64));
        assert!(record.get("verifiedAtUnixMs").is_none());
        assert_eq!(record["restorePreviewAtUnixMs"], 20);
        assert_eq!(
            super::backup_prerequisite_check(true, Some(&record))["state"],
            "ATTENTION"
        );
    }

    #[test]
    fn automated_draft_payloads_always_declare_a_visual_policy() {
        let candidate = candidate_draft_payload(
            "c1",
            &json!({ "sourceIds": ["src-1"], "title": "Aday", "section": "haberler" }),
        )
        .expect("candidate draft payload");
        assert!(candidate
            .get("visualPolicy")
            .and_then(Value::as_str)
            .is_some());

        let edit = revision_edit_payload(
            "rev-1",
            "kaynakları genişlet",
            json!({ "sources": [{ "url": "https://example.com/a" }] }),
            None,
        )
        .expect("revision edit payload");
        assert!(edit.get("visualPolicy").and_then(Value::as_str).is_some());

        // Without a configured ImageGen key the engine defaults to GENERATE and
        // produces a revision with no hero media, which can never be approved.
        assert_eq!(
            super::automated_visual_policy_with(|_| None),
            "LOCAL_RENDERER"
        );
        assert_eq!(
            super::automated_visual_policy_with(|name| (name == "BLOGBOT_IMAGEGEN_API_KEY")
                .then(|| std::ffi::OsString::from("configured"))),
            "GENERATE"
        );
    }

    #[test]
    fn a_retried_local_state_write_re_reads_the_state_the_conflict_invalidated() {
        let stored = std::cell::RefCell::new(json!({ "mutations": ["m1"] }));
        let attempts = std::cell::Cell::new(0_u32);
        let sent = std::cell::RefCell::new(Vec::new());

        let result = super::local_state_write(
            || Ok(100),
            || stored.borrow().clone(),
            |value| {
                value
                    .get_mut("mutations")
                    .and_then(Value::as_array_mut)
                    .expect("mutations array")
                    .push(json!("mA"));
                Ok(())
            },
            |_version, value| {
                sent.borrow_mut().push(value.clone());
                attempts.set(attempts.get() + 1);
                if attempts.get() == 1 {
                    // A concurrent writer commits while this attempt is rolled back.
                    *stored.borrow_mut() = json!({ "mutations": ["m1", "mB"] });
                    return Err(CommandError::EngineUnavailable(
                        "VERSION_CONFLICT:100:102".into(),
                    ));
                }
                Ok(json!({ "ok": true }))
            },
        )
        .expect("retried local state write");

        assert_eq!(result["ok"], true);
        let last = sent.borrow().last().cloned().expect("second attempt");
        assert_eq!(last["mutations"], json!(["m1", "mB", "mA"]));
    }

    #[test]
    fn the_native_confirmation_detail_truncates_multi_byte_paths_by_character() {
        let path = "ş".repeat(200);
        let detail = super::native_confirmation_detail(&path);
        assert_eq!(detail.chars().count(), 161);
        assert!(detail.ends_with('…'));
        assert_eq!(super::native_confirmation_detail("kısa"), "kısa");
    }

    #[test]
    fn publishing_starts_paused_like_the_offline_runtime_default() {
        let state = DesktopState::default();
        assert!(*state.publishing_paused.read().expect("publishing flag"));
        assert_eq!(
            *state.runtime.read().expect("runtime"),
            RuntimeMode::OfflineReadOnly
        );
    }

    #[test]
    fn manual_publication_is_rejected_while_publishing_is_paused() {
        assert!(super::ensure_publishing_active(false).is_ok());
        let error = super::ensure_publishing_active(true).expect_err("paused publication");
        assert_eq!(error.to_string(), "ENGINE_UNAVAILABLE: PUBLISHING_PAUSED");
    }

    #[test]
    fn publication_enqueue_returns_before_the_blocking_transport_and_drainer_runs_it_later() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc, Arc,
        };

        let transport_calls = Arc::new(AtomicUsize::new(0));
        let request = json!({
            "kind": "publication.enqueue",
            "revisionId": "revision-1"
        });
        let value = super::persist_publication_enqueue(request, |request| {
            assert_eq!(request["kind"], "publication.enqueue");
            Ok(json!({
                "ok": true,
                "value": { "id": "effect-1", "state": "PENDING" }
            }))
        })
        .expect("durable enqueue");

        assert_eq!(value["id"], "effect-1");
        assert_eq!(transport_calls.load(Ordering::SeqCst), 0);

        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let drainer_calls = Arc::clone(&transport_calls);
        let drainer = std::thread::spawn(move || {
            super::reconcile_pending_publications(&[json!("effect-1")], |effect_id| {
                assert_eq!(effect_id, "effect-1");
                drainer_calls.fetch_add(1, Ordering::SeqCst);
                started_tx.send(()).expect("transport started");
                release_rx.recv().expect("release blocking transport");
                Ok(json!({ "id": effect_id, "state": "SUCCEEDED" }))
            });
        });

        started_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("background drainer reached transport");
        assert_eq!(transport_calls.load(Ordering::SeqCst), 1);
        release_tx.send(()).expect("release transport");
        drainer.join().expect("drainer thread");
    }

    #[test]
    fn approval_keys_differ_per_attempt_so_a_retry_is_not_a_reused_key() {
        let attestation = json!({
            "editorialReview": { "reviewer": "Deniz Editor", "sourceRoles": [{ "sourceId": "source-1", "role": "primary" }] },
            "expertReview": null,
            "ethicsReview": null
        });
        let first = build_approval_command("revision-1", &"a".repeat(64), &"b".repeat(64), &attestation, 7)
            .expect("first approval command");
        let second = build_approval_command("revision-1", &"a".repeat(64), &"b".repeat(64), &attestation, 8)
            .expect("retried approval command");
        assert_ne!(first["idempotencyKey"], second["idempotencyKey"]);
        assert_eq!(
            first["payload"]["revisionHash"],
            second["payload"]["revisionHash"]
        );
        let changed_attestation = json!({
            "editorialReview": { "reviewer": "Baska Editor", "sourceRoles": [{ "sourceId": "source-1", "role": "primary" }] },
            "expertReview": null,
            "ethicsReview": null
        });
        let changed = build_approval_command("revision-1", &"a".repeat(64), &"b".repeat(64), &changed_attestation, 7)
            .expect("changed human approval command");
        assert_ne!(first["idempotencyKey"], changed["idempotencyKey"]);
    }

    #[test]
    fn the_approval_version_is_read_after_the_blocking_consent_dialog() {
        let cursor = std::cell::Cell::new(100_u64);
        let command = super::command_after_consent(
            || {
                // The engine advances its cursor while the dialog is open.
                cursor.set(cursor.get() + 1);
                Ok(())
            },
            || Ok(cursor.get()),
            |version| Ok(json!({ "expectedVersion": version })),
        )
        .expect("consented command");

        assert_eq!(command["expectedVersion"], 101);
    }

    #[test]
    fn the_review_diff_only_describes_a_real_predecessor() {
        let materialization = json!({
            "revisionHash": "c".repeat(64),
            "revision": {
                "id": "rev-2",
                "tr": { "title": "Yeni başlık", "description": "Yeni", "slug": "yeni", "bodyMarkdown": "Yeni gövde" },
                "en": { "title": "New title", "description": "New", "slug": "new", "bodyMarkdown": "New body" }
            }
        });
        let predecessor = json!({
            "revision": {
                "id": "rev-1",
                "tr": { "title": "Eski başlık", "description": "Eski", "slug": "eski", "bodyMarkdown": "Eski gövde" },
                "en": { "title": "Old title", "description": "Old", "slug": "old", "bodyMarkdown": "Old body" }
            }
        });

        let without = build_review_revision(&materialization).expect("review revision");
        assert_eq!(without["hasPrevious"], false);

        let with =
            super::build_review_revision_with_predecessor(&materialization, Some(&predecessor))
                .expect("review revision with predecessor");
        assert_eq!(with["hasPrevious"], true);
        assert_eq!(with["previous"]["tr"]["title"], "Eski başlık");
        assert_ne!(with["previous"]["tr"]["title"], with["tr"]["title"]);
    }

    #[test]
    fn a_corrupt_media_size_never_reaches_the_allocation() {
        assert!(super::bounded_media_size(u64::MAX).is_err());
        assert!(super::bounded_media_size(0).is_err());
        assert_eq!(
            super::bounded_media_size(super::ENGINE_MEDIA_MAX_BYTES).expect("maximum media size"),
            super::ENGINE_MEDIA_MAX_BYTES
        );
        assert!(super::bounded_media_size(super::ENGINE_MEDIA_MAX_BYTES + 1).is_err());
    }

    #[test]
    fn source_scan_tokens_are_unique_per_invocation() {
        let first = super::source_scan_request_token().expect("first scan token");
        let second = super::source_scan_request_token().expect("second scan token");
        assert_ne!(first, second);
        assert!(first.starts_with("desktop-scan-"));
    }

    #[test]
    fn broker_faults_are_recorded_as_token_free_codes_with_a_failure_counter() {
        super::clear_broker_fault("effect-fault-test");
        // Preserve a realistic runtime token shape without storing a
        // secret-looking credential literal in repository source.
        let simulated_token = ["gh", "p_", "0123456789", "abcdefghij"].concat();
        let simulated_fault = format!("PUBLICATION_BROKER_CLAIM_FAILED: {simulated_token}");
        super::record_broker_fault(
            "effect-fault-test",
            &simulated_fault,
        );
        super::record_broker_fault(
            "effect-fault-test",
            &simulated_fault,
        );

        let report = super::broker_fault_report();
        let entry = report
            .iter()
            .find(|entry| entry["effectId"] == "effect-fault-test")
            .cloned()
            .expect("recorded broker fault");
        assert_eq!(entry["code"], "PUBLICATION_BROKER_CLAIM_FAILED");
        assert_eq!(entry["consecutiveFailures"], 2);
        assert!(!serde_json::to_string(&entry)
            .expect("fault encodes")
            .contains("ghp_"));

        super::clear_broker_fault("effect-fault-test");
        assert!(!super::broker_fault_report()
            .iter()
            .any(|entry| entry["effectId"] == "effect-fault-test"));
    }

    #[test]
    fn connector_validation_refuses_a_folder_the_user_never_granted() {
        let state = DesktopState::default();
        let directory = std::env::temp_dir().join(format!(
            "blogbot-ungranted-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).expect("temporary project directory");

        let error = super::test_setup_connector_with_grants(
            &state,
            "site".into(),
            json!({
                "repositoryPath": directory.to_string_lossy(),
                "mode": "LOCAL_ONLY"
            }),
        )
        .expect_err("ungranted folder must not be probed");

        std::fs::remove_dir_all(&directory).ok();
        assert!(matches!(error, CommandError::InvalidInput(_)));
    }

    #[test]
    fn a_second_diagnostics_export_never_doubles_a_log_copy() {
        let directory = std::env::temp_dir().join(format!(
            "blogbot-diagnostics-copy-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).expect("temporary diagnostics directory");
        let source = directory.join("engine.stderr.source.log");
        std::fs::write(&source, "BRIDGE_START ok\nENGINE_READY ok\n").expect("write source log");
        let target = directory.join("engine.stderr.log");

        super::write_redacted_diagnostic_copy(Some(&source), &target);
        let first = super::diagnostic_file_size(&target);
        super::write_redacted_diagnostic_copy(Some(&source), &target);
        let second = super::diagnostic_file_size(&target);

        std::fs::remove_dir_all(&directory).ok();
        assert!(first > 0);
        assert_eq!(first, second);
    }

    #[test]
    fn automatic_restore_request_replaces_live_data_only_after_explicit_confirmation() {
        let request = super::automatic_backup_restore_request(
            "automatic-2026-08-20T09-30-00-000Z.backup",
            true,
        )
        .expect("confirmed automatic restore request");

        assert_eq!(request["kind"], "backup.auto.restore");
        assert_eq!(
            request["payload"],
            json!({
                "backupName": "automatic-2026-08-20T09-30-00-000Z.backup",
                "confirmReplaceLocalData": true
            })
        );
        assert!(request["payload"].get("targetDirectory").is_none());

        let error = super::automatic_backup_restore_request(
            "automatic-2026-08-20T09-30-00-000Z.backup",
            false,
        )
        .expect_err("unconfirmed automatic restore must fail closed");
        assert!(matches!(error, CommandError::InvalidInput(_)));
    }

    #[test]
    fn publication_readiness_preserves_the_reauthorization_error_code() {
        let error = super::require_github_publication_readiness(Err(
            "GITHUB_REAUTHORIZATION_REQUIRED".to_string(),
        ))
        .expect_err("reauthorization must block publication");

        assert!(matches!(
            error,
            CommandError::EngineUnavailable(code)
                if code == "GITHUB_REAUTHORIZATION_REQUIRED"
        ));
    }
}
