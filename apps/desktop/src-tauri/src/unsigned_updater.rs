use std::path::PathBuf;
use std::process::Command;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use crate::commands::CommandError;

const MANIFEST_URL: &str =
    "https://github.com/ucsahinn/blogbot/releases/latest/download/latest.json";
const RELEASES_API_URL: &str = "https://api.github.com/repos/ucsahinn/blogbot/releases/latest";
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

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    assets: Vec<GithubReleaseAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubReleaseAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    digest: Option<String>,
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

fn github_release_update(release: GithubRelease) -> Result<Option<UnsignedUpdate>, CommandError> {
    let version = release
        .tag_name
        .strip_prefix('v')
        .unwrap_or(&release.tag_name)
        .to_string();
    if !is_newer_version(&version)? {
        return Ok(None);
    }

    let artifact = release
        .assets
        .into_iter()
        .find(|asset| asset.name.ends_with("x64-setup.exe"))
        .ok_or_else(|| CommandError::UpdateUnavailable("UPDATE_INSTALLER_MISSING".into()))?;
    let sha256 = artifact
        .digest
        .as_deref()
        .and_then(|digest| digest.strip_prefix("sha256:"))
        .ok_or_else(|| CommandError::UpdateUnavailable("UPDATE_HASH_MISSING".into()))?
        .to_ascii_lowercase();

    validate_release_url(&artifact.browser_download_url)?;
    validate_sha256(&sha256)?;
    Ok(Some(UnsignedUpdate {
        version,
        notes: release.body,
        url: artifact.browser_download_url,
        sha256,
    }))
}

/// The release manifest is the primary update contract because it binds the
/// installer hash explicitly. GitHub's release API carries the same digest as
/// a recoverable read-only fallback when the `latest/download` edge is
/// temporarily unavailable. A valid manifest always wins, including a valid
/// "already current" result, so a stale API response can never override it.
fn resolve_manifest_or_release(
    manifest: Result<Option<UnsignedUpdate>, CommandError>,
    release: Result<Option<UnsignedUpdate>, CommandError>,
) -> Result<Option<UnsignedUpdate>, CommandError> {
    match manifest {
        Ok(update) => Ok(update),
        Err(manifest_error) => release.or(Err(manifest_error)),
    }
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
        .map_err(|_| CommandError::UpdateUnavailable("UPDATE_MANIFEST_UNAVAILABLE".into()))
        .and_then(|response| {
            response
                .error_for_status()
                .map_err(|_| CommandError::UpdateUnavailable("UPDATE_MANIFEST_HTTP_ERROR".into()))
        });
    let manifest_update_result = match manifest {
        Ok(response) => response
            .json::<ReleaseManifest>()
            .await
            .map_err(|_| CommandError::UpdateUnavailable("UPDATE_MANIFEST_INVALID".into()))
            .and_then(manifest_update),
        Err(error) => Err(error),
    };
    if manifest_update_result.is_ok() {
        return manifest_update_result;
    }

    let release_update_result = client
        .get(RELEASES_API_URL)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .header(reqwest::header::USER_AGENT, "Blogbot-update-check")
        .send()
        .await
        .map_err(|_| CommandError::UpdateUnavailable("UPDATE_RELEASE_UNAVAILABLE".into()))?
        .error_for_status()
        .map_err(|_| CommandError::UpdateUnavailable("UPDATE_RELEASE_HTTP_ERROR".into()))?
        .json::<GithubRelease>()
        .await
        .map_err(|_| CommandError::UpdateUnavailable("UPDATE_RELEASE_INVALID".into()))
        .and_then(github_release_update);
    resolve_manifest_or_release(manifest_update_result, release_update_result)
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
        current_version, github_release_update, is_newer_version, manifest_update, validate_release_url,
        validate_sha256, resolve_manifest_or_release, CommandError, GithubRelease,
        ReleaseManifest, UnsignedUpdate,
    };

    fn next_test_version() -> String {
        let mut segments = current_version()
            .split('.')
            .map(|segment| segment.parse::<u64>().expect("package version is semver"));
        let major = segments.next().expect("major version");
        let minor = segments.next().expect("minor version");
        let patch = segments.next().expect("patch version") + 1;
        assert!(segments.next().is_none(), "package version has three segments");
        format!("{major}.{minor}.{patch}")
    }

    #[test]
    fn accepts_only_new_https_github_installer_releases() {
        let version = next_test_version();
        let manifest = ReleaseManifest {
            version: version.clone(),
            notes: String::new(),
            platforms: super::WindowsPlatform {
                windows_x86_64: super::WindowsArtifact {
                    url: format!("https://github.com/ucsahinn/blogbot/releases/download/v{version}/Blogbot_{version}_x64-setup.exe"),
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

    #[test]
    fn accepts_latest_github_release_api_when_manifest_asset_is_missing() {
        let version = next_test_version();
        let release: GithubRelease = serde_json::from_value(serde_json::json!({
            "tag_name": format!("v{version}"),
            "body": "Daha hızlı yerel çalışma.",
            "assets": [{
                "name": format!("Blogbot_{version}_x64-setup.exe"),
                "browser_download_url": format!("https://github.com/ucsahinn/blogbot/releases/download/v{version}/Blogbot_{version}_x64-setup.exe"),
                "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }]
        })).unwrap();
        let update = github_release_update(release).unwrap().unwrap();
        assert_eq!(update.version, version);
        assert_eq!(update.sha256, "a".repeat(64));
    }

    #[test]
    fn falls_back_to_the_github_release_when_the_manifest_endpoint_is_temporarily_unavailable() {
        let fallback = UnsignedUpdate {
            version: "0.1.13".into(),
            notes: "Yerel düzeltmeler.".into(),
            url: "https://github.com/ucsahinn/blogbot/releases/download/v0.1.13/Blogbot_0.1.13_x64-setup.exe".into(),
            sha256: "a".repeat(64),
        };

        let result = resolve_manifest_or_release(
            Err(CommandError::UpdateUnavailable("UPDATE_MANIFEST_UNAVAILABLE".into())),
            Ok(Some(fallback)),
        )
        .unwrap()
        .unwrap();

        assert_eq!(result.version, "0.1.13");
    }
}
