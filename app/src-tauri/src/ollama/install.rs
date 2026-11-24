//! Installing Ollama with the user's consent.
//!
//! Ollama publishes no checksum for its installers, so the download is verified by its **code
//! signature** instead (macOS `codesign` and the signing team; Windows Authenticode, valid and
//! with an Ollama subject). A failed check aborts and deletes everything.
//!
//! The steps are traits so the order and the failure handling are unit-tested without touching
//! the system; the real macOS/Windows steps are only run with the user's consent.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::download::{CancelToken, DownloadError, Downloader};

/// Official download URLs (both redirect to the project's GitHub releases; checked 2026-11-24).
pub const MAC_URL: &str = "https://ollama.com/download/Ollama-darwin.zip";
pub const WINDOWS_URL: &str = "https://ollama.com/download/OllamaSetup.exe";

/// Apple Developer Team ID of the app signed as "Infra Technologies, Inc" (Ollama's publisher),
/// read from the signature of an installed official Ollama.app with `codesign -dv --verbose=4`.
pub const MAC_TEAM_ID: &str = "3MU9H2V9Y9";

#[derive(Debug, PartialEq, Eq)]
pub enum InstallError {
    /// The user has not agreed. Nothing was downloaded.
    ConsentRequired,
    Download(DownloadError),
    /// The signature check failed; the download was deleted.
    Signature(String),
    Step(String),
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InstallError::ConsentRequired => {
                f.write_str("Installing Ollama needs your permission first.")
            }
            InstallError::Download(e) => write!(f, "{e}"),
            InstallError::Signature(m) => write!(
                f,
                "The downloaded installer did not pass the security check ({m}), so it was not installed."
            ),
            InstallError::Step(m) => write!(f, "Installing Ollama failed: {m}"),
        }
    }
}

pub trait SignatureChecker {
    fn verify(&self, artifact: &Path) -> Result<(), String>;
}

/// Platform-specific steps around the download.
pub trait Steps {
    fn url(&self) -> &str;
    fn file_name(&self) -> &str;
    /// Turns the downloaded file into the thing whose signature is checked (macOS: unpack the zip
    /// and return the `.app`; Windows: the installer itself).
    fn prepare(&self, downloaded: &Path, work_dir: &Path) -> Result<PathBuf, String>;
    /// Performs the install of a verified artifact and returns where Ollama now is.
    fn finish(&self, artifact: &Path) -> Result<PathBuf, String>;
}

/// Downloads, verifies and installs. Refuses unless `consent` is true.
pub fn install(
    consent: bool,
    downloader: &Downloader,
    steps: &dyn Steps,
    checker: &dyn SignatureChecker,
    work_dir: &Path,
    progress: &mut dyn FnMut(u64, Option<u64>),
    cancel: &CancelToken,
) -> Result<PathBuf, InstallError> {
    if !consent {
        return Err(InstallError::ConsentRequired);
    }
    fs::create_dir_all(work_dir).map_err(|e| InstallError::Step(e.to_string()))?;
    let downloaded = work_dir.join(steps.file_name());
    let cleanup = |paths: &[&Path]| {
        for p in paths {
            let _ = fs::remove_file(p);
            let _ = fs::remove_dir_all(p);
        }
    };

    downloader
        .download(steps.url(), &downloaded, None, progress, cancel)
        .map_err(InstallError::Download)?;

    let artifact = match steps.prepare(&downloaded, work_dir) {
        Ok(a) => a,
        Err(e) => {
            cleanup(&[&downloaded]);
            return Err(InstallError::Step(e));
        }
    };
    if let Err(why) = checker.verify(&artifact) {
        cleanup(&[&downloaded, &artifact]);
        return Err(InstallError::Signature(why));
    }
    let result = steps.finish(&artifact).map_err(InstallError::Step);
    cleanup(&[&downloaded, &artifact]);
    result
}

// ---- real implementations ------------------------------------------------------------------

fn run(cmd: &mut Command) -> Result<String, String> {
    let out = cmd
        .output()
        .map_err(|e| format!("could not run {:?}: {e}", cmd.get_program()))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if out.status.success() {
        Ok(text)
    } else {
        Err(format!(
            "{:?} failed ({}): {}",
            cmd.get_program(),
            out.status,
            text.trim()
        ))
    }
}

/// `TeamIdentifier=XXXXXXXXXX` from `codesign -dv --verbose=4` output.
pub fn parse_team_id(codesign_output: &str) -> Option<&str> {
    codesign_output
        .lines()
        .find_map(|l| l.trim().strip_prefix("TeamIdentifier="))
        .map(str::trim)
        .filter(|t| !t.is_empty() && *t != "not set")
}

