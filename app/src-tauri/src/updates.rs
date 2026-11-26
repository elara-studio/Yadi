//! "Check for updates" (Settings), on the person's request only.
//!
//! Yadi compares its own version with the latest published release of its GitHub repository
//! (`REPO`). If the release is newer, the person can download the installer for their computer;
//! it is verified against the SHA-256 digest GitHub records for the file, then opened (macOS: the
//! disk image; Windows: the installer) and Yadi closes so it can be replaced.
//!
//! Nothing here runs by itself: there is no background check and no data is sent (the request is a
//! plain read of public release information). Until the repository has a published release, the
//! check answers "no release published yet".

use std::cmp::Ordering;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::StatusCode;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::download::{CancelToken, DownloadError, Downloader};

/// The GitHub repository whose releases are checked (`owner/name`).
pub const REPO: &str = "elara-studio/Yadi";
const API_BASE: &str = "https://api.github.com";

// ---- versions -------------------------------------------------------------------------------

/// `1.2.3` or `1.2.3-beta.1` (a leading `v` is ignored). Build metadata (`+...`) is dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    parts: [u64; 3],
    pre: Option<String>,
}

impl Version {
    pub fn parse(text: &str) -> Option<Self> {
        let t = text.trim();
        let t = t.strip_prefix(['v', 'V']).unwrap_or(t);
        let t = t.split('+').next()?;
        let (core, pre) = match t.split_once('-') {
            Some((c, p)) if !p.is_empty() => (c, Some(p.to_string())),
            Some(_) => return None,
            None => (t, None),
        };
        let mut nums = core.split('.');
        let mut parts = [0u64; 3];
        for part in &mut parts {
            *part = nums.next()?.parse().ok()?;
        }
        if nums.next().is_some() {
            return None;
        }
        Some(Self { parts, pre })
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        self.parts
            .cmp(&other.parts)
            .then_with(|| match (&self.pre, &other.pre) {
                // 1.0.0 is newer than 1.0.0-beta.
                (None, None) => Ordering::Equal,
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                (Some(a), Some(b)) => compare_prerelease(a, b),
            })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// `beta.2` < `beta.10`: dot-separated parts, numbers compared as numbers.
fn compare_prerelease(a: &str, b: &str) -> Ordering {
    let (mut a, mut b) = (a.split('.'), b.split('.'));
    loop {
        match (a.next(), b.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => {
                let ord = match (x.parse::<u64>(), y.parse::<u64>()) {
                    (Ok(x), Ok(y)) => x.cmp(&y),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => x.cmp(y),
                };
                if ord != Ordering::Equal {
                    return ord;
                }
            }
        }
    }
}

// ---- the GitHub release ---------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct Asset {
    pub name: String,
    #[serde(default)]
    pub size: u64,
    pub browser_download_url: String,
    /// `sha256:<hex>`, recorded by GitHub for every uploaded file.
    #[serde(default)]
    pub digest: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Release {
    pub tag_name: String,
    #[serde(default)]
    pub body: Option<String>,
    pub html_url: String,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub assets: Vec<Asset>,
}

impl Asset {
    /// The lowercase SHA-256 from the digest GitHub recorded, if there is one.
    pub fn sha256(&self) -> Option<String> {
        let hex = self
            .digest
            .as_deref()?
            .strip_prefix("sha256:")?
            .to_ascii_lowercase();
        (hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit())).then_some(hex)
    }
}

/// The installer for this computer among a release's files, or `None`.
/// macOS: the `.dmg` for this processor. Windows: the `-setup.exe` (NSIS installer).
pub fn pick_asset<'a>(os: &str, arch: &str, assets: &'a [Asset]) -> Option<&'a Asset> {
    let wanted_ext = match os {
        "macos" => ".dmg",
        "windows" => ".exe",
        _ => return None,
    };
    let arm = ["aarch64", "arm64"];
    let intel = ["x64", "x86_64", "amd64"];
    let (mine, other): (&[&str], &[&str]) = match arch {
        "aarch64" => (&arm, &intel),
        "x86_64" => (&intel, &arm),
        _ => return None,
    };
    let candidates: Vec<&Asset> = assets
        .iter()
        .filter(|a| {
            let n = a.name.to_ascii_lowercase();
            n.ends_with(wanted_ext) && (os != "windows" || n.contains("setup"))
        })
        .collect();
    let has = |a: &Asset, tokens: &[&str]| {
        let n = a.name.to_ascii_lowercase();
        tokens.iter().any(|t| n.contains(t))
    };
    // Prefer a file named for this processor; accept an unlabelled one (a universal build) but
    // never one named for the other processor.
    candidates
        .iter()
        .copied()
        .find(|a| has(a, mine))
        .or_else(|| candidates.iter().copied().find(|a| !has(a, other)))
}

