use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::github_publication::{
    reconcile, ApprovedClaim, FileContent, GithubRestPort,
    PublicationBundlePolicy as ApprovedBundlePolicy, PublicationConfig, PublicationError,
    PublicationFile as NativePublicationFile, RETRY_AFTER_SECONDS,
};
use crate::github_rest_adapter::GithubRestAdapter;
use crate::secure_store;

const DEVICE_CODE_ENDPOINT: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_ENDPOINT: &str = "https://github.com/login/oauth/access_token";
const API_ROOT: &str = "https://api.github.com";
const DEVICE_VERIFICATION_URI: &str = "https://github.com/login/device";
const GITHUB_ACCEPT: &str = "application/vnd.github+json";
const GITHUB_API_VERSION: &str = "2022-11-28";
const MAX_AUTH_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_DEVICE_CODE_LEN: usize = 256;
const MAX_USER_CODE_LEN: usize = 32;
const MAX_DEVICE_EXPIRY_SECONDS: u64 = 86_400;
const MIN_POLL_INTERVAL_SECONDS: u64 = 5;
const MAX_POLL_INTERVAL_SECONDS: u64 = 60;
const MIN_ACCESS_TOKEN_EXPIRY_SECONDS: u64 = 60;
const MAX_ACCESS_TOKEN_EXPIRY_SECONDS: u64 = 86_400;
const MAX_REFRESH_TOKEN_EXPIRY_SECONDS: u64 = 34_560_000;
const TOKEN_REFRESH_MARGIN_SECONDS: u64 = 300;
const INSTALLATION_PAGE_SIZE: usize = 100;
const MAX_INSTALLATION_PAGES: u32 = 20;
const REQUIRED_REPOSITORY_PERMISSIONS: [(&str, &str); 6] = [
    ("actions", "write"),
    ("administration", "read"),
    ("checks", "read"),
    ("contents", "write"),
    ("metadata", "read"),
    ("pull_requests", "write"),
];

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
    pub repository: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<Vec<String>>,
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
            repository: None,
            permissions: None,
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
            repository: None,
            permissions: None,
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

struct TokenGrant {
    access_token: secure_store::SecretBytes,
    refresh_token: secure_store::SecretBytes,
    access_expires_in: u64,
    refresh_expires_in: u64,
}

impl std::fmt::Debug for TokenGrant {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TokenGrant")
            .field("access_token", &"[REDACTED]")
            .field("refresh_token", &"[REDACTED]")
            .field("access_expires_in", &self.access_expires_in)
            .field("refresh_expires_in", &self.refresh_expires_in)
            .finish()
    }
}

enum TokenPoll {
    Authorized(TokenGrant),
    Pending,
    SlowDown,
    Expired,
    AccessDenied,
}

trait GitHubAuthTransport: Send + Sync {
    fn request_device_code(&self, client_id: &str) -> Result<Value, String>;
    fn poll_access_token(&self, client_id: &str, device_code: &str) -> Result<TokenPoll, String>;
    fn refresh_access_token(
        &self,
        client_id: &str,
        refresh_token: &str,
    ) -> Result<TokenGrant, String>;
    fn validate_token(&self, token: &str, repository: &str) -> Result<Vec<String>, String>;
}

trait GitHubTokenStore: Send + Sync {
    fn load(&self, path: &Path) -> Result<secure_store::GithubAppCredentials, String>;
    fn store(
        &self,
        path: &Path,
        credentials: &secure_store::GithubAppCredentials,
    ) -> Result<(), String>;
    fn authorization_state(
        &self,
        path: &Path,
    ) -> Result<secure_store::GithubAuthorizationState, String>;
    fn store_authorization_state(
        &self,
        path: &Path,
        state: secure_store::GithubAuthorizationState,
    ) -> Result<(), String>;
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
    fn load(&self, path: &Path) -> Result<secure_store::GithubAppCredentials, String> {
        secure_store::load_github_app_credentials_at(path)
    }

    fn store(
        &self,
        path: &Path,
        credentials: &secure_store::GithubAppCredentials,
    ) -> Result<(), String> {
        secure_store::store_github_app_credentials_at(path, credentials)
    }

    fn authorization_state(
        &self,
        path: &Path,
    ) -> Result<secure_store::GithubAuthorizationState, String> {
        secure_store::load_github_authorization_state_at(path)
    }

    fn store_authorization_state(
        &self,
        path: &Path,
        state: secure_store::GithubAuthorizationState,
    ) -> Result<(), String> {
        secure_store::store_github_authorization_state_at(path, state)
    }

    fn clear(&self, path: &Path) -> Result<(), String> {
        let token_result = match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("GITHUB_TOKEN_CLEAR_FAILED".into()),
        };
        let state_result = secure_store::clear_github_authorization_state_at(path);
        token_result.and(state_result)
    }
}

fn load_authorized_credentials(
    store: &dyn GitHubTokenStore,
    token_path: &Path,
) -> Result<secure_store::GithubAppCredentials, String> {
    if !matches!(
        store.authorization_state(token_path),
        Ok(secure_store::GithubAuthorizationState::Validated)
    ) {
        return Err("GITHUB_REAUTHORIZATION_REQUIRED".into());
    }
    store
        .load(token_path)
        .map_err(|_| "GITHUB_REAUTHORIZATION_REQUIRED".to_string())
}

fn authorization_ready(store: &dyn GitHubTokenStore, token_path: &Path, now: u64) -> bool {
    load_authorized_credentials(store, token_path)
        .is_ok_and(|credentials| credentials.refresh_expires_at > now)
}

fn authorization_ready_for_repository(
    store: &dyn GitHubTokenStore,
    token_path: &Path,
    repository: &str,
    now: u64,
) -> bool {
    load_authorized_credentials(store, token_path).is_ok_and(|credentials| {
        credentials.repository.eq_ignore_ascii_case(repository)
            && credentials.refresh_expires_at > now
    })
}

fn latch_reauthorization_required(
    store: &dyn GitHubTokenStore,
    token_path: &Path,
) -> Result<(), String> {
    if store
        .store_authorization_state(
            token_path,
            secure_store::GithubAuthorizationState::ReauthorizationRequired,
        )
        .is_ok()
    {
        return Ok(());
    }
    let _ = store.clear(token_path);
    Err("GITHUB_AUTHORIZATION_STATE_STORE_FAILED".into())
}

fn auth_error_requires_reauthorization(error: &str) -> bool {
    matches!(
        error,
        "GITHUB_REAUTHORIZATION_REQUIRED"
            | "GITHUB_APP_TOKEN_EXPIRATION_REQUIRED"
            | "GITHUB_CLASSIC_OAUTH_SCOPE_REJECTED"
            | "GITHUB_APP_PERMISSION_POLICY_MISMATCH"
            | "GITHUB_APP_REPOSITORY_SELECTION_REQUIRED"
            | "GITHUB_APP_SINGLE_REPOSITORY_REQUIRED"
            | "GITHUB_APP_REPOSITORY_ACCESS_REQUIRED"
            | "GITHUB_APP_CREDENTIALS_INVALID"
            | "GITHUB_TOKEN_RESPONSE_INVALID"
    )
}

fn revalidate_repository_binding(
    transport: &dyn GitHubAuthTransport,
    store: &dyn GitHubTokenStore,
    token_path: &Path,
    access_token: &str,
    repository: &str,
) -> Result<(), String> {
    match transport.validate_token(access_token, repository) {
        Ok(_) => Ok(()),
        Err(error) if auth_error_requires_reauthorization(&error) => {
            latch_reauthorization_required(store, token_path)?;
            Err("GITHUB_REAUTHORIZATION_REQUIRED".into())
        }
        Err(error) => Err(error),
    }
}

fn device_authorization_form(client_id: &str) -> Vec<(&'static str, &str)> {
    vec![("client_id", client_id)]
}

fn parse_github_app_token_grant(mut value: Value) -> Result<TokenGrant, String> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| "GITHUB_TOKEN_RESPONSE_INVALID".to_string())?;
    let access_expires_in = object.get("expires_in").and_then(Value::as_u64);
    let refresh_expires_in = object
        .get("refresh_token_expires_in")
        .and_then(Value::as_u64);
    let refresh_token = object
        .remove("refresh_token")
        .and_then(|value| value.as_str().map(str::to_owned));
    if access_expires_in.is_none() || refresh_expires_in.is_none() || refresh_token.is_none() {
        return Err("GITHUB_APP_TOKEN_EXPIRATION_REQUIRED".into());
    }
    let scope = match object.get("scope") {
        None => "",
        Some(Value::String(scope)) => scope.trim(),
        Some(_) => return Err("GITHUB_TOKEN_RESPONSE_INVALID".into()),
    };
    if !scope.is_empty() {
        return Err("GITHUB_CLASSIC_OAUTH_SCOPE_REJECTED".into());
    }
    if object.get("token_type").and_then(Value::as_str) != Some("bearer") {
        return Err("GITHUB_TOKEN_RESPONSE_INVALID".into());
    }
    let access_expires_in = access_expires_in.unwrap_or_default();
    let refresh_expires_in = refresh_expires_in.unwrap_or_default();
    if !(MIN_ACCESS_TOKEN_EXPIRY_SECONDS..=MAX_ACCESS_TOKEN_EXPIRY_SECONDS)
        .contains(&access_expires_in)
        || refresh_expires_in <= access_expires_in
        || refresh_expires_in > MAX_REFRESH_TOKEN_EXPIRY_SECONDS
    {
        return Err("GITHUB_APP_TOKEN_EXPIRATION_REQUIRED".into());
    }
    let access_token = object
        .remove("access_token")
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| "GITHUB_TOKEN_RESPONSE_INVALID".to_string())?;
    Ok(TokenGrant {
        access_token: secure_store::SecretBytes::new(access_token.into_bytes())
            .map_err(|_| "GITHUB_TOKEN_RESPONSE_INVALID")?,
        refresh_token: secure_store::SecretBytes::new(
            refresh_token.unwrap_or_default().into_bytes(),
        )
        .map_err(|_| "GITHUB_TOKEN_RESPONSE_INVALID")?,
        access_expires_in,
        refresh_expires_in,
    })
}

