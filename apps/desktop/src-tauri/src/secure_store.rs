use std::fs::{self, OpenOptions};
use std::fmt::Write as _;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::ptr;
use std::slice;
use std::sync::atomic::{compiler_fence, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};
use windows::core::{w, Error as WindowsError};
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{
    BCryptGenRandom, CryptProtectData, CryptUnprotectData, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
    CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};
use windows::Win32::Storage::FileSystem::{
    MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecureStoreStatus {
    pub backend: &'static str,
    pub ready: bool,
    pub detail: &'static str,
}

const STABLE_DATA_ROOT: &str = "Blogbot";
const MAX_RECOVERY_KEY_CANDIDATES: usize = 8;
// `app_local_data_dir` is derived from the product name on Windows, not the
// Tauri identifier. Keep this explicit identifier path while recovering the
// encrypted database created by earlier desktop builds.
const CURRENT_APP_IDENTIFIER: &str = "app.blogbot.desktop";
const LEGACY_IDENTIFIERS: &[&str] = &["net.siberdergi.blogbot"];
const GITHUB_AUTH_STATE_VALIDATED: &[u8] = b"blogbot-github-auth-state:v1:validated";
const GITHUB_AUTH_STATE_REAUTH_REQUIRED: &[u8] =
    b"blogbot-github-auth-state:v1:reauthorization-required";

/// App-owned plaintext GitHub token storage. The wrapper is intentionally not
/// cloneable or printable. It removes durable and per-request application
/// copies; transient reqwest/TLS/OS buffers while a request is active remain
/// outside this best-effort zeroization boundary.
pub(crate) struct SecretBytes(Vec<u8>);

impl SecretBytes {
    pub(crate) fn new(bytes: Vec<u8>) -> Result<Self, String> {
        let secret = Self(bytes);
        if secret.0.is_empty() || secret.0.len() > 1024 {
            return Err("GITHUB_TOKEN_INVALID".into());
        }
        let value =
            std::str::from_utf8(&secret.0).map_err(|_| "GITHUB_TOKEN_INVALID".to_string())?;
        if value.trim().is_empty() {
            return Err("GITHUB_TOKEN_INVALID".into());
        }
        Ok(secret)
    }

    pub(crate) fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    pub(crate) fn expose_str(&self) -> &str {
        std::str::from_utf8(&self.0).expect("SecretBytes construction validates UTF-8")
    }

    pub(crate) fn wipe(&mut self) {
        let capacity = self.0.capacity();
        let pointer = self.0.as_mut_ptr();
        for index in 0..capacity {
            unsafe { ptr::write_volatile(pointer.add(index), 0) };
        }
        compiler_fence(Ordering::SeqCst);
    }
}

impl Drop for SecretBytes {
    fn drop(&mut self) {
        self.wipe();
    }
}

fn volatile_zero(bytes: &mut [u8]) {
    for byte in bytes {
        unsafe { ptr::write_volatile(byte, 0) };
    }
    compiler_fence(Ordering::SeqCst);
}

fn copy_then_wipe(source: &mut [u8]) -> Vec<u8> {
    let bytes = source.to_vec();
    volatile_zero(source);
    bytes
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GithubAuthorizationState {
    Validated,
    ReauthorizationRequired,
}

pub fn stable_data_key_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .and_then(|directory| directory.parent().map(Path::to_path_buf))
        .map(|root| {
            root.join(STABLE_DATA_ROOT)
                .join("secrets")
                .join("data-key.dpapi")
        })
}

fn identifier_secret_path(root: &Path, identifier: &str) -> PathBuf {
    root.join(identifier).join("secrets").join("data-key.dpapi")
}

fn app_secret_path(_app: &AppHandle) -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|root| identifier_secret_path(&root, CURRENT_APP_IDENTIFIER))
}

fn legacy_secret_paths() -> Vec<PathBuf> {
    let Some(root) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else {
        return Vec::new();
    };
    LEGACY_IDENTIFIERS
        .iter()
        .map(|identifier| identifier_secret_path(&root, identifier))
        .collect()
}

