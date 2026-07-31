use std::sync::RwLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use std::process::{Child, Command, Stdio};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri_plugin_autostart::ManagerExt;
use thiserror::Error;

use crate::engine_bridge::EngineBridge;
use crate::notifications;
use crate::secure_store;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[allow(
    dead_code,
    reason = "engine handshake will construct online/degraded states"
)]
pub enum RuntimeMode {
    Online,
    Degraded,
    OfflineReadOnly,
}

pub struct DesktopState {
    runtime: RwLock<RuntimeMode>,
    onboarding_complete: RwLock<bool>,
    ingestion_paused: RwLock<bool>,
    publishing_paused: RwLock<bool>,
    /// Local-only editorial mutations for capabilities not yet represented by
    /// the engine protocol. These are typed JSON records and remain in the
    /// desktop process; they are never sent to external services.
    editorial_mutations: RwLock<Vec<Value>>,
    preferences: RwLock<Value>,
    local_dev_process: RwLock<Option<Child>>,
}

fn local_dev_log_path() -> Result<PathBuf, CommandError> {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .ok_or_else(|| CommandError::EngineUnavailable("yerel günlük klasörü bulunamadı".into()))?;
    let directory = base.join("Blogbot").join("logs");
    std::fs::create_dir_all(&directory).map_err(|error| CommandError::EngineUnavailable(format!("yerel günlük klasörü açılamadı: {error}")))?;
    Ok(directory.join("local-dev.log"))
}

impl Default for DesktopState {
    fn default() -> Self {
        Self {
            // Fail closed until the bundled engine sidecar has completed its
            // readiness handshake. The UI must never present placeholder commands
            // as a healthy production runtime.
            runtime: RwLock::new(RuntimeMode::OfflineReadOnly),
            onboarding_complete: RwLock::new(false),
            ingestion_paused: RwLock::new(false),
            publishing_paused: RwLock::new(false),
            editorial_mutations: RwLock::new(Vec::new()),
            preferences: RwLock::new(json!({
                "author": "Blogbot Editorya",
                "reviewer": "Editör",
                "notifications": true,
                "emailDigest": false,
                "defaultSection": "haberler"
            })),
            local_dev_process: RwLock::new(None),
        }
    }
}