fn validate_github_app_installation(
    installation: &Value,
    repositories: &Value,
    repository: &str,
) -> Result<Vec<String>, String> {
    if installation
        .get("repository_selection")
        .and_then(Value::as_str)
        != Some("selected")
    {
        return Err("GITHUB_APP_REPOSITORY_SELECTION_REQUIRED".into());
    }
    let permissions = installation
        .get("permissions")
        .and_then(Value::as_object)
        .ok_or("GITHUB_APP_PERMISSION_POLICY_MISMATCH")?;
    if permissions.len() != REQUIRED_REPOSITORY_PERMISSIONS.len()
        || REQUIRED_REPOSITORY_PERMISSIONS
            .iter()
            .any(|(name, level)| permissions.get(*name).and_then(Value::as_str) != Some(*level))
    {
        return Err("GITHUB_APP_PERMISSION_POLICY_MISMATCH".into());
    }
    if repositories.get("total_count").and_then(Value::as_u64) != Some(1) {
        return Err("GITHUB_APP_SINGLE_REPOSITORY_REQUIRED".into());
    }
    let repository_values = repositories
        .get("repositories")
        .and_then(Value::as_array)
        .ok_or("GITHUB_APP_REPOSITORY_ACCESS_REQUIRED")?;
    if repository_values.len() != 1
        || !repository_values.iter().any(|value| {
            value
                .get("full_name")
                .and_then(Value::as_str)
                .is_some_and(|name| name.eq_ignore_ascii_case(repository))
        })
    {
        return Err("GITHUB_APP_REPOSITORY_ACCESS_REQUIRED".into());
    }
    Ok(REQUIRED_REPOSITORY_PERMISSIONS
        .iter()
        .map(|(name, level)| format!("{name}:{level}"))
        .collect())
}

fn credentials_from_grant(
    grant: TokenGrant,
    client_id: &str,
    repository: &str,
    now: u64,
) -> Result<secure_store::GithubAppCredentials, String> {
    let access_expires_at = now
        .checked_add(grant.access_expires_in)
        .ok_or("GITHUB_APP_CREDENTIALS_INVALID")?;
    let refresh_expires_at = now
        .checked_add(grant.refresh_expires_in)
        .ok_or("GITHUB_APP_CREDENTIALS_INVALID")?;
    secure_store::GithubAppCredentials::new(
        client_id.to_string(),
        repository.to_string(),
        grant.access_token,
        grant.refresh_token,
        access_expires_at,
        refresh_expires_at,
    )
}
struct ReqwestGitHubAuthTransport {
    http: reqwest::blocking::Client,
    api_root: String,
}

impl ReqwestGitHubAuthTransport {
    fn http_client() -> reqwest::blocking::Client {
        reqwest::blocking::Client::builder()
            .user_agent("Blogbot/0.1")
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("static reqwest client configuration")
    }

    fn new() -> Self {
        Self {
            http: Self::http_client(),
            api_root: API_ROOT.to_string(),
        }
    }

    #[cfg(test)]
    fn for_test_api_root(api_root: &str) -> Self {
        Self {
            http: Self::http_client(),
            api_root: api_root.trim_end_matches('/').to_string(),
        }
    }

    fn read_json(
        response: reqwest::blocking::Response,
        invalid_code: &'static str,
    ) -> Result<Value, String> {
        let mut bytes = Vec::new();
        response
            .take(MAX_AUTH_RESPONSE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| invalid_code.to_string())?;
        if bytes.len() > MAX_AUTH_RESPONSE_BYTES {
            return Err(invalid_code.into());
        }
        serde_json::from_slice(&bytes).map_err(|_| invalid_code.into())
    }

    fn post_form(&self, endpoint: &str, form: &[(&str, &str)]) -> Result<Value, String> {
        let response = self
            .http
            .post(endpoint)
            .header("Accept", "application/json")
            .form(form)
            .send()
            .map_err(|_| "GITHUB_AUTH_NETWORK_FAILED".to_string())?;
        if !response.status().is_success() {
            return Err("GITHUB_AUTH_NETWORK_FAILED".into());
        }
        Self::read_json(response, "GITHUB_TOKEN_RESPONSE_INVALID")
    }

    fn api_json(
        &self,
        path_and_query: &str,
        token: &str,
        accepted: &[u16],
    ) -> Result<(u16, Value), String> {
        if !path_and_query.starts_with('/') {
            return Err("GITHUB_TOKEN_VALIDATION_FAILED".into());
        }
        let response = self
            .http
            .get(format!("{}{path_and_query}", self.api_root))
            .bearer_auth(token)
            .header("Accept", GITHUB_ACCEPT)
            .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
            .send()
            .map_err(|_| "GITHUB_TOKEN_VALIDATION_FAILED".to_string())?;
        let status = response.status().as_u16();
        if matches!(status, 401 | 403) {
            return Err("GITHUB_REAUTHORIZATION_REQUIRED".into());
        }
        if !accepted.contains(&status) {
            return Err("GITHUB_TOKEN_VALIDATION_FAILED".into());
        }
        if !response.status().is_success() {
            return Ok((status, Value::Null));
        }
        Ok((
            status,
            Self::read_json(response, "GITHUB_TOKEN_VALIDATION_FAILED")?,
        ))
    }
}

impl GitHubAuthTransport for ReqwestGitHubAuthTransport {
    fn request_device_code(&self, client_id: &str) -> Result<Value, String> {
        self.post_form(DEVICE_CODE_ENDPOINT, &device_authorization_form(client_id))
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
        if value.get("access_token").is_some() {
            return parse_github_app_token_grant(value).map(TokenPoll::Authorized);
        }
        match value.get("error").and_then(Value::as_str) {
            Some("authorization_pending") => Ok(TokenPoll::Pending),
            Some("slow_down") => Ok(TokenPoll::SlowDown),
            Some("expired_token") => Ok(TokenPoll::Expired),
            Some("access_denied") => Ok(TokenPoll::AccessDenied),
            _ => Err("GITHUB_TOKEN_RESPONSE_INVALID".into()),
        }
    }

    fn refresh_access_token(
        &self,
        client_id: &str,
        refresh_token: &str,
    ) -> Result<TokenGrant, String> {
        let value = self.post_form(
            ACCESS_TOKEN_ENDPOINT,
            &[
                ("client_id", client_id),
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token),
            ],
        )?;
        if value.get("access_token").is_some() {
            return parse_github_app_token_grant(value);
        }
        match value.get("error").and_then(Value::as_str) {
            Some("bad_refresh_token")
            | Some("incorrect_client_credentials")
            | Some("incorrect_client_id") => Err("GITHUB_REAUTHORIZATION_REQUIRED".into()),
            _ => Err("GITHUB_TOKEN_RESPONSE_INVALID".into()),
        }
    }

    fn validate_token(&self, token: &str, repository: &str) -> Result<Vec<String>, String> {
        if !valid_repository_name(repository) {
            return Err("GITHUB_APP_REPOSITORY_ACCESS_REQUIRED".into());
        }
        let (repository_status, repository_value) =
            self.api_json(&format!("/repos/{repository}"), token, &[200, 301, 404])?;
        if matches!(repository_status, 301 | 404) {
            return Err("GITHUB_APP_REPOSITORY_ACCESS_REQUIRED".into());
        }
        let repository_id = repository_value
            .get("id")
            .and_then(Value::as_u64)
            .filter(|id| *id > 0)
            .ok_or("GITHUB_TOKEN_VALIDATION_FAILED")?;

        for page in 1..=MAX_INSTALLATION_PAGES {
            let (_, value) = self.api_json(
                &format!("/user/installations?per_page={INSTALLATION_PAGE_SIZE}&page={page}"),
                token,
                &[200],
            )?;
            let installations = value
                .get("installations")
                .and_then(Value::as_array)
                .ok_or("GITHUB_TOKEN_VALIDATION_FAILED")?;
            for installation in installations {
                let installation_id = installation
                    .get("id")
                    .and_then(Value::as_u64)
                    .filter(|id| *id > 0)
                    .ok_or("GITHUB_TOKEN_VALIDATION_FAILED")?;
                let (status, repositories) = self.api_json(
                    &format!("/user/installations/{installation_id}/repositories?per_page=2"),
                    token,
                    &[200, 404],
                )?;
                if status == 404 {
                    continue;
                }
                let selected = repositories
                    .get("repositories")
                    .and_then(Value::as_array)
                    .ok_or("GITHUB_TOKEN_VALIDATION_FAILED")?;
                if !selected.iter().any(|entry| {
                    entry.get("id").and_then(Value::as_u64) == Some(repository_id)
                        && entry
                            .get("full_name")
                            .and_then(Value::as_str)
                            .is_some_and(|name| name.eq_ignore_ascii_case(repository))
                }) {
                    continue;
                }
                return validate_github_app_installation(installation, &repositories, repository);
            }
            if installations.len() < INSTALLATION_PAGE_SIZE {
                return Err("GITHUB_APP_REPOSITORY_ACCESS_REQUIRED".into());
            }
        }
        Err("GITHUB_TOKEN_VALIDATION_FAILED".into())
    }
}
struct PendingAuthorization {
    client_id: String,
    repository: String,
    device_code: String,
    grant: Option<TokenGrant>,
    grant_issued_at: Option<u64>,
    expires_at: u64,
    next_poll_at: u64,
    interval: u64,
}

