use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::github_publication::{
    reconcile, ApprovedClaim, FileContent, PublicationConfig,
    PublicationBundlePolicy as ApprovedBundlePolicy,
    PublicationFile as NativePublicationFile,
};
use crate::github_rest_adapter::GithubRestAdapter;
use crate::secure_store;

const DEVICE_CODE_ENDPOINT: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_ENDPOINT: &str = "https://github.com/login/oauth/access_token";
const USER_ENDPOINT: &str = "https://api.github.com/user";
const DEVICE_VERIFICATION_URI: &str = "https://github.com/login/device";
const OAUTH_SCOPE: &str = "repo";
const MAX_DEVICE_CODE_LEN: usize = 256;
const MAX_USER_CODE_LEN: usize = 32;
const MAX_DEVICE_EXPIRY_SECONDS: u64 = 86_400;
const MIN_POLL_INTERVAL_SECONDS: u64 = 5;
const MAX_POLL_INTERVAL_SECONDS: u64 = 60;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFlowResult {
    pub status: &'static str,
    pub writes: bool,
    pub network: bool,
    pub detail: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_uri: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_in: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scopes: Option<Vec<String>>,
}

impl DeviceFlowResult {
    fn state(status: &'static str, network: bool, detail: &'static str) -> Self {
        Self {
            status,
            writes: false,
            network,
            detail,
            user_code: None,
            verification_uri: None,
            expires_in: None,
            interval: None,
            scopes: None,
        }
    }

    fn pending(user_code: &str, expires_in: u64, interval: u64) -> Self {
        Self {
            status: "pending",
            writes: false,
            network: true,
            detail: "GitHub doğrulaması kullanıcı onayı bekliyor.",
            user_code: Some(user_code.into()),
            verification_uri: Some(DEVICE_VERIFICATION_URI),
            expires_in: Some(expires_in),
            interval: Some(interval),
            scopes: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct DeviceAuthorizationWire {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Debug, Clone)]
pub struct DeviceAuthorization {
    device_code: String,
    user_code: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Debug, Clone)]
pub enum TokenPoll {
    Authorized(String),
    Pending,
    SlowDown,
    Expired,
    AccessDenied,
}

pub trait GitHubAuthTransport: Send + Sync {
    fn request_device_code(&self, client_id: &str) -> Result<Value, String>;
    fn poll_access_token(&self, client_id: &str, device_code: &str) -> Result<TokenPoll, String>;
    fn validate_token(&self, token: &str) -> Result<String, String>;
}

pub trait GitHubTokenStore: Send + Sync {
    fn load(&self, path: &Path) -> Result<Vec<u8>, String>;
    fn store(&self, path: &Path, token: &[u8]) -> Result<(), String>;
    fn clear(&self, path: &Path) -> Result<(), String>;
}

trait Clock: Send + Sync {
    fn now(&self) -> u64;
}
struct SystemClock;
impl Clock for SystemClock {
    fn now(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }
}

struct DpapiTokenStore;
impl GitHubTokenStore for DpapiTokenStore {
    fn load(&self, path: &Path) -> Result<Vec<u8>, String> {
        secure_store::load_github_token_at(path)
    }
    fn store(&self, path: &Path, token: &[u8]) -> Result<(), String> {
        secure_store::store_github_token_at(path, token)
    }
    fn clear(&self, path: &Path) -> Result<(), String> {
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("GITHUB_TOKEN_CLEAR_FAILED".into()),
        }
    }
}

struct ReqwestGitHubAuthTransport {
    http: reqwest::blocking::Client,
}
impl ReqwestGitHubAuthTransport {
    fn new() -> Self {
        Self {
            http: reqwest::blocking::Client::builder()
                .user_agent("Blogbot/0.1")
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("static reqwest client configuration"),
        }
    }
    fn post_form(&self, endpoint: &str, form: &[(&str, &str)]) -> Result<Value, String> {
        self.http
            .post(endpoint)
            .header("Accept", "application/json")
            .form(form)
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .and_then(reqwest::blocking::Response::json)
            .map_err(|_| "GITHUB_AUTH_NETWORK_FAILED".into())
    }
}
impl GitHubAuthTransport for ReqwestGitHubAuthTransport {
    fn request_device_code(&self, client_id: &str) -> Result<Value, String> {
        self.post_form(
            DEVICE_CODE_ENDPOINT,
            &[("client_id", client_id), ("scope", OAUTH_SCOPE)],
        )
    }
    fn poll_access_token(&self, client_id: &str, device_code: &str) -> Result<TokenPoll, String> {
        let value = self.post_form(
            ACCESS_TOKEN_ENDPOINT,
            &[
                ("client_id", client_id),
                ("device_code", device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ],
        )?;
        if let Some(token) = value.get("access_token").and_then(Value::as_str) {
            return Ok(TokenPoll::Authorized(token.into()));
        }
        match value.get("error").and_then(Value::as_str) {
            Some("authorization_pending") => Ok(TokenPoll::Pending),
            Some("slow_down") => Ok(TokenPoll::SlowDown),
            Some("expired_token") => Ok(TokenPoll::Expired),
            Some("access_denied") => Ok(TokenPoll::AccessDenied),
            _ => Err("GITHUB_TOKEN_RESPONSE_INVALID".into()),
        }
    }
    fn validate_token(&self, token: &str) -> Result<String, String> {
        let response = self
            .http
            .get(USER_ENDPOINT)
            .bearer_auth(token)
            .header("Accept", "application/vnd.github+json")
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|_| "GITHUB_TOKEN_VALIDATION_FAILED".to_string())?;
        response
            .headers()
            .get("x-oauth-scopes")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
            .ok_or_else(|| "GITHUB_TOKEN_SCOPES_MISSING".into())
    }
}