impl Drop for DesktopState {
    fn drop(&mut self) {
        if let Ok(mut process) = self.local_dev_process.write() {
            if let Some(mut child) = process.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
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

fn local_state_path(file_name: &str) -> Result<std::path::PathBuf, CommandError> {
    let root = std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| CommandError::InvalidInput("LOCALAPPDATA is unavailable".into()))?
        .join("Blogbot");
    std::fs::create_dir_all(&root)
        .map_err(|error| CommandError::InvalidInput(error.to_string()))?;
    Ok(root.join(file_name))
}

fn persist_local_json(file_name: &str, value: &Value) -> Result<(), CommandError> {
    let path = local_state_path(file_name)?;
    let temp = path.with_extension("tmp");
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| CommandError::InvalidInput(error.to_string()))?;
    std::fs::write(&temp, bytes)
        .map_err(|error| CommandError::InvalidInput(error.to_string()))?;
    std::fs::rename(&temp, &path)
        .map_err(|error| CommandError::InvalidInput(error.to_string()))?;
    Ok(())
}

/// Read a desktop-owned JSON artifact without treating a missing or malformed
/// file as a fatal engine error. These files are cache-like UI state; the
/// engine and revision store remain authoritative for editorial data.
fn read_local_json(file_name: &str) -> Option<Value> {
    let path = local_state_path(file_name).ok()?;
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn read_local_json_array(file_name: &str) -> Vec<Value> {
    read_local_json(file_name)
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
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
            let Some(start) = lower.find(attribute) else { continue };
            let after = &tag[start + attribute.len()..];
            let Some((_, quoted)) = after.split_once('=') else { continue };
            let quoted = quoted.trim_start();
            let Some(quote) = quoted.chars().next() else { continue };
            if quote != '"' && quote != '\'' { continue; }
            let value = &quoted[quote.len_utf8()..];
            let Some(end) = value.find(quote) else { continue };
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
    Err(CommandError::EngineUnavailable(
        response
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| {
                response
                    .pointer("/result/error/message")
                    .and_then(Value::as_str)
            })
            .unwrap_or("ENGINE_REQUEST_FAILED")
            .to_string(),
    ))
}

fn read_engine_local_state(bridge: &EngineBridge, key: &str) -> Option<Value> {
    engine_request(
        bridge,
        json!({
            "version": 1,
            "id": format!("desktop-local-state-read-{key}"),
            "kind": "local.state.get",
            "key": key
        }),
    )
    .ok()
    .and_then(|response| response.get("value").cloned())
    .filter(|value| !value.is_null())
}

fn write_engine_local_state(
    bridge: &EngineBridge,
    key: &str,
    value: Value,
) -> Result<Value, CommandError> {
    let version = read_engine_state(bridge)?
        .pointer("/snapshot/serverCursor")
        .and_then(Value::as_u64)
        .ok_or_else(|| CommandError::EngineUnavailable("STATE_VERSION_MISSING".into()))?;
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

fn persist_editorial_state(
    bridge: &EngineBridge,
    mutation: Value,
    field: Option<(&str, Value)>,
) -> Result<Value, CommandError> {
    let mut state = read_engine_local_state(bridge, "desktop.editorial")
        .unwrap_or_else(|| json!({}));
    let object = state
        .as_object_mut()
        .ok_or_else(|| CommandError::EngineUnavailable("EDITORIAL_STATE_INVALID".into()))?;
    let mutations = object
        .entry("mutations")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or_else(|| CommandError::EngineUnavailable("EDITORIAL_MUTATIONS_INVALID".into()))?;
    mutations.push(mutation);
    if let Some((key, value)) = field {
        object.insert(key.to_string(), value);
    }
    write_engine_local_state(bridge, "desktop.editorial", Value::Object(object.clone()))
}

fn read_engine_state(bridge: &EngineBridge) -> Result<Value, CommandError> {
    bridge
        .request(json!({
            "version": 1,
            "id": "desktop-state",
            "kind": "state",
            "afterCursor": 0
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

#[tauri::command]
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

/// Opens the operating system's folder picker. No arbitrary filesystem path
/// is accepted from the WebView: the returned value is produced by the native
/// dialog and is validated before it is handed to the UI.
#[tauri::command]
pub fn pick_local_folder() -> Result<Option<String>, CommandError> {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::Shell::{
            BROWSEINFOW, BIF_NEWDIALOGSTYLE, BIF_RETURNONLYFSDIRS, SHBrowseForFolderW,
            SHGetPathFromIDListW,
        };
        use windows::Win32::System::Com::CoTaskMemFree;
        use windows::core::{PCWSTR, PWSTR};

        let title: Vec<u16> = "Blogbot için bir proje klasörü seçin"
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
        let end = path.iter().position(|value| *value == 0).unwrap_or(path.len());
        let selected = String::from_utf16_lossy(&path[..end]);
        validate_folder_selection(&selected)?;
        Ok(Some(selected))
    }

    #[cfg(not(windows))]
    {
        Err(CommandError::InvalidInput(
            "yerel klasör seçici yalnızca Windows çalışma zamanında kullanılabilir".into(),
        ))
    }
}

#[tauri::command]
pub fn engine_doctor(bridge: tauri::State<'_, EngineBridge>) -> Result<Value, CommandError> {
    bridge.doctor().map_err(CommandError::EngineUnavailable)
}

#[tauri::command]
pub fn test_setup_connector(connector: String, config: Value) -> Result<Value, CommandError> {
    let allowed = ["codex", "github", "site", "siberdergi", "deploy", "backup"];
    if !allowed.contains(&connector.as_str()) {
        return Err(CommandError::InvalidInput("unknown setup connector".into()));
    }
    let object = config
        .as_object()
        .ok_or_else(|| CommandError::InvalidInput("setup connector config must be an object".into()))?;
    let allowed_fields: &[&str] = match connector.as_str() {
        "codex" => &["accountLabel"],
        "github" => &["owner", "repository", "clientId"],
        "site" | "siberdergi" => &["repositoryPath", "publicSiteUrl", "mode"],
        "deploy" => &["workflowName"],
        "backup" => &["folder"],
        _ => &[],
    };
    if object.keys().any(|key| !allowed_fields.contains(&key.as_str())) {
        return Err(CommandError::InvalidInput("unknown setup connector field".into()));
    }
    let serialized = serde_json::to_string(&config)
        .map_err(|error| CommandError::InvalidInput(error.to_string()))?
        .to_ascii_lowercase();
    for forbidden in ["token", "password", "privatekey", "private_key", "secret", "credential"] {
        if serialized.contains(forbidden) {
            return Err(CommandError::InvalidInput(
                "secret or credential fields are not accepted by setup".into(),
            ));
        }
    }
    let text = |key: &str| config.get(key).and_then(Value::as_str).map(str::trim);
    let site_mode = text("mode").unwrap_or("LOCAL_ONLY");
    let missing = match connector.as_str() {
        "codex" => text("accountLabel").map(|value| value.is_empty()).unwrap_or(true),
        "github" => ["owner", "repository"].iter().any(|key| text(key).map(|value| value.is_empty()).unwrap_or(true)),
        "site" | "siberdergi" => text("repositoryPath").map(|value| value.is_empty()).unwrap_or(true),
        "deploy" => text("workflowName").map(|value| value.is_empty()).unwrap_or(true),
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
    let semantic_error = match connector.as_str() {
        "github" => {
            let owner = text("owner").unwrap_or_default();
            let repository = text("repository").unwrap_or_default();
            (!valid_github_segment(owner) || !valid_github_segment(repository)).then_some("GitHub sahibi ve depo adı yalnız güvenli ad karakterlerini içerebilir.")
        }
        "site" | "siberdergi" => {
            let path = text("repositoryPath").unwrap_or_default();
            let site = text("publicSiteUrl").unwrap_or_default();
            let mode = text("mode").unwrap_or("LOCAL_ONLY");
            if !valid_site_work_mode(mode) {
                return Ok(json!({"connector": connector, "ready": false, "state": "ATTENTION", "detail": "Çalışma biçimi LOCAL_ONLY, LOCAL_DEV veya PUBLISH olmalı."}));
            }
            if mode == "PUBLISH" && site.is_empty() {
                return Ok(json!({"connector": connector, "ready": false, "state": "ATTENTION", "detail": "Yayın biçiminde public adres gerekir; yerel biçimlerde boş bırakılabilir."}));
            }
            let valid_public_url = site.is_empty() || (site.starts_with("https://") && site.len() <= 2048);
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
                    Err(detail) => Some(detail)
                }
            }
        }
        "deploy" => (!text("workflowName").unwrap_or_default().chars().all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | '.')))
            .then_some("Workflow adı yalnız harf, sayı, tire, alt çizgi ve nokta içerebilir."),
        "backup" => (!is_local_path(text("folder").unwrap_or_default())).then_some("Yedek klasörü yerel ve mutlak bir yol olmalı."),
        _ => None,
    };
    if let Some(detail) = semantic_error {
        return Ok(json!({ "connector": connector, "ready": false, "state": "ATTENTION", "detail": detail }));
    }
    let adapter_dry_run = if matches!(connector.as_str(), "site" | "siberdergi") && site_mode == "PUBLISH" {
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
            })
        })
    } else {
        None
    };
    let local_only = connector == "site" && site_mode != "PUBLISH";
    let adapter_ready = adapter_dry_run.as_ref()
        .and_then(Value::as_object)
        .and_then(|value| value.get("ok"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    Ok(json!({
        "connector": connector,
        "ready": true,
        "state": "DRY_RUN_READY",
        "authorizationState": "NOT_CHECKED",
        "contentModel": if matches!(connector.as_str(), "site" | "siberdergi") { detect_site_content_model(text("repositoryPath").unwrap_or_default()) } else { "N/A" },
        "siteFormat": if matches!(connector.as_str(), "site" | "siberdergi") { detect_site_format(text("repositoryPath").unwrap_or_default()).unwrap_or("UNKNOWN") } else { "N/A" },
        "repositorySuggestion": if matches!(connector.as_str(), "site" | "siberdergi") { detect_repository_remote(text("repositoryPath").unwrap_or_default()) } else { None::<String> },
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
        && value.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/'))
        && !value.starts_with('/')
        && !value.contains("//")
}

fn valid_site_work_mode(value: &str) -> bool {
    matches!(value, "LOCAL_ONLY" | "LOCAL_DEV" | "PUBLISH")
}

fn github_preview_payload(repository: &str, workflow: &str, revision_id: &str, revision_hash: &str) -> Result<Value, CommandError> {
    let mut segments = repository.split('/');
    let owner = segments.next().unwrap_or_default();
    let repo = segments.next().unwrap_or_default();
    if segments.next().is_some() || !valid_github_segment(owner) || !valid_github_segment(repo) {
        return Err(CommandError::InvalidInput("GitHub repository must be owner/name".into()));
    }
    if !valid_github_workflow(workflow) || revision_id.trim().is_empty() || revision_hash.len() != 64 || !revision_hash.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(CommandError::InvalidInput("GitHub preview intent scope is invalid".into()));
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

#[tauri::command]
pub fn github_device_flow_start(
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    if let Ok(response) = engine_request(&bridge, json!({
        "version": 1,
        "id": "github-auth-begin",
        "kind": "github.auth.begin"
    })) {
        if let Some(value) = response.get("value") { return Ok(value.clone()); }
    }
    Ok(json!({
        "started": false,
        "writes": false,
        "network": false,
        "detail": "GitHub cihaz yetkilendirmesi kullanıcı tarafından açıkça başlatılmalıdır; bu yerel dry-run ağ isteği yapmaz."
    }))
}

#[tauri::command]
pub fn github_device_flow_status(
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    if let Ok(response) = engine_request(&bridge, json!({
        "version": 1,
        "id": "github-auth-poll",
        "kind": "github.auth.poll"
    })) {
        if let Some(value) = response.get("value") { return Ok(value.clone()); }
    }
    if let Ok(response) = engine_request(&bridge, json!({
        "version": 1,
        "id": "github-auth-status",
        "kind": "github.auth.status"
    })) {
        if let Some(value) = response.get("value") { return Ok(value.clone()); }
    }
    Ok(json!({
        "status": "logged-out",
        "writes": false,
        "network": false,
        "detail": "GitHub kimlik bilgisi bu yerel köprüde tutulmuyor."
    }))
}

#[tauri::command]
pub fn github_validate_repository(owner: String, repository: String, workflow: String) -> Result<Value, CommandError> {
    let owner = owner.trim();
    let repository = repository.trim();
    let workflow = workflow.trim();
    if !valid_github_segment(owner) || !valid_github_segment(repository) || !valid_github_workflow(workflow) {
        return Ok(json!({ "valid": false, "repository": format!("{owner}/{repository}"), "workflow": workflow, "writes": false, "detail": "GitHub depo veya workflow adı güvenli değil." }));
    }
    Ok(json!({ "valid": true, "repository": format!("{owner}/{repository}"), "workflow": workflow, "writes": false, "network": false }))
}

#[tauri::command]
pub fn github_preview_pull_request(repository: String, workflow: String, revision_id: String, revision_hash: String) -> Result<Value, CommandError> {
    github_preview_payload(repository.trim(), workflow.trim(), revision_id.trim(), revision_hash.trim())
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
    ].iter().any(|candidate| candidate.is_file());
    if root.join("src").join("content").is_dir() && !has_content_schema {
        return Err("Astro içerik klasörü bulundu ancak strict içerik şeması bulunamadı; src/content.config.ts veya src/content/config.ts ekleyin.");
    }
    let files = ["astro.config.mjs", "astro.config.js", "astro.config.ts", "package.json"]
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
    content.lines()
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
        return Err(CommandError::InvalidInput("yerel proje klasörü mutlak bir Windows yolu olmalı".into()));
    }
    let root = std::fs::canonicalize(raw)
        .map_err(|_| CommandError::InvalidInput("yerel proje klasörü bulunamadı".into()))?;
    if !root.is_dir() || !root.join("package.json").is_file() {
        return Err(CommandError::InvalidInput("yerel proje klasöründe package.json bulunamadı".into()));
    }
    let bytes = std::fs::read(root.join("package.json"))
        .map_err(|_| CommandError::InvalidInput("package.json okunamadı".into()))?;
    if bytes.len() > 2_000_000 {
        return Err(CommandError::InvalidInput("package.json çok büyük".into()));
    }
    let package: Value = serde_json::from_slice(&bytes)
        .map_err(|_| CommandError::InvalidInput("package.json geçerli JSON değil".into()))?;
    let has_dev = package.pointer("/scripts/dev").and_then(Value::as_str).is_some_and(|value| !value.trim().is_empty());
    if !has_dev {
        return Err(CommandError::InvalidInput("package.json içinde scripts.dev bulunamadı".into()));
    }
    Ok(root)
}

#[tauri::command]
pub fn local_dev_status(
    state: tauri::State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    let mut process = write_lock(&state.local_dev_process)?;
    let running = match process.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(Some(_)) => { *process = None; false }
            Ok(None) => true,
            Err(_) => false,
        },
        None => false,
    };
    let log_path = local_dev_log_path().ok();
    Ok(json!({ "running": running, "logPath": log_path }))
}

#[tauri::command]
pub fn start_local_dev(
    path: String,
    state: tauri::State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    let root = validate_local_dev_project(&path)?;
    let mut process = write_lock(&state.local_dev_process)?;
    if let Some(child) = process.as_mut() {
        if child.try_wait().map_err(|_| CommandError::EngineUnavailable("yerel geliştirme süreci denetlenemedi".into()))?.is_none() {
            return Ok(json!({ "running": true, "directory": root }));
        }
        *process = None;
    }
    let executable = if cfg!(windows) { "npm.cmd" } else { "npm" };
    let log_path = local_dev_log_path()?;
    let stdout = std::fs::OpenOptions::new().create(true).append(true).open(&log_path)
        .map_err(|error| CommandError::EngineUnavailable(format!("yerel günlük açılamadı: {error}")))?;
    let stderr = stdout.try_clone()
        .map_err(|error| CommandError::EngineUnavailable(format!("yerel günlük çoğaltılamadı: {error}")))?;
    let child = Command::new(executable)
        .args(["run", "dev"])
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|error| CommandError::EngineUnavailable(format!("yerel geliştirme süreci başlatılamadı: {error}")))?;
    *process = Some(child);
    Ok(json!({ "running": true, "directory": root, "logPath": log_path }))
}

#[tauri::command]
pub fn stop_local_dev(
    state: tauri::State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    let mut process = write_lock(&state.local_dev_process)?;
    if let Some(mut child) = process.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(json!({ "running": false }))
}

#[tauri::command]
pub fn get_local_dev_logs() -> Result<Value, CommandError> {
    let path = local_dev_log_path()?;
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    let mut lines = content.lines().rev().take(200).map(str::to_owned).collect::<Vec<_>>();
    lines.reverse();
    Ok(json!({ "path": path, "lines": lines }))
}

fn configured_site_origin(connectors: &Value) -> Option<String> {
    connectors
        .pointer("/site/publicSiteUrl")
        .or_else(|| connectors.pointer("/siberdergi/publicSiteUrl"))
        .and_then(Value::as_str)
        .map(|value| value.trim_end_matches('/').to_string())
}