pub struct GitHubBroker {
    transport: Arc<dyn GitHubAuthTransport>,
    store: Arc<dyn GitHubTokenStore>,
    clock: Arc<dyn Clock>,
    pending: Mutex<Option<PendingAuthorization>>,
    credential_lock: Mutex<()>,
}

pub fn validate_client_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if (8..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        Ok(value.into())
    } else {
        Err("GITHUB_CLIENT_ID_INVALID".into())
    }
}

fn valid_repository_name(value: &str) -> bool {
    secure_store::valid_github_repository_name(value)
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

fn load_fresh_authorized_token(
    transport: &dyn GitHubAuthTransport,
    store: &dyn GitHubTokenStore,
    clock: &dyn Clock,
    token_path: &Path,
    repository: &str,
) -> Result<secure_store::SecretBytes, String> {
    let now = clock.now();
    let credentials = match load_authorized_credentials(store, token_path) {
        Ok(credentials) => credentials,
        Err(error) => {
            latch_reauthorization_required(store, token_path)?;
            return Err(error);
        }
    };
    if !credentials.repository.eq_ignore_ascii_case(repository)
        || credentials.refresh_expires_at <= now.saturating_add(TOKEN_REFRESH_MARGIN_SECONDS)
    {
        latch_reauthorization_required(store, token_path)?;
        return Err("GITHUB_REAUTHORIZATION_REQUIRED".into());
    }
    if credentials.access_expires_at > now.saturating_add(TOKEN_REFRESH_MARGIN_SECONDS) {
        revalidate_repository_binding(
            transport,
            store,
            token_path,
            credentials.access_token.expose_str(),
            repository,
        )?;
        return Ok(credentials.access_token);
    }

    let client_id = credentials.client_id;
    let refresh_token = credentials.refresh_token;
    let grant = match transport.refresh_access_token(&client_id, refresh_token.expose_str()) {
        Ok(grant) => grant,
        Err(error) if auth_error_requires_reauthorization(&error) => {
            latch_reauthorization_required(store, token_path)?;
            return Err("GITHUB_REAUTHORIZATION_REQUIRED".into());
        }
        Err(error) => return Err(error),
    };
    let rotated = match credentials_from_grant(grant, &client_id, repository, now) {
        Ok(credentials) => credentials,
        Err(_) => {
            latch_reauthorization_required(store, token_path)?;
            return Err("GITHUB_REAUTHORIZATION_REQUIRED".into());
        }
    };
    // GitHub invalidates the refresh token as soon as it is exchanged. Persist
    // the replacement pair before remote policy revalidation so a transient
    // repository outage cannot strand the client with the consumed pair.
    // Fresh access tokens are still revalidated before they are returned.
    store.store(token_path, &rotated)?;
    if let Err(error) = store.store_authorization_state(
        token_path,
        secure_store::GithubAuthorizationState::Validated,
    ) {
        let _ = store.clear(token_path);
        return Err(error);
    }
    revalidate_repository_binding(
        transport,
        store,
        token_path,
        rotated.access_token.expose_str(),
        repository,
    )?;
    Ok(rotated.access_token)
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

fn repository_matches_trusted(claimed: &str, trusted: &str) -> bool {
    valid_repo(trusted) && claimed.eq_ignore_ascii_case(trusted)
}
fn valid_repo(value: &str) -> bool {
    secure_store::valid_github_repository_name(value)
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
        && secure_store::valid_github_branch_name(&claim.base_branch)
        && valid_sha(&claim.expected_base_sha)
        && valid_sha64(&claim.approved_files_sha)
        && claim
            .prior_result_ref
            .as_ref()
            .is_none_or(|value| value.len() <= 512)
        && !claim.required_checks.is_empty()
        && claim.required_checks.len() <= 32
        && claim
            .required_checks
            .iter()
            .all(|value| !value.trim().is_empty() && value.len() <= 200)
        && secure_store::valid_github_workflow_name(&claim.deploy_workflow)
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
        Err(error) if error == "GITHUB_REAUTHORIZATION_REQUIRED" => json!({
            "version": 1,
            "id": format!("native-complete-{effect_id}"),
            "kind": "publication.broker.complete",
            "effectId": effect_id,
            "claimAttempt": claim.claim_attempt,
            "state": "UNKNOWN",
            "lastError": "GITHUB_REAUTHORIZATION_REQUIRED",
            "retryAfterMs": u64::from(RETRY_AFTER_SECONDS) * 1_000
        }),
        Err(error)
            if matches!(
                error.as_str(),
                "GITHUB_AUTH_NETWORK_FAILED" | "GITHUB_TOKEN_VALIDATION_FAILED"
            ) =>
        {
            json!({
                "version": 1,
                "id": format!("native-complete-{effect_id}"),
                "kind": "publication.broker.complete",
                "effectId": effect_id,
                "claimAttempt": claim.claim_attempt,
                "state": "UNKNOWN",
                "lastError": error,
                "retryAfterMs": u64::from(RETRY_AFTER_SECONDS) * 1_000
            })
        }
        Err(error) if error == "REQUIRED_CHECK_FAILED" => json!({
            "version": 1,
            "id": format!("native-complete-{effect_id}"),
            "kind": "publication.broker.complete",
            "effectId": effect_id,
            "claimAttempt": claim.claim_attempt,
            "state": "FAILED",
            "lastError": "REQUIRED_CHECK_FAILED"
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
            credential_lock: Mutex::new(()),
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
            credential_lock: Mutex::new(()),
        }
    }

    pub fn status(&self, token_path: Option<&Path>) -> DeviceFlowResult {
        if token_path
            .is_some_and(|path| authorization_ready(self.store.as_ref(), path, self.clock.now()))
        {
            let mut result = DeviceFlowResult::state(
                "authorized",
                false,
                "GitHub tokenı yerel DPAPI deposunda kullanılabilir.",
            );
            if let Some(path) = token_path {
                if let Ok(credentials) = load_authorized_credentials(self.store.as_ref(), path) {
                    result.repository = Some(credentials.repository);
                }
            }
            result.permissions = Some(
                REQUIRED_REPOSITORY_PERMISSIONS
                    .iter()
                    .map(|(name, level)| format!("{name}:{level}"))
                    .collect(),
            );
            return result;
        }
        if token_path.is_some_and(|path| {
            matches!(
                self.store.authorization_state(path),
                Ok(secure_store::GithubAuthorizationState::ReauthorizationRequired)
            )
        }) {
            return DeviceFlowResult::state(
                "reauthorization-required",
                false,
                "GitHub yetkilendirmesi yenilenmeden yayın yapılamaz.",
            );
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

    pub fn begin_device_authorization(
        &self,
        client_id: &str,
        repository: &str,
    ) -> Result<DeviceFlowResult, String> {
        let client_id = validate_client_id(client_id)?;
        if !valid_repository_name(repository) {
            return Err("GITHUB_APP_REPOSITORY_ACCESS_REQUIRED".into());
        }
        let repository = repository.to_ascii_lowercase();
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
            repository,
            device_code: authorization.device_code,
            grant: None,
            grant_issued_at: None,
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
        let grant_issued_at = pending.grant_issued_at.unwrap_or(now);
        let outcome = if let Some(grant) = pending.grant.take() {
            TokenPoll::Authorized(grant)
        } else {
            match self
                .transport
                .poll_access_token(&pending.client_id, &pending.device_code)
            {
                Ok(outcome) => outcome,
                Err(error) if auth_error_requires_reauthorization(&error) => {
                    *guard = None;
                    latch_reauthorization_required(self.store.as_ref(), token_path)?;
                    return Err("GITHUB_REAUTHORIZATION_REQUIRED".into());
                }
                Err(error) => {
                    pending.next_poll_at = now.saturating_add(pending.interval);
                    return Err(error);
                }
            }
        };
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
            TokenPoll::Authorized(grant) => {
                let client_id = pending.client_id.clone();
                let repository = pending.repository.clone();
                let permissions = match self
                    .transport
                    .validate_token(grant.access_token.expose_str(), &repository)
                {
                    Ok(permissions) => permissions,
                    Err(error) if auth_error_requires_reauthorization(&error) => {
                        *guard = None;
                        latch_reauthorization_required(self.store.as_ref(), token_path)?;
                        return Err("GITHUB_REAUTHORIZATION_REQUIRED".into());
                    }
                    Err(error) => {
                        pending.expires_at =
                            grant_issued_at.saturating_add(grant.access_expires_in);
                        pending.next_poll_at = now.saturating_add(pending.interval);
                        pending.grant = Some(grant);
                        pending.grant_issued_at = Some(grant_issued_at);
                        return Err(error);
                    }
                };
                let credentials =
                    match credentials_from_grant(grant, &client_id, &repository, grant_issued_at) {
                        Ok(credentials) => credentials,
                        Err(_) => {
                            *guard = None;
                            latch_reauthorization_required(self.store.as_ref(), token_path)?;
                            return Err("GITHUB_REAUTHORIZATION_REQUIRED".into());
                        }
                    };
                let _credential_guard = self
                    .credential_lock
                    .lock()
                    .map_err(|_| "GITHUB_AUTH_STATE_UNAVAILABLE")?;
                if let Err(error) = self.store.store(token_path, &credentials) {
                    *guard = None;
                    return Err(error);
                }
                if let Err(error) = self.store.store_authorization_state(
                    token_path,
                    secure_store::GithubAuthorizationState::Validated,
                ) {
                    let _ = self.store.clear(token_path);
                    *guard = None;
                    return Err(error);
                }
                *guard = None;
                let mut result = DeviceFlowResult::state(
                    "authorized",
                    true,
                    "GitHub yetkilendirmesi doğrulandı ve DPAPI ile saklandı.",
                );
                result.repository = Some(repository);
                result.permissions = Some(permissions);
                Ok(result)
            }
        }
    }

    pub fn clear_authorization(&self, token_path: &Path) -> Result<DeviceFlowResult, String> {
        // Poll holds pending before credentials. Use the same order, and keep
        // pending locked through deletion so an in-flight grant cannot revive it.
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "GITHUB_AUTH_STATE_UNAVAILABLE")?;
        let _credential_guard = self
            .credential_lock
            .lock()
            .map_err(|_| "GITHUB_AUTH_STATE_UNAVAILABLE")?;
        self.store.clear(token_path)?;
        *pending = None;
        Ok(DeviceFlowResult::state(
            "logged-out",
            false,
            "GitHub yetkilendirmesi temizlendi.",
        ))
    }

    pub fn publication_effects<'a>(
        &'a self,
        token_path: &'a Path,
        trusted_repository: &'a str,
    ) -> NativePublicationEffects<'a> {
        NativePublicationEffects {
            transport: self.transport.as_ref(),
            store: self.store.as_ref(),
            clock: self.clock.as_ref(),
            credential_lock: &self.credential_lock,
            token_path,
            trusted_repository,
        }
    }

    pub fn publication_readiness(&self, token_path: &Path, repository: &str) -> Result<(), String> {
        if authorization_ready_for_repository(
            self.store.as_ref(),
            token_path,
            repository,
            self.clock.now(),
        ) {
            Ok(())
        } else {
            Err("GITHUB_REAUTHORIZATION_REQUIRED".into())
        }
    }

    /// Reads the current tip of a repository's base branch.
    ///
    /// Approval binds a revision to `targetBaseSha`, and that value has to exist
    /// before the draft is materialized. Nothing captured it, so the
    /// `publication-target` quality gate stayed NOT_RUN and no revision in
    /// PUBLISH mode could ever be approved. Setup calls this once the repository
    /// is chosen; a stale value is still caught later by the reconciler's
    /// BASE_SHA_MISMATCH check.
    pub fn base_sha(
        &self,
        token_path: &Path,
        repository: &str,
        base_branch: &str,
    ) -> Result<String, String> {
        let _credential_guard = self
            .credential_lock
            .lock()
            .map_err(|_| "GITHUB_AUTH_STATE_UNAVAILABLE")?;
        let token = load_fresh_authorized_token(
            self.transport.as_ref(),
            self.store.as_ref(),
            self.clock.as_ref(),
            token_path,
            repository,
        )?;
        let mut github = GithubRestAdapter::new(token)?;
        match GithubRestPort::base_sha(&mut github, repository, base_branch) {
            Err(error) if error == "GITHUB_REAUTHORIZATION_REQUIRED" => {
                latch_reauthorization_required(self.store.as_ref(), token_path)?;
                Err(error)
            }
            result => result,
        }
    }
}