/// Only files published by the repository itself are ever downloaded.
fn is_trusted_download_url(url: &str) -> bool {
    url.starts_with(&format!("https://github.com/{REPO}/releases/download/"))
}

fn is_trusted_page_url(url: &str) -> bool {
    url.starts_with(&format!("https://github.com/{REPO}/"))
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        // GitHub's API rejects requests without a User-Agent. It names the app, nothing else.
        .user_agent("Yadi-update-check")
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

const OFFLINE: &str = "Yadi could not reach GitHub. Check your internet connection and try again.";

/// The latest published release, or `None` when there is none (or the repository is not public
/// yet). Drafts and pre-releases are never offered.
pub fn fetch_latest(base: &str, repo: &str) -> Result<Option<Release>, String> {
    let response = http_client()?
        .get(format!("{base}/repos/{repo}/releases/latest"))
        .header("Accept", "application/vnd.github+json")
        .send()
        .map_err(|_| OFFLINE.to_string())?;
    match response.status() {
        StatusCode::OK => {
            let text = response.text().map_err(|_| OFFLINE.to_string())?;
            let release: Release = serde_json::from_str(&text)
                .map_err(|_| "GitHub sent an answer Yadi could not read.".to_string())?;
            Ok((!release.draft && !release.prerelease).then_some(release))
        }
        StatusCode::NOT_FOUND => Ok(None),
        StatusCode::FORBIDDEN | StatusCode::TOO_MANY_REQUESTS => {
            Err("GitHub is asking Yadi to slow down. Please try again in a little while.".into())
        }
        s => Err(format!(
            "GitHub answered with an error (HTTP {}).",
            s.as_u16()
        )),
    }
}

// ---- what the screen is told ----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum UpdateCheck {
    /// No release has been published yet.
    NoRelease {
        current: String,
    },
    UpToDate {
        current: String,
        latest: String,
    },
    Available {
        current: String,
        latest: String,
        notes: String,
        page_url: String,
        /// Can Yadi install it itself? Otherwise the person is sent to the release page.
        installable: bool,
        /// Why it cannot be installed here, in plain words.
        reason: Option<String>,
        size_bytes: Option<u64>,
    },
}

/// Decides what to tell the person about `release` (pure; the network part is `fetch_latest`).
pub fn evaluate(
    current: &str,
    release: Option<&Release>,
    os: &str,
    arch: &str,
) -> Result<UpdateCheck, String> {
    let Some(release) = release else {
        return Ok(UpdateCheck::NoRelease {
            current: current.to_string(),
        });
    };
    let mine = Version::parse(current).ok_or("Yadi does not know its own version number.")?;
    let latest = Version::parse(&release.tag_name).ok_or_else(|| {
        format!(
            "The newest release has an unusual name ({}).",
            release.tag_name
        )
    })?;
    let latest_text = release.tag_name.trim_start_matches(['v', 'V']).to_string();
    if latest <= mine {
        return Ok(UpdateCheck::UpToDate {
            current: current.to_string(),
            latest: latest_text,
        });
    }
    let asset = pick_asset(os, arch, &release.assets);
    let reason = match asset {
        None => Some("There is no installer for this computer in that release.".to_string()),
        Some(a) if a.sha256().is_none() => {
            Some("The installer has no checksum to verify it with.".to_string())
        }
        Some(a) if !is_trusted_download_url(&a.browser_download_url) => {
            Some("The installer is not hosted where Yadi expects it.".to_string())
        }
        Some(_) => None,
    };
    Ok(UpdateCheck::Available {
        current: current.to_string(),
        latest: latest_text,
        notes: release
            .body
            .clone()
            .unwrap_or_default()
            .chars()
            .take(4000)
            .collect(),
        page_url: release.html_url.clone(),
        installable: reason.is_none(),
        reason,
        size_bytes: asset.map(|a| a.size).filter(|s| *s > 0),
    })
}