/// Return only bounded, explicitly named same-user key backups. These files
/// are read-only recovery candidates; they are never promoted until the
/// engine proves that the candidate opens the encrypted workspace.
fn recovery_key_paths(secret_directories: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut paths = secret_directories
        .into_iter()
        .flat_map(|directory| {
            fs::read_dir(directory)
                .into_iter()
                .flat_map(|entries| entries.filter_map(Result::ok))
                .filter_map(|entry| {
                    let path = entry.path();
                    let name = path.file_name()?.to_str()?;
                    (entry.file_type().ok()?.is_file()
                        && name.starts_with("data-key.dpapi.")
                        && name.ends_with(".bak"))
                    .then_some(path)
                })
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    paths.truncate(MAX_RECOVERY_KEY_CANDIDATES);
    paths
}

fn existing_valid_key(path: &Path) -> Option<Vec<u8>> {
    fs::read(path)
        .ok()
        .and_then(|ciphertext| unprotect_for_current_user(&ciphertext).ok())
        .filter(|plaintext| plaintext.len() == 32)
}

/// Once a candidate has successfully opened the encrypted workspace it is
/// persisted as the canonical stable key, so try that first, then the current
/// Tauri identifier key, then keys left by earlier identifiers. Only a
/// candidate that actually decrypts is used, so this order is a preference and
/// never a decision.
fn ordered_key_candidates(
    stable: PathBuf,
    app_key: Option<PathBuf>,
    legacy: Vec<PathBuf>,
) -> Vec<PathBuf> {
    let mut candidates = vec![stable];
    if let Some(app_key) = app_key {
        candidates.push(app_key);
    }
    candidates.extend(legacy);
    candidates
}

pub fn status(app: &AppHandle) -> SecureStoreStatus {
    let key_path = stable_data_key_path(app).or_else(|| app_secret_path(app));
    let ready = match key_path.as_ref().map(fs::read) {
        Some(Ok(ciphertext)) => {
            unprotect_for_current_user(&ciphertext).is_ok_and(|plaintext| plaintext.len() == 32)
        }
        Some(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            protect_for_current_user(b"blogbot-dpapi-readiness")
                .and_then(|ciphertext| unprotect_for_current_user(&ciphertext))
                .is_ok_and(|plaintext| plaintext == b"blogbot-dpapi-readiness")
        }
        _ => false,
    };
    SecureStoreStatus {
        backend: "windows-dpapi-current-user",
        ready,
        detail: if ready {
            "Local cache secrets are bound to the current Windows user without plaintext fallback."
        } else {
            "DPAPI readiness probe failed; encrypted cache and mutations remain disabled."
        },
    }
}

pub fn load_or_create_data_key(app: &AppHandle) -> Result<String, String> {
    let path = stable_data_key_path(app)
        .or_else(|| app_secret_path(app))
        .ok_or_else(|| "DATA_KEY_DIRECTORY_UNAVAILABLE: LOCALAPPDATA is unavailable".to_string())?;
    let directory = path
        .parent()
        .ok_or_else(|| "DATA_KEY_DIRECTORY_UNAVAILABLE".to_string())?
        .to_path_buf();
    fs::create_dir_all(&directory)
        .map_err(|error| format!("DATA_KEY_DIRECTORY_CREATE_FAILED: {error}"))?;

    let app_key = app_secret_path(app);
    // If a persisted Blogbot database predates the current Tauri identifier, its
    // same-user DPAPI key is still a candidate here. This avoids creating a
    // second key during an identifier migration and never touches user data.
    let candidates = ordered_key_candidates(path.clone(), app_key, legacy_secret_paths());
    let plaintext = if let Some((candidate, key)) = candidates
        .iter()
        .find_map(|candidate| existing_valid_key(candidate).map(|key| (candidate, key)))
    {
        if candidate != &path {
            let protected = protect_for_current_user(&key)
                .map_err(|error| format!("DATA_KEY_PROTECT_FAILED: {error}"))?;
            let _ = persist_new_key_atomically(&directory, &path, &protected, &key);
        }
        key
    } else {
        let mut key = [0_u8; 32];
        unsafe {
            BCryptGenRandom(None, &mut key, BCRYPT_USE_SYSTEM_PREFERRED_RNG)
                .ok()
                .map_err(|error| format!("DATA_KEY_RANDOM_FAILED: {error}"))?;
        }
        let protected = protect_for_current_user(&key)
            .map_err(|error| format!("DATA_KEY_PROTECT_FAILED: {error}"))?;
        persist_new_key_atomically(&directory, &path, &protected, &key)?
    };
    if plaintext.len() != 32 {
        return Err("DATA_KEY_INVALID_LENGTH".to_string());
    }
    let mut encoded = String::with_capacity(plaintext.len() * 2);
    for byte in plaintext {
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(encoded)
}

/// Return same-user DPAPI key candidates without changing any existing key.
/// The first value is the canonical key. Older identifier keys are retained
/// only for a bounded, read-only engine recovery attempt when a migrated
/// encrypted workspace cannot be opened with that canonical key.
pub fn load_data_key_candidates(app: &AppHandle) -> Result<Vec<String>, String> {
    let stable_path = stable_data_key_path(app);
    let canonical = load_or_create_data_key(app)?;
    let mut candidates = vec![canonical];
    let Some(root) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else {
        return Ok(candidates);
    };
    let app_key = identifier_secret_path(&root, CURRENT_APP_IDENTIFIER);
    let legacy = LEGACY_IDENTIFIERS
        .iter()
        .map(|identifier| identifier_secret_path(&root, identifier));
    let app_key_directory = app_key.parent().map(Path::to_path_buf);
    let legacy: Vec<PathBuf> = legacy.collect();
    let recovery_directories = stable_path
        .and_then(|candidate| candidate.parent().map(Path::to_path_buf))
        .into_iter()
        .chain(app_key_directory)
        .chain(
            legacy
                .iter()
                .filter_map(|candidate| candidate.parent().map(Path::to_path_buf)),
        );
    let recovery_paths = recovery_key_paths(recovery_directories);
    for path in std::iter::once(app_key).chain(legacy).chain(recovery_paths) {
        if let Some(key) = existing_valid_key(&path) {
            let mut encoded = String::with_capacity(key.len() * 2);
            for byte in key {
                write!(&mut encoded, "{byte:02x}")
                    .expect("writing to a String cannot fail");
            }
            if !candidates.iter().any(|candidate| candidate == &encoded) {
                candidates.push(encoded);
            }
        }
    }
    Ok(candidates)
}

fn persist_new_key_atomically(
    directory: &std::path::Path,
    path: &std::path::Path,
    protected: &[u8],
    key: &[u8],
) -> Result<Vec<u8>, String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("DATA_KEY_CLOCK_FAILED: {error}"))?
        .as_nanos();
    let temp_path = directory.join(format!("data-key.{}.{}.tmp", std::process::id(), nonce));
    let write_result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|error| format!("DATA_KEY_TEMP_CREATE_FAILED: {error}"))?;
        file.write_all(protected)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("DATA_KEY_WRITE_FAILED: {error}"))?;
        if path.exists() {
            return Err("DATA_KEY_COMMIT_FAILED: destination already exists".to_string());
        }
        // Rename within the same directory is atomic on Windows and works on
        // filesystems where hard-links are disabled by policy.
        fs::rename(&temp_path, path).map_err(|error| format!("DATA_KEY_COMMIT_FAILED: {error}"))?;
        Ok::<_, String>(key.to_vec())
    })();

    match write_result {
        Ok(value) => Ok(value),
        Err(_error) if path.exists() => {
            let _ = fs::remove_file(&temp_path);
            let ciphertext = fs::read(path)
                .map_err(|read_error| format!("DATA_KEY_READ_FAILED: {read_error}"))?;
            unprotect_for_current_user(&ciphertext)
                .map_err(|unprotect_error| format!("DATA_KEY_UNPROTECT_FAILED: {unprotect_error}"))
        }
        Err(error) => {
            let _ = fs::remove_file(&temp_path);
            Err(error)
        }
    }
}