pub struct NativePublicationEffects<'a> {
    transport: &'a dyn GitHubAuthTransport,
    store: &'a dyn GitHubTokenStore,
    clock: &'a dyn Clock,
    credential_lock: &'a Mutex<()>,
    token_path: &'a Path,
    trusted_repository: &'a str,
}

/// Decides whether a failed reconcile pass may be retried.
///
/// `PublicationError::remote` documents that a retry is safe: network
/// interruptions, rate limits and transient GitHub errors all produce it.
/// Reporting those as the caller's terminal `FAILED` made an approved
/// publication unrecoverable, because the outbox idempotency key collides with
/// the failed effect and no later attempt is ever made. Validation errors stay
/// terminal: they mean the approved state no longer matches the remote, which a
/// retry cannot repair.
pub(crate) fn outcome_for_reconcile_error(
    error: &PublicationError,
) -> Result<PublicationEffectOutcome, String> {
    if error.code == "REMOTE_FAILURE" {
        return Ok(PublicationEffectOutcome::Waiting {
            result_ref: String::new(),
            last_error: Some(error.code.to_string()),
            retry_after_ms: u64::from(RETRY_AFTER_SECONDS) * 1_000,
        });
    }
    Err(error.code.to_string())
}

impl PublicationBrokerEffects for NativePublicationEffects<'_> {
    fn execute(&self, command: &Value) -> Result<PublicationEffectOutcome, String> {
        let claim: ClaimedPublication = serde_json::from_value(command.clone())
            .map_err(|_| "PUBLICATION_BROKER_CLAIM_SHAPE_INVALID".to_string())?;
        if !validate_claim(&claim) {
            return Err("PUBLICATION_BROKER_CLAIM_SHAPE_INVALID".into());
        }
        if !repository_matches_trusted(&claim.target_repository, self.trusted_repository) {
            return Err("PUBLICATION_REPOSITORY_NOT_CONFIGURED".into());
        }
        let _credential_guard = self
            .credential_lock
            .lock()
            .map_err(|_| "GITHUB_AUTH_STATE_UNAVAILABLE")?;
        let token = load_fresh_authorized_token(
            self.transport,
            self.store,
            self.clock,
            self.token_path,
            self.trusted_repository,
        )?;
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
        let result = match reconcile(&approved, &config, &mut github) {
            Ok(result) => result,
            // `PublicationError::remote` documents that a retry is safe: network
            // interruptions, rate limits and transient GitHub errors all produce
            // it. Collapsing it into the caller's terminal `FAILED` arm made an
            // approved publication unrecoverable, because the outbox idempotency
            // key collides with the failed effect and no later attempt is made.
            // Validation errors stay terminal: they mean the approved state no
            // longer matches the remote and a new approval is required.
            Err(error) if error.code == "GITHUB_REAUTHORIZATION_REQUIRED" => {
                latch_reauthorization_required(self.store, self.token_path)?;
                return Err("GITHUB_REAUTHORIZATION_REQUIRED".into());
            }
            Err(error) => return outcome_for_reconcile_error(&error),
        };
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
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;

    use serde_json::json;

    use super::{
        drive_publication_broker, GitHubBroker, PublicationBrokerEffects, PublicationEffectOutcome,
    };

    fn github_status_fixture(status_line: &str) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind GitHub HTTP fixture");
        let port = listener.local_addr().expect("fixture address").port();
        let status_line = status_line.to_string();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept GitHub request");
            let mut request = [0_u8; 4096];
            let read = stream.read(&mut request).expect("read GitHub request");
            let request_line = String::from_utf8_lossy(&request[..read])
                .lines()
                .next()
                .unwrap_or_default()
                .to_string();
            assert_eq!(request_line, "GET /repos/owner/site HTTP/1.1");
            let response = format!(
                "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            stream
                .write_all(response.as_bytes())
                .expect("write GitHub response");
            stream.flush().expect("flush GitHub response");
        });
        (format!("http://127.0.0.1:{port}"), server)
    }

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

    #[test]
    fn failed_required_checks_keep_the_actionable_terminal_code() {
        struct RequiredCheckFailed;
        impl PublicationBrokerEffects for RequiredCheckFailed {
            fn execute(
                &self,
                _command: &serde_json::Value,
            ) -> Result<PublicationEffectOutcome, String> {
                Err("REQUIRED_CHECK_FAILED".into())
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
            &RequiredCheckFailed,
        )
        .unwrap();

        assert_eq!(result["state"], "FAILED");
        assert_eq!(requests[1]["state"], "FAILED");
        assert_eq!(requests[1]["lastError"], "REQUIRED_CHECK_FAILED");
        assert!(requests[1].get("retryAfterMs").is_none());
    }

    #[test]
    fn reauthorization_is_reconciled_as_retryable_with_the_stable_code() {
        struct ReauthorizationRequired;
        impl PublicationBrokerEffects for ReauthorizationRequired {
            fn execute(
                &self,
                _command: &serde_json::Value,
            ) -> Result<PublicationEffectOutcome, String> {
                Err("GITHUB_REAUTHORIZATION_REQUIRED".into())
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
            &ReauthorizationRequired,
        )
        .unwrap();
        assert_eq!(result["state"], "UNKNOWN");
        assert_eq!(requests[1]["state"], "UNKNOWN");
        assert_eq!(requests[1]["lastError"], "GITHUB_REAUTHORIZATION_REQUIRED");
        assert_eq!(requests[1]["retryAfterMs"], 30_000);
    }

    #[test]
    fn transient_auth_validation_is_reconciled_as_retryable_unknown() {
        struct ValidationUnavailable;
        impl PublicationBrokerEffects for ValidationUnavailable {
            fn execute(
                &self,
                _command: &serde_json::Value,
            ) -> Result<PublicationEffectOutcome, String> {
                Err("GITHUB_TOKEN_VALIDATION_FAILED".into())
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
            &ValidationUnavailable,
        )
        .unwrap();
        assert_eq!(result["state"], "UNKNOWN");
        assert_eq!(requests[1]["state"], "UNKNOWN");
        assert_eq!(requests[1]["lastError"], "GITHUB_TOKEN_VALIDATION_FAILED");
        assert_eq!(requests[1]["retryAfterMs"], 30_000);
    }

    #[test]
    fn a_retry_safe_remote_failure_is_never_reported_as_terminal() {
        use crate::github_publication::PublicationError;

        let remote = PublicationError {
            code: "REMOTE_FAILURE",
            safe_message: "GitHub base lookup failed; retry is safe".into(),
        };
        match super::outcome_for_reconcile_error(&remote) {
            Ok(PublicationEffectOutcome::Waiting {
                result_ref,
                last_error,
                retry_after_ms,
            }) => {
                assert!(
                    result_ref.is_empty(),
                    "no result ref exists before a successful pass"
                );
                assert_eq!(last_error.as_deref(), Some("REMOTE_FAILURE"));
                assert!(
                    retry_after_ms > 0,
                    "a retryable effect needs a retry deadline"
                );
            }
            Ok(PublicationEffectOutcome::Succeeded { .. }) => {
                panic!("a failed reconcile pass must never report success")
            }
            Err(code) => panic!("a retry-safe failure must stay retryable, got {code}"),
        }

        // A validation failure means the approved state no longer matches the
        // remote, so it must stay terminal rather than retry forever.
        let validation = PublicationError {
            code: "BASE_SHA_MISMATCH",
            safe_message: "approved base SHA no longer matches".into(),
        };
        match super::outcome_for_reconcile_error(&validation) {
            Err(code) => assert_eq!(code, "BASE_SHA_MISMATCH"),
            Ok(_) => panic!("a validation failure must stay terminal"),
        }
    }

    #[test]
    fn native_publication_requires_the_configured_repository() {
        assert!(super::repository_matches_trusted(
            "Owner/Site",
            "owner/site"
        ));
        assert!(!super::repository_matches_trusted(
            "owner/other",
            "owner/site"
        ));
        assert!(!super::repository_matches_trusted("owner/site", ""));
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
    fn publication_broker_branch_uses_the_shared_contract() {
        let mut valid = valid_claim()["value"].clone();
        valid["baseBranch"] = json!("release/v1.2.3");
        let valid: super::ClaimedPublication =
            serde_json::from_value(valid).expect("valid publication claim");
        assert!(super::validate_claim(&valid));

        for branch in [
            "/main",
            "main/",
            "main//next",
            "main..next",
            "main:next",
            ".hidden",
            "feature/.hidden",
            "feature.lock",
            "feature/x.lock",
            "feature.",
            "-main",
        ] {
            let mut invalid = valid_claim()["value"].clone();
            invalid["baseBranch"] = json!(branch);
            let invalid: super::ClaimedPublication =
                serde_json::from_value(invalid).expect("well-shaped publication claim");
            assert!(!super::validate_claim(&invalid), "{branch}");
        }
    }

    #[test]
    fn publication_broker_workflow_uses_the_shared_contract() {
        for workflow in ["deploy.yml", "release_1.yaml"] {
            let mut valid = valid_claim()["value"].clone();
            valid["deployWorkflow"] = json!(workflow);
            let valid: super::ClaimedPublication =
                serde_json::from_value(valid).expect("valid publication claim");
            assert!(super::validate_claim(&valid), "{workflow}");
        }

        for workflow in [
            format!("{}.yml", "w".repeat(97)),
            "a..yml".to_string(),
            ".yml".to_string(),
            "deploy.txt".to_string(),
            "nested/deploy.yml".to_string(),
        ] {
            let mut invalid = valid_claim()["value"].clone();
            invalid["deployWorkflow"] = json!(workflow);
            let invalid: super::ClaimedPublication =
                serde_json::from_value(invalid).expect("well-shaped publication claim");
            assert!(!super::validate_claim(&invalid), "{workflow}");
        }
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
    fn repository_identity_rejects_invalid_owner_and_dot_segments() {
        for repository in [
            "./site",
            "owner/.",
            "../site",
            "owner/..",
            ".owner/site",
            "_owner/site",
            "-owner/site",
        ] {
            assert!(
                !super::valid_repository_name(repository),
                "{repository} must not reach a GitHub API URL"
            );
            assert!(
                !super::valid_repo(repository),
                "{repository} must not enter an approved publication claim"
            );
        }

        assert!(super::valid_repository_name("owner/.github"));
        assert!(super::valid_repo("owner/.github"));
    }
    #[test]
    fn moved_or_missing_repository_is_not_treated_as_a_transient_failure() {
        for status_line in ["301 Moved Permanently", "404 Not Found"] {
            let (api_root, server) = github_status_fixture(status_line);
            let transport = super::ReqwestGitHubAuthTransport::for_test_api_root(&api_root);
            let error =
                <super::ReqwestGitHubAuthTransport as super::GitHubAuthTransport>::validate_token(
                    &transport,
                    "access-token-fixture",
                    "owner/site",
                )
                .expect_err("moved or missing repository must require reauthorization");
            server.join().expect("GitHub HTTP fixture");
            assert_eq!(
                error, "GITHUB_APP_REPOSITORY_ACCESS_REQUIRED",
                "{status_line} must not enter the transient retry loop"
            );
            assert!(super::auth_error_requires_reauthorization(&error));
        }
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
    fn github_app_device_request_never_asks_for_classic_oauth_repo_scope() {
        let form = super::device_authorization_form("Iv1.0123456789abcdef");
        assert_eq!(form, vec![("client_id", "Iv1.0123456789abcdef")]);
    }

    #[test]
    fn github_app_token_grant_requires_rotation_fields_and_rejects_classic_scopes() {
        let grant = super::parse_github_app_token_grant(json!({
            "access_token": "github-app-access-fixture",
            "expires_in": 28_800,
            "refresh_token": "github-app-refresh-fixture",
            "refresh_token_expires_in": 15_897_600,
            "token_type": "bearer",
            "scope": ""
        }))
        .expect("expiring GitHub App grant");
        assert_eq!(grant.access_token.as_bytes(), b"github-app-access-fixture");
        assert_eq!(
            grant.refresh_token.as_bytes(),
            b"github-app-refresh-fixture"
        );
        assert_eq!(grant.access_expires_in, 28_800);
        assert_eq!(grant.refresh_expires_in, 15_897_600);

        assert_eq!(
            super::parse_github_app_token_grant(json!({
                "access_token": "classic-oauth-fixture",
                "token_type": "bearer",
                "scope": "repo"
            }))
            .unwrap_err(),
            "GITHUB_APP_TOKEN_EXPIRATION_REQUIRED"
        );
        assert_eq!(
            super::parse_github_app_token_grant(json!({
                "access_token": "classic-oauth-fixture",
                "expires_in": 28_800,
                "refresh_token": "classic-refresh-fixture",
                "refresh_token_expires_in": 15_897_600,
                "token_type": "bearer",
                "scope": "repo"
            }))
            .unwrap_err(),
            "GITHUB_CLASSIC_OAUTH_SCOPE_REJECTED"
        );
    }

    #[test]
    fn github_app_installation_must_be_single_repo_and_exactly_least_privileged() {
        let exact = json!({
            "repository_selection": "selected",
            "permissions": {
                "actions": "write",
                "administration": "read",
                "checks": "read",
                "contents": "write",
                "metadata": "read",
                "pull_requests": "write"
            }
        });
        let selected = json!({
            "total_count": 1,
            "repositories": [{"full_name": "owner/site"}]
        });
        assert_eq!(
            super::validate_github_app_installation(&exact, &selected, "owner/site")
                .expect("exact least-privilege installation"),
            vec![
                "actions:write",
                "administration:read",
                "checks:read",
                "contents:write",
                "metadata:read",
                "pull_requests:write"
            ]
        );

        let multiple = json!({
            "total_count": 2,
            "repositories": [{"full_name": "owner/site"}, {"full_name": "owner/other"}]
        });
        assert_eq!(
            super::validate_github_app_installation(&exact, &multiple, "owner/site").unwrap_err(),
            "GITHUB_APP_SINGLE_REPOSITORY_REQUIRED"
        );

        let mut overprivileged = exact;
        overprivileged["permissions"]["issues"] = json!("write");
        assert_eq!(
            super::validate_github_app_installation(&overprivileged, &selected, "owner/site")
                .unwrap_err(),
            "GITHUB_APP_PERMISSION_POLICY_MISMATCH"
        );
    }

    #[test]
    fn publication_token_loading_never_reintroduces_a_plaintext_clone() {
        let source = include_str!("github_broker.rs");
        assert!(!source.contains(&["token_bytes", ".clone()"].concat()));
        assert!(!source.contains(&["String", "::from_utf8(token"].concat()));
    }

    struct FakeClock(AtomicU64);
    impl super::Clock for FakeClock {
        fn now(&self) -> u64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    fn grant(access_token: &[u8], refresh_token: &[u8]) -> super::TokenGrant {
        super::TokenGrant {
            access_token: crate::secure_store::SecretBytes::new(access_token.to_vec()).unwrap(),
            refresh_token: crate::secure_store::SecretBytes::new(refresh_token.to_vec()).unwrap(),
            access_expires_in: 28_800,
            refresh_expires_in: 15_897_600,
        }
    }

    #[derive(Clone)]
    struct CredentialFixture {
        client_id: String,
        repository: String,
        access_token: Vec<u8>,
        refresh_token: Vec<u8>,
        access_expires_at: u64,
        refresh_expires_at: u64,
    }

    impl CredentialFixture {
        fn materialize(&self) -> crate::secure_store::GithubAppCredentials {
            crate::secure_store::GithubAppCredentials::new(
                self.client_id.clone(),
                self.repository.clone(),
                crate::secure_store::SecretBytes::new(self.access_token.clone()).unwrap(),
                crate::secure_store::SecretBytes::new(self.refresh_token.clone()).unwrap(),
                self.access_expires_at,
                self.refresh_expires_at,
            )
            .unwrap()
        }

        fn from_credentials(value: &crate::secure_store::GithubAppCredentials) -> Self {
            Self {
                client_id: value.client_id.clone(),
                repository: value.repository.clone(),
                access_token: value.access_token.as_bytes().to_vec(),
                refresh_token: value.refresh_token.as_bytes().to_vec(),
                access_expires_at: value.access_expires_at,
                refresh_expires_at: value.refresh_expires_at,
            }
        }
    }

    fn credential_fixture(access_expires_at: u64, refresh_expires_at: u64) -> CredentialFixture {
        CredentialFixture {
            client_id: "Iv1.0123456789abcdef".into(),
            repository: "owner/site".into(),
            access_token: b"stored-access-fixture".to_vec(),
            refresh_token: b"stored-refresh-fixture".to_vec(),
            access_expires_at,
            refresh_expires_at,
        }
    }

    struct FakeTransport {
        polls: Mutex<VecDeque<super::TokenPoll>>,
        refreshes: Mutex<VecDeque<Result<super::TokenGrant, String>>>,
        validation_error: Mutex<Option<String>>,
        validated: AtomicUsize,
        refreshed: AtomicUsize,
    }

    impl FakeTransport {
        fn idle() -> Self {
            Self {
                polls: Mutex::new(VecDeque::new()),
                refreshes: Mutex::new(VecDeque::new()),
                validation_error: Mutex::new(None),
                validated: AtomicUsize::new(0),
                refreshed: AtomicUsize::new(0),
            }
        }
    }

    impl super::GitHubAuthTransport for FakeTransport {
        fn request_device_code(&self, client_id: &str) -> Result<serde_json::Value, String> {
            assert_eq!(client_id, "Iv1.0123456789abcdef");
            Ok(json!({
                "device_code":"native-only-device-code",
                "user_code":"ABCD-EFGH",
                "verification_uri":"https://github.com/login/device",
                "expires_in":900,
                "interval":5
            }))
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

        fn refresh_access_token(
            &self,
            client_id: &str,
            refresh_token: &str,
        ) -> Result<super::TokenGrant, String> {
            assert_eq!(client_id, "Iv1.0123456789abcdef");
            assert_eq!(refresh_token, "stored-refresh-fixture");
            self.refreshed.fetch_add(1, Ordering::SeqCst);
            self.refreshes
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Err("unexpected refresh".into()))
        }

        fn validate_token(&self, token: &str, repository: &str) -> Result<Vec<String>, String> {
            assert!(!token.is_empty());
            assert_eq!(repository, "owner/site");
            self.validated.fetch_add(1, Ordering::SeqCst);
            if let Some(error) = self.validation_error.lock().unwrap().take() {
                return Err(error);
            }
            Ok(super::REQUIRED_REPOSITORY_PERMISSIONS
                .iter()
                .map(|(name, level)| format!("{name}:{level}"))
                .collect())
        }
    }

    #[derive(Default)]
    struct FakeStore {
        credentials: Mutex<Option<CredentialFixture>>,
        state: Mutex<Option<crate::secure_store::GithubAuthorizationState>>,
    }

    impl super::GitHubTokenStore for FakeStore {
        fn load(
            &self,
            _path: &std::path::Path,
        ) -> Result<crate::secure_store::GithubAppCredentials, String> {
            self.credentials
                .lock()
                .unwrap()
                .clone()
                .map(|credentials| credentials.materialize())
                .ok_or_else(|| "absent".to_string())
        }

        fn store(
            &self,
            _path: &std::path::Path,
            credentials: &crate::secure_store::GithubAppCredentials,
        ) -> Result<(), String> {
            *self.credentials.lock().unwrap() =
                Some(CredentialFixture::from_credentials(credentials));
            *self.state.lock().unwrap() = None;
            Ok(())
        }

        fn authorization_state(
            &self,
            _path: &std::path::Path,
        ) -> Result<crate::secure_store::GithubAuthorizationState, String> {
            self.state.lock().unwrap().ok_or_else(|| "absent".into())
        }

        fn store_authorization_state(
            &self,
            _path: &std::path::Path,
            state: crate::secure_store::GithubAuthorizationState,
        ) -> Result<(), String> {
            *self.state.lock().unwrap() = Some(state);
            Ok(())
        }

        fn clear(&self, _path: &std::path::Path) -> Result<(), String> {
            *self.credentials.lock().unwrap() = None;
            *self.state.lock().unwrap() = None;
            Ok(())
        }
    }

    #[test]
    fn explicit_poll_binds_exact_repository_permissions_and_stores_rotating_credentials() {
        let clock = Arc::new(FakeClock(AtomicU64::new(100)));
        let transport = Arc::new(FakeTransport {
            polls: Mutex::new(VecDeque::from([
                super::TokenPoll::Pending,
                super::TokenPoll::Authorized(grant(
                    b"native-access-fixture",
                    b"native-refresh-fixture",
                )),
            ])),
            refreshes: Mutex::new(VecDeque::new()),
            validation_error: Mutex::new(None),
            validated: AtomicUsize::new(0),
            refreshed: AtomicUsize::new(0),
        });
        let store = Arc::new(FakeStore::default());
        let broker = GitHubBroker::with_parts(transport.clone(), store.clone(), clock.clone());
        let begin = broker
            .begin_device_authorization("Iv1.0123456789abcdef", "owner/site")
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
        assert_eq!(authorized.repository.as_deref(), Some("owner/site"));
        assert_eq!(
            authorized.permissions.as_deref(),
            Some(
                super::REQUIRED_REPOSITORY_PERMISSIONS
                    .iter()
                    .map(|(name, level)| format!("{name}:{level}"))
                    .collect::<Vec<_>>()
                    .as_slice()
            )
        );
        let stored = store.credentials.lock().unwrap().clone().unwrap();
        assert_eq!(stored.repository, "owner/site");
        assert_eq!(stored.access_token, b"native-access-fixture");
        assert_eq!(stored.refresh_token, b"native-refresh-fixture");
        assert_eq!(stored.access_expires_at, 28_910);
        assert_eq!(stored.refresh_expires_at, 15_897_710);
        assert_eq!(
            *store.state.lock().unwrap(),
            Some(crate::secure_store::GithubAuthorizationState::Validated)
        );
        assert_eq!(transport.validated.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn concurrent_logout_and_poll_complete_without_restoring_cleared_authorization() {
        use std::sync::mpsc;
        use std::time::{Duration, Instant};
        let clock = Arc::new(FakeClock(AtomicU64::new(100)));
        let transport = Arc::new(FakeTransport::idle());
        transport
            .polls
            .lock()
            .unwrap()
            .push_back(super::TokenPoll::Authorized(grant(
                b"native-access-fixture",
                b"native-refresh-fixture",
            )));
        let store = Arc::new(FakeStore::default());
        *store.credentials.lock().unwrap() = Some(credential_fixture(50_000, 99_000));
        let broker = Arc::new(GitHubBroker::with_parts(
            transport.clone(),
            store.clone(),
            clock.clone(),
        ));
        broker
            .begin_device_authorization("Iv1.0123456789abcdef", "owner/site")
            .unwrap();
        clock.0.store(105, Ordering::SeqCst);
        let validation_gate = transport.validation_error.lock().unwrap();
        let (done_tx, done_rx) = mpsc::channel();
        let poll_broker = broker.clone();
        let poll_tx = done_tx.clone();
        let poll = thread::spawn(move || {
            poll_tx
                .send(poll_broker.poll_device_authorization(std::path::Path::new("fixture")))
                .unwrap();
        });
        let started = Instant::now();
        while transport.validated.load(Ordering::SeqCst) == 0
            && started.elapsed() < Duration::from_secs(3)
        {
            thread::yield_now();
        }
        assert_eq!(transport.validated.load(Ordering::SeqCst), 1);
        let clear_broker = broker.clone();
        let clear = thread::spawn(move || {
            done_tx
                .send(clear_broker.clear_authorization(std::path::Path::new("fixture")))
                .unwrap();
        });
        // The old inverse lock order clears the store, then waits for pending.
        // The fixed clear waits without acquiring credentials or deleting them.
        let started = Instant::now();
        while store.credentials.lock().unwrap().is_some()
            && started.elapsed() < Duration::from_millis(250)
        {
            thread::yield_now();
        }
        drop(validation_gate);
        for _ in 0..2 {
            assert!(done_rx
                .recv_timeout(Duration::from_secs(3))
                .expect("poll and logout must not deadlock")
                .is_ok());
        }
        poll.join().unwrap();
        clear.join().unwrap();
        assert!(store.credentials.lock().unwrap().is_none());
        assert!(store.state.lock().unwrap().is_none());
        assert!(broker.pending.lock().unwrap().is_none());
    }

    #[test]
    fn native_auth_uses_documented_lists_and_binds_repository_identity() {
        for (id, name, count, valid) in [
            (7, "OWNER/site", 1, true),
            (8, "owner/site", 1, false),
            (7, "owner/other", 1, false),
            (7, "owner/site", 2, false),
        ] {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let api_root = format!("http://{}", listener.local_addr().unwrap());
            let server = thread::spawn(move || {
                let permission_map: serde_json::Map<String, serde_json::Value> =
                    super::REQUIRED_REPOSITORY_PERMISSIONS
                        .iter()
                        .map(|(name, level)| (name.to_string(), json!(level)))
                        .collect();
                let responses = [
                    (
                        "/repos/owner/site",
                        json!({"id":7,"full_name":"owner/site"}),
                    ),
                    (
                        "/user/installations?per_page=100&page=1",
                        json!({"installations":[{
                            "id":42,"repository_selection":"selected","permissions":permission_map
                        }]}),
                    ),
                    (
                        "/user/installations/42/repositories?per_page=2",
                        json!({
                            "total_count":count,"repositories":[{"id":id,"full_name":name}]
                        }),
                    ),
                ];
                for (expected_path, body) in responses {
                    listener.set_nonblocking(true).unwrap();
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
                    let (mut stream, _) = loop {
                        match listener.accept() {
                            Ok(connection) => break connection,
                            Err(error)
                                if error.kind() == std::io::ErrorKind::WouldBlock
                                    && std::time::Instant::now() < deadline =>
                            {
                                thread::sleep(std::time::Duration::from_millis(1));
                            }
                            Err(error) => panic!("bounded GitHub fixture accept failed: {error}"),
                        }
                    };
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_write_timeout(Some(std::time::Duration::from_secs(3)))
                        .unwrap();
                    stream
                        .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                        .unwrap();
                    let mut request = [0_u8; 4096];
                    let bytes = stream.read(&mut request).unwrap();
                    let expected = format!("GET {expected_path} HTTP/1.1");
                    let request_text = String::from_utf8_lossy(&request[..bytes]);
                    let status = if request_text.lines().next() == Some(expected.as_str()) {
                        "200 OK"
                    } else {
                        "404 Not Found"
                    };
                    let payload = if status == "200 OK" {
                        body.to_string()
                    } else {
                        "{}".into()
                    };
                    write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len()).unwrap();
                }
            });
            let transport = super::ReqwestGitHubAuthTransport::for_test_api_root(&api_root);
            let result = super::GitHubAuthTransport::validate_token(
                &transport,
                "synthetic-access",
                "owner/site",
            );
            server.join().unwrap();
            assert_eq!(
                result.is_ok(),
                valid,
                "repository identity: {id}, {name}, {count}; result: {result:?}"
            );
        }
    }

    #[test]
    fn transient_validation_after_device_grant_retries_without_repolling_token() {
        let clock = Arc::new(FakeClock(AtomicU64::new(100)));
        let transport = Arc::new(FakeTransport {
            polls: Mutex::new(VecDeque::from([super::TokenPoll::Authorized(grant(
                b"native-device-access-fixture",
                b"native-device-refresh-fixture",
            ))])),
            refreshes: Mutex::new(VecDeque::new()),
            validation_error: Mutex::new(Some("GITHUB_TOKEN_VALIDATION_FAILED".into())),
            validated: AtomicUsize::new(0),
            refreshed: AtomicUsize::new(0),
        });
        let store = Arc::new(FakeStore::default());
        let broker = GitHubBroker::with_parts(transport.clone(), store.clone(), clock.clone());
        broker
            .begin_device_authorization("Iv1.0123456789abcdef", "owner/site")
            .unwrap();

        clock.0.store(105, Ordering::SeqCst);
        assert_eq!(
            broker
                .poll_device_authorization(std::path::Path::new("ignored"))
                .unwrap_err(),
            "GITHUB_TOKEN_VALIDATION_FAILED"
        );
        assert_eq!(
            broker.status(Some(std::path::Path::new("ignored"))).status,
            "pending"
        );
        assert!(store.credentials.lock().unwrap().is_none());

        clock.0.store(110, Ordering::SeqCst);
        let authorized = broker
            .poll_device_authorization(std::path::Path::new("ignored"))
            .expect("the in-memory device grant should be revalidated");
        assert_eq!(authorized.status, "authorized");
        assert_eq!(transport.polls.lock().unwrap().len(), 0);
        assert_eq!(transport.validated.load(Ordering::SeqCst), 2);
        let stored = store.credentials.lock().unwrap().clone().unwrap();
        assert_eq!(stored.access_token, b"native-device-access-fixture");
        assert_eq!(stored.refresh_token, b"native-device-refresh-fixture");
        assert_eq!(stored.access_expires_at, 28_905);
        assert_eq!(stored.refresh_expires_at, 15_897_705);
        assert_eq!(
            *store.state.lock().unwrap(),
            Some(crate::secure_store::GithubAuthorizationState::Validated)
        );
    }

    #[test]
    fn transient_device_grant_validation_cannot_extend_access_token_expiry() {
        let clock = Arc::new(FakeClock(AtomicU64::new(100)));
        let transport = Arc::new(FakeTransport {
            polls: Mutex::new(VecDeque::from([super::TokenPoll::Authorized(grant(
                b"native-expiring-access-fixture",
                b"native-expiring-refresh-fixture",
            ))])),
            refreshes: Mutex::new(VecDeque::new()),
            validation_error: Mutex::new(Some("GITHUB_TOKEN_VALIDATION_FAILED".into())),
            validated: AtomicUsize::new(0),
            refreshed: AtomicUsize::new(0),
        });
        let store = Arc::new(FakeStore::default());
        let broker = GitHubBroker::with_parts(transport.clone(), store.clone(), clock.clone());
        broker
            .begin_device_authorization("Iv1.0123456789abcdef", "owner/site")
            .unwrap();

        clock.0.store(105, Ordering::SeqCst);
        assert_eq!(
            broker
                .poll_device_authorization(std::path::Path::new("ignored"))
                .unwrap_err(),
            "GITHUB_TOKEN_VALIDATION_FAILED"
        );
        *transport.validation_error.lock().unwrap() = Some("GITHUB_TOKEN_VALIDATION_FAILED".into());

        clock.0.store(110, Ordering::SeqCst);
        assert_eq!(
            broker
                .poll_device_authorization(std::path::Path::new("ignored"))
                .unwrap_err(),
            "GITHUB_TOKEN_VALIDATION_FAILED"
        );

        clock.0.store(28_905, Ordering::SeqCst);
        assert_eq!(
            broker
                .poll_device_authorization(std::path::Path::new("ignored"))
                .expect("the original access-token expiry must remain authoritative")
                .status,
            "expired"
        );
        assert!(store.credentials.lock().unwrap().is_none());
        assert_eq!(transport.validated.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn authorization_state_is_restart_persistent_repository_bound_and_fail_closed() {
        let store = Arc::new(FakeStore::default());
        *store.credentials.lock().unwrap() = Some(credential_fixture(10_000, 20_000));
        let path = std::path::Path::new("ignored");
        let broker = GitHubBroker::with_parts(
            Arc::new(FakeTransport::idle()),
            store.clone(),
            Arc::new(FakeClock(AtomicU64::new(100))),
        );

        assert!(
            broker.publication_readiness(path, "owner/site").is_err(),
            "missing state must fail closed"
        );
        assert_eq!(broker.status(Some(path)).status, "logged-out");
        *store.state.lock().unwrap() =
            Some(crate::secure_store::GithubAuthorizationState::Validated);
        assert!(broker.publication_readiness(path, "owner/site").is_ok());
        assert!(broker.publication_readiness(path, "owner/other").is_err());
        assert_eq!(broker.status(Some(path)).status, "authorized");

        super::latch_reauthorization_required(store.as_ref(), path).unwrap();
        let restarted = GitHubBroker::with_parts(
            Arc::new(FakeTransport::idle()),
            store.clone(),
            Arc::new(FakeClock(AtomicU64::new(200))),
        );
        assert!(restarted.publication_readiness(path, "owner/site").is_err());
        assert_eq!(
            restarted.status(Some(path)).status,
            "reauthorization-required"
        );
        restarted.clear_authorization(path).unwrap();
        assert!(store.credentials.lock().unwrap().is_none());
        assert!(store.state.lock().unwrap().is_none());
    }

    #[test]
    fn fresh_access_token_revalidates_repository_permissions_before_use() {
        let store = FakeStore::default();
        *store.credentials.lock().unwrap() = Some(credential_fixture(10_000, 20_000));
        *store.state.lock().unwrap() =
            Some(crate::secure_store::GithubAuthorizationState::Validated);
        let transport = FakeTransport::idle();
        let clock = FakeClock(AtomicU64::new(100));

        let token = super::load_fresh_authorized_token(
            &transport,
            &store,
            &clock,
            std::path::Path::new("ignored"),
            "owner/site",
        )
        .expect("fresh credential remains usable after remote policy validation");

        assert_eq!(token.as_bytes(), b"stored-access-fixture");
        assert_eq!(transport.refreshed.load(Ordering::SeqCst), 0);
        assert_eq!(transport.validated.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn fresh_access_token_permission_change_latches_reauthorization() {
        let store = FakeStore::default();
        *store.credentials.lock().unwrap() = Some(credential_fixture(10_000, 20_000));
        *store.state.lock().unwrap() =
            Some(crate::secure_store::GithubAuthorizationState::Validated);
        let transport = FakeTransport {
            validation_error: Mutex::new(Some("GITHUB_APP_PERMISSION_POLICY_MISMATCH".into())),
            ..FakeTransport::idle()
        };
        let clock = FakeClock(AtomicU64::new(100));

        let result = super::load_fresh_authorized_token(
            &transport,
            &store,
            &clock,
            std::path::Path::new("ignored"),
            "owner/site",
        );

        assert_eq!(
            result.err().as_deref(),
            Some("GITHUB_REAUTHORIZATION_REQUIRED")
        );
        assert_eq!(transport.refreshed.load(Ordering::SeqCst), 0);
        assert_eq!(transport.validated.load(Ordering::SeqCst), 1);
        assert_eq!(
            *store.state.lock().unwrap(),
            Some(crate::secure_store::GithubAuthorizationState::ReauthorizationRequired)
        );
    }

    #[test]
    fn expired_access_token_rotates_before_use_and_revalidates_repository_permissions() {
        let store = FakeStore::default();
        *store.credentials.lock().unwrap() = Some(credential_fixture(350, 20_000));
        *store.state.lock().unwrap() =
            Some(crate::secure_store::GithubAuthorizationState::Validated);
        let transport = FakeTransport {
            polls: Mutex::new(VecDeque::new()),
            refreshes: Mutex::new(VecDeque::from([Ok(grant(
                b"rotated-access-fixture",
                b"rotated-refresh-fixture",
            ))])),
            validation_error: Mutex::new(None),
            validated: AtomicUsize::new(0),
            refreshed: AtomicUsize::new(0),
        };
        let clock = FakeClock(AtomicU64::new(100));

        let token = super::load_fresh_authorized_token(
            &transport,
            &store,
            &clock,
            std::path::Path::new("ignored"),
            "owner/site",
        )
        .expect("refresh succeeds");
        assert_eq!(token.as_bytes(), b"rotated-access-fixture");
        assert_eq!(transport.refreshed.load(Ordering::SeqCst), 1);
        assert_eq!(transport.validated.load(Ordering::SeqCst), 1);
        let stored = store.credentials.lock().unwrap().clone().unwrap();
        assert_eq!(stored.access_token, b"rotated-access-fixture");
        assert_eq!(stored.refresh_token, b"rotated-refresh-fixture");
        assert_eq!(stored.access_expires_at, 28_900);
        assert_eq!(stored.refresh_expires_at, 15_897_700);
        assert_eq!(
            *store.state.lock().unwrap(),
            Some(crate::secure_store::GithubAuthorizationState::Validated)
        );
    }

    #[test]
    fn transient_validation_after_refresh_preserves_the_rotated_credential_pair() {
        let store = FakeStore::default();
        *store.credentials.lock().unwrap() = Some(credential_fixture(350, 20_000));
        *store.state.lock().unwrap() =
            Some(crate::secure_store::GithubAuthorizationState::Validated);
        let transport = FakeTransport {
            polls: Mutex::new(VecDeque::new()),
            refreshes: Mutex::new(VecDeque::from([Ok(grant(
                b"rotated-access-fixture",
                b"rotated-refresh-fixture",
            ))])),
            validation_error: Mutex::new(Some("GITHUB_TOKEN_VALIDATION_FAILED".into())),
            validated: AtomicUsize::new(0),
            refreshed: AtomicUsize::new(0),
        };
        let result = super::load_fresh_authorized_token(
            &transport,
            &store,
            &FakeClock(AtomicU64::new(100)),
            std::path::Path::new("ignored"),
            "owner/site",
        );

        assert_eq!(
            result.err().as_deref(),
            Some("GITHUB_TOKEN_VALIDATION_FAILED")
        );
        let stored = store.credentials.lock().unwrap().clone().unwrap();
        assert_eq!(stored.access_token, b"rotated-access-fixture");
        assert_eq!(stored.refresh_token, b"rotated-refresh-fixture");
        assert_eq!(
            *store.state.lock().unwrap(),
            Some(crate::secure_store::GithubAuthorizationState::Validated)
        );
    }

    #[test]
    fn refresh_expiry_latches_reauthorization_without_contacting_github() {
        let store = FakeStore::default();
        *store.credentials.lock().unwrap() = Some(credential_fixture(200, 300));
        *store.state.lock().unwrap() =
            Some(crate::secure_store::GithubAuthorizationState::Validated);
        let transport = FakeTransport::idle();
        let clock = FakeClock(AtomicU64::new(100));

        let result = super::load_fresh_authorized_token(
            &transport,
            &store,
            &clock,
            std::path::Path::new("ignored"),
            "owner/site",
        );
        assert_eq!(
            result.err().as_deref(),
            Some("GITHUB_REAUTHORIZATION_REQUIRED")
        );
        assert_eq!(transport.refreshed.load(Ordering::SeqCst), 0);
        assert_eq!(
            *store.state.lock().unwrap(),
            Some(crate::secure_store::GithubAuthorizationState::ReauthorizationRequired)
        );
    }

    #[test]
    fn rejected_device_token_persists_reauthorization_state() {
        struct RejectingTransport;

        impl super::GitHubAuthTransport for RejectingTransport {
            fn request_device_code(&self, _: &str) -> Result<serde_json::Value, String> {
                Ok(json!({
                    "device_code":"native-only-device-code",
                    "user_code":"ABCD-EFGH",
                    "verification_uri":"https://github.com/login/device",
                    "expires_in":900,
                    "interval":5
                }))
            }

            fn poll_access_token(&self, _: &str, _: &str) -> Result<super::TokenPoll, String> {
                Ok(super::TokenPoll::Authorized(grant(
                    b"rejected-access-fixture",
                    b"rejected-refresh-fixture",
                )))
            }

            fn refresh_access_token(&self, _: &str, _: &str) -> Result<super::TokenGrant, String> {
                Err("unexpected refresh".into())
            }

            fn validate_token(&self, _: &str, _: &str) -> Result<Vec<String>, String> {
                Err("GITHUB_REAUTHORIZATION_REQUIRED".into())
            }
        }

        let store = Arc::new(FakeStore::default());
        let clock = Arc::new(FakeClock(AtomicU64::new(100)));
        let broker =
            GitHubBroker::with_parts(Arc::new(RejectingTransport), store.clone(), clock.clone());
        broker
            .begin_device_authorization("Iv1.0123456789abcdef", "owner/site")
            .unwrap();
        clock.0.store(105, Ordering::SeqCst);
        assert_eq!(
            broker
                .poll_device_authorization(std::path::Path::new("ignored"))
                .unwrap_err(),
            "GITHUB_REAUTHORIZATION_REQUIRED"
        );
        assert_eq!(
            *store.state.lock().unwrap(),
            Some(crate::secure_store::GithubAuthorizationState::ReauthorizationRequired)
        );
        assert!(broker
            .publication_readiness(std::path::Path::new("ignored"), "owner/site")
            .is_err());
    }

    #[test]
    fn native_publication_rejects_missing_authorization_state_before_http() {
        let store = FakeStore::default();
        *store.credentials.lock().unwrap() = Some(credential_fixture(10_000, 20_000));
        let transport = FakeTransport::idle();
        let clock = FakeClock(AtomicU64::new(100));
        let credential_lock = Mutex::new(());
        let effects = super::NativePublicationEffects {
            transport: &transport,
            store: &store,
            clock: &clock,
            credential_lock: &credential_lock,
            token_path: std::path::Path::new("ignored"),
            trusted_repository: "owner/site",
        };
        let command = valid_claim()["value"].clone();
        match effects.execute(&command) {
            Err(error) => assert_eq!(error, "GITHUB_REAUTHORIZATION_REQUIRED"),
            Ok(_) => panic!("publication must stop before constructing an HTTP adapter"),
        }
    }
}