fn current_os() -> &'static str {
    std::env::consts::OS
}

fn fetch_and_evaluate(current: &str) -> Result<(UpdateCheck, Option<Release>), String> {
    let release = fetch_latest(API_BASE, REPO)?;
    let check = evaluate(
        current,
        release.as_ref(),
        current_os(),
        std::env::consts::ARCH,
    )?;
    Ok((check, release))
}

// ---- commands -------------------------------------------------------------------------------

#[derive(Default)]
pub struct UpdateState {
    cancel: Mutex<Option<CancelToken>>,
    /// The verified installer, once downloaded. `install_update` only ever opens this path.
    ready: Mutex<Option<PathBuf>>,
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateCheck, String> {
    let current = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || fetch_and_evaluate(&current).map(|(c, _)| c))
        .await
        .map_err(|e| e.to_string())?
}

fn updates_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("updates"))
        .map_err(|e| format!("no app data directory: {e}"))
}

/// Downloads the installer of the newest release and checks it against GitHub's SHA-256. Emits
/// `update:progress {received, total, phase?}`. The release is looked up again here, so the screen
/// never decides what gets downloaded.
#[tauri::command]
pub async fn download_update(app: AppHandle, state: State<'_, UpdateState>) -> Result<(), String> {
    let token = {
        let mut slot = state.cancel.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_some() {
            return Err("The update is already downloading.".into());
        }
        let t = CancelToken::new();
        *slot = Some(t.clone());
        t
    };
    *state.ready.lock().unwrap_or_else(|e| e.into_inner()) = None;

    let current = app.package_info().version.to_string();
    let dir = updates_dir(&app)?;
    let emit_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<PathBuf, String> {
        let (check, release) = fetch_and_evaluate(&current)?;
        let UpdateCheck::Available {
            installable, reason, ..
        } = check
        else {
            return Err("There is no newer version to install.".into());
        };
        if !installable {
            return Err(reason.unwrap_or_else(|| "This update cannot be installed here.".into()));
        }
        let release = release.ok_or("There is no newer version to install.")?;
        let asset = pick_asset(current_os(), std::env::consts::ARCH, &release.assets)
            .ok_or("There is no installer for this computer.")?;
        let sha = asset.sha256().ok_or("The installer has no checksum.")?;

        // A file name from the network is never used as a path: keep only its last component.
        let file_name = std::path::Path::new(&asset.name)
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("The installer has an unusual file name.")?
            .to_string();
        // Earlier downloads (older versions) are no longer needed.
        let _ = fs::remove_dir_all(&dir);
        let dest = dir.join(&file_name);

        let downloader = Downloader::new().map_err(|e| e.to_string())?;
        let mut last = Instant::now() - Duration::from_secs(1);
        let mut progress = |received: u64, total: Option<u64>| {
            if last.elapsed() >= Duration::from_millis(100) || total == Some(received) {
                last = Instant::now();
                let _ = emit_app.emit(
                    "update:progress",
                    json!({ "received": received, "total": total }),
                );
            }
        };
        downloader
            .download(
                &asset.browser_download_url,
                &dest,
                Some(&sha),
                &mut progress,
                &token,
            )
            .map_err(|e| match e {
                DownloadError::ChecksumMismatch { .. } => {
                    "The downloaded file did not match its checksum, so it was deleted. Please try again.".to_string()
                }
                other => other.to_string(),
            })?;
        Ok(dest)
    })
    .await
    .map_err(|e| format!("download task failed: {e}"))?;

    *state.cancel.lock().unwrap_or_else(|e| e.into_inner()) = None;
    let path = result?;
    *state.ready.lock().unwrap_or_else(|e| e.into_inner()) = Some(path);
    Ok(())
}