fn codex_executable() -> Option<&'static str> {
    ["codex.cmd", "codex.exe", "codex"].into_iter().find(|candidate| {
        Command::new(candidate)
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

#[tauri::command]
pub fn test_codex_runtime(
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    let Some(executable) = codex_executable() else {
        return Ok(json!({
            "available": false,
            "authenticated": false,
            "detail": "Yazı üretimi aracı bu bilgisayarda bulunamadı. Kurulum paketindeki bağlantı adımını veya Codex kurulumunu kontrol edin."
        }));
    };
    let version = Command::new(executable)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .map_err(|error| CommandError::EngineUnavailable(format!("CODEX_VERSION_CHECK_FAILED:{error}")))?;
    let output = String::from_utf8_lossy(&version.stdout)
        .lines()
        .next()
        .unwrap_or("Codex hazır")
        .chars()
        .take(120)
        .collect::<String>();
    let codex_home = bridge.codex_home();
    let authenticated = codex_authenticated(executable, codex_home.as_deref());
    let runner_ready = bridge
        .doctor()
        .ok()
        .and_then(|doctor| doctor.get("capabilities").cloned())
        .and_then(|value| value.as_array().cloned())
        .is_some_and(|capabilities| capabilities.iter().any(|item| item.as_str() == Some("CODEX.RUNNER")));
    Ok(json!({
        "available": true,
        "authenticated": authenticated,
        "runnerReady": runner_ready,
        "version": output,
        "detail": if !authenticated { "Yazı üretimi aracı bulundu; hesap bağlantısı bekleniyor." } else if runner_ready { "Yazı üretimi aracı ve izole Blogbot runner hazır." } else { "Yazı üretimi hesabı hazır; izole Blogbot runner başlatılamadı." }
    }))
}

#[tauri::command]
pub fn start_codex_login(
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    let executable = codex_executable()
        .ok_or_else(|| CommandError::EngineUnavailable("CODEX_NOT_INSTALLED".into()))?;
    let mut command = Command::new(executable);
    if let Some(home) = bridge.codex_home() {
        command.env("CODEX_HOME", home);
    }
    command
        .arg("login")
        .stdin(Stdio::null())
        .spawn()
        .map_err(|error| CommandError::EngineUnavailable(format!("CODEX_LOGIN_START_FAILED:{error}")))?;
    Ok(json!({
        "started": true,
        "detail": "Codex giriş penceresi başlatıldı. Giriş tamamlandığında bu ekrandan yeniden test edin."
    }))
}

/// Persist only validated, non-secret setup fields in the encrypted engine
/// local-state store. Authentication tokens, passwords and private keys are
/// rejected by `test_setup_connector` before this command can write anything.
#[tauri::command]
pub fn save_setup_connector(
    connector: String,
    config: Value,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    let validation = test_setup_connector(connector.clone(), config.clone())?;
    if validation.get("ready").and_then(Value::as_bool) != Some(true) {
        return Ok(validation);
    }
    let mut saved = read_engine_local_state(&bridge, "desktop.connectors")
        .unwrap_or_else(|| json!({}));
    let object = saved
        .as_object_mut()
        .ok_or_else(|| CommandError::EngineUnavailable("CONNECTOR_STATE_INVALID".into()))?;
    let storage_key = if connector == "siberdergi" { "site" } else { connector.as_str() };
    object.insert(storage_key.to_string(), config.clone());
    write_engine_local_state(&bridge, "desktop.connectors", Value::Object(object.clone()))?;
    // The engine workers consume connector-scoped records directly. Mirror
    // only validated, non-secret setup metadata; credentials remain owned by
    // the engine authentication runtime and never pass through this command.
    if matches!(storage_key, "github" | "site" | "deploy") {
        write_engine_local_state(&bridge, &format!("connector.{storage_key}"), config.clone())?;
    }
    let mut checks = read_engine_local_state(&bridge, "desktop.connectorChecks")
        .unwrap_or_else(|| json!({}));
    let checks_object = checks
        .as_object_mut()
        .ok_or_else(|| CommandError::EngineUnavailable("CONNECTOR_CHECK_STATE_INVALID".into()))?;
    let adapter_verified = if connector == "site" || connector == "siberdergi" {
        validation.get("adapterDryRun").and_then(Value::as_object).and_then(|value| value.get("ok")).and_then(Value::as_bool) == Some(true)
    } else {
        true
    };
    checks_object.insert(storage_key.to_string(), json!({
        "ready": adapter_verified,
        "state": if adapter_verified { "DRY_RUN_READY" } else { "ADAPTER_DRY_RUN_REQUIRED" },
        "checkedAtUnixMs": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()
    }));
    write_engine_local_state(&bridge, "desktop.connectorChecks", Value::Object(checks_object.clone()))?;
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

fn valid_github_segment(value: &str) -> bool {
    !value.is_empty() && value.len() <= 100 && value.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
    })
}

fn is_local_path(value: &str) -> bool {
    value.len() >= 3
        && value.as_bytes().get(1) == Some(&b':')
        && value.as_bytes().get(2).is_some_and(|character| *character == b'\\' || *character == b'/')
        && value.chars().all(|character| character != '\0' && character != '"')
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
    matches!(
        slot_id,
        "slot-mon" | "slot-tue" | "slot-wed" | "slot-thu" | "slot-fri" | "slot-sat" | "slot-sun"
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

#[tauri::command]
pub fn get_bootstrap_snapshot(
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    let runtime = *read_lock(&state.runtime)?;
    let engine_state = read_engine_state(&bridge).ok();
    let doctor = bridge.doctor().ok();
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
    let revision_materializations = read_revision_list(&bridge).unwrap_or_default();
    let revision_queue = build_revision_queue(&revision_materializations);
    let review_count = revision_queue
        .iter()
        .filter(|item| item.get("state").and_then(Value::as_str) == Some("REVIEW_REQUIRED"))
        .count();
    let approved_count = revision_queue
        .iter()
        .filter(|item| item.get("state").and_then(Value::as_str) == Some("APPROVED"))
        .count();
    let source_count = engine_request(
        &bridge,
        json!({
            "version": 1,
            "id": format!("desktop-bootstrap-source-list-{}", std::process::id()),
            "kind": "source.list"
        }),
    )
    .ok()
    .and_then(|result| result.get("sources").and_then(Value::as_array).map(Vec::len))
    .unwrap_or(0);
    let scheduled_count = revision_queue
        .iter()
        .filter(|item| item.get("scheduledAt").and_then(Value::as_str).is_some())
        .count();
    let queue_jobs = engine_state
        .as_ref()
        .and_then(|value| value.pointer("/snapshot/jobs").and_then(Value::as_array))
        .cloned()
        .unwrap_or_default();
    let codex_waiting = queue_jobs
        .iter()
        .filter(|job| {
            matches!(
                job.get("state").and_then(Value::as_str),
                Some("WAITING_CODEX") | Some("QUEUED") | Some("RUNNING")
            ) && matches!(job.get("kind").and_then(Value::as_str), Some("CODEX") | Some("DRAFT"))
        })
        .count();

    Ok(json!({
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
            "state": if codex_waiting > 0 { "WAITING" } else { "UNCONFIGURED" },
            "accountLabel": "Codex bağlantısı Kurulum Merkezi'nden yapılandırılır",
            "queueDepth": codex_waiting,
            "lastRunAt": Value::Null
        },
        "pipeline": [
            { "label": "Keşfedilen", "count": 0, "tone": "neutral" },
            { "label": "Araştırılan", "count": 0, "tone": "blue" },
            { "label": "İnceleme", "count": review_count, "tone": "amber" },
            { "label": "Onaylı", "count": approved_count, "tone": "green" }
        ],
        "queue": revision_queue,
        "sourceCount": source_count,
        "scheduledCount": scheduled_count
    }))
}

#[tauri::command]
pub fn get_prerequisite_status(
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
    let checked_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let connectors = read_engine_local_state(&bridge, "desktop.connectors")
        .unwrap_or_else(|| json!({}));
    let codex_configured = connectors.pointer("/codex/accountLabel")
        .and_then(Value::as_str).is_some_and(|value| !value.trim().is_empty());
    let codex_available = codex_executable().is_some();
    let codex_authenticated = codex_executable().is_some_and(|executable| {
        codex_authenticated(executable, bridge.codex_home().as_deref())
    });
    let codex_runner_ready = engine_doctor
        .as_ref()
        .and_then(|value| value.get("capabilities"))
        .and_then(Value::as_array)
        .is_some_and(|capabilities| capabilities.iter().any(|item| item.as_str() == Some("CODEX.RUNNER")));
    let github_configured = connectors.pointer("/github/owner").and_then(Value::as_str).is_some_and(|value| !value.trim().is_empty())
        && connectors.pointer("/github/repository").and_then(Value::as_str).is_some_and(|value| !value.trim().is_empty());
    let github_auth_status = engine_request(&bridge, json!({
        "version": 1,
        "id": "github-auth-prerequisite",
        "kind": "github.auth.status"
    })).ok().and_then(|value| value.get("value").cloned()).unwrap_or_else(|| json!({"status": "unconfigured"}));
    let github_authorized = github_auth_status.get("status").and_then(Value::as_str) == Some("authorized");
    let site_configured = connectors.pointer("/site/repositoryPath")
        .or_else(|| connectors.pointer("/siberdergi/repositoryPath"))
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    let backup_configured = connectors.pointer("/backup/folder").and_then(Value::as_str).is_some_and(|value| !value.trim().is_empty());
    let connector_checks = read_engine_local_state(&bridge, "desktop.connectorChecks")
        .unwrap_or_else(|| json!({}));
    let site_check_ready = connector_checks.pointer("/site/ready").and_then(Value::as_bool)
        .or_else(|| connector_checks.pointer("/siberdergi/ready").and_then(Value::as_bool))
        .unwrap_or(false);

    Ok(json!({
        "checkedAtUnixMs": checked_at_unix_ms,
        "checks": [
            {
                "id": "windows",
                "label": "Desteklenen Windows",
                "state": "READY",
                "scope": "APP",
                "detail": "Windows masaüstü çalışma zamanı hazır.",
                "userAction": null
            },
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
                "detail": if !codex_available { "Yazı üretimi aracı bu bilgisayarda bulunamadı." } else if !codex_configured { "Yazı üretimi hesabı henüz seçilmedi." } else if !codex_authenticated { "Yazı üretimi aracı bulundu; hesap girişi bekleniyor." } else if !codex_runner_ready { "Hesap hazır; izole yerel runner henüz başlatılmadı." } else { "Codex hesabı ve izole yerel runner hazır." },
                "userAction": if codex_runner_ready && codex_authenticated && codex_configured { Value::Null } else { json!("Codex hesabını bağlayıp izole runner testini tamamlayın.") }
            },
            {
                "id": "clock",
                "label": "Yerel zamanlayıcı",
                "state": "READY",
                "scope": "PUBLISH",
                "detail": "Planlama bu Windows bilgisayarının yerel saatini kullanır.",
                "userAction": Value::Null
            },
            {
                "id": "github",
                "label": "GitHub yayın bağlantısı",
                "state": if github_configured && github_authorized { "READY" } else { "BLOCKED" },
                "scope": "PUBLISH",
                "detail": if !github_configured { "GitHub depo hedefi henüz yapılandırılmadı." } else if github_authorized { "GitHub deposu ve cihaz yetkilendirmesi hazır." } else { "GitHub depo hedefi kaydedildi; cihaz yetkilendirmesi bekleniyor." },
                "userAction": if github_configured && github_authorized { Value::Null } else { json!("GitHub yetkilendirmesini tamamlayın; aksi halde PR ve yayın işlemleri kilitli kalır.") }
            },
            {
                "id": "backup",
                "label": "İsteğe bağlı şifreli yedek",
                "state": "BLOCKED",
                "scope": "APP",
                "detail": if backup_configured { "Yedek klasörü kaydedildi; recovery key ile doğrulama bekleniyor." } else { "Şifreli yedek klasörü henüz seçilmedi." },
                "userAction": json!("Recovery key oluşturun ve boş klasöre geri yükleme testini tamamlayın.")
            },
            {
                "id": "site-adapter",
                "checkPassed": site_check_ready,
                "label": "Site yayın adaptörü",
                "state": if site_check_ready { "READY" } else if site_configured { "ATTENTION" } else { "BLOCKED" },
                "scope": "PUBLISH",
                "detail": if site_check_ready { "Seçilen site adaptörü ve yayın sözleşmesi doğrulandı." } else if site_configured { "Site klasörü kaydedildi; format ve route dry-run doğrulaması bekleniyor." } else { "Yayın yapılacak site henüz seçilmedi." },
                "userAction": if site_check_ready { Value::Null } else { json!("Yayın yapılacak siteyi seçin ve format/route dry-run testini çalıştırın.") }
            }
        ]
    }))
}

#[tauri::command]
pub fn list_sources(bridge: tauri::State<'_, EngineBridge>) -> Result<Value, CommandError> {
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
                "canPublish": publishable,
                "blockers": source.pointer("/capabilities/blockers").cloned().unwrap_or_else(|| json!([]))
            })
        }).collect::<Vec<_>>()
    }))
}