/// Atomically replace a protected key only after the caller has proved that
/// its plaintext opens the current local workspace. This is intentionally
/// separate from first-key creation: a damaged or unrelated key may never be
/// replaced merely because it exists.
fn replace_protected_key_atomically(
    directory: &Path,
    path: &Path,
    protected: &[u8],
) -> Result<(), String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("DATA_KEY_CLOCK_FAILED: {error}"))?
        .as_nanos();
    let temp_path = directory.join(format!(
        "data-key-promote.{}.{}.tmp",
        std::process::id(),
        nonce
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|error| format!("DATA_KEY_TEMP_CREATE_FAILED: {error}"))?;
        file.write_all(protected)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("DATA_KEY_WRITE_FAILED: {error}"))?;
        let source = windows::core::HSTRING::from(temp_path.as_os_str());
        let destination = windows::core::HSTRING::from(path.as_os_str());
        unsafe {
            MoveFileExW(
                &source,
                &destination,
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
            .map_err(|error| format!("DATA_KEY_COMMIT_FAILED: {error}"))?;
        }
        Ok::<(), String>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

pub fn promote_confirmed_data_key(path: &Path, encoded_key: &str) -> Result<(), String> {
    if encoded_key.len() != 64 || !encoded_key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("DATA_KEY_INVALID_LENGTH".to_string());
    }
    let key = (0..encoded_key.len())
        .step_by(2)
        .map(|offset| u8::from_str_radix(&encoded_key[offset..offset + 2], 16))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "DATA_KEY_INVALID_HEX".to_string())?;
    if key.len() != 32 {
        return Err("DATA_KEY_INVALID_LENGTH".to_string());
    }
    if existing_valid_key(path).is_some_and(|current| current == key) {
        return Ok(());
    }
    let directory = path
        .parent()
        .ok_or_else(|| "DATA_KEY_DIRECTORY_UNAVAILABLE".to_string())?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("DATA_KEY_DIRECTORY_CREATE_FAILED: {error}"))?;
    let protected = protect_for_current_user(&key)
        .map_err(|error| format!("DATA_KEY_PROTECT_FAILED: {error}"))?;
    replace_protected_key_atomically(directory, path, &protected)
}