struct PendingAuthorization {
    client_id: String,
    device_code: String,
    expires_at: u64,
    next_poll_at: u64,
    interval: u64,
}

pub struct GitHubBroker {
    transport: Arc<dyn GitHubAuthTransport>,
    store: Arc<dyn GitHubTokenStore>,
    clock: Arc<dyn Clock>,
    pending: Mutex<Option<PendingAuthorization>>,
}

pub fn validate_client_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if (8..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        Ok(value.into())
    } else {
        Err("GITHUB_CLIENT_ID_INVALID".into())
    }
}

fn has_repo_scope(scopes: &str) -> bool {
    scopes.split(',').any(|scope| scope.trim() == OAUTH_SCOPE)
}

fn parse_device_authorization(endpoint: &str, value: Value) -> Result<DeviceAuthorization, String> {
    if endpoint != DEVICE_CODE_ENDPOINT {
        return Err("GITHUB_DEVICE_ORIGIN_INVALID".into());
    }
    let wire: DeviceAuthorizationWire =
        serde_json::from_value(value).map_err(|_| "GITHUB_DEVICE_RESPONSE_INVALID".to_string())?;
    if wire.device_code.is_empty()
        || wire.device_code.len() > MAX_DEVICE_CODE_LEN
        || wire.user_code.is_empty()
        || wire.user_code.len() > MAX_USER_CODE_LEN
        || wire.verification_uri != DEVICE_VERIFICATION_URI
        || !(1..=MAX_DEVICE_EXPIRY_SECONDS).contains(&wire.expires_in)
        || !(MIN_POLL_INTERVAL_SECONDS..=MAX_POLL_INTERVAL_SECONDS).contains(&wire.interval)
    {
        return Err("GITHUB_DEVICE_RESPONSE_INVALID".into());
    }
    Ok(DeviceAuthorization {
        device_code: wire.device_code,
        user_code: wire.user_code,
        expires_in: wire.expires_in,
        interval: wire.interval,
    })
}

pub enum PublicationEffectOutcome {
    Succeeded {
        result_ref: String,
    },
    Waiting {
        result_ref: String,
        last_error: Option<String>,
        retry_after_ms: u64,
    },
}