#[tauri::command]
pub fn test_source(
    url: String,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    if !is_http_url(&url) {
        return Err(CommandError::InvalidInput(
            "source URL must use HTTPS".into(),
        ));
    }
    let response = engine_request(
        &bridge,
        json!({
            "version": 1,
            "id": format!("desktop-source-test-{}", std::process::id()),
            "kind": "source.test",
            "url": url
        }),
    )?;
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
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| CommandError::StateUnavailable)?
        .as_millis();
    let request_token = format!("desktop-scan-{}-{timestamp}", std::process::id());
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

#[tauri::command]
pub fn scan_source(
    source_id: String,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    scan_sources(Some(&source_id), &state, &bridge)
}

#[tauri::command]
pub fn scan_all_sources(
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    scan_sources(None, &state, &bridge)
}

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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
        let stable_key = stable_source_key(&format!("{expected_version}:{}", source));
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
                "payload": {}
            }
        }),
    )?;
    response
        .pointer("/result/value")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| CommandError::EngineUnavailable("REVISION_LIST_SHAPE_INVALID".into()))
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
            let fully_approved =
                has_editorial_approval && (!high_risk || has_high_risk_approval);
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
                + usize::from(
                    high_risk && has_editorial_approval && !has_high_risk_approval,
                );
            Some(json!({
                "id": id,
                "revisionHash": item.get("revisionHash").cloned().unwrap_or(Value::Null),
                "title": title,
                "section": revision.get("section").cloned().unwrap_or(json!("haberler")),
                "slug": revision.pointer("/tr/slug").cloned().unwrap_or(json!(id)),
                "state": state,
                "sourceCount": source_count,
                "updatedAt": revision.get("scheduledAt").cloned().unwrap_or(Value::Null),
                "dueLabel": "İnceleme bekliyor",
                "blockers": blockers
            }))
        })
        .collect()
}

fn build_review_revision(item: &Value) -> Result<Value, CommandError> {
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
                        "contentBase64": asset.get("contentBase64").cloned().unwrap_or(Value::Null),
                        "altTr": tr.get("heroImageAlt").cloned().unwrap_or(Value::Null),
                        "altEn": en.get("heroImageAlt").cloned().unwrap_or(Value::Null)
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let claims_ready = revision
        .get("claims")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            !items.is_empty()
                && items.iter().all(|claim| {
                    claim.get("status").and_then(Value::as_str) == Some("VERIFIED")
                        && claim
                            .get("evidenceAnchors")
                            .and_then(Value::as_array)
                            .is_some_and(|anchors| !anchors.is_empty())
                })
        });
    let parity_ready =
        revision.pointer("/translationParity/status").and_then(Value::as_str) == Some("MATCHED");
    let has_editorial_approval = item
        .get("editorialApproval")
        .is_some_and(|value| !value.is_null());
    let high_risk = revision.get("riskLevel").and_then(Value::as_str) == Some("HIGH");
    let has_high_risk_approval = item
        .get("highRiskApproval")
        .is_some_and(|value| !value.is_null());
    let approved = has_editorial_approval && (!high_risk || has_high_risk_approval);
    let mut gates = vec![
        json!({
            "id": "claims",
            "label": "İddia ve kanıt bütünlüğü",
            "detail": if claims_ready { "Tüm iddialar doğrulanmış kanıta bağlı." } else { "Eksik veya doğrulanmamış iddia var." },
            "state": if claims_ready { "PASS" } else { "BLOCK" },
            "group": "editorial"
        }),
        json!({
            "id": "parity",
            "label": "TR/EN anlam eşitliği",
            "detail": if parity_ready { "Dil sürümleri eşleşiyor." } else { "Dil eşitliği doğrulanmadı." },
            "state": if parity_ready { "PASS" } else { "BLOCK" },
            "group": "editorial"
        }),
        json!({
            "id": "immutable-package",
            "label": "Değişmez yayın paketi",
            "detail": "Revizyon hash'i engine tarafından yeniden hesaplandı.",
            "state": "PASS",
            "group": "security"
        }),
    ];
    if high_risk {
        gates.push(json!({
            "id": "high-risk-approval",
            "label": "Yüksek risk ikinci onayı",
            "detail": if has_high_risk_approval {
                "Ayrı yüksek risk kontrolü ve Windows yeniden doğrulaması kaydedildi."
            } else {
                "Ayrı yüksek risk kontrolü ve Windows yeniden doğrulaması gerekiyor."
            },
            "state": if has_high_risk_approval { "PASS" } else { "BLOCK" },
            "group": "security"
        }));
    }

    Ok(json!({
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
        "previous": { "tr": locale_content(tr), "en": locale_content(en) },
        "claims": claims,
        "sources": sources,
        "gates": gates,
        "media": media
    }))
}

#[tauri::command]
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
        .map(|items| items.iter().filter_map(Value::as_str).map(str::trim).filter(|url| is_http_url(url)).map(str::to_string).collect::<Vec<_>>())
        .unwrap_or_default();
    if instruction.len() < 10 || (source_ids.is_empty() && urls.is_empty()) {
        return Err(CommandError::InvalidInput(
            "anlık içerik için talimat ve en az bir kaynak gerekir".into(),
        ));
    }
    let version = read_engine_state(&bridge)?
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
                    "section": request.get("section").and_then(Value::as_str).unwrap_or("haberler"),
                    "articleType": request.get("articleType").and_then(Value::as_str).unwrap_or("news")
                }
            }
        }),
    )?;
    let queued = response
        .pointer("/result/value")
        .cloned()
        .ok_or_else(|| CommandError::EngineUnavailable("DRAFT_CREATE_SHAPE_INVALID".into()))?;
    Ok(json!({
        "id": queued.get("id").cloned().unwrap_or_else(|| json!(draft_id)),
        "state": "RESEARCHING",
        "queueState": queued.get("state").cloned().unwrap_or_else(|| json!("WAITING_CODEX"))
    }))
}

#[tauri::command]
pub fn get_review_revision(
    revision_id: String,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    let materializations = read_revision_list(&bridge)?;
    let item = materializations
        .iter()
        .find(|item| {
            item.pointer("/revision/id").and_then(Value::as_str)
                == Some(revision_id.as_str())
        })
        .ok_or_else(|| CommandError::InvalidInput("revizyon bulunamadı".into()))?;
    build_review_revision(item)
}

fn build_approval_command(
    revision_id: &str,
    expected_hash: &str,
    expected_version: u64,
) -> Result<Value, CommandError> {
    if revision_id.is_empty()
        || revision_id.len() > 128
        || !revision_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
        || expected_hash.len() != 64
        || !expected_hash.chars().all(|character| character.is_ascii_hexdigit())
    {
        return Err(CommandError::InvalidInput(
            "revizyon kimliği veya exact hash geçersiz".into(),
        ));
    }
    let request_key = stable_source_key(&format!("{revision_id}:{expected_hash}"));
    Ok(json!({
        "version": 1,
        "requestId": request_key,
        "idempotencyKey": request_key,
        "expectedVersion": expected_version,
        "kind": "APPROVAL.GRANT",
        "payload": {
            "revisionId": revision_id,
            "revisionHash": expected_hash.to_ascii_lowercase(),
            "deviceId": "windows-local-device-v1"
        }
    }))
}