pub struct MacChecker;

impl SignatureChecker for MacChecker {
    fn verify(&self, app: &Path) -> Result<(), String> {
        run(Command::new("codesign")
            .args(["--verify", "--deep", "--strict"])
            .arg(app))
        .map_err(|e| format!("signature is not valid: {e}"))?;
        let info = run(Command::new("codesign")
            .args(["-dv", "--verbose=4"])
            .arg(app))?;
        match parse_team_id(&info) {
            Some(MAC_TEAM_ID) => Ok(()),
            Some(other) => Err(format!("signed by team {other}, expected {MAC_TEAM_ID}")),
            None => Err("no signing team found".into()),
        }
    }
}

pub struct MacSteps {
    /// Where to install: `/Applications`, falling back to `~/Applications`.
    pub targets: Vec<PathBuf>,
}

impl Steps for MacSteps {
    fn url(&self) -> &str {
        MAC_URL
    }
    fn file_name(&self) -> &str {
        "Ollama-darwin.zip"
    }
    fn prepare(&self, downloaded: &Path, work_dir: &Path) -> Result<PathBuf, String> {
        // `ditto` (built into macOS) unpacks zips while keeping symlinks and the code signature.
        let staging = work_dir.join("unpacked");
        let _ = fs::remove_dir_all(&staging);
        run(Command::new("ditto")
            .args(["-x", "-k"])
            .arg(downloaded)
            .arg(&staging))?;
        let app = staging.join("Ollama.app");
        app.exists()
            .then_some(app)
            .ok_or_else(|| "the download did not contain Ollama.app".to_string())
    }
    fn finish(&self, app: &Path) -> Result<PathBuf, String> {
        let mut last = String::from("no install location is available");
        for dir in &self.targets {
            if fs::create_dir_all(dir).is_err() {
                continue;
            }
            let dest = dir.join("Ollama.app");
            let _ = fs::remove_dir_all(&dest);
            match run(Command::new("ditto").arg(app).arg(&dest)) {
                Ok(_) => return Ok(dest),
                Err(e) => last = e,
            }
        }
        Err(last)
    }
}

/// `Status` on line 1, signer certificate subject on line 2.
pub fn parse_authenticode(output: &str) -> Result<(), String> {
    let mut lines = output.lines().map(str::trim).filter(|l| !l.is_empty());
    let status = lines.next().unwrap_or("");
    let subject = lines.next().unwrap_or("");
    if status != "Valid" {
        return Err(format!("signature status is '{status}', expected 'Valid'"));
    }
    if !subject.to_ascii_lowercase().contains("ollama") {
        return Err(format!("signed by '{subject}', not by Ollama"));
    }
    Ok(())
}

pub struct WindowsChecker;

impl SignatureChecker for WindowsChecker {
    fn verify(&self, exe: &Path) -> Result<(), String> {
        let script = format!(
            "$s = Get-AuthenticodeSignature -LiteralPath '{}'; Write-Output $s.Status; Write-Output $s.SignerCertificate.Subject",
            exe.display().to_string().replace('\'', "''")
        );
        let out = run(Command::new("powershell").args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &script,
        ]))?;
        parse_authenticode(&out)
    }
}

pub struct WindowsSteps;