#[tauri::command]
pub fn cancel_update_download(state: State<UpdateState>) {
    if let Some(t) = state
        .cancel
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
    {
        t.cancel();
    }
}

/// Opens the downloaded installer and quits Yadi so it can be replaced.
#[tauri::command]
pub fn install_update(app: AppHandle, state: State<UpdateState>) -> Result<(), String> {
    let path = state
        .ready
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or("There is no downloaded update to install.")?;
    if !path.is_file() {
        return Err("The downloaded update is no longer there. Please download it again.".into());
    }
    launch_installer(&path)?;
    log::info!("update installer opened; quitting so it can replace Yadi");
    // Give the installer a moment to appear before the mascot disappears.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(800));
        app.exit(0);
    });
    Ok(())
}

#[cfg(target_os = "macos")]
fn launch_installer(path: &std::path::Path) -> Result<(), String> {
    // Opens the disk image in Finder: the person drags Yadi onto Applications.
    let status = std::process::Command::new("open")
        .arg(path)
        .status()
        .map_err(|e| format!("could not open the installer: {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "macOS could not open the installer.".to_string())
}

#[cfg(windows)]
fn launch_installer(path: &std::path::Path) -> Result<(), String> {
    // Yadi's installer is per-user (no administrator rights) and asks Yadi to close if needed.
    std::process::Command::new(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not start the installer: {e}"))
}

#[cfg(not(any(target_os = "macos", windows)))]
fn launch_installer(_path: &std::path::Path) -> Result<(), String> {
    Err("Installing updates is not supported on this system.".into())
}

/// Opens the release page in the browser (the way out when Yadi cannot install by itself).
#[tauri::command]
pub fn open_release_page(url: String) -> Result<(), String> {
    if !is_trusted_page_url(&url) {
        return Err("That is not a page of Yadi's releases.".into());
    }
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(windows)]
    let mut cmd = {
        let mut c = std::process::Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    #[cfg(not(any(target_os = "macos", windows)))]
    let mut cmd = std::process::Command::new("xdg-open");
    cmd.arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not open the browser: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::download::testserver::{Server, ServerConfig};

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap_or_else(|| panic!("{s} should parse"))
    }

    fn asset(name: &str) -> Asset {
        Asset {
            name: name.into(),
            size: 1000,
            browser_download_url: format!(
                "https://github.com/{REPO}/releases/download/v0.2.0/{name}"
            ),
            digest: Some(format!("sha256:{}", "ab".repeat(32))),
        }
    }

    fn release(tag: &str, assets: Vec<Asset>) -> Release {
        Release {
            tag_name: tag.into(),
            body: Some("What is new".into()),
            html_url: format!("https://github.com/{REPO}/releases/tag/{tag}"),
            draft: false,
            prerelease: false,
            assets,
        }
    }

    fn standard_assets() -> Vec<Asset> {
        vec![
            asset("Yadi_0.2.0_aarch64.dmg"),
            asset("Yadi_0.2.0_x64-setup.exe"),
            asset("Yadi_0.2.0_x64.dmg"),
        ]
    }

    #[test]
    fn versions_parse_with_or_without_a_v_and_reject_nonsense() {
        assert_eq!(v("0.1.0"), v("v0.1.0"));
        assert!(Version::parse("1.2").is_none());
        assert!(Version::parse("1.2.3.4").is_none());
        assert!(Version::parse("one.two.three").is_none());
        assert!(Version::parse("1.2.3-").is_none());
        assert!(Version::parse("").is_none());
        assert_eq!(v("1.2.3+build5"), v("1.2.3"));
    }

    #[test]
    fn versions_compare_as_numbers_not_text() {
        assert!(v("0.10.0") > v("0.9.0"));
        assert!(v("1.0.0") > v("0.99.99"));
        assert!(v("0.1.1") > v("0.1.0"));
        assert!(v("0.1.0") == v("0.1.0"));
    }

    #[test]
    fn a_pre_release_is_older_than_its_release() {
        assert!(v("1.0.0") > v("1.0.0-beta.1"));
        assert!(v("1.0.0-beta.2") > v("1.0.0-beta.1"));
        assert!(v("1.0.0-beta.10") > v("1.0.0-beta.2"));
        assert!(v("1.0.0-rc.1") > v("1.0.0-beta.9"));
        assert!(v("1.0.1-beta.1") > v("1.0.0"));
    }

    #[test]
    fn the_right_installer_is_picked_for_each_computer() {
        let assets = standard_assets();
        let name = |os, arch| pick_asset(os, arch, &assets).map(|a| a.name.as_str());
        assert_eq!(name("macos", "aarch64"), Some("Yadi_0.2.0_aarch64.dmg"));
        assert_eq!(name("macos", "x86_64"), Some("Yadi_0.2.0_x64.dmg"));
        assert_eq!(name("windows", "x86_64"), Some("Yadi_0.2.0_x64-setup.exe"));
        assert_eq!(name("linux", "x86_64"), None);
    }

    #[test]
    fn a_dmg_for_the_other_processor_is_never_picked() {
        let assets = vec![asset("Yadi_0.2.0_aarch64.dmg")];
        assert!(pick_asset("macos", "x86_64", &assets).is_none());
        // A build with no processor in its name is taken to be universal.
        let universal = vec![asset("Yadi_0.2.0_universal.dmg")];
        assert!(pick_asset("macos", "x86_64", &universal).is_some());
        assert!(pick_asset("macos", "aarch64", &universal).is_some());
    }

    #[test]
    fn digests_are_read_only_when_well_formed() {
        let mut a = asset("x.dmg");
        assert_eq!(a.sha256().as_deref(), Some("ab".repeat(32).as_str()));
        a.digest = Some("sha256:XYZ".into());
        assert!(a.sha256().is_none());
        a.digest = Some("md5:abcd".into());
        assert!(a.sha256().is_none());
        a.digest = None;
        assert!(a.sha256().is_none());
        a.digest = Some(format!("sha256:{}", "AB".repeat(32)));
        assert_eq!(a.sha256().as_deref(), Some("ab".repeat(32).as_str()));
    }

    #[test]
    fn no_release_yet_is_not_an_error() {
        assert_eq!(
            evaluate("0.1.0", None, "macos", "aarch64").unwrap(),
            UpdateCheck::NoRelease {
                current: "0.1.0".into()
            }
        );
    }

    #[test]
    fn the_same_or_an_older_release_means_up_to_date() {
        for tag in ["v0.1.0", "v0.0.9"] {
            let r = release(tag, standard_assets());
            assert!(matches!(
                evaluate("0.1.0", Some(&r), "macos", "aarch64").unwrap(),
                UpdateCheck::UpToDate { .. }
            ));
        }
    }

    #[test]
    fn a_newer_release_is_offered_with_its_notes_and_size() {
        let r = release("v0.2.0", standard_assets());
        match evaluate("0.1.0", Some(&r), "macos", "aarch64").unwrap() {
            UpdateCheck::Available {
                latest,
                notes,
                installable,
                reason,
                size_bytes,
                ..
            } => {
                assert_eq!(latest, "0.2.0");
                assert_eq!(notes, "What is new");
                assert!(installable && reason.is_none());
                assert_eq!(size_bytes, Some(1000));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_release_without_an_installer_for_this_computer_sends_the_person_to_the_page() {
        let r = release("v0.2.0", vec![asset("Yadi_0.2.0_x64-setup.exe")]);
        match evaluate("0.1.0", Some(&r), "macos", "aarch64").unwrap() {
            UpdateCheck::Available {
                installable,
                reason,
                page_url,
                ..
            } => {
                assert!(!installable);
                assert!(reason.unwrap().contains("no installer"));
                assert!(page_url.starts_with("https://github.com/"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn an_installer_without_a_checksum_is_not_installed_automatically() {
        let mut a = asset("Yadi_0.2.0_aarch64.dmg");
        a.digest = None;
        let r = release("v0.2.0", vec![a]);
        match evaluate("0.1.0", Some(&r), "macos", "aarch64").unwrap() {
            UpdateCheck::Available {
                installable,
                reason,
                ..
            } => {
                assert!(!installable);
                assert!(reason.unwrap().contains("checksum"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn an_installer_hosted_somewhere_else_is_not_trusted() {
        let mut a = asset("Yadi_0.2.0_aarch64.dmg");
        a.browser_download_url = "https://evil.example/Yadi_0.2.0_aarch64.dmg".into();
        let r = release("v0.2.0", vec![a]);
        match evaluate("0.1.0", Some(&r), "macos", "aarch64").unwrap() {
            UpdateCheck::Available { installable, .. } => assert!(!installable),
            other => panic!("{other:?}"),
        }
        assert!(!is_trusted_download_url(
            "https://github.com/other/Yadi/releases/download/v1/x.dmg"
        ));
        assert!(!is_trusted_download_url(&format!(
            "http://github.com/{REPO}/releases/download/v1/x.dmg"
        )));
        assert!(is_trusted_page_url(&format!(
            "https://github.com/{REPO}/releases/tag/v1"
        )));
        assert!(!is_trusted_page_url("https://github.com.evil.example/x"));
    }

    #[test]
    fn a_strange_tag_is_reported_not_guessed() {
        let r = release("nightly", vec![]);
        assert!(evaluate("0.1.0", Some(&r), "macos", "aarch64").is_err());
    }

    fn base_of(server: &Server) -> String {
        server.url().trim_end_matches("/model.bin").to_string()
    }

    #[test]
    fn the_latest_release_is_read_from_github_json() {
        let body = serde_json::json!({
            "tag_name": "v0.3.0",
            "html_url": "https://github.com/elara-studio/Yadi/releases/tag/v0.3.0",
            "body": "Notes",
            "draft": false,
            "prerelease": false,
            "assets": [{
                "name": "Yadi_0.3.0_aarch64.dmg",
                "size": 5,
                "browser_download_url": "https://github.com/elara-studio/Yadi/releases/download/v0.3.0/Yadi_0.3.0_aarch64.dmg",
                "digest": format!("sha256:{}", "cd".repeat(32)),
                "unknown_field": 1
            }]
        });
        let server = Server::start(ServerConfig::new(body.to_string().into_bytes()));
        let r = fetch_latest(&base_of(&server), REPO).unwrap().unwrap();
        assert_eq!(r.tag_name, "v0.3.0");
        assert_eq!(r.assets.len(), 1);
        assert!(r.assets[0].sha256().is_some());
    }

    #[test]
    fn a_pre_release_or_draft_is_not_offered() {
        for flag in ["draft", "prerelease"] {
            let body = serde_json::json!({
                "tag_name": "v9.0.0", "html_url": "https://github.com/x/y", flag: true
            });
            let server = Server::start(ServerConfig::new(body.to_string().into_bytes()));
            assert!(fetch_latest(&base_of(&server), REPO).unwrap().is_none());
        }
    }

    #[test]
    fn a_repository_with_no_releases_reads_as_none() {
        let mut cfg = ServerConfig::new(vec![]);
        cfg.status_override = Some(404);
        let server = Server::start(cfg);
        assert!(fetch_latest(&base_of(&server), REPO).unwrap().is_none());
    }

    #[test]
    fn rate_limits_and_server_errors_are_explained() {
        for (code, expect) in [(403, "slow down"), (429, "slow down"), (500, "HTTP 500")] {
            let mut cfg = ServerConfig::new(vec![]);
            cfg.status_override = Some(code);
            let server = Server::start(cfg);
            let err = fetch_latest(&base_of(&server), REPO).unwrap_err();
            assert!(err.contains(expect), "{code}: {err}");
        }
    }

    #[test]
    fn being_offline_is_explained_in_plain_words() {
        // Nothing listens on port 1.
        let err = fetch_latest("http://127.0.0.1:1", REPO).unwrap_err();
        assert!(err.contains("internet connection"), "{err}");
    }

    #[test]
    fn garbage_from_the_server_is_not_a_crash() {
        let server = Server::start(ServerConfig::new(b"<html>not json</html>".to_vec()));
        assert!(
            fetch_latest(&base_of(&server), REPO)
                .unwrap_err()
                .contains("could not read")
        );
    }
}