fn build_high_risk_approval_command(
    revision_id: &str,
    expected_hash: &str,
    checklist_hash: &str,
    expected_version: u64,
) -> Result<Value, CommandError> {
    if revision_id.is_empty()
        || revision_id.len() > 128
        || !revision_id.chars().all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
        || expected_hash.len() != 64
        || !expected_hash.chars().all(|character| character.is_ascii_hexdigit())
        || checklist_hash.len() != 64
        || !checklist_hash.chars().all(|character| character.is_ascii_hexdigit())
    {
        return Err(CommandError::InvalidInput("revizyon, exact hash veya risk kontrol hash'i geçersiz".into()));
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let request_key = stable_source_key(&format!("high-risk:{revision_id}:{expected_hash}:{checklist_hash}:{now}"));
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
            "windowsReauthenticatedAt": reauthenticated_at
        }
    }))
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
    Ok(format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{:03}Z", system_time.subsec_millis()))
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

#[tauri::command]
pub fn approve_revision(
    revision_id: String,
    expected_hash: String,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    let engine_state = read_engine_state(&bridge)?;
    let expected_version = engine_state
        .pointer("/snapshot/serverCursor")
        .and_then(Value::as_u64)
        .ok_or_else(|| CommandError::EngineUnavailable("STATE_VERSION_MISSING".into()))?;
    let command = build_approval_command(&revision_id, &expected_hash, expected_version)?;
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
    let materializations = read_revision_list(&bridge)?;
    let materialization = materializations
        .iter()
        .find(|item| {
            item.pointer("/revision/id").and_then(Value::as_str)
                == Some(revision_id.as_str())
        })
        .ok_or_else(|| CommandError::EngineUnavailable("APPROVED_REVISION_MISSING".into()))?;
    let review_revision = build_review_revision(materialization)?;
    Ok(json!({
        "approvedAt": approval.get("approvedAt").cloned().unwrap_or(Value::Null),
        "revisionHash": approval.get("revisionHash").cloned().unwrap_or(Value::Null),
        "state": review_revision.get("state").cloned().unwrap_or(json!("REVIEW_REQUIRED"))
    }))
}

#[tauri::command]
pub fn approve_high_risk_revision(
    revision_id: String,
    expected_hash: String,
    risk_checklist_hash: String,
    confirm_reauthenticated: bool,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
    app: tauri::AppHandle,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    if !confirm_reauthenticated {
        return Err(CommandError::InvalidInput("Windows yeniden doğrulaması açıkça onaylanmalı".into()));
    }
    if !secure_store::status(&app).ready {
        return Err(CommandError::EngineUnavailable("SECURE_STORE_NOT_READY".into()));
    }
    let engine_state = read_engine_state(&bridge)?;
    let expected_version = engine_state.pointer("/snapshot/serverCursor").and_then(Value::as_u64)
        .ok_or_else(|| CommandError::EngineUnavailable("STATE_VERSION_MISSING".into()))?;
    let command = build_high_risk_approval_command(&revision_id, &expected_hash, &risk_checklist_hash, expected_version)?;
    let request_id = command.get("requestId").and_then(Value::as_str).ok_or(CommandError::StateUnavailable)?.to_string();
    let response = engine_request(&bridge, json!({ "version": 1, "id": request_id, "kind": "command", "command": command }))?;
    response.pointer("/result/value").cloned().ok_or_else(|| CommandError::EngineUnavailable("HIGH_RISK_APPROVAL_SHAPE_INVALID".into()))
}

#[tauri::command]
pub fn enqueue_publication(
    revision_id: String,
    revision_hash: String,
    preview_hash: String,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    if revision_id.trim().is_empty()
        || !revision_hash.chars().all(|value| value.is_ascii_hexdigit())
        || revision_hash.len() != 64
        || !preview_hash.chars().all(|value| value.is_ascii_hexdigit())
        || preview_hash.len() != 64
    {
        return Err(CommandError::InvalidInput("revision id, exact revision hash, and publication preview hash are required".into()));
    }
    let version = read_engine_state(&bridge)?
        .pointer("/snapshot/serverCursor")
        .and_then(Value::as_u64)
        .ok_or_else(|| CommandError::EngineUnavailable("STATE_VERSION_MISSING".into()))?;
    let idempotency_key = stable_source_key(&format!("publication:{revision_id}:{revision_hash}"));
    let response = engine_request(&bridge, json!({
        "version": 1,
        "id": idempotency_key,
        "kind": "publication.enqueue",
        "revisionId": revision_id,
        "revisionHash": revision_hash,
        "previewHash": preview_hash,
        "expectedVersion": version,
        "idempotencyKey": idempotency_key
    }))?;
    response.get("value").cloned().ok_or_else(|| CommandError::EngineUnavailable("PUBLICATION_ENQUEUE_SHAPE_INVALID".into()))
}

/// Writes only the exact, already approved preview bundle into the user's
/// selected local project. The WebView never supplies file contents or paths.
#[tauri::command]
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
        return Err(CommandError::InvalidInput("approved revision, preview hash ve yerel hedef klasör gerekir".into()));
    }
    let root = std::fs::canonicalize(&target_directory)
        .map_err(|error| CommandError::InvalidInput(format!("hedef klasör okunamadı: {error}")))?;
    // Setup persists the selected site in the encrypted connector catalog.
    // Retain the former key as a read-only migration fallback.
    let configured_root = read_engine_local_state(&bridge, "desktop.connectors")
        .and_then(|value| value.pointer("/site/repositoryPath").and_then(Value::as_str).map(str::to_owned))
        .or_else(|| read_engine_local_state(&bridge, "connector.site")
            .and_then(|value| value.get("repositoryPath").and_then(Value::as_str).map(str::to_owned)))
        .ok_or_else(|| CommandError::InvalidInput("önce Kurulum Merkezi'nden site klasörünü kaydedin".into()))?;
    let configured_root = std::fs::canonicalize(configured_root)
        .map_err(|error| CommandError::InvalidInput(format!("kayıtlı site klasörü okunamadı: {error}")))?;
    if root != configured_root {
        return Err(CommandError::InvalidInput("yalnız Kurulum Merkezi'nde seçilen site klasörüne yazılabilir".into()));
    }
    let state_value = read_engine_local_state(&bridge, &format!("publication.preview:{revision_id}"))
        .ok_or_else(|| CommandError::EngineUnavailable("PUBLICATION_PREVIEW_MISSING".into()))?;
    if state_value.get("revisionHash").and_then(Value::as_str) != Some(revision_hash.as_str())
        || state_value.get("previewHash").and_then(Value::as_str) != Some(preview_hash.as_str())
    {
        return Err(CommandError::InvalidInput("önizleme artık onaylı revizyonla eşleşmiyor".into()));
    }
    let snapshot = read_engine_state(&bridge)?;
    let revision = snapshot.pointer("/snapshot/revisions").and_then(Value::as_array).and_then(|items| {
        items.iter().find(|item| item.get("id").and_then(Value::as_str) == Some(revision_id.as_str()))
    }).ok_or_else(|| CommandError::InvalidInput("onaylı revizyon bulunamadı".into()))?;
    if !matches!(revision.get("state").and_then(Value::as_str), Some("APPROVED" | "PR_READY" | "SCHEDULED")) {
        return Err(CommandError::InvalidInput("revizyon yayınlanabilir durumda değil".into()));
    }
    let parity_ready = revision.pointer("/translationParity/status").and_then(Value::as_str).map(|status| status == "MATCHED").unwrap_or(true);
    if !parity_ready {
        return Err(CommandError::InvalidInput("TR/EN doğruluk eşleşmesi tamamlanmadan yazılamaz".into()));
    }
    let claims_ready = revision.get("claims").and_then(Value::as_array).is_some_and(|claims| claims.iter().all(|claim| {
        claim.get("status").and_then(Value::as_str) == Some("VERIFIED")
            && claim.get("evidenceAnchors").and_then(Value::as_array).is_some_and(|anchors| !anchors.is_empty() && anchors.iter().all(|anchor| anchor.get("quoteHash").and_then(Value::as_str).is_some_and(|hash| hash.len() == 64 && hash.chars().all(|value| value.is_ascii_hexdigit()))))
    }));
    if !claims_ready {
        return Err(CommandError::InvalidInput("kaynak kanıtları doğrulanmadan yazılamaz".into()));
    }
    let approved = snapshot.pointer("/snapshot/approvals").and_then(Value::as_array).is_some_and(|items| {
        items.iter().any(|item| item.get("revisionId").and_then(Value::as_str) == Some(revision_id.as_str())
            && item.get("revisionHash").and_then(Value::as_str) == Some(revision_hash.as_str()))
    });
    if !approved {
        return Err(CommandError::InvalidInput("yerel klasöre yazmak için insan onayı gerekir".into()));
    }
    if revision.get("riskLevel").and_then(Value::as_str) == Some("HIGH") {
        let high_risk = snapshot.pointer("/snapshot/highRiskApprovals").and_then(Value::as_array).is_some_and(|items| items.iter().any(|item| item.get("revisionId").and_then(Value::as_str) == Some(revision_id.as_str())));
        if !high_risk {
            return Err(CommandError::InvalidInput("yüksek riskli yazı için ikinci onay gerekir".into()));
        }
    }
    let files = state_value.pointer("/payload/files").and_then(Value::as_array)
        .ok_or_else(|| CommandError::EngineUnavailable("PUBLICATION_FILES_MISSING".into()))?;
    let backup_root = root.join(".blogbot").join("backups").join(&preview_hash[..12]);
    let mut written = 0usize;
    for file in files {
        let relative = file.get("path").and_then(Value::as_str).unwrap_or_default();
        let content = file.get("content").and_then(Value::as_str).unwrap_or_default();
        if relative.is_empty() || relative.contains('\\') || relative.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
            return Err(CommandError::InvalidInput("önizleme içinde güvensiz dosya yolu var".into()));
        }
        let destination = root.join(relative);
        if !destination.starts_with(&root) {
            return Err(CommandError::InvalidInput("dosya yolu hedef klasör dışına çıkıyor".into()));
        }
        // A lexical prefix check is insufficient when an existing parent is
        // a junction/symlink. Refuse every existing ancestor below root.
        let mut ancestor = destination.parent();
        while let Some(path) = ancestor {
            if path == root {
                break;
            }
            if let Ok(metadata) = std::fs::symlink_metadata(path) {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(CommandError::InvalidInput("unsafe destination directory".into()));
                }
            }
            ancestor = path.parent();
        }
        if destination.exists() {
            let metadata = std::fs::symlink_metadata(&destination).map_err(|error| CommandError::InvalidInput(error.to_string()))?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(CommandError::InvalidInput("hedefteki dosya güvenli değil".into()));
            }
            let backup = backup_root.join(relative);
            if let Some(parent) = backup.parent() { std::fs::create_dir_all(parent).map_err(|error| CommandError::InvalidInput(error.to_string()))?; }
            std::fs::copy(&destination, backup).map_err(|error| CommandError::InvalidInput(error.to_string()))?;
        }
        if let Some(parent) = destination.parent() { std::fs::create_dir_all(parent).map_err(|error| CommandError::InvalidInput(error.to_string()))?; }
        let temp = destination.with_extension("blogbot.tmp");
        std::fs::write(&temp, content.as_bytes()).map_err(|error| CommandError::InvalidInput(error.to_string()))?;
        if destination.exists() { std::fs::remove_file(&destination).map_err(|error| CommandError::InvalidInput(error.to_string()))?; }
        std::fs::rename(&temp, &destination).map_err(|error| CommandError::InvalidInput(error.to_string()))?;
        written += 1;
    }
    Ok(json!({"written": written, "targetDirectory": root, "backupDirectory": if written > 0 { Some(backup_root) } else { None::<std::path::PathBuf> }}))
}