pub trait PublicationBrokerEffects {
    fn execute(&self, command: &Value) -> Result<PublicationEffectOutcome, String>;
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaimedPublication {
    effect_id: String,
    claim_attempt: u64,
    idempotency_key: String,
    revision_id: String,
    revision_hash: String,
    target_repository: String,
    base_branch: String,
    expected_base_sha: String,
    approved_files_sha: String,
    #[serde(default)]
    prior_result_ref: Option<String>,
    required_checks: Vec<String>,
    deploy_workflow: String,
    adapter_version: String,
    bundle_policy: PublicationBundlePolicy,
    files: Vec<PublicationFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublicationBundlePolicy {
    adapter_id: String,
    manifest_path: String,
    allowed_path_prefixes: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PublicationFile {
    path: String,
    content: PublicationContent,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum PublicationContent {
    Text(String),
    Binary(Base64PublicationContent),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Base64PublicationContent {
    base64: String,
}

impl PublicationContent {
    fn len(&self) -> usize {
        match self {
            Self::Text(value) => value.len(),
            Self::Binary(value) => (value.base64.len() / 4).saturating_mul(3),
        }
    }
}

fn valid_identifier(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
}

fn valid_repo(value: &str) -> bool {
    let mut parts = value.split('/');
    matches!((parts.next(), parts.next(), parts.next()), (Some(owner), Some(repo), None)
        if valid_identifier(owner, 100) && !owner.contains('/') && valid_identifier(repo, 100) && !repo.contains('/'))
}

fn valid_sha(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_publication_path(value: &str) -> bool {
    value.len() <= 240
        && !value.starts_with('/')
        && !value.contains('\\')
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn validate_claim(claim: &ClaimedPublication) -> bool {
    valid_identifier(&claim.effect_id, 128)
        && claim.claim_attempt > 0
        && valid_identifier(&claim.idempotency_key, 200)
        && valid_repo(&claim.target_repository)
        && valid_identifier(&claim.revision_id, 128)
        && valid_sha64(&claim.revision_hash)
        && valid_identifier(&claim.base_branch, 200)
        && !claim.base_branch.contains("..")
        && valid_sha(&claim.expected_base_sha)
        && valid_sha64(&claim.approved_files_sha)
        && claim
            .prior_result_ref
            .as_ref()
            .map_or(true, |value| value.len() <= 512)
        && !claim.required_checks.is_empty()
        && claim.required_checks.len() <= 32
        && claim
            .required_checks
            .iter()
            .all(|value| !value.trim().is_empty() && value.len() <= 200)
        && !claim.deploy_workflow.is_empty()
        && claim.deploy_workflow.len() <= 100
        && valid_adapter_identity(&claim.adapter_version, &claim.bundle_policy.adapter_id)
        && valid_publication_path(&claim.bundle_policy.manifest_path)
        && !claim.bundle_policy.allowed_path_prefixes.is_empty()
        && claim.bundle_policy.allowed_path_prefixes.len() <= 256
        && claim
            .bundle_policy
            .allowed_path_prefixes
            .iter()
            .all(|path| valid_publication_path(path))
        && !claim.files.is_empty()
        && claim.files.len() <= 100
        && claim
            .files
            .iter()
            .all(|file| valid_publication_path(&file.path) && file.content.len() <= 10_000_000)
}

fn valid_adapter_identity(value: &str, adapter_id: &str) -> bool {
    valid_identifier(adapter_id, 100)
        && value.len() <= 200
        && value
            .strip_prefix(adapter_id)
            .and_then(|suffix| suffix.strip_prefix('@'))
            .is_some_and(|version| !version.trim().is_empty() && version.len() <= 100)
}

fn valid_sha64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn approved_head_from_result_ref(value: &str) -> Result<Option<String>, String> {
    if value.starts_with("deploy:") {
        return Ok(None);
    }
    let mut parts = value.split(':');
    let valid = matches!(
        (parts.next(), parts.next(), parts.next(), parts.next()),
        (Some("pr"), Some(number), Some(sha), None)
            if number.parse::<u64>().is_ok() && valid_sha(sha)
    );
    if !valid {
        return Err("PUBLICATION_BROKER_PRIOR_RESULT_INVALID".into());
    }
    Ok(value.rsplit(':').next().map(str::to_string))
}

/// Drives one approved effect through a deliberately narrow protocol. The
/// claim contains immutable publication material but no credential; only the
/// native effects implementation can access authorization and remote GitHub.
pub fn drive_publication_broker<F, E>(
    effect_id: &str,
    mut engine_request: F,
    effects: &E,
) -> Result<Value, String>
where
    F: FnMut(Value) -> Result<Value, String>,
    E: PublicationBrokerEffects,
{
    let claim_response = engine_request(json!({
        "version": 1,
        "id": format!("native-claim-{effect_id}"),
        "kind": "publication.broker.claim",
        "effectId": effect_id
    }))?;
    if claim_response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err("PUBLICATION_BROKER_CLAIM_FAILED".into());
    }
    let command = claim_response
        .get("value")
        .cloned()
        .ok_or_else(|| "PUBLICATION_BROKER_CLAIM_SHAPE_INVALID".to_string())?;
    let claim: ClaimedPublication = serde_json::from_value(command.clone())
        .map_err(|_| "PUBLICATION_BROKER_CLAIM_SHAPE_INVALID".to_string())?;
    if !validate_claim(&claim) {
        return Err("PUBLICATION_BROKER_CLAIM_SHAPE_INVALID".into());
    }
    if claim.effect_id != effect_id {
        return Err("PUBLICATION_BROKER_EFFECT_MISMATCH".into());
    }
    let completion_request = match effects.execute(&command) {
        Ok(PublicationEffectOutcome::Succeeded { result_ref }) => json!({
            "version": 1,
            "id": format!("native-complete-{effect_id}"),
            "kind": "publication.broker.complete",
            "effectId": effect_id,
            "claimAttempt": claim.claim_attempt,
            "state": "SUCCEEDED",
            "resultRef": result_ref
        }),
        Ok(PublicationEffectOutcome::Waiting {
            result_ref,
            last_error,
            retry_after_ms,
        }) => json!({
            "version": 1,
            "id": format!("native-complete-{effect_id}"),
            "kind": "publication.broker.complete",
            "effectId": effect_id,
            "claimAttempt": claim.claim_attempt,
            "state": "UNKNOWN",
            "resultRef": result_ref,
            "lastError": last_error,
            "retryAfterMs": retry_after_ms
        }),
        Err(_) => json!({
            "version": 1,
            "id": format!("native-complete-{effect_id}"),
            "kind": "publication.broker.complete",
            "effectId": effect_id,
            "claimAttempt": claim.claim_attempt,
            "state": "FAILED",
            "lastError": "GITHUB_PUBLICATION_FAILED"
        }),
    };
    let completion = engine_request(completion_request)?;
    if completion.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err("PUBLICATION_BROKER_COMPLETE_FAILED".into());
    }
    completion
        .get("value")
        .cloned()
        .ok_or_else(|| "PUBLICATION_BROKER_COMPLETE_SHAPE_INVALID".to_string())
}

impl GitHubBroker {
    pub fn new() -> Self {
        Self {
            transport: Arc::new(ReqwestGitHubAuthTransport::new()),
            store: Arc::new(DpapiTokenStore),
            clock: Arc::new(SystemClock),
            pending: Mutex::new(None),
        }
    }

    #[cfg(test)]
    fn with_parts(
        transport: Arc<dyn GitHubAuthTransport>,
        store: Arc<dyn GitHubTokenStore>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            transport,
            store,
            clock,
            pending: Mutex::new(None),
        }
    }

    pub fn status(&self, token_path: Option<&Path>) -> DeviceFlowResult {
        if token_path.is_some_and(|path| self.store.load(path).is_ok()) {
            let mut result = DeviceFlowResult::state(
                "authorized",
                false,
                "GitHub tokenı yerel DPAPI deposunda kullanılabilir.",
            );
            result.scopes = Some(vec![OAUTH_SCOPE.into()]);
            return result;
        }
        if self.pending.lock().is_ok_and(|pending| pending.is_some()) {
            return DeviceFlowResult::state(
                "pending",
                false,
                "GitHub doğrulaması kullanıcı onayı bekliyor.",
            );
        }
        DeviceFlowResult::state("logged-out", false, "GitHub yetkilendirmesi başlatılmadı.")
    }

    pub fn begin_device_authorization(&self, client_id: &str) -> Result<DeviceFlowResult, String> {
        let client_id = validate_client_id(client_id)?;
        let authorization = parse_device_authorization(
            DEVICE_CODE_ENDPOINT,
            self.transport.request_device_code(&client_id)?,
        )?;
        let now = self.clock.now();
        let result = DeviceFlowResult::pending(
            &authorization.user_code,
            authorization.expires_in,
            authorization.interval,
        );
        *self
            .pending
            .lock()
            .map_err(|_| "GITHUB_AUTH_STATE_UNAVAILABLE")? = Some(PendingAuthorization {
            client_id,
            device_code: authorization.device_code,
            expires_at: now.saturating_add(authorization.expires_in),
            next_poll_at: now.saturating_add(authorization.interval),
            interval: authorization.interval,
        });
        Ok(result)
    }

    pub fn poll_device_authorization(&self, token_path: &Path) -> Result<DeviceFlowResult, String> {
        let now = self.clock.now();
        let mut guard = self
            .pending
            .lock()
            .map_err(|_| "GITHUB_AUTH_STATE_UNAVAILABLE")?;
        let pending = guard.as_mut().ok_or("GITHUB_DEVICE_FLOW_NOT_PENDING")?;
        if now >= pending.expires_at {
            *guard = None;
            return Ok(DeviceFlowResult::state(
                "expired",
                false,
                "GitHub cihaz kodunun süresi doldu.",
            ));
        }
        if now < pending.next_poll_at {
            return Err("GITHUB_DEVICE_POLL_TOO_EARLY".into());
        }
        let outcome = self
            .transport
            .poll_access_token(&pending.client_id, &pending.device_code)?;
        match outcome {
            TokenPoll::Pending => {
                pending.next_poll_at = now.saturating_add(pending.interval);
                Ok(DeviceFlowResult::state(
                    "pending",
                    true,
                    "GitHub doğrulaması kullanıcı onayı bekliyor.",
                ))
            }
            TokenPoll::SlowDown => {
                pending.interval = pending
                    .interval
                    .saturating_add(5)
                    .min(MAX_POLL_INTERVAL_SECONDS);
                pending.next_poll_at = now.saturating_add(pending.interval);
                Ok(DeviceFlowResult::state(
                    "pending",
                    true,
                    "GitHub daha yavaş sorgulama istedi.",
                ))
            }
            TokenPoll::Expired => {
                *guard = None;
                Ok(DeviceFlowResult::state(
                    "expired",
                    true,
                    "GitHub cihaz kodunun süresi doldu.",
                ))
            }
            TokenPoll::AccessDenied => {
                *guard = None;
                Ok(DeviceFlowResult::state(
                    "access-denied",
                    true,
                    "GitHub yetkilendirmesi reddedildi.",
                ))
            }
            TokenPoll::Authorized(token) => {
                if token.is_empty() || token.len() > 1024 {
                    *guard = None;
                    return Err("GITHUB_TOKEN_INVALID".into());
                }
                let scopes = self.transport.validate_token(&token)?;
                if !has_repo_scope(&scopes) {
                    *guard = None;
                    return Err("GITHUB_REPO_SCOPE_REQUIRED".into());
                }
                self.store.store(token_path, token.as_bytes())?;
                *guard = None;
                let mut result = DeviceFlowResult::state(
                    "authorized",
                    true,
                    "GitHub yetkilendirmesi doğrulandı ve DPAPI ile saklandı.",
                );
                result.scopes = Some(
                    scopes
                        .split(',')
                        .map(|scope| scope.trim().to_string())
                        .filter(|scope| !scope.is_empty())
                        .collect(),
                );
                Ok(result)
            }
        }
    }

    pub fn clear_authorization(&self, token_path: &Path) -> Result<DeviceFlowResult, String> {
        self.store.clear(token_path)?;
        *self
            .pending
            .lock()
            .map_err(|_| "GITHUB_AUTH_STATE_UNAVAILABLE")? = None;
        Ok(DeviceFlowResult::state(
            "logged-out",
            false,
            "GitHub yetkilendirmesi temizlendi.",
        ))
    }

    pub fn publication_effects<'a>(&'a self, token_path: &'a Path) -> NativePublicationEffects<'a> {
        NativePublicationEffects {
            store: self.store.as_ref(),
            token_path,
        }
    }

    pub fn publication_ready(&self, token_path: &Path) -> bool {
        self.store.load(token_path).is_ok()
    }
}

pub struct NativePublicationEffects<'a> {
    store: &'a dyn GitHubTokenStore,
    token_path: &'a Path,
}

impl PublicationBrokerEffects for NativePublicationEffects<'_> {
    fn execute(&self, command: &Value) -> Result<PublicationEffectOutcome, String> {
        let claim: ClaimedPublication = serde_json::from_value(command.clone())
            .map_err(|_| "PUBLICATION_BROKER_CLAIM_SHAPE_INVALID".to_string())?;
        if !validate_claim(&claim) {
            return Err("PUBLICATION_BROKER_CLAIM_SHAPE_INVALID".into());
        }
        let mut token_bytes = self.store.load(self.token_path)?;
        let token = String::from_utf8(token_bytes.clone()).map_err(|_| {
            token_bytes.fill(0);
            "GITHUB_TOKEN_INVALID".to_string()
        })?;
        token_bytes.fill(0);
        let mut github = GithubRestAdapter::new(token)?;
        let approved_head_sha = match claim.prior_result_ref.as_deref() {
            Some(value) => approved_head_from_result_ref(value)?,
            None => None,
        };
        let approved = ApprovedClaim {
            repository: claim.target_repository,
            base_branch: claim.base_branch,
            approved_base_sha: claim.expected_base_sha,
            approved_revision_hash: claim.revision_hash,
            approved_files_sha: claim.approved_files_sha,
            approved_head_sha,
            revision_id: claim.revision_id,
            idempotency_key: claim.idempotency_key,
            adapter_version: claim.adapter_version,
            bundle_policy: ApprovedBundlePolicy {
                adapter_id: claim.bundle_policy.adapter_id,
                manifest_path: claim.bundle_policy.manifest_path,
                allowed_path_prefixes: claim.bundle_policy.allowed_path_prefixes,
            },
            files: claim
                .files
                .into_iter()
                .map(|file| {
                    let content = match file.content {
                        PublicationContent::Text(value) => FileContent::Text(value),
                        PublicationContent::Binary(value) => {
                            if value.base64.len() > 14_000_000 {
                                return Err("PUBLICATION_FILE_TOO_LARGE".to_string());
                            }
                            use base64::Engine as _;
                            FileContent::Bytes(
                                base64::engine::general_purpose::STANDARD
                                    .decode(&value.base64)
                                    .map_err(|_| "PUBLICATION_FILE_CONTENT_INVALID".to_string())?,
                            )
                        }
                    };
                    Ok(NativePublicationFile {
                        path: file.path,
                        content,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?,
        };
        let config = PublicationConfig {
            required_checks: claim.required_checks,
            deploy_workflow: claim.deploy_workflow,
        };
        let result =
            reconcile(&approved, &config, &mut github).map_err(|error| error.code.to_string())?;
        if result.status == "SUCCEEDED" {
            Ok(PublicationEffectOutcome::Succeeded {
                result_ref: result.result_ref,
            })
        } else {
            Ok(PublicationEffectOutcome::Waiting {
                result_ref: result.result_ref,
                last_error: result.last_error,
                retry_after_ms: u64::from(result.retry_after_seconds) * 1_000,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    use serde_json::json;

    use super::{
        drive_publication_broker, GitHubBroker, PublicationBrokerEffects, PublicationEffectOutcome,
    };

    struct FakeEffects {
        commands: RefCell<Vec<serde_json::Value>>,
    }

    impl PublicationBrokerEffects for FakeEffects {
        fn execute(&self, command: &serde_json::Value) -> Result<PublicationEffectOutcome, String> {
            self.commands.borrow_mut().push(command.clone());
            Ok(PublicationEffectOutcome::Succeeded {
                result_ref: "merge:abc123".into(),
            })
        }
    }

    #[test]
    fn approved_enqueue_progresses_across_the_credential_free_native_boundary() {
        let effects = FakeEffects {
            commands: RefCell::new(Vec::new()),
        };
        let mut requests = Vec::new();
        let result = drive_publication_broker(
            "effect-1",
            |request| {
                requests.push(request.clone());
                match request["kind"].as_str() {
                    Some("publication.broker.claim") => Ok(json!({
                        "ok": true,
                        "value": {
                            "effectId": "effect-1",
                            "claimAttempt": 1,
                            "idempotencyKey": "publish:revision-1",
                            "revisionId": "revision-1",
                            "revisionHash": "b".repeat(64),
                            "targetRepository": "owner/site",
                            "baseBranch": "main",
                            "expectedBaseSha": "a".repeat(40),
                            "approvedFilesSha": "c".repeat(64),
                            "requiredChecks": ["ci/test"],
                            "deployWorkflow": "deploy.yml",
                            "adapterVersion": "astro-generic@2.0.0",
                            "bundlePolicy": {
                                "adapterId": "astro-generic",
                                "manifestPath": ".blogbot/manifests/revision-1.json",
                                "allowedPathPrefixes": [
                                    "content/tr/story.md",
                                    "public/image.bin",
                                    ".blogbot/manifests/revision-1.json"
                                ]
                            },
                            "files": [
                                { "path": "content/tr/story.md", "content": "metin" },
                                { "path": "public/image.bin", "content": { "base64": "AAH/" } }
                            ]
                        }
                    })),
                    Some("publication.broker.complete") => {
                        Ok(json!({ "ok": true, "value": { "state": "SUCCEEDED" } }))
                    }
                    _ => Err("unexpected request".into()),
                }
            },
            &effects,
        )
        .expect("fake native publication should complete");

        assert_eq!(result["state"], "SUCCEEDED");
        assert_eq!(effects.commands.borrow().len(), 1);
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[1]["resultRef"], "merge:abc123");
        assert!(requests
            .iter()
            .all(|request| request.get("token").is_none()));
    }

    #[test]
    fn malformed_publication_claim_is_rejected_before_effects() {
        let effects = FakeEffects {
            commands: RefCell::new(Vec::new()),
        };
        let result = drive_publication_broker(
            "effect-1",
            |request| match request["kind"].as_str() {
                Some("publication.broker.claim") => Ok(json!({"ok":true,"value":{
                    "effectId":"effect-1", "idempotencyKey":"publish:revision-1",
                    "targetRepository":"owner/site", "baseBranch":"main",
                    "expectedBaseSha":"short", "files":[{"path":"../secret","content":"x"}]
                }})),
                _ => Err("unexpected".into()),
            },
            &effects,
        );
        assert_eq!(
            result.unwrap_err(),
            "PUBLICATION_BROKER_CLAIM_SHAPE_INVALID"
        );
        assert!(effects.commands.borrow().is_empty());
    }

    #[test]
    fn waiting_effect_is_reconciled_as_retryable_unknown() {
        struct Waiting;
        impl PublicationBrokerEffects for Waiting {
            fn execute(
                &self,
                _command: &serde_json::Value,
            ) -> Result<PublicationEffectOutcome, String> {
                Ok(PublicationEffectOutcome::Waiting {
                    result_ref: "pr:17".into(),
                    last_error: Some("GITHUB_REQUIRED_CHECKS_PENDING".into()),
                    retry_after_ms: 30_000,
                })
            }
        }
        let mut requests = Vec::new();
        let result = drive_publication_broker(
            "effect-1",
            |request| {
                requests.push(request.clone());
                match request["kind"].as_str() {
                    Some("publication.broker.claim") => Ok(valid_claim()),
                    Some("publication.broker.complete") => {
                        Ok(json!({"ok":true,"value":{"state":"UNKNOWN"}}))
                    }
                    _ => Err("unexpected".into()),
                }
            },
            &Waiting,
        )
        .expect("waiting state should be durably reconciled");
        assert_eq!(result["state"], "UNKNOWN");
        assert_eq!(requests[1]["state"], "UNKNOWN");
        assert_eq!(requests[1]["resultRef"], "pr:17");
        assert_eq!(requests[1]["retryAfterMs"], 30_000);
    }

    #[test]
    fn effect_failure_is_reconciled_with_safe_error_only() {
        struct Failing;
        impl PublicationBrokerEffects for Failing {
            fn execute(
                &self,
                _command: &serde_json::Value,
            ) -> Result<PublicationEffectOutcome, String> {
                Err("token ghp_super_secret network exploded".into())
            }
        }
        let mut requests = Vec::new();
        let result = drive_publication_broker(
            "effect-1",
            |request| {
                requests.push(request.clone());
                match request["kind"].as_str() {
                    Some("publication.broker.claim") => Ok(valid_claim()),
                    Some("publication.broker.complete") => {
                        Ok(json!({"ok":true,"value":{"state":"FAILED"}}))
                    }
                    _ => Err("unexpected".into()),
                }
            },
            &Failing,
        )
        .expect("failure should be durably reconciled");
        assert_eq!(result["state"], "FAILED");
        assert_eq!(requests[1]["state"], "FAILED");
        assert_eq!(requests[1]["lastError"], "GITHUB_PUBLICATION_FAILED");
        assert!(!requests[1].to_string().contains("ghp_super_secret"));
    }

    fn valid_claim() -> serde_json::Value {
        json!({"ok":true,"value":{
            "effectId":"effect-1", "idempotencyKey":"publish:revision-1",
            "claimAttempt":1,
            "revisionId":"revision-1", "revisionHash":"b".repeat(64),
            "targetRepository":"owner/site", "baseBranch":"main",
            "expectedBaseSha":"a".repeat(40),
            "approvedFilesSha":"c".repeat(64), "requiredChecks":["ci/test"],
            "deployWorkflow":"deploy.yml",
            "adapterVersion":"astro-generic@2.0.0",
            "bundlePolicy":{"adapterId":"astro-generic","manifestPath":".blogbot/manifests/revision-1.json","allowedPathPrefixes":["content/tr/story.md",".blogbot/manifests/revision-1.json"]},
            "files":[{"path":"content/tr/story.md","content":"metin"}]
        }})
    }

    #[test]
    fn device_response_is_origin_scope_and_bounds_checked() {
        let valid = super::parse_device_authorization(
            "https://github.com/login/device/code",
            json!({
                "device_code": "device-code-123",
                "user_code": "ABCD-EFGH",
                "verification_uri": "https://github.com/login/device",
                "expires_in": 900,
                "interval": 5
            }),
        )
        .expect("valid GitHub device response");
        assert_eq!(valid.user_code, "ABCD-EFGH");
        assert_eq!(valid.device_code, "device-code-123");
        assert_eq!(valid.expires_in, 900);
        assert_eq!(valid.interval, 5);
        assert!(super::parse_device_authorization(
            "https://github.example/login/device/code",
            json!({"device_code":"x","user_code":"A","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5})
        ).is_err());
        assert!(super::parse_device_authorization(
            "https://github.com/login/device/code",
            json!({"device_code":"x","user_code":"A","verification_uri":"https://evil.example/device","expires_in":900,"interval":5})
        ).is_err());
        assert!(super::parse_device_authorization(
            "https://github.com/login/device/code",
            json!({"device_code":"x","user_code":"A","verification_uri":"https://github.com/login/device","expires_in":86_401,"interval":5})
        ).is_err());
    }

    #[test]
    fn unconfigured_broker_never_claims_network_or_write_access() {
        let state = GitHubBroker::new().status(None);
        assert_eq!(state.status, "logged-out");
        assert!(!state.network);
        assert!(!state.writes);
    }

    #[test]
    fn client_id_validation_is_strict_and_public_only() {
        assert!(super::validate_client_id("Iv1.0123456789abcdef").is_ok());
        assert!(super::validate_client_id("").is_err());
        assert!(super::validate_client_id("client id").is_err());
        assert!(super::validate_client_id("abc&client_secret=oops").is_err());
    }

    #[test]
    fn device_flow_response_projection_never_serializes_native_secrets() {
        let response = super::DeviceFlowResult::pending("ABCD-EFGH", 900, 5);
        let value = serde_json::to_value(response).expect("serialize safe projection");
        assert_eq!(value["userCode"], "ABCD-EFGH");
        assert_eq!(value["verificationUri"], "https://github.com/login/device");
        assert!(value.get("deviceCode").is_none());
        assert!(value.get("token").is_none());
    }

    #[test]
    fn token_scope_parser_requires_repo_scope() {
        assert!(super::has_repo_scope("repo, workflow"));
        assert!(!super::has_repo_scope("public_repo, workflow"));
        assert!(!super::has_repo_scope("repository"));
    }

    struct FakeClock(AtomicU64);
    impl super::Clock for FakeClock {
        fn now(&self) -> u64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    struct FakeTransport {
        polls: Mutex<VecDeque<super::TokenPoll>>,
        validated: Mutex<Vec<String>>,
    }
    impl super::GitHubAuthTransport for FakeTransport {
        fn request_device_code(&self, client_id: &str) -> Result<serde_json::Value, String> {
            assert_eq!(client_id, "Iv1.0123456789abcdef");
            Ok(
                json!({"device_code":"native-only-device-code","user_code":"ABCD-EFGH","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}),
            )
        }
        fn poll_access_token(
            &self,
            client_id: &str,
            device_code: &str,
        ) -> Result<super::TokenPoll, String> {
            assert_eq!(client_id, "Iv1.0123456789abcdef");
            assert_eq!(device_code, "native-only-device-code");
            self.polls
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| "unexpected poll".into())
        }
        fn validate_token(&self, token: &str) -> Result<String, String> {
            self.validated.lock().unwrap().push(token.into());
            Ok("repo, workflow".into())
        }
    }

    #[derive(Default)]
    struct FakeStore(Mutex<Option<Vec<u8>>>);
    impl super::GitHubTokenStore for FakeStore {
        fn load(&self, _path: &std::path::Path) -> Result<Vec<u8>, String> {
            self.0
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| "absent".into())
        }
        fn store(&self, _path: &std::path::Path, token: &[u8]) -> Result<(), String> {
            *self.0.lock().unwrap() = Some(token.to_vec());
            Ok(())
        }
        fn clear(&self, _path: &std::path::Path) -> Result<(), String> {
            *self.0.lock().unwrap() = None;
            Ok(())
        }
    }

    #[test]
    fn explicit_poll_enforces_interval_validates_repo_scope_and_stores_token() {
        let clock = Arc::new(FakeClock(AtomicU64::new(100)));
        let transport = Arc::new(FakeTransport {
            polls: Mutex::new(VecDeque::from([
                super::TokenPoll::Pending,
                super::TokenPoll::Authorized("native-token".into()),
            ])),
            validated: Mutex::new(Vec::new()),
        });
        let store = Arc::new(FakeStore::default());
        let broker = GitHubBroker::with_parts(transport.clone(), store.clone(), clock.clone());
        let begin = broker
            .begin_device_authorization("Iv1.0123456789abcdef")
            .unwrap();
        assert_eq!(begin.user_code.as_deref(), Some("ABCD-EFGH"));
        assert_eq!(
            broker
                .poll_device_authorization(std::path::Path::new("ignored"))
                .unwrap_err(),
            "GITHUB_DEVICE_POLL_TOO_EARLY"
        );
        clock.0.store(105, Ordering::SeqCst);
        assert_eq!(
            broker
                .poll_device_authorization(std::path::Path::new("ignored"))
                .unwrap()
                .status,
            "pending"
        );
        clock.0.store(110, Ordering::SeqCst);
        let authorized = broker
            .poll_device_authorization(std::path::Path::new("ignored"))
            .unwrap();
        assert_eq!(authorized.status, "authorized");
        assert_eq!(
            store.0.lock().unwrap().as_deref(),
            Some(b"native-token".as_slice())
        );
        assert_eq!(
            transport.validated.lock().unwrap().as_slice(),
            ["native-token"]
        );
    }
}
