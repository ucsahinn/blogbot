use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::slice;
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
// `app_local_data_dir` is derived from the product name on Windows, not the
// Tauri identifier. Keep this explicit identifier path while recovering the
// encrypted database created by earlier desktop builds.
const CURRENT_APP_IDENTIFIER: &str = "app.blogbot.desktop";
const LEGACY_IDENTIFIERS: &[&str] = &["net.siberdergi.blogbot"];

fn stable_secret_path(app: &AppHandle) -> Option<PathBuf> {
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

fn existing_valid_key(path: &Path) -> Option<Vec<u8>> {
    fs::read(path)
        .ok()
        .and_then(|ciphertext| unprotect_for_current_user(&ciphertext).ok())
        .filter(|plaintext| plaintext.len() == 32)
}

fn ordered_key_candidates(
    stable: PathBuf,
    app_key: Option<PathBuf>,
    legacy: Vec<PathBuf>,
    persisted_data: bool,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if persisted_data {
        // Once a candidate has successfully opened the encrypted workspace it
        // is persisted here as the canonical key. Prefer it over stale keys
        // from earlier Tauri identifiers.
        candidates.push(stable);
        if let Some(app_key) = app_key {
            candidates.push(app_key);
        }
        candidates.extend(legacy);
    } else {
        candidates.push(stable);
        if let Some(app_key) = app_key {
            candidates.push(app_key);
        }
        candidates.extend(legacy);
    }
    candidates
}

pub fn status(app: &AppHandle) -> SecureStoreStatus {
    let key_path = stable_secret_path(app).or_else(|| app_secret_path(app));
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
    let path = stable_secret_path(app)
        .or_else(|| app_secret_path(app))
        .ok_or_else(|| "DATA_KEY_DIRECTORY_UNAVAILABLE: LOCALAPPDATA is unavailable".to_string())?;
    let directory = path
        .parent()
        .ok_or_else(|| "DATA_KEY_DIRECTORY_UNAVAILABLE".to_string())?
        .to_path_buf();
    fs::create_dir_all(&directory)
        .map_err(|error| format!("DATA_KEY_DIRECTORY_CREATE_FAILED: {error}"))?;

    let app_key = app_secret_path(app);
    // If a persisted Blogbot database predates the current Tauri identifier,
    // use its same-user DPAPI key directly. This avoids creating a second key
    // during an identifier migration and does not require touching user data.
    let persisted_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|root| root.join("Blogbot").join("data").join("pgdata"))
        .is_some_and(|path| path.exists());
    let candidates = ordered_key_candidates(
        path.clone(),
        app_key,
        legacy_secret_paths(),
        persisted_data,
    );
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
    Ok(plaintext.iter().map(|byte| format!("{byte:02x}")).collect())
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

fn input_blob(data: &[u8]) -> Result<CRYPT_INTEGER_BLOB, WindowsError> {
    let length = u32::try_from(data.len()).map_err(|_| WindowsError::from_win32())?;
    Ok(CRYPT_INTEGER_BLOB {
        cbData: length,
        pbData: data.as_ptr().cast_mut(),
    })
}

fn copy_and_free(blob: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    if blob.pbData.is_null() || blob.cbData == 0 {
        return Vec::new();
    }
    let bytes = unsafe { slice::from_raw_parts(blob.pbData, blob.cbData as usize) }.to_vec();
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
    Ok(copy_and_free(output))
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
    Ok(copy_and_free(output))
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
pub fn load_github_token_at(path: &Path) -> Result<Vec<u8>, String> {
    let protected = fs::read(path).map_err(|_| "GITHUB_TOKEN_UNAVAILABLE".to_string())?;
    let token = unprotect_for_current_user(&protected)
        .map_err(|_| "GITHUB_TOKEN_UNAVAILABLE".to_string())?;
    if token.is_empty() || token.len() > 1024 {
        return Err("GITHUB_TOKEN_INVALID".into());
    }
    Ok(token)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{
        persist_new_key_atomically, protect_for_current_user, unprotect_for_current_user,
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
            super::load_github_token_at(&path).expect("load token"),
            b"native-token-secret"
        );
        super::store_github_token_at(&path, b"rotated-native-token")
            .expect("atomically rotate token");
        assert_eq!(
            super::load_github_token_at(&path).expect("load rotated token"),
            b"rotated-native-token"
        );
        fs::remove_dir_all(directory).expect("cleanup");
    }

    #[test]
    fn invalid_ciphertext_fails_closed() {
        assert!(unprotect_for_current_user(b"not-dpapi-ciphertext").is_err());
    }

    #[test]
    fn persisted_data_prefers_the_canonical_stable_key_before_identifier_or_legacy_keys() {
        let stable = PathBuf::from("stable/data-key.dpapi");
        let app = PathBuf::from("current-app/data-key.dpapi");
        let legacy = PathBuf::from("legacy/data-key.dpapi");
        assert_eq!(
            super::ordered_key_candidates(stable.clone(), Some(app.clone()), vec![legacy.clone()], true),
            vec![stable, app, legacy]
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