#[tauri::command]
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
            if object.get("siteOrigin").and_then(Value::as_str).unwrap_or_default().is_empty() {
                if let Some(origin) = configured_site_origin(&connectors) {
                    object.insert("siteOrigin".into(), Value::String(origin));
                }
            }
            if object.get("targetRepository").and_then(Value::as_str).unwrap_or_default().is_empty() {
                let owner = connectors.pointer("/github/owner").and_then(Value::as_str).unwrap_or_default();
                let repository = connectors.pointer("/github/repository").and_then(Value::as_str).unwrap_or_default();
                if !owner.is_empty() && !repository.is_empty() {
                    object.insert("targetRepository".into(), Value::String(format!("{owner}/{repository}")));
                }
            }
            if object.get("baseBranch").and_then(Value::as_str).unwrap_or_default().is_empty() {
                object.insert("baseBranch".into(), Value::String("main".into()));
            }
            if object.get("contentRoot").and_then(Value::as_str).unwrap_or_default().is_empty() {
                // The publisher's contentRoot is a logical deployment root,
                // not the user's Windows checkout path. Keep it generic and
                // POSIX-safe; the actual site adapter owns its file layout.
                if object.get("siteOrigin").and_then(Value::as_str).is_some()
                    && object.get("targetRepository").and_then(Value::as_str).is_some()
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
        serde_json::to_string(&preview_payload).map_err(|error| CommandError::InvalidInput(error.to_string()))?
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
    let value = response
        .get("value")
        .cloned()
        .ok_or_else(|| CommandError::EngineUnavailable("PUBLICATION_PREVIEW_SHAPE_INVALID".into()))?;
    if value.get("previewHash").and_then(Value::as_str).is_none() {
        return Err(CommandError::EngineUnavailable(
            "PUBLICATION_PREVIEW_HASH_MISSING".into(),
        ));
    }
    Ok(value)
}

#[tauri::command]
pub fn get_operations(
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
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
    for job in jobs.iter().filter(|job| {
        matches!(job.get("state").and_then(Value::as_str), Some("FAILED" | "DEAD_LETTER"))
    }) {
        let id = job.get("id").and_then(Value::as_str).unwrap_or("unknown-job");
        let state = job.get("state").and_then(Value::as_str).unwrap_or("FAILED");
        let detail = sanitize_operation_error(
            job.get("lastError").and_then(Value::as_str).unwrap_or("İş hata durumunda.")
        );
        events.insert(0, json!({
            "id": format!("job-{id}"),
            "at": "şimdi",
            "title": "İş başarısız",
            "detail": format!("{state} · {detail}"),
            "state": "BLOCKED",
            "level": "ERROR",
            "correlationId": id
        }));
    }
    let queue_depth = jobs
        .iter()
        .filter(|job| matches!(job.get("state").and_then(Value::as_str), Some("QUEUED" | "RUNNING" | "RETRY_SCHEDULED" | "WAITING_CODEX")))
        .count();
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i128;
    let oldest_job_minutes = jobs
        .iter()
        .filter(|job| matches!(job.get("state").and_then(Value::as_str), Some("QUEUED" | "RUNNING" | "RETRY_SCHEDULED" | "WAITING_CODEX")))
        .filter_map(|job| job.pointer("/metadata/createdAtUnixMs").and_then(Value::as_u64))
        .map(|created| ((now_ms - created as i128).max(0) / 60_000) as u64)
        .max()
        .unwrap_or(0);
    let outbox_pending = outbox
        .iter()
        .filter(|effect| matches!(effect.get("state").and_then(Value::as_str), Some("PENDING" | "IN_PROGRESS" | "UNKNOWN")))
        .count();
    let persisted_editorial = read_engine_local_state(&bridge, "desktop.editorial")
        .unwrap_or_else(|| json!({}));
    let schedule = persisted_editorial
        .get("schedule")
        .and_then(|value| value.get("slots"))
        .and_then(Value::as_object)
        .map(|slots| slots.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let doctor = bridge.doctor().ok();
    let publisher_capable = doctor
        .as_ref()
        .and_then(|value| value.get("capabilities"))
        .and_then(Value::as_array)
        .map(|capabilities| capabilities.iter().any(|item| item.as_str() == Some("PUBLISH")))
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

#[tauri::command]
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
        "path": path.map(|value| value.to_string_lossy().to_string()),
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
    std::fs::create_dir_all(&root)
        .map_err(|error| CommandError::EngineUnavailable(format!("Tanılama klasörü açılamadı: {error}")))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| CommandError::EngineUnavailable(error.to_string()))?
        .as_secs();
    Ok(root.join(format!("blogbot-diagnostics-{stamp}.json")))
}

fn read_recent_diagnostic_lines(path: Option<&Path>) -> Vec<String> {
    path.and_then(|value| std::fs::read_to_string(value).ok())
        .map(|text| text.lines().rev().take(500).map(redact_diagnostic_line).collect())
        .unwrap_or_default()
}

fn redact_diagnostic_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    let sensitive_markers = [
        "token", "password", "passwd", "secret", "api_key", "apikey",
        "authorization", "bearer", "private_key", "cookie", "credential"
    ];
    if sensitive_markers.iter().any(|marker| lower.contains(marker)) {
        return "[redacted sensitive diagnostic line]".to_string();
    }
    line.chars().take(2_000).collect()
}

#[tauri::command]
pub fn export_diagnostics(
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    let engine_path = bridge.diagnostic_log_path();
    let local_dev_path = local_dev_log_path().ok();
    let operations = get_operations(bridge.clone()).unwrap_or_else(|_| json!({
        "events": [],
        "worker": {"state": "UNKNOWN"},
        "publisher": {"state": "UNKNOWN"}
    }));
    let payload = json!({
        "format": "blogbot-diagnostics-v1",
        "generatedAtUnixMs": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
        "runtime": {
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "engineRunning": bridge.is_running(),
            "bridgeError": bridge.last_error().map(|value| sanitize_operation_error(&value))
        },
        "operations": operations,
        "logs": {
            "engine": {
                "path": engine_path.as_ref().map(|value| value.to_string_lossy().to_string()),
                "lines": read_recent_diagnostic_lines(engine_path.as_deref())
            },
            "localDev": {
                "path": local_dev_path.as_ref().map(|value| value.to_string_lossy().to_string()),
                "lines": read_recent_diagnostic_lines(local_dev_path.as_deref())
            }
        },
        "notice": "Bu paket sır, anahtar, token ve ham kaynak metni içerecek şekilde tasarlanmamıştır."
    });
    let bytes = serde_json::to_vec_pretty(&payload)
        .map_err(|error| CommandError::EngineUnavailable(error.to_string()))?;
    let path = diagnostic_bundle_path()?;
    std::fs::write(&path, &bytes)
        .map_err(|error| CommandError::EngineUnavailable(format!("Tanılama paketi yazılamadı: {error}")))?;
    Ok(json!({
        "path": path.to_string_lossy().to_string(),
        "bytes": bytes.len(),
        "included": ["runtime", "operations", "engine", "local-dev"]
    }))
}