impl Steps for WindowsSteps {
    fn url(&self) -> &str {
        WINDOWS_URL
    }
    fn file_name(&self) -> &str {
        "OllamaSetup.exe"
    }
    fn prepare(&self, downloaded: &Path, _work_dir: &Path) -> Result<PathBuf, String> {
        Ok(downloaded.to_path_buf())
    }
    fn finish(&self, installer: &Path) -> Result<PathBuf, String> {
        // Ollama's installer is an Inno Setup installer (app/ollama.iss in its repository), so the
        // documented Inno switches apply: /SILENT (progress only), /SP- (no start prompt),
        // /NORESTART. It installs per user, no administrator rights needed.
        run(Command::new(installer).args(["/SILENT", "/SP-", "/NORESTART"]))?;
        let local = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .ok_or("LOCALAPPDATA is not set")?;
        let exe = local.join("Programs").join("Ollama").join("ollama.exe");
        exe.exists()
            .then_some(exe)
            .ok_or_else(|| "the installer finished but ollama.exe was not found".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::download::testserver::{Server, ServerConfig};
    use std::cell::RefCell;
    use std::time::Duration;

    #[derive(Default)]
    struct Calls(RefCell<Vec<String>>);
    struct FakeSteps<'a> {
        url: String,
        calls: &'a Calls,
    }
    impl Steps for FakeSteps<'_> {
        fn url(&self) -> &str {
            &self.url
        }
        fn file_name(&self) -> &str {
            "installer.bin"
        }
        fn prepare(&self, downloaded: &Path, _w: &Path) -> Result<PathBuf, String> {
            self.calls.0.borrow_mut().push("prepare".into());
            Ok(downloaded.to_path_buf())
        }
        fn finish(&self, _a: &Path) -> Result<PathBuf, String> {
            self.calls.0.borrow_mut().push("finish".into());
            Ok(PathBuf::from("/installed/ollama"))
        }
    }
    struct Checker<'a> {
        verdict: Result<(), String>,
        calls: &'a Calls,
    }
    impl SignatureChecker for Checker<'_> {
        fn verify(&self, _a: &Path) -> Result<(), String> {
            self.calls.0.borrow_mut().push("verify".into());
            self.verdict.clone()
        }
    }

    fn dl() -> Downloader {
        Downloader::new()
            .unwrap()
            .with_backoff(vec![])
            .with_free_space(Box::new(|_| Ok(u64::MAX)))
    }
    fn work(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("yadi-inst-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }
    fn server() -> Server {
        Server::start(ServerConfig::new(b"pretend this is an installer".to_vec()))
    }

    #[test]
    fn without_consent_it_refuses_and_downloads_nothing() {
        let s = server();
        let calls = Calls::default();
        let steps = FakeSteps {
            url: s.url(),
            calls: &calls,
        };
        let checker = Checker {
            verdict: Ok(()),
            calls: &calls,
        };
        let w = work("noconsent");
        let r = install(
            false,
            &dl(),
            &steps,
            &checker,
            &w,
            &mut |_, _| {},
            &CancelToken::new(),
        );
        assert_eq!(r, Err(InstallError::ConsentRequired));
        assert_eq!(s.requests().len(), 0, "not a single request was made");
        assert!(calls.0.borrow().is_empty());
        assert!(!w.exists(), "not even the work folder was created");
    }

    #[test]
    fn consent_runs_download_prepare_verify_finish_in_order_and_cleans_up() {
        let s = server();
        let calls = Calls::default();
        let steps = FakeSteps {
            url: s.url(),
            calls: &calls,
        };
        let checker = Checker {
            verdict: Ok(()),
            calls: &calls,
        };
        let w = work("ok");
        let r = install(
            true,
            &dl(),
            &steps,
            &checker,
            &w,
            &mut |_, _| {},
            &CancelToken::new(),
        );
        assert_eq!(r, Ok(PathBuf::from("/installed/ollama")));
        assert_eq!(calls.0.borrow().as_slice(), ["prepare", "verify", "finish"]);
        assert_eq!(s.requests().len(), 1);
        assert!(
            !w.join("installer.bin").exists(),
            "the installer file is deleted afterwards"
        );
        let _ = fs::remove_dir_all(&w);
    }

    #[test]
    fn a_failed_signature_check_aborts_before_installing_and_deletes_the_download() {
        let s = server();
        let calls = Calls::default();
        let steps = FakeSteps {
            url: s.url(),
            calls: &calls,
        };
        let checker = Checker {
            verdict: Err("signed by team EVIL123, expected 3MU9H2V9Y9".into()),
            calls: &calls,
        };
        let w = work("badsig");
        let r = install(
            true,
            &dl(),
            &steps,
            &checker,
            &w,
            &mut |_, _| {},
            &CancelToken::new(),
        );
        match r {
            Err(InstallError::Signature(m)) => assert!(m.contains("EVIL123")),
            other => panic!("{other:?}"),
        }
        assert_eq!(
            calls.0.borrow().as_slice(),
            ["prepare", "verify"],
            "finish was never called"
        );
        assert!(
            !w.join("installer.bin").exists(),
            "the untrusted download is removed"
        );
        let _ = fs::remove_dir_all(&w);
    }

    #[test]
    fn the_signature_error_message_is_user_readable() {
        let m = InstallError::Signature("expired".into()).to_string();
        assert!(
            m.contains("did not pass the security check") && m.contains("not installed"),
            "{m}"
        );
    }

    #[test]
    fn a_failed_download_is_reported_and_nothing_else_runs() {
        let mut cfg = ServerConfig::new(vec![]);
        cfg.status_override = Some(404);
        let s = Server::start(cfg);
        let calls = Calls::default();
        let steps = FakeSteps {
            url: s.url(),
            calls: &calls,
        };
        let checker = Checker {
            verdict: Ok(()),
            calls: &calls,
        };
        let r = install(
            true,
            &dl(),
            &steps,
            &checker,
            &work("404"),
            &mut |_, _| {},
            &CancelToken::new(),
        );
        assert_eq!(r, Err(InstallError::Download(DownloadError::Status(404))));
        assert!(calls.0.borrow().is_empty());
    }

    #[test]
    fn a_prepare_failure_cleans_up() {
        struct Broken(String);
        impl Steps for Broken {
            fn url(&self) -> &str {
                &self.0
            }
            fn file_name(&self) -> &str {
                "x.zip"
            }
            fn prepare(&self, _: &Path, _: &Path) -> Result<PathBuf, String> {
                Err("the download did not contain Ollama.app".into())
            }
            fn finish(&self, _: &Path) -> Result<PathBuf, String> {
                unreachable!()
            }
        }
        let s = server();
        let calls = Calls::default();
        let checker = Checker {
            verdict: Ok(()),
            calls: &calls,
        };
        let w = work("prep");
        let r = install(
            true,
            &dl(),
            &Broken(s.url()),
            &checker,
            &w,
            &mut |_, _| {},
            &CancelToken::new(),
        );
        assert!(matches!(r, Err(InstallError::Step(_))));
        assert!(!w.join("x.zip").exists());
        assert!(
            calls.0.borrow().is_empty(),
            "no signature check on something that could not be prepared"
        );
        let _ = fs::remove_dir_all(&w);
    }

    #[test]
    fn team_id_parsing() {
        let out = "Identifier=com.electron.ollama\nAuthority=Developer ID Application: X (ABC)\nTeamIdentifier=3MU9H2V9Y9\nRuntime Version=1";
        assert_eq!(parse_team_id(out), Some("3MU9H2V9Y9"));
        assert_eq!(parse_team_id("TeamIdentifier=not set"), None);
        assert_eq!(parse_team_id("nothing here"), None);
    }

    #[test]
    fn authenticode_parsing() {
        assert!(parse_authenticode("Valid\nCN=Ollama Inc., O=Ollama Inc.\n").is_ok());
        assert!(parse_authenticode("Valid\r\nCN=\"OLLAMA INC.\"\r\n").is_ok());
        assert!(
            parse_authenticode("HashMismatch\nCN=Ollama\n")
                .unwrap_err()
                .contains("HashMismatch")
        );
        assert!(
            parse_authenticode("NotSigned\n\n")
                .unwrap_err()
                .contains("NotSigned")
        );
        assert!(
            parse_authenticode("Valid\nCN=Somebody Else\n")
                .unwrap_err()
                .contains("not by Ollama")
        );
        assert!(parse_authenticode("").is_err());
    }

    #[test]
    fn official_urls_are_https_ollama_com() {
        for u in [MAC_URL, WINDOWS_URL] {
            assert!(u.starts_with("https://ollama.com/download/"), "{u}");
        }
    }

    /// Mac only: the real signature checker accepts the Ollama.app that is already installed on
    /// this machine (read-only: nothing is installed or changed). Skips if it is not there.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_real_mac_checker_accepts_the_installed_official_app() {
        let app = Path::new("/Applications/Ollama.app");
        if !app.exists() {
            eprintln!("SKIPPED: Ollama.app is not installed on this machine");
            return;
        }
        assert_eq!(MacChecker.verify(app), Ok(()));
        // and rejects something that is not a signed Ollama
        assert!(
            MacChecker
                .verify(Path::new("/System/Applications/Calculator.app"))
                .is_err()
        );
    }

    /// Opt-in real install (macOS or Windows). Installs real software: only with the flag.
    #[test]
    #[ignore = "installs Ollama for real; needs YADI_ALLOW_REAL_INSTALL=1"]
    fn real_install_only_with_the_explicit_flag() {
        if std::env::var("YADI_ALLOW_REAL_INSTALL").as_deref() != Ok("1") {
            eprintln!("SKIPPED: set YADI_ALLOW_REAL_INSTALL=1 to run a real install");
            return;
        }
        let (steps, checker): (Box<dyn Steps>, Box<dyn SignatureChecker>) = if cfg!(windows) {
            (Box::new(WindowsSteps), Box::new(WindowsChecker))
        } else {
            let home = std::env::var_os("HOME").map(PathBuf::from).unwrap();
            (
                Box::new(MacSteps {
                    targets: vec![PathBuf::from("/Applications"), home.join("Applications")],
                }),
                Box::new(MacChecker),
            )
        };
        let w = work("real");
        let r = install(
            true,
            &Downloader::new().unwrap(),
            steps.as_ref(),
            checker.as_ref(),
            &w,
            &mut |_, _| {},
            &CancelToken::new(),
        );
        println!("real install result: {r:?}");
        r.expect("real install");
        let _ = Duration::from_secs(0);
    }
}
