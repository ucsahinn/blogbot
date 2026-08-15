use std::io::Write;
use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use windows::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};

use crate::commands::CommandError;

const MANIFEST_URL: &str =
    "https://github.com/ucsahinn/blogbot/releases/latest/download/latest.json";
const RELEASES_API_URL: &str = "https://api.github.com/repos/ucsahinn/blogbot/releases/latest";
const RELEASE_HOST: &str = "github.com";
const RELEASE_PATH_PREFIX: &str = "/ucsahinn/blogbot/releases/download/";
const MAX_INSTALLER_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsignedUpdate {
    pub version: String,
    pub notes: String,
    pub url: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum UnsignedUpdateCheck {
    UpdateAvailable { update: UnsignedUpdate },
    UpToDate { latest_version: String },
    LocalBuildNewer { latest_version: String },
}

#[derive(Debug, Clone)]
struct CheckedUpdateAuthorization {
    version: String,
    url: String,
    sha256: String,
}

impl CheckedUpdateAuthorization {
    fn new(update: &UnsignedUpdate) -> Self {
        Self {
            version: update.version.clone(),
            url: update.url.clone(),
            sha256: update.sha256.clone(),
        }
    }

    fn validate(&self, request: &InstallUnsignedUpdateRequest) -> Result<(), CommandError> {
        if self.version != request.version
            || self.url != request.url
            || self.sha256 != request.sha256
        {
            return Err(CommandError::InvalidInput(
                "UPDATE_NOT_AUTHORIZED_BY_CHECK".into(),
            ));
        }
        Ok(())
    }
}

fn checked_update_authorization() -> &'static Mutex<Option<CheckedUpdateAuthorization>> {
    static AUTHORIZATION: OnceLock<Mutex<Option<CheckedUpdateAuthorization>>> = OnceLock::new();
    AUTHORIZATION.get_or_init(|| Mutex::new(None))
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UpdateFreshness {
    UpdateAvailable,
    UpToDate,
    LocalBuildNewer,
}

/// A locally built installer can legitimately have a higher version than the
/// newest GitHub Release. That is not the same as a verified, published
/// "up-to-date" state and must be surfaced distinctly to the editor.
fn update_freshness_for_version(version: &str) -> Result<UpdateFreshness, CommandError> {
    Ok(match version_parts(version)?.cmp(&version_parts(current_version())?) {
        Ordering::Greater => UpdateFreshness::UpdateAvailable,
        Ordering::Equal => UpdateFreshness::UpToDate,
        Ordering::Less => UpdateFreshness::LocalBuildNewer,
    })
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

fn manifest_update(manifest: ReleaseManifest) -> Result<UnsignedUpdateCheck, CommandError> {
    match update_freshness_for_version(&manifest.version)? {
        UpdateFreshness::UpToDate => Ok(UnsignedUpdateCheck::UpToDate {
            latest_version: manifest.version,
        }),
        UpdateFreshness::LocalBuildNewer => Ok(UnsignedUpdateCheck::LocalBuildNewer {
            latest_version: manifest.version,
        }),
        UpdateFreshness::UpdateAvailable => {
            validate_release_url(&manifest.platforms.windows_x86_64.url)?;
            validate_sha256(&manifest.platforms.windows_x86_64.sha256)?;
            Ok(UnsignedUpdateCheck::UpdateAvailable {
                update: UnsignedUpdate {
                    version: manifest.version,
                    notes: manifest.notes,
                    url: manifest.platforms.windows_x86_64.url,
                    sha256: manifest
                        .platforms
                        .windows_x86_64
                        .sha256
                        .to_ascii_lowercase(),
                },
            })
        }
    }
}

fn github_release_update(release: GithubRelease) -> Result<UnsignedUpdateCheck, CommandError> {
    let version = release
        .tag_name
        .strip_prefix('v')
        .unwrap_or(&release.tag_name)
        .to_string();
    match update_freshness_for_version(&version)? {
        UpdateFreshness::UpToDate => return Ok(UnsignedUpdateCheck::UpToDate { latest_version: version }),
        UpdateFreshness::LocalBuildNewer => return Ok(UnsignedUpdateCheck::LocalBuildNewer { latest_version: version }),
        UpdateFreshness::UpdateAvailable => {}
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
    Ok(UnsignedUpdateCheck::UpdateAvailable {
        update: UnsignedUpdate {
            version,
            notes: release.body,
            url: artifact.browser_download_url,
            sha256,
        },
    })
}

/// The release manifest is the primary update contract because it binds the
/// installer hash explicitly. GitHub's release API carries the same digest as
/// a recoverable read-only fallback when the `latest/download` edge is
/// temporarily unavailable. A valid manifest always wins, including a valid
/// "already current" result, so a stale API response can never override it.
fn resolve_manifest_or_release(
    manifest: Result<UnsignedUpdateCheck, CommandError>,
    release: Result<UnsignedUpdateCheck, CommandError>,
) -> Result<UnsignedUpdateCheck, CommandError> {
    match manifest {
        Ok(update) => Ok(update),
        Err(manifest_error) => release.or(Err(manifest_error)),
    }
}

async fn fetch_update() -> Result<UnsignedUpdateCheck, CommandError> {
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

pub async fn check_unsigned_update() -> Result<UnsignedUpdateCheck, CommandError> {
    let result = fetch_update().await?;
    let authorization = match &result {
        UnsignedUpdateCheck::UpdateAvailable { update } => Some(CheckedUpdateAuthorization::new(update)),
        UnsignedUpdateCheck::UpToDate { .. } | UnsignedUpdateCheck::LocalBuildNewer { .. } => None,
    };
    *checked_update_authorization().lock().map_err(|_| {
        CommandError::UpdateUnavailable("UPDATE_AUTHORIZATION_UNAVAILABLE".into())
    })? = authorization;
    Ok(result)
}

fn configure_hidden_command(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
}

fn powershell_single_quoted(value: &str) -> String {
    value.replace('\'', "''")
}

fn deferred_installer_script(installer_path: &Path, parent_pid: u32) -> String {
    let installer = powershell_single_quoted(&installer_path.display().to_string());
    format!(
        "Wait-Process -Id {parent_pid} -ErrorAction SilentlyContinue; Start-Process -FilePath '{installer}' -ArgumentList @('/S')"
    )
}

fn launch_installer_after_exit(installer_path: &Path, parent_pid: u32) -> Result<(), CommandError> {
    let mut launcher = Command::new("powershell.exe");
    configure_hidden_command(&mut launcher);
    launcher
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
        ])
        .arg(deferred_installer_script(installer_path, parent_pid));
    launcher
        .spawn()
        .map(|_| ())
        .map_err(|_| CommandError::UpdateUnavailable("UPDATE_INSTALLER_START_FAILED".into()))
}

fn create_installer_file(version: &str) -> Result<(PathBuf, std::fs::File), CommandError> {
    let mut random = [0u8; 16];
    unsafe {
        if BCryptGenRandom(None, &mut random, BCRYPT_USE_SYSTEM_PREFERRED_RNG).is_err() {
            return Err(CommandError::UpdateUnavailable(
                "UPDATE_INSTALLER_TEMP_UNAVAILABLE".into(),
            ));
        }
    }
    let entropy = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    for attempt in 0..32u32 {
        let path =
            std::env::temp_dir().join(format!("Blogbot-{version}-{entropy}-{attempt}.setup.exe"));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => {
                return Err(CommandError::UpdateUnavailable(
                    "UPDATE_INSTALLER_WRITE_FAILED".into(),
                ))
            }
        }
    }
    Err(CommandError::UpdateUnavailable(
        "UPDATE_INSTALLER_TEMP_UNAVAILABLE".into(),
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
    checked_update_authorization()
        .lock()
        .map_err(|_| CommandError::UpdateUnavailable("UPDATE_AUTHORIZATION_UNAVAILABLE".into()))?
        .as_ref()
        .ok_or_else(|| CommandError::InvalidInput("UPDATE_CHECK_REQUIRED".into()))?
        .validate(&request)?;
    validate_release_url(&request.url)?;
    validate_sha256(&request.sha256)?;
    if !is_newer_version(&request.version)? {
        return Err(CommandError::InvalidInput("UPDATE_NOT_NEWER".into()));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|_| CommandError::UpdateUnavailable("UPDATE_CLIENT_UNAVAILABLE".into()))?;
    let mut response = client
        .get(&request.url)
        .send()
        .await
        .map_err(|_| CommandError::UpdateUnavailable("UPDATE_DOWNLOAD_UNAVAILABLE".into()))?
        .error_for_status()
        .map_err(|_| CommandError::UpdateUnavailable("UPDATE_DOWNLOAD_HTTP_ERROR".into()))?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_INSTALLER_BYTES)
    {
        return Err(CommandError::UpdateUnavailable(
            "UPDATE_DOWNLOAD_TOO_LARGE".into(),
        ));
    }
    let (path, mut installer_file) = create_installer_file(&request.version)?;
    let mut digest = Sha256::new();
    let mut downloaded = 0u64;
    while let Some(chunk) = match response.chunk().await {
        Ok(chunk) => chunk,
        Err(_) => {
            let _ = std::fs::remove_file(&path);
            return Err(CommandError::UpdateUnavailable(
                "UPDATE_DOWNLOAD_FAILED".into(),
            ));
        }
    } {
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > MAX_INSTALLER_BYTES {
            let _ = std::fs::remove_file(&path);
            return Err(CommandError::UpdateUnavailable(
                "UPDATE_DOWNLOAD_TOO_LARGE".into(),
            ));
        }
        digest.update(&chunk);
        if installer_file.write_all(&chunk).is_err() {
            let _ = std::fs::remove_file(&path);
            return Err(CommandError::UpdateUnavailable(
                "UPDATE_INSTALLER_WRITE_FAILED".into(),
            ));
        }
    }
    if installer_file.sync_all().is_err() {
        let _ = std::fs::remove_file(&path);
        return Err(CommandError::UpdateUnavailable(
            "UPDATE_INSTALLER_WRITE_FAILED".into(),
        ));
    }
    drop(installer_file);

    let actual = format!("{:x}", digest.finalize());
    if actual != request.sha256.to_ascii_lowercase() {
        let _ = std::fs::remove_file(&path);
        return Err(CommandError::UpdateUnavailable(
            "UPDATE_HASH_MISMATCH".into(),
        ));
    }

    if launch_installer_after_exit(&path, std::process::id()).is_err() {
        let _ = std::fs::remove_file(&path);
        return Err(CommandError::UpdateUnavailable(
            "UPDATE_INSTALLER_START_FAILED".into(),
        ));
    }
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        current_version, github_release_update, is_newer_version, manifest_update,
        resolve_manifest_or_release, validate_release_url, validate_sha256,
        CheckedUpdateAuthorization, CommandError, GithubRelease, InstallUnsignedUpdateRequest,
        ReleaseManifest, UnsignedUpdate, UnsignedUpdateCheck, UpdateFreshness,
        update_freshness_for_version,
    };

    fn next_test_version() -> String {
        let mut segments = current_version()
            .split('.')
            .map(|segment| segment.parse::<u64>().expect("package version is semver"));
        let major = segments.next().expect("major version");
        let minor = segments.next().expect("minor version");
        let patch = segments.next().expect("patch version") + 1;
        assert!(
            segments.next().is_none(),
            "package version has three segments"
        );
        format!("{major}.{minor}.{patch}")
    }

    #[test]
    fn update_check_distinguishes_current_build_from_a_local_build_that_is_newer_than_release() {
        assert_eq!(
            update_freshness_for_version(current_version()).unwrap(),
            UpdateFreshness::UpToDate
        );
        assert_eq!(
            update_freshness_for_version("0.1.29").unwrap(),
            UpdateFreshness::LocalBuildNewer
        );
        assert_eq!(
            update_freshness_for_version(&next_test_version()).unwrap(),
            UpdateFreshness::UpdateAvailable
        );

        let payload = serde_json::to_value(UnsignedUpdateCheck::LocalBuildNewer {
            latest_version: "0.1.29".into(),
        })
        .expect("update check must serialize for the Tauri bridge");
        assert_eq!(payload["kind"], "localBuildNewer");
        assert_eq!(payload["latestVersion"], "0.1.29");
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
        assert!(matches!(
            manifest_update(manifest).unwrap(),
            UnsignedUpdateCheck::UpdateAvailable { .. }
        ));
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
        let UnsignedUpdateCheck::UpdateAvailable { update } = github_release_update(release).unwrap() else {
            panic!("newer GitHub release must offer an installer");
        };
        assert_eq!(update.version, version);
        assert_eq!(update.sha256, "a".repeat(64));
    }

    #[test]
    fn falls_back_to_the_github_release_when_the_manifest_endpoint_is_temporarily_unavailable() {
        let fallback = UnsignedUpdate {
            version: "0.1.15".into(),
            notes: "Yerel düzeltmeler.".into(),
            url: "https://github.com/ucsahinn/blogbot/releases/download/v0.1.15/Blogbot_0.1.15_x64-setup.exe".into(),
            sha256: "a".repeat(64),
        };

        let result = resolve_manifest_or_release(
            Err(CommandError::UpdateUnavailable(
                "UPDATE_MANIFEST_UNAVAILABLE".into(),
            )),
            Ok(UnsignedUpdateCheck::UpdateAvailable { update: fallback }),
        )
        .unwrap();

        let UnsignedUpdateCheck::UpdateAvailable { update } = result else {
            panic!("release fallback must offer its verified installer");
        };
        assert_eq!(update.version, "0.1.15");
    }

    #[test]
    fn install_authorization_rejects_a_renderer_mixing_manifest_tuple_fields() {
        let version = next_test_version();
        let checked = UnsignedUpdate {
            version: version.clone(),
            notes: "Official release".into(),
            url: format!(
                "https://github.com/ucsahinn/blogbot/releases/download/v{version}/Blogbot_{version}_x64-setup.exe"
            ),
            sha256: "a".repeat(64),
        };
        let authorization = CheckedUpdateAuthorization::new(&checked);
        let official = InstallUnsignedUpdateRequest {
            version: checked.version.clone(),
            url: checked.url.clone(),
            sha256: checked.sha256.clone(),
        };

        assert!(authorization.validate(&official).is_ok());

        let mismatches = [
            InstallUnsignedUpdateRequest {
                version: format!("{}.0", checked.version),
                url: official.url.clone(),
                sha256: official.sha256.clone(),
            },
            InstallUnsignedUpdateRequest {
                version: official.version.clone(),
                url: official.url.replace("Blogbot_", "Forged_"),
                sha256: official.sha256.clone(),
            },
            InstallUnsignedUpdateRequest {
                version: official.version.clone(),
                url: official.url.clone(),
                sha256: "b".repeat(64),
            },
        ];
        for request in mismatches {
            assert!(
                authorization.validate(&request).is_err(),
                "every requested field must match the exact checked manifest tuple"
            );
        }
    }

    #[test]
    fn defers_the_silent_installer_until_the_current_process_has_exited() {
        let script =
            super::deferred_installer_script(Path::new(r"C:\Temp\Blogbot O'Brien.setup.exe"), 4242);

        assert!(script.contains("Wait-Process -Id 4242"));
        assert!(script.contains("Start-Process -FilePath 'C:\\Temp\\Blogbot O''Brien.setup.exe'"));
        assert!(script.contains("-ArgumentList @('/S')"));
    }
}