fn sanitize_operation_error(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    let sensitive = [
        "token", "password", "passwd", "secret", "api_key", "apikey",
        "authorization", "bearer", "private_key", "cookie", "credential"
    ];
    if sensitive.iter().any(|marker| lower.contains(marker)) {
        return "İş başarısız oldu; ayrıntı güvenlik nedeniyle gizlendi.".to_string();
    }
    value.chars().take(512).collect()
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

#[tauri::command]
pub fn get_editorial_workspace(
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    let runtime = *read_lock(&state.runtime)?;
    let engine_state = read_engine_state(&bridge).ok();
    let materializations = read_revision_list(&bridge).unwrap_or_default();
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
        .and_then(|value| value.pointer("/snapshot/serverCursor").and_then(Value::as_u64))
        .unwrap_or(0);
    let stale = engine_state.is_none() || !matches!(runtime, RuntimeMode::Online);
    let drafts = revision_queue
        .iter()
        .map(|item| {
            json!({
                "id": item.get("id").cloned().unwrap_or(Value::Null),
                "titleTr": item.get("title").cloned().unwrap_or(Value::Null),
                "titleEn": item.get("title").cloned().unwrap_or(Value::Null),
                "section": item.get("section").cloned().unwrap_or(json!("haberler")),
                "completion": if item.get("state").and_then(Value::as_str) == Some("APPROVED") { 1.0 } else { 0.65 },
                "blockers": item.get("blockers").cloned().unwrap_or(json!(0)),
                "updatedAt": item.get("updatedAt").cloned().unwrap_or(Value::Null),
                "scheduledAt": item.get("updatedAt").cloned().unwrap_or(Value::Null),
                "state": item.get("state").cloned().unwrap_or(json!("REVIEW_REQUIRED"))
            })
        })
        .collect::<Vec<_>>();
    let failures = jobs
        .iter()
        .filter(|job| matches!(job.get("state").and_then(Value::as_str), Some("FAILED" | "DEAD_LETTER")))
        .map(|job| json!({
            "id": job.get("id").cloned().unwrap_or(Value::Null),
            "title": "Yerel iş",
            "jobType": job.get("kind").cloned().unwrap_or(json!("UNKNOWN")),
            "message": job.get("lastError").cloned().unwrap_or(json!("İş başarısız oldu.")),
            "attempts": job.get("attempts").cloned().unwrap_or(json!(0)),
            "lastAttemptAt": Value::Null,
            "retryMode": "SAFE",
            "state": "ACTION_REQUIRED"
        }))
        .collect::<Vec<_>>();
    let codex_depth = jobs
        .iter()
        .filter(|job| matches!(job.get("kind").and_then(Value::as_str), Some("CODEX" | "DRAFT")))
        .filter(|job| matches!(job.get("state").and_then(Value::as_str), Some("QUEUED" | "RUNNING" | "WAITING_CODEX")))
        .count();
    let candidate_values = engine_request(
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
    .unwrap_or_default();
    let persisted_editorial = read_engine_local_state(&bridge, "desktop.editorial")
        .unwrap_or_else(|| json!({}));
    let candidate_mutations = persisted_editorial
        .get("mutations")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| read_local_json_array("editorial-mutations.json"));
    let candidates = candidate_values
        .into_iter()
        .map(|candidate| {
            let id = candidate.get("id").and_then(Value::as_str).unwrap_or_default();
            let state = candidate_mutations.iter().rev().find_map(|mutation| {
                if mutation.get("candidateId").and_then(Value::as_str) != Some(id) { return None; }
                match mutation.get("kind").and_then(Value::as_str) {
                    Some("CANDIDATE.DISMISS") => Some("DISMISSED"),
                    Some("CANDIDATE.PROMOTE") => Some("PROMOTED"),
                    _ => None
                }
            }).unwrap_or("NEW");
            json!({
                "id": candidate.get("id").cloned().unwrap_or(Value::Null),
                "title": candidate.get("title").cloned().unwrap_or(json!("Başlıksız aday")),
                "summary": candidate.get("summary").cloned().unwrap_or(Value::Null),
                "primarySource": candidate.get("primarySource").cloned().unwrap_or(Value::Null),
                "sourceCount": candidate.get("sourceCount").cloned().unwrap_or(json!(1)),
                "section": candidate.get("section").cloned().unwrap_or(json!("haberler")),
                "articleType": candidate.get("articleType").cloned().unwrap_or(json!("news")),
                "confidence": candidate.get("confidence").cloned().unwrap_or(json!(0)),
                "duplicateScore": candidate.get("duplicateScore").cloned().unwrap_or(json!(0)),
                "discoveredAt": candidate.get("discoveredAt").cloned().unwrap_or(Value::Null),
                "state": state
            })
        })
        .collect::<Vec<_>>();
    let health_state = if stale { "OFFLINE" } else { "HEALTHY" };
    // Schedule and preference commands are intentionally local-only until the
    // corresponding engine contracts exist. Rehydrate their durable desktop
    // state so a restart does not make a successful UI mutation appear lost.
    let persisted_schedule = persisted_editorial
        .get("schedule")
        .cloned()
        .or_else(|| read_local_json("schedule.json"));
    let mut weekly_slots = vec![
        json!({ "id": "slot-mon", "dayLabel": "Pazartesi", "time": "10:00", "enabled": true, "articleId": null, "articleTitle": null, "state": "EMPTY" }),
        json!({ "id": "slot-tue", "dayLabel": "Salı", "time": "16:30", "enabled": true, "articleId": null, "articleTitle": null, "state": "EMPTY" }),
        json!({ "id": "slot-wed", "dayLabel": "Çarşamba", "time": "10:00", "enabled": true, "articleId": null, "articleTitle": null, "state": "EMPTY" }),
        json!({ "id": "slot-thu", "dayLabel": "Perşembe", "time": "16:30", "enabled": true, "articleId": null, "articleTitle": null, "state": "EMPTY" }),
        json!({ "id": "slot-fri", "dayLabel": "Cuma", "time": "10:00", "enabled": true, "articleId": null, "articleTitle": null, "state": "EMPTY" }),
        json!({ "id": "slot-sat", "dayLabel": "Cumartesi", "time": "11:00", "enabled": true, "articleId": null, "articleTitle": null, "state": "EMPTY" }),
        json!({ "id": "slot-sun", "dayLabel": "Pazar", "time": "11:00", "enabled": true, "articleId": null, "articleTitle": null, "state": "EMPTY" }),
    ];
    if let Some(saved) = persisted_schedule.as_ref().and_then(Value::as_object) {
        let mut apply_slot = |slot_value: &Value| {
            if let Some(slot_id) = slot_value.get("slotId").and_then(Value::as_str) {
                if let Some(slot) = weekly_slots.iter_mut().find(|slot| slot.get("id").and_then(Value::as_str) == Some(slot_id)) {
                    if let Some(object) = slot.as_object_mut() {
                        if let Some(time) = slot_value.get("time").and_then(Value::as_str) { object.insert("time".into(), json!(time)); }
                        if let Some(enabled) = slot_value.get("enabled").and_then(Value::as_bool) { object.insert("enabled".into(), json!(enabled)); }
                    }
                }
            }
        };
        if let Some(slots) = saved.get("slots").and_then(Value::as_object) {
            for slot_value in slots.values() { apply_slot(slot_value); }
        } else {
            apply_slot(&Value::Object(saved.clone()));
        }
    }
    let preferences = persisted_editorial
        .get("preferences")
        .cloned()
        .or_else(|| read_local_json("preferences.json"))
        .unwrap_or_else(|| json!({
        "author": "Blogbot Editorya",
        "reviewer": "Editör",
        "notifications": true,
        "emailDigest": false,
        "defaultSection": "haberler"
    }));
    let connectors = read_engine_local_state(&bridge, "desktop.connectors")
        .unwrap_or_else(|| json!({}));
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
            "generatedAt": "local-runtime",
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
        "codexRoles": [
            { "role": "FAST", "label": "Sınıflandırma ve tekrar analizi", "state": if codex_depth > 0 { "BUSY" } else { "UNAVAILABLE" }, "queueDepth": codex_depth, "completedToday": 0, "lastSuccessAt": null },
            { "role": "DEFAULT", "label": "Araştırma, Türkçe ve İngilizce", "state": if codex_depth > 0 { "BUSY" } else { "UNAVAILABLE" }, "queueDepth": codex_depth, "completedToday": 0, "lastSuccessAt": null },
            { "role": "DEEP_REVIEW", "label": "Çelişki ve son kalite denetimi", "state": if codex_depth > 0 { "BUSY" } else { "UNAVAILABLE" }, "queueDepth": codex_depth, "completedToday": 0, "lastSuccessAt": null }
        ],
        "preferences": preferences,
        "systemHealth": [
            { "id": "engine", "label": "Yerel engine", "state": health_state, "detail": if stale { "Yerel engine bağlantısı şu anda kullanılamıyor." } else { "Paketlenmiş sidecar stdio üzerinden çalışıyor." }, "checkedAt": "local-runtime" },
            { "id": "pglite", "label": "PGlite ve kalıcı kuyruk", "state": health_state, "detail": if stale { "PGlite durumu engine yeniden bağlanınca doğrulanacak." } else { "Yerel veri ve pg-boss kuyruğu hazır." }, "checkedAt": "local-runtime" },
            { "id": "codex", "label": "Codex çalışma zamanı", "state": "NOT_CONFIGURED", "detail": "Codex hesabı Kurulum Merkezi'nden bağlanmadı.", "checkedAt": "local-runtime" },
            { "id": "github", "label": "GitHub yayıncısı", "state": "NOT_CONFIGURED", "detail": "GitHub bağlantısı yayın akışında ayrıca yetkilendirilir.", "checkedAt": "local-runtime" },
            { "id": "site-adapter", "label": "Site adaptörü", "state": "NOT_CONFIGURED", "detail": "Seçilen site hedefi yayın akışında doğrulanır.", "checkedAt": "local-runtime" }
        ]
    }))
}

#[tauri::command]
pub fn promote_candidate(
    candidate_id: String,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    if candidate_id.trim().is_empty() || candidate_id.len() > 200 || !candidate_id.chars().all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | ':' | '.')) {
        return Err(CommandError::InvalidInput("candidate id is required".into()));
    }
    let version = read_engine_state(&bridge)?
        .pointer("/snapshot/serverCursor")
        .and_then(Value::as_u64)
        .ok_or_else(|| CommandError::EngineUnavailable("STATE_VERSION_MISSING".into()))?;
    let key = stable_source_key(&format!("candidate-draft:{candidate_id}"));
    let draft_id = format!("draft-candidate-{candidate_id}");
    let response = engine_request(&bridge, json!({
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
                "candidateId": candidate_id,
                "sourceIds": [candidate_id],
                "urls": [],
                "instruction": "Bu adayÄ± kaynak kanÄ±tlarÄ±yla araÅŸtÄ±r ve insan incelemesine hazÄ±rla.",
                "section": "haberler",
                "articleType": "news"
            }
        }
    }))?;
    let job = response.pointer("/result/value/backendJob").cloned().unwrap_or(Value::Null);
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

#[tauri::command]
pub fn dismiss_candidate(
    candidate_id: String,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    if candidate_id.trim().is_empty() {
        return Err(CommandError::InvalidInput("candidate id is required".into()));
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

#[tauri::command]
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

#[tauri::command]
pub fn request_revision_edit(
    revision_id: String,
    instruction: String,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    if revision_id.trim().is_empty() || revision_id.len() > 200 || !revision_id.chars().all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | ':' | '.')) || instruction.trim().len() < 3 || instruction.len() > 20_000 {
        return Err(CommandError::InvalidInput("revision id and edit instruction are required".into()));
    }
    let version = read_engine_state(&bridge)?
        .pointer("/snapshot/serverCursor")
        .and_then(Value::as_u64)
        .ok_or_else(|| CommandError::EngineUnavailable("STATE_VERSION_MISSING".into()))?;
    let key = stable_source_key(&format!("revision-edit:{revision_id}:{instruction}"));
    let draft_id = format!("draft-edit-{revision_id}-{}", &key[..12]);
    let response = engine_request(&bridge, json!({
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
                "revisionId": revision_id,
                "sourceIds": [format!("revision:{revision_id}")],
                "urls": [],
                "instruction": instruction,
                "section": "haberler",
                "articleType": "news"
            }
        }
    }))?;
    let job = response.pointer("/result/value/backendJob").cloned().unwrap_or(Value::Null);
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