fn input_blob(data: &[u8]) -> Result<CRYPT_INTEGER_BLOB, WindowsError> {
    let length = u32::try_from(data.len()).map_err(|_| WindowsError::from_win32())?;
    Ok(CRYPT_INTEGER_BLOB {
        cbData: length,
        pbData: data.as_ptr().cast_mut(),
    })
}

fn copy_and_free(blob: CRYPT_INTEGER_BLOB, wipe_before_free: bool) -> Vec<u8> {
    if blob.pbData.is_null() || blob.cbData == 0 {
        return Vec::new();
    }
    let source = unsafe { slice::from_raw_parts_mut(blob.pbData, blob.cbData as usize) };
    let bytes = if wipe_before_free {
        copy_then_wipe(source)
    } else {
        source.to_vec()
    };
    unsafe {
        let _ = LocalFree(Some(HLOCAL(blob.pbData.cast())));
    }
    bytes
}

pub fn protect_for_current_user(plaintext: &[u8]) -> Result<Vec<u8>, WindowsError> {
    let input = input_blob(plaintext)?;
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            w!("Blogbot local encrypted cache"),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )?;
    }
    Ok(copy_and_free(output, false))
}

pub fn unprotect_for_current_user(ciphertext: &[u8]) -> Result<Vec<u8>, WindowsError> {
    let input = input_blob(ciphertext)?;
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )?;
    }
    Ok(copy_and_free(output, true))
}

