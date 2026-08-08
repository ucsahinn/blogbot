use std::path::PathBuf;
use std::process::Command;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use crate::commands::CommandError;

const MANIFEST_URL: &str =
    "https://github.com/ucsahinn/blogbot/releases/latest/download/latest.json";
const RELEASE_HOST: &str = "github.com";
const RELEASE_PATH_PREFIX: &str = "/ucsahinn/blogbot/releases/download/";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsignedUpdate {
    pub version: String,
    pub notes: String,
    pub url: String,
    pub sha256: String,
}

#[derive(Debug, Deserialize)]
struct ReleaseManifest {
    version: String,
    #[serde(default)]
    notes: String,
    platforms: WindowsPlatform,
}

#[derive(Debug, Deserialize)]
struct WindowsPlatform {
    #[serde(rename = "windows-x86_64")]
    windows_x86_64: WindowsArtifact,
}

#[derive(Debug, Deserialize)]
struct WindowsArtifact {
    url: String,
    sha256: String,
}

fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

fn version_parts(version: &str) -> Result<[u64; 3], CommandError> {
    let mut parts = version.split('.');
    let parsed = [parts.next(), parts.next(), parts.next()]
        .map(|part| part.and_then(|value| value.parse::<u64>().ok()));
    if parts.next().is_some() || parsed.iter().any(Option::is_none) {
        return Err(CommandError::InvalidInput("UPDATE_VERSION_INVALID".into()));
    }
    Ok(parsed.map(Option::unwrap))
}

fn is_newer_version(version: &str) -> Result<bool, CommandError> {
    Ok(version_parts(version)? > version_parts(current_version())?)
}

fn validate_release_url(raw: &str) -> Result<(), CommandError> {
    let url = reqwest::Url::parse(raw)
        .map_err(|_| CommandError::InvalidInput("UPDATE_URL_INVALID".into()))?;
    if url.scheme() != "https"
        || url.host_str() != Some(RELEASE_HOST)
        || !url.path().starts_with(RELEASE_PATH_PREFIX)
        || !url.path().ends_with("-setup.exe")
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(CommandError::InvalidInput("UPDATE_URL_NOT_ALLOWED".into()));
    }
    Ok(())
}

fn validate_sha256(sha256: &str) -> Result<(), CommandError> {
    if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(CommandError::InvalidInput("UPDATE_HASH_INVALID".into()));
    }
    Ok(())
}

fn manifest_update(manifest: ReleaseManifest) -> Result<Option<UnsignedUpdate>, CommandError> {
    if !is_newer_version(&manifest.version)? {
        return Ok(None);
    }
    validate_release_url(&manifest.platforms.windows_x86_64.url)?;
    validate_sha256(&manifest.platforms.windows_x86_64.sha256)?;
    Ok(Some(UnsignedUpdate {
        version: manifest.version,
        notes: manifest.notes,
        url: manifest.platforms.windows_x86_64.url,
        sha256: manifest
            .platforms
            .windows_x86_64
            .sha256
            .to_ascii_lowercase(),
    }))
}

async fn fetch_update() -> Result<Option<UnsignedUpdate>, CommandError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|_| CommandError::UpdateUnavailable("UPDATE_CLIENT_UNAVAILABLE".into()))?;
    let manifest = client
        .get(MANIFEST_URL)
        .send()
        .await
        .map_err(|_| CommandError::UpdateUnavailable("UPDATE_MANIFEST_UNAVAILABLE".into()))?
        .error_for_status()
        .map_err(|_| CommandError::UpdateUnavailable("UPDATE_MANIFEST_HTTP_ERROR".into()))?
        .json::<ReleaseManifest>()
        .await
        .map_err(|_| CommandError::UpdateUnavailable("UPDATE_MANIFEST_INVALID".into()))?;
    manifest_update(manifest)
}

pub async fn check_unsigned_update() -> Result<Option<UnsignedUpdate>, CommandError> {
    fetch_update().await
}

fn configure_hidden_command(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
}

fn installer_path(version: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "Blogbot-{version}-{}-setup.exe",
        std::process::id()
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallUnsignedUpdateRequest {
    pub version: String,
    pub url: String,
    pub sha256: String,
}

pub async fn install_unsigned_update(
    app: AppHandle,
    request: InstallUnsignedUpdateRequest,
) -> Result<(), CommandError> {
    validate_release_url(&request.url)?;
    validate_sha256(&request.sha256)?;
    if !is_newer_version(&request.version)? {
        return Err(CommandError::InvalidInput("UPDATE_NOT_NEWER".into()));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|_| CommandError::UpdateUnavailable("UPDATE_CLIENT_UNAVAILABLE".into()))?;
    let bytes = client
        .get(&request.url)
        .send()
        .await
        .map_err(|_| CommandError::UpdateUnavailable("UPDATE_DOWNLOAD_UNAVAILABLE".into()))?
        .error_for_status()
        .map_err(|_| CommandError::UpdateUnavailable("UPDATE_DOWNLOAD_HTTP_ERROR".into()))?
        .bytes()
        .await
        .map_err(|_| CommandError::UpdateUnavailable("UPDATE_DOWNLOAD_FAILED".into()))?;

    let digest = Sha256::digest(&bytes);
    let actual = format!("{digest:x}");
    if actual != request.sha256.to_ascii_lowercase() {
        return Err(CommandError::UpdateUnavailable(
            "UPDATE_HASH_MISMATCH".into(),
        ));
    }

    let path = installer_path(&request.version);
    std::fs::write(&path, &bytes)
        .map_err(|_| CommandError::UpdateUnavailable("UPDATE_INSTALLER_WRITE_FAILED".into()))?;
    let mut installer = Command::new(&path);
    configure_hidden_command(&mut installer);
    installer.arg("/S");
    installer
        .spawn()
        .map_err(|_| CommandError::UpdateUnavailable("UPDATE_INSTALLER_START_FAILED".into()))?;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        is_newer_version, manifest_update, validate_release_url, validate_sha256, ReleaseManifest,
    };

    #[test]
    fn accepts_only_new_https_github_installer_releases() {
        let manifest = ReleaseManifest {
            version: "0.1.9".into(),
            notes: String::new(),
            platforms: super::WindowsPlatform {
                windows_x86_64: super::WindowsArtifact {
                    url: "https://github.com/ucsahinn/blogbot/releases/download/v0.1.9/Blogbot_0.1.9_x64-setup.exe".into(),
                    sha256: "a".repeat(64),
                },
            },
        };
        assert!(manifest_update(manifest).unwrap().is_some());
        assert!(!is_newer_version("0.1.6").unwrap());
    }

    #[test]
    fn rejects_non_github_urls_and_bad_hashes() {
        assert!(validate_release_url(
            "http://github.com/ucsahinn/blogbot/releases/download/v0.1.8/Blogbot-setup.exe"
        )
        .is_err());
        assert!(validate_release_url("https://example.com/Blogbot-setup.exe").is_err());
        assert!(validate_sha256("not-a-hash").is_err());
    }
}