#[tauri::command]
pub fn update_schedule_slot(
    slot_id: String,
    enabled: bool,
    time: String,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    if !valid_schedule_slot(slot_id.trim()) || !valid_hhmm(time.trim()) {
        return Err(CommandError::InvalidInput("known weekly slot and valid HH:MM time are required".into()));
    }
    let slot_id = slot_id.trim().to_string();
    let time = time.trim().to_string();
    let mutation = json!({
        "kind": "SCHEDULE.SET",
        "slotId": slot_id,
        "enabled": enabled,
        "time": time
    });
    let mut schedule_state = read_engine_local_state(&bridge, "desktop.editorial")
        .unwrap_or_else(|| json!({}));
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
    slots_object
        .as_object_mut()
        .ok_or_else(|| CommandError::EngineUnavailable("SCHEDULE_SLOTS_INVALID".into()))?
        .insert(slot_id.clone(), mutation.clone());
    persist_editorial_state(&bridge, mutation.clone(), Some(("schedule", schedule_state.get("schedule").cloned().unwrap_or_else(|| json!({"slots": {}})))))?;
    persist_local_json("schedule.json", &mutation)?;
    write_lock(&state.editorial_mutations)?.push(mutation);
    Ok(json!({ "ok": true, "slotId": slot_id, "enabled": enabled, "time": time }))
}

#[tauri::command]
pub fn save_desktop_preferences(
    preferences: Value,
    state: tauri::State<'_, DesktopState>,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    ensure_mutation_allowed(&state)?;
    if !preferences.is_object() {
        return Err(CommandError::InvalidInput("desktop preferences must be an object".into()));
    }
    let mutation = json!({ "kind": "PREFERENCES.SET", "preferences": preferences });
    persist_editorial_state(&bridge, mutation, Some(("preferences", preferences.clone())))?;
    persist_local_json("preferences.json", &preferences)?;
    *write_lock(&state.preferences)? = preferences.clone();
    Ok(json!({ "ok": true, "preferences": preferences }))
}

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
pub fn secure_store_status(app: tauri::AppHandle) -> secure_store::SecureStoreStatus {
    secure_store::status(&app)
}

#[tauri::command]
pub fn send_test_notification(app: tauri::AppHandle) -> Result<Value, CommandError> {
    notifications::show_review_ready(&app, "Bildirimler doğru çalışıyor.")
        .map_err(CommandError::InvalidInput)?;
    Ok(json!({ "shown": true }))
}

#[tauri::command]
pub fn autostart_status(app: tauri::AppHandle) -> Result<Value, CommandError> {
    let enabled = app
        .autolaunch()
        .is_enabled()
        .map_err(|error| CommandError::InvalidInput(error.to_string()))?;
    Ok(json!({ "enabled": enabled }))
}

#[tauri::command]
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

#[tauri::command]
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
        return Err(CommandError::InvalidInput("backup source, output, recovery key, and bounded file list are required".into()));
    }
    engine_request(&bridge, json!({
        "version": 1,
        "id": format!("desktop-backup-create-{}", std::process::id()),
        "kind": "backup.create",
        "payload": {
            "sourceDirectory": source_directory,
            "relativePaths": relative_paths,
            "outputPath": output_path,
            "recoveryKey": recovery_key
        }
    }))
}

#[tauri::command]
pub fn backup_verify(
    archive_path: String,
    recovery_key: String,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    if archive_path.trim().is_empty() || !valid_recovery_key(&recovery_key) {
        return Err(CommandError::InvalidInput("archive path and recovery key are required".into()));
    }
    engine_request(&bridge, json!({
        "version": 1,
        "id": format!("desktop-backup-verify-{}", std::process::id()),
        "kind": "backup.verify",
        "payload": { "archivePath": archive_path, "recoveryKey": recovery_key }
    }))
}

#[tauri::command]
pub fn backup_restore_preview(
    archive_path: String,
    target_directory: String,
    recovery_key: String,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    if archive_path.trim().is_empty() || target_directory.trim().is_empty() || !valid_recovery_key(&recovery_key) {
        return Err(CommandError::InvalidInput(
            "archive path, target directory, and recovery key are required".into(),
        ));
    }
    engine_request(&bridge, json!({
        "version": 1,
        "id": format!("desktop-backup-preview-{}", std::process::id()),
        "kind": "backup.restore.preview",
        "payload": {
            "archivePath": archive_path,
            "targetDirectory": target_directory,
            "recoveryKey": recovery_key
        }
    }))
}

#[tauri::command]
pub fn backup_restore_apply(
    archive_path: String,
    target_directory: String,
    recovery_key: String,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<Value, CommandError> {
    if archive_path.trim().is_empty() || target_directory.trim().is_empty() || !valid_recovery_key(&recovery_key) {
        return Err(CommandError::InvalidInput(
            "archive path, target directory, and recovery key are required".into(),
        ));
    }
    engine_request(&bridge, json!({
        "version": 1,
        "id": format!("desktop-backup-restore-{}", std::process::id()),
        "kind": "backup.restore",
        "payload": { "archivePath": archive_path, "targetDirectory": target_directory, "recoveryKey": recovery_key }
    }))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        build_approval_command, build_high_risk_approval_command, build_review_revision, build_revision_queue, build_source_scan_command,
        configured_site_origin, ensure_mutation_allowed, github_preview_payload, is_local_path, publication_observability, valid_github_segment, valid_github_workflow, valid_site_work_mode, valid_hhmm, valid_recovery_key, valid_schedule_slot, validate_folder_selection, validate_local_dev_project, write_lock, CommandError, DesktopState, RuntimeMode,
    };

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
        assert!(!valid_schedule_slot("slot-any"));
        assert!(valid_hhmm("23:59"));
        assert!(!valid_hhmm("99:99"));
        assert!(!valid_hhmm("ab:cd"));
        assert!(!valid_recovery_key("short"));
        assert!(!valid_recovery_key("                "));
        assert!(valid_recovery_key("correct horse 2026"));
    }

    #[test]
    fn native_folder_selection_accepts_only_absolute_windows_paths() {
        assert!(validate_folder_selection(r"C:\Users\editor\site").is_ok());
        assert!(validate_folder_selection("https://example.com/site").is_err());
        assert!(validate_folder_selection(r"C:relative\site").is_err());
        assert!(validate_folder_selection("C:\\unsafe\"quote").is_err());
    }

    #[test]
    fn site_work_mode_is_explicit_and_limited_to_three_choices() {
        assert!(valid_site_work_mode("LOCAL_ONLY"));
        assert!(valid_site_work_mode("LOCAL_DEV"));
        assert!(validate_local_dev_project("relative-project").is_err());
        assert!(valid_site_work_mode("PUBLISH"));
        assert!(!valid_site_work_mode("HETZNER"));
    }

    #[test]
    fn github_bridge_contracts_are_local_only_and_scope_safe() {
        assert!(valid_github_workflow("deploy.yml"));
        assert!(!valid_github_workflow("../deploy.yml"));
        assert!(github_preview_payload("owner/site", "deploy.yml", "rev-1", &"a".repeat(64)).is_ok());
        assert!(github_preview_payload("owner/site", "deploy.yml", "rev-1", "secret").is_err());
    }

    #[test]
    fn publication_observability_never_marks_missing_intent_ready() {
        assert_eq!(publication_observability(None), ("NOT_STARTED", "BLOCKED"));
        assert_eq!(publication_observability(Some("PENDING")), ("NOT_STARTED", "BLOCKED"));
        assert_eq!(publication_observability(Some("IN_PROGRESS")), ("RUNNING", "PUBLISHING"));
        assert_eq!(publication_observability(Some("FAILED")), ("FAILED", "BLOCKED"));
        assert_eq!(publication_observability(Some("SUCCEEDED")), ("PASSED", "READY"));
    }

    #[test]
    fn generic_site_origin_precedes_legacy_adapter_storage() {
        assert_eq!(
            configured_site_origin(&json!({
                "site": { "publicSiteUrl": "https://example.org/" },
                "siberdergi": { "publicSiteUrl": "https://siberdergi.net/" }
            })),
            Some("https://example.org".to_string())
        );
        assert_eq!(
            configured_site_origin(&json!({
                "siberdergi": { "publicSiteUrl": "https://legacy.example/" }
            })),
            Some("https://legacy.example".to_string())
        );
    }

    #[test]
    fn high_risk_approval_command_binds_both_hashes_and_exact_utc_time() {
        let command = build_high_risk_approval_command(
            "revision-high-risk",
            &"a".repeat(64),
            &"b".repeat(64),
            4,
        ).expect("high-risk command");
        assert_eq!(command["kind"], "APPROVAL.GRANT_HIGH_RISK");
        assert_eq!(command["payload"]["revisionHash"], "a".repeat(64));
        assert_eq!(command["payload"]["riskChecklistHash"], "b".repeat(64));
        assert!(command["payload"]["windowsReauthenticatedAt"].as_str().unwrap().ends_with('Z'));
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

        assert_eq!(urls, vec![
            "https://example.com/feed.xml".to_string(),
            "https://example.org".to_string(),
            "https://example.org/atom.xml".to_string()
        ]);
    }

    #[test]
    fn operation_error_details_are_redacted_and_bounded() {
        assert!(super::sanitize_operation_error("Authorization: Bearer abc")
            .contains("güvenlik nedeniyle"));
        assert_eq!(super::sanitize_operation_error(&"x".repeat(600)).chars().count(), 512);
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
        assert_eq!(review["gates"][3]["id"], "high-risk-approval");
        assert_eq!(review["gates"][3]["state"], "BLOCK");

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
        assert_eq!(review["gates"][3]["state"], "PASS");
    }

    #[test]
    fn approval_command_is_exact_hash_and_version_bound() {
        let command = build_approval_command("revision-1", &"a".repeat(64), 7)
            .expect("approval command");
        assert_eq!(command["kind"], "APPROVAL.GRANT");
        assert_eq!(command["expectedVersion"], 7);
        assert_eq!(command["payload"]["revisionId"], "revision-1");
        assert_eq!(command["payload"]["revisionHash"], "a".repeat(64));
        assert_eq!(
            command["payload"]["deviceId"],
            "windows-local-device-v1"
        );
    }
}