#[allow(dead_code)]
pub fn store_github_token_at(path: &Path, token: &[u8]) -> Result<(), String> {
    if token.is_empty() || token.len() > 1024 {
        return Err("GITHUB_TOKEN_INVALID".into());
    }
    let directory = path
        .parent()
        .ok_or_else(|| "GITHUB_TOKEN_DIRECTORY_UNAVAILABLE".to_string())?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("GITHUB_TOKEN_DIRECTORY_CREATE_FAILED: {error}"))?;
    // Invalidate authorization before replacing the token. If invalidation
    // fails, the old token remains untouched; if the later write fails, no
    // stale validated state can authorize either token.
    clear_github_authorization_state_at(path)?;
    let protected = protect_for_current_user(token)
        .map_err(|error| format!("GITHUB_TOKEN_PROTECT_FAILED: {error}"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = directory.join(format!("github-token.{}.{}.tmp", std::process::id(), nonce));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|error| format!("GITHUB_TOKEN_TEMP_CREATE_FAILED: {error}"))?;
        file.write_all(&protected)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("GITHUB_TOKEN_WRITE_FAILED: {error}"))?;
        let source = windows::core::HSTRING::from(temp.as_os_str());
        let destination = windows::core::HSTRING::from(path.as_os_str());
        unsafe {
            MoveFileExW(
                &source,
                &destination,
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
            .map_err(|error| format!("GITHUB_TOKEN_COMMIT_FAILED: {error}"))?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

#[allow(dead_code)]
pub(crate) fn load_github_token_at(path: &Path) -> Result<SecretBytes, String> {
    let protected = fs::read(path).map_err(|_| "GITHUB_TOKEN_UNAVAILABLE".to_string())?;
    let token = unprotect_for_current_user(&protected)
        .map_err(|_| "GITHUB_TOKEN_UNAVAILABLE".to_string())?;
    SecretBytes::new(token)
}

pub fn github_authorization_state_path(token_path: &Path) -> Result<PathBuf, String> {
    let file_name = token_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "GITHUB_AUTHORIZATION_STATE_PATH_INVALID".to_string())?;
    Ok(token_path.with_file_name(format!("{file_name}.authorization-state.dpapi")))
}

pub fn store_github_authorization_state_at(
    token_path: &Path,
    state: GithubAuthorizationState,
) -> Result<(), String> {
    let path = github_authorization_state_path(token_path)?;
    let directory = path
        .parent()
        .ok_or_else(|| "GITHUB_AUTHORIZATION_STATE_PATH_INVALID".to_string())?;
    fs::create_dir_all(directory)
        .map_err(|_| "GITHUB_AUTHORIZATION_STATE_STORE_FAILED".to_string())?;
    let plaintext = match state {
        GithubAuthorizationState::Validated => GITHUB_AUTH_STATE_VALIDATED,
        GithubAuthorizationState::ReauthorizationRequired => GITHUB_AUTH_STATE_REAUTH_REQUIRED,
    };
    let protected = protect_for_current_user(plaintext)
        .map_err(|_| "GITHUB_AUTHORIZATION_STATE_STORE_FAILED".to_string())?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = directory.join(format!(
        "github-authorization-state.{}.{}.tmp",
        std::process::id(),
        nonce
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|_| "GITHUB_AUTHORIZATION_STATE_STORE_FAILED".to_string())?;
        file.write_all(&protected)
            .and_then(|_| file.sync_all())
            .map_err(|_| "GITHUB_AUTHORIZATION_STATE_STORE_FAILED".to_string())?;
        let source = windows::core::HSTRING::from(temp.as_os_str());
        let destination = windows::core::HSTRING::from(path.as_os_str());
        unsafe {
            MoveFileExW(
                &source,
                &destination,
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
            .map_err(|_| "GITHUB_AUTHORIZATION_STATE_STORE_FAILED".to_string())?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

pub fn load_github_authorization_state_at(
    token_path: &Path,
) -> Result<GithubAuthorizationState, String> {
    let path = github_authorization_state_path(token_path)?;
    let protected =
        fs::read(path).map_err(|_| "GITHUB_AUTHORIZATION_STATE_UNAVAILABLE".to_string())?;
    let plaintext = unprotect_for_current_user(&protected)
        .map_err(|_| "GITHUB_AUTHORIZATION_STATE_INVALID".to_string())?;
    match plaintext.as_slice() {
        GITHUB_AUTH_STATE_VALIDATED => Ok(GithubAuthorizationState::Validated),
        GITHUB_AUTH_STATE_REAUTH_REQUIRED => Ok(GithubAuthorizationState::ReauthorizationRequired),
        _ => Err("GITHUB_AUTHORIZATION_STATE_INVALID".into()),
    }
}

pub fn clear_github_authorization_state_at(token_path: &Path) -> Result<(), String> {
    let path = github_authorization_state_path(token_path)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("GITHUB_AUTHORIZATION_STATE_CLEAR_FAILED".into()),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{
        persist_new_key_atomically, protect_for_current_user, recovery_key_paths,
        unprotect_for_current_user,
    };

    #[test]
    fn dpapi_round_trip_is_bound_to_the_current_windows_user() {
        let plaintext = b"blogbot-device-cache-key";
        let protected = protect_for_current_user(plaintext).expect("DPAPI protection failed");
        assert_ne!(protected, plaintext);
        let recovered = unprotect_for_current_user(&protected).expect("DPAPI unprotect failed");
        assert_eq!(recovered, plaintext);
    }

    #[test]
    fn github_token_is_dpapi_protected_at_rest_and_rotates_atomically() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "blogbot-github-token-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("create token directory");
        let path = directory.join("github-token.dpapi");
        super::store_github_token_at(&path, b"native-token-secret").expect("store token");
        let disk = fs::read(&path).expect("read protected token");
        assert!(!String::from_utf8_lossy(&disk).contains("native-token-secret"));
        assert_eq!(
            super::load_github_token_at(&path)
                .expect("load token")
                .as_bytes(),
            b"native-token-secret"
        );
        super::store_github_token_at(&path, b"rotated-native-token")
            .expect("atomically rotate token");
        assert_eq!(
            super::load_github_token_at(&path)
                .expect("load rotated token")
                .as_bytes(),
            b"rotated-native-token"
        );
        fs::remove_dir_all(directory).expect("cleanup");
    }

    #[test]
    fn github_secret_buffer_is_volatile_wiped_without_retaining_plaintext() {
        let mut secret =
            super::SecretBytes::new(b"native-token-secret".to_vec()).expect("valid token fixture");
        secret.wipe();
        assert!(secret.as_bytes().iter().all(|byte| *byte == 0));
    }

    #[test]
    fn dpapi_plaintext_copy_wipes_the_source_before_it_can_be_freed() {
        let mut source = b"native-token-secret".to_vec();
        let copied = super::copy_then_wipe(&mut source);
        assert_eq!(copied, b"native-token-secret");
        assert!(source.iter().all(|byte| *byte == 0));
    }

    #[test]
    fn invalid_ciphertext_fails_closed() {
        assert!(unprotect_for_current_user(b"not-dpapi-ciphertext").is_err());
    }

    #[test]
    fn rotating_github_token_clears_previously_validated_authorization_state() {
        let directory = std::env::temp_dir().join(format!(
            "blogbot-token-rotation-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&directory).expect("create token directory");
        let token_path = directory.join("github-token.dpapi");
        super::store_github_token_at(&token_path, b"first-token").expect("store initial token");
        super::store_github_authorization_state_at(
            &token_path,
            super::GithubAuthorizationState::Validated,
        )
        .expect("store authorization state");

        super::store_github_token_at(&token_path, b"rotated-token").expect("rotate token");

        assert_eq!(
            super::load_github_authorization_state_at(&token_path),
            Err("GITHUB_AUTHORIZATION_STATE_UNAVAILABLE".to_string())
        );
        assert_eq!(
            super::load_github_token_at(&token_path)
                .expect("load rotated token")
                .as_bytes(),
            b"rotated-token"
        );
        fs::remove_dir_all(directory).expect("cleanup");
    }

    #[test]
    fn github_authorization_state_is_token_free_persistent_and_corruption_fails_closed() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "blogbot-github-auth-state-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("create authorization state directory");
        let token_path = directory.join("github-token.dpapi");

        super::store_github_authorization_state_at(
            &token_path,
            super::GithubAuthorizationState::Validated,
        )
        .expect("store validated authorization state");
        assert_eq!(
            super::load_github_authorization_state_at(&token_path).unwrap(),
            super::GithubAuthorizationState::Validated
        );
        let state_path = super::github_authorization_state_path(&token_path).unwrap();
        let disk = fs::read(&state_path).expect("read protected authorization state");
        assert!(!String::from_utf8_lossy(&disk).contains("validated"));
        assert!(!String::from_utf8_lossy(&disk).contains("token"));

        super::store_github_authorization_state_at(
            &token_path,
            super::GithubAuthorizationState::ReauthorizationRequired,
        )
        .expect("store reauthorization latch");
        assert_eq!(
            super::load_github_authorization_state_at(&token_path).unwrap(),
            super::GithubAuthorizationState::ReauthorizationRequired
        );
        fs::write(&state_path, b"corrupt").expect("corrupt state fixture");
        assert!(super::load_github_authorization_state_at(&token_path).is_err());

        super::clear_github_authorization_state_at(&token_path).expect("clear state");
        assert!(!state_path.exists());
        fs::remove_dir_all(directory).expect("cleanup");
    }

    #[test]
    fn candidates_prefer_the_canonical_stable_key_before_identifier_or_legacy_keys() {
        let stable = PathBuf::from("stable/data-key.dpapi");
        let app = PathBuf::from("current-app/data-key.dpapi");
        let legacy = PathBuf::from("legacy/data-key.dpapi");
        assert_eq!(
            super::ordered_key_candidates(stable.clone(), Some(app.clone()), vec![legacy.clone()]),
            vec![stable.clone(), app, legacy.clone()]
        );
        assert_eq!(
            super::ordered_key_candidates(stable.clone(), None, vec![legacy.clone()]),
            vec![stable, legacy]
        );
    }

    #[test]
    fn current_app_key_uses_the_tauri_identifier_not_the_product_name_directory() {
        let root = PathBuf::from("C:/Users/editor/AppData/Local");
        assert_eq!(
            super::identifier_secret_path(&root, super::CURRENT_APP_IDENTIFIER),
            root.join("app.blogbot.desktop")
                .join("secrets")
                .join("data-key.dpapi")
        );
    }

    #[test]
    fn recovery_key_paths_accept_only_bounded_named_backups() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "blogbot-recovery-key-candidates-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("create recovery directory");
        fs::write(
            directory.join("data-key.dpapi.recovery-1.bak"),
            b"candidate",
        )
        .expect("write backup");
        fs::write(
            directory.join("data-key.dpapi.recovery-2.bak"),
            b"candidate",
        )
        .expect("write backup");
        fs::write(
            directory.join("data-key.dpapi.tmp"),
            b"not a recovery backup",
        )
        .expect("write temp");
        fs::write(directory.join("other-secret.bak"), b"not a data key")
            .expect("write unrelated backup");

        let paths = recovery_key_paths([directory.clone()]);
        assert_eq!(paths.len(), 2);
        assert!(paths.iter().all(|path| path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("data-key.dpapi.") && name.ends_with(".bak"))));
        fs::remove_dir_all(directory).expect("cleanup");
    }

    #[test]
    fn confirmed_legacy_key_replaces_the_stable_key_atomically() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "blogbot-stable-key-promotion-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("create key directory");
        let path = directory.join("data-key.dpapi");
        let stale = protect_for_current_user(&[3_u8; 32]).expect("protect stale key");
        fs::write(&path, stale).expect("write stale key");

        super::replace_protected_key_atomically(
            &directory,
            &path,
            &protect_for_current_user(&[9_u8; 32]).expect("protect recovered key"),
        )
        .expect("promote recovered key");

        let restored = unprotect_for_current_user(&fs::read(&path).expect("read promoted key"))
            .expect("unprotect promoted key");
        assert_eq!(restored, [9_u8; 32]);
        fs::remove_dir_all(directory).expect("cleanup");
    }

    #[test]
    fn data_key_commit_is_atomic_and_never_overwrites_a_corrupt_existing_key() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "blogbot-secure-store-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("create test directory");
        let path = directory.join("data-key.dpapi");
        let key = [7_u8; 32];
        let protected = protect_for_current_user(&key).expect("protect key");

        let saved =
            persist_new_key_atomically(&directory, &path, &protected, &key).expect("commit key");
        assert_eq!(saved, key);
        let recovered =
            unprotect_for_current_user(&fs::read(&path).expect("read key")).expect("recover key");
        assert_eq!(recovered, key);

        fs::write(&path, b"corrupt-existing-key").expect("replace test fixture");
        assert!(
            persist_new_key_atomically(&directory, &path, &protected, &key).is_err(),
            "an existing corrupt key must fail closed instead of being replaced"
        );
        assert_eq!(
            fs::read(&path).expect("read corrupt fixture"),
            b"corrupt-existing-key"
        );
        fs::remove_dir_all(&directory).expect("remove test directory");
    }
}
