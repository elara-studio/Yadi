//! Resumable, checksum-verified file downloads (`download`) and archive extraction
//! (`archive`). Used for the speech models and, later, the Ollama installer.
//!
//! Behaviour (PLAN Task 09): HTTP via reqwest (native TLS: the OS certificate store, so no extra crypto crates); resume with a `Range` request into
//! `<dest>.part` (a `200` instead of `206` restarts from zero); SHA-256 is computed while
//! writing and compared at the end (mismatch deletes the file); the final `rename` is atomic;
//! free disk space is checked before any body is written; cancel token; 3 tries with backoff.

pub mod archive;
#[cfg(test)]
pub(crate) mod testserver;

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use reqwest::StatusCode;
use reqwest::blocking::Client;
use reqwest::header::{CONTENT_LENGTH, CONTENT_RANGE, RANGE};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DownloadError {
    Cancelled,
    /// Not enough free disk space. Sizes are in bytes.
    DiskSpace {
        needed: u64,
        available: u64,
    },
    ChecksumMismatch {
        expected: String,
        actual: String,
    },
    /// The server answered with an HTTP error that retrying will not fix (e.g. 404).
    Status(u16),
    /// Network or I/O trouble that survived all retries.
    Failed(String),
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DownloadError::Cancelled => f.write_str("The download was cancelled."),
            DownloadError::DiskSpace { needed, available } => write!(
                f,
                "Not enough free disk space: {:.0} MB needed, {:.0} MB available.",
                *needed as f64 / 1e6,
                *available as f64 / 1e6
            ),
            DownloadError::ChecksumMismatch { expected, actual } => write!(
                f,
                "The downloaded file is corrupted (expected checksum {expected}, got {actual}). It was deleted; please try again."
            ),
            DownloadError::Status(code) => write!(f, "The server answered with HTTP {code}."),
            DownloadError::Failed(m) => write!(f, "Download failed: {m}"),
        }
    }
}

impl std::error::Error for DownloadError {}

/// An attempt failed in a way worth retrying (the `.part` file is kept so the retry resumes).
enum Attempt {
    Retry(String),
    Fatal(DownloadError),
}

/// Shared cancel flag. Cheap to clone.
#[derive(Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

pub type FreeSpaceFn = Box<dyn Fn(&Path) -> std::io::Result<u64> + Send + Sync>;

pub struct Downloader {
    client: Client,
    free_space: FreeSpaceFn,
    /// Waits between tries; its length + 1 is the number of tries (3 by default).
    backoff: Vec<Duration>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// SHA-256 of a file, lowercase hex.
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut hasher = Sha256::new();
    let mut file = File::open(path)?;
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".part");
    dest.with_file_name(name)
}

/// `Content-Range: bytes 100-999/1000` -> (100, Some(1000)). `bytes */1000` -> (0 unused, total).
fn parse_content_range(value: &str) -> Option<(Option<u64>, Option<u64>)> {
    let rest = value.trim().strip_prefix("bytes")?.trim();
    let (range, total) = rest.split_once('/')?;
    let total = total.trim().parse::<u64>().ok();
    if range.trim() == "*" {
        return Some((None, total));
    }
    let start = range.split('-').next()?.trim().parse::<u64>().ok()?;
    Some((Some(start), total))
}

impl Downloader {
    pub fn new() -> Result<Self, DownloadError> {
        let client = Client::builder()
            .user_agent("Yadi-model-downloader")
            .connect_timeout(Duration::from_secs(20))
            // The default 30 s total timeout would kill big downloads.
            .timeout(None::<Duration>)
            .build()
            .map_err(|e| DownloadError::Failed(e.to_string()))?;
        Ok(Self {
            client,
            free_space: Box::new(|p| fs4::available_space(p)),
            backoff: vec![Duration::from_secs(2), Duration::from_secs(5)],
        })
    }

    /// Replaces the free-disk-space probe (tests).
    #[cfg(test)]
    pub fn with_free_space(mut self, f: FreeSpaceFn) -> Self {
        self.free_space = f;
        self
    }

    /// Replaces the retry waits (tests use zero waits).
    #[cfg(test)]
    pub fn with_backoff(mut self, waits: Vec<Duration>) -> Self {
        self.backoff = waits;
        self
    }

    /// Downloads `url` to `dest`, verifying `expected_sha256` (lowercase hex) when given.
    /// `None` is for files with no published checksum (the Ollama installer, which is verified by
    /// its code signature instead); such a file is always downloaded afresh.
    /// `on_progress(received, total)` is called as bytes arrive.
    pub fn download(
        &self,
        url: &str,
        dest: &Path,
        expected_sha256: Option<&str>,
        on_progress: &mut dyn FnMut(u64, Option<u64>),
        cancel: &CancelToken,
    ) -> Result<(), DownloadError> {
        let expected = expected_sha256.map(|s| s.trim().to_ascii_lowercase());
        let expected = expected.as_deref();
        if let Some(dir) = dest.parent() {
            fs::create_dir_all(dir).map_err(|e| {
                DownloadError::Failed(format!("cannot create {}: {e}", dir.display()))
            })?;
        }

        // Already downloaded and intact? Nothing to do (only possible when a checksum is known).
        if dest.exists() {
            match (expected, sha256_file(dest)) {
                (Some(want), Ok(actual)) if actual == want => {
                    let len = fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
                    on_progress(len, Some(len));
                    return Ok(());
                }
                _ => {
                    let _ = fs::remove_file(dest);
                }
            }
        }

        let part = part_path(dest);
        let tries = self.backoff.len() + 1;
        let mut last = String::new();
        for attempt in 0..tries {
            if cancel.is_cancelled() {
                return Err(DownloadError::Cancelled);
            }
            match self.attempt(url, dest, &part, expected, on_progress, cancel) {
                Ok(()) => return Ok(()),
                Err(Attempt::Fatal(e)) => return Err(e),
                Err(Attempt::Retry(why)) => {
                    log::warn!("download attempt {}/{tries} failed: {why}", attempt + 1);
                    last = why;
                    if let Some(wait) = self.backoff.get(attempt) {
                        sleep_cancellable(*wait, cancel);
                    }
                }
            }
        }
        Err(DownloadError::Failed(last))
    }

    fn attempt(
        &self,
        url: &str,
        dest: &Path,
        part: &Path,
        expected: Option<&str>,
        on_progress: &mut dyn FnMut(u64, Option<u64>),
        cancel: &CancelToken,
    ) -> Result<(), Attempt> {
        let io = |what: &str, e: std::io::Error| {
            Attempt::Fatal(DownloadError::Failed(format!("{what}: {e}")))
        };

        let mut existing = fs::metadata(part).map(|m| m.len()).unwrap_or(0);
        let mut request = self.client.get(url);
        if existing > 0 {
            request = request.header(RANGE, format!("bytes={existing}-"));
        }
        let response = request.send().map_err(|e| Attempt::Retry(e.to_string()))?;
        let status = response.status();

        // Work out what the server is giving us and where in the file it starts.
        let total: Option<u64>;
        match status {
            StatusCode::PARTIAL_CONTENT => {
                let cr = response
                    .headers()
                    .get(CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                    .and_then(parse_content_range);
                match cr {
                    Some((Some(start), t)) if start == existing => total = t,
                    // A 206 that does not start where we asked cannot be appended safely.
                    _ => {
                        let _ = fs::remove_file(part);
                        return Err(Attempt::Retry(
                            "server sent an unexpected byte range".into(),
                        ));
                    }
                }
            }
            StatusCode::OK => {
                // The server ignored (or we did not send) a Range request: start over.
                if existing > 0 {
                    log::info!("server ignored the Range request; restarting the download");
                }
                existing = 0;
                total = response
                    .headers()
                    .get(CONTENT_LENGTH)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok());
            }
            StatusCode::RANGE_NOT_SATISFIABLE => {
                // Usually: the .part is already complete (or bigger than the real file).
                let total_known = response
                    .headers()
                    .get(CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                    .and_then(parse_content_range)
                    .and_then(|(_, t)| t);
                if total_known == Some(existing) {
                    return self.finish(dest, part, expected, on_progress, Some(existing));
                }
                let _ = fs::remove_file(part);
                return Err(Attempt::Retry("stale partial file discarded".into()));
            }
            s if s.is_server_error() || s == StatusCode::TOO_MANY_REQUESTS => {
                return Err(Attempt::Retry(format!("HTTP {}", s.as_u16())));
            }
            s => return Err(Attempt::Fatal(DownloadError::Status(s.as_u16()))),
        }

        // Disk space, before a single byte is written.
        let full_size = match (status, total, response.content_length()) {
            (StatusCode::PARTIAL_CONTENT, Some(t), _) => Some(t),
            (StatusCode::PARTIAL_CONTENT, None, Some(rest)) => Some(existing + rest),
            (_, t, _) => t,
        };
        if let Some(size) = full_size {
            let remaining = size.saturating_sub(existing);
            let needed = remaining + remaining / 10; // size x 1.1
            let dir = dest.parent().unwrap_or(Path::new("."));
            if let Ok(available) = (self.free_space)(dir)
                && available < needed
            {
                return Err(Attempt::Fatal(DownloadError::DiskSpace {
                    needed,
                    available,
                }));
            }
        }

        // Hash what is already on disk (resume) so the digest covers the whole file.
        let mut hasher = Sha256::new();
        let mut file = if existing > 0 {
            let mut f = File::open(part).map_err(|e| io("reopen partial file", e))?;
            let mut buf = vec![0u8; 256 * 1024];
            loop {
                let n = f.read(&mut buf).map_err(|e| io("read partial file", e))?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
            }
            OpenOptions::new()
                .append(true)
                .open(part)
                .map_err(|e| io("append to partial file", e))?
        } else {
            File::create(part).map_err(|e| io("create partial file", e))?
        };

        let mut received = existing;
        on_progress(received, full_size);
        let mut response = response;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            if cancel.is_cancelled() {
                let _ = file.flush();
                return Err(Attempt::Fatal(DownloadError::Cancelled));
            }
            let n = match response.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                // Connection cut mid-body: keep the .part and let the retry resume.
                Err(e) => {
                    let _ = file.flush();
                    return Err(Attempt::Retry(format!("connection interrupted: {e}")));
                }
            };
            hasher.update(&buf[..n]);
            file.write_all(&buf[..n]).map_err(|e| io("write", e))?;
            received += n as u64;
            on_progress(received, full_size);
        }
        file.sync_all().map_err(|e| io("flush", e))?;
        drop(file);

        if let Some(size) = full_size
            && received < size
        {
            return Err(Attempt::Retry(format!(
                "connection closed early ({received} of {size} bytes)"
            )));
        }
        self.verify_and_rename(
            dest,
            part,
            expected,
            &hex(&hasher.finalize()),
            received,
            on_progress,
        )
    }

    /// Used when the `.part` turned out to be complete already.
    fn finish(
        &self,
        dest: &Path,
        part: &Path,
        expected: Option<&str>,
        on_progress: &mut dyn FnMut(u64, Option<u64>),
        size: Option<u64>,
    ) -> Result<(), Attempt> {
        let actual =
            sha256_file(part).map_err(|e| Attempt::Fatal(DownloadError::Failed(e.to_string())))?;
        self.verify_and_rename(
            dest,
            part,
            expected,
            &actual,
            size.unwrap_or(0),
            on_progress,
        )
    }

    fn verify_and_rename(
        &self,
        dest: &Path,
        part: &Path,
        expected: Option<&str>,
        actual: &str,
        received: u64,
        on_progress: &mut dyn FnMut(u64, Option<u64>),
    ) -> Result<(), Attempt> {
        if let Some(want) = expected
            && actual != want
        {
            let _ = fs::remove_file(part);
            return Err(Attempt::Fatal(DownloadError::ChecksumMismatch {
                expected: want.to_string(),
                actual: actual.to_string(),
            }));
        }
        fs::rename(part, dest)
            .map_err(|e| Attempt::Fatal(DownloadError::Failed(format!("rename: {e}"))))?;
        on_progress(received, Some(received));
        Ok(())
    }
}

fn sleep_cancellable(total: Duration, cancel: &CancelToken) {
    let step = Duration::from_millis(50);
    let mut waited = Duration::ZERO;
    while waited < total && !cancel.is_cancelled() {
        let d = step.min(total - waited);
        std::thread::sleep(d);
        waited += d;
    }
}

#[cfg(test)]
mod tests {
    use super::testserver::{Server, ServerConfig};
    use super::*;
    use std::sync::Mutex;

    /// Deterministic pseudo-random bytes.
    fn payload(len: usize) -> Vec<u8> {
        let mut x: u32 = 0x1234_5678;
        (0..len)
            .map(|_| {
                x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (x >> 24) as u8
            })
            .collect()
    }

    fn sha(data: &[u8]) -> String {
        hex(&Sha256::digest(data))
    }

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yadi-dl-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn dl() -> Downloader {
        Downloader::new()
            .unwrap()
            .with_backoff(vec![Duration::ZERO, Duration::ZERO])
            .with_free_space(Box::new(|_| Ok(u64::MAX)))
    }

    type Progress = Vec<(u64, Option<u64>)>;

    fn run(
        d: &Downloader,
        url: &str,
        dest: &Path,
        sha: &str,
    ) -> (Result<(), DownloadError>, Progress) {
        let events = Mutex::new(Vec::new());
        let result = d.download(
            url,
            dest,
            Some(sha),
            &mut |r, t| events.lock().unwrap().push((r, t)),
            &CancelToken::new(),
        );
        (result, events.into_inner().unwrap())
    }

    #[test]
    fn full_download_verifies_and_reports_progress() {
        let data = payload(300_000);
        let server = Server::start(ServerConfig::new(data.clone()));
        let dir = tmp("full");
        let dest = dir.join("model.bin");
        let (res, events) = run(&dl(), &server.url(), &dest, &sha(&data));
        res.unwrap();
        assert_eq!(fs::read(&dest).unwrap(), data);
        assert!(!part_path(&dest).exists(), ".part is gone after the rename");
        assert_eq!(events.last(), Some(&(300_000, Some(300_000))));
        assert!(
            events.windows(2).all(|w| w[0].0 <= w[1].0),
            "progress never goes backwards"
        );
        assert_eq!(server.requests().len(), 1);
    }

    #[test]
    fn resumes_after_the_connection_is_cut() {
        let data = payload(400_000);
        let mut cfg = ServerConfig::new(data.clone());
        cfg.cut_first_response_after = Some(150_000);
        let server = Server::start(cfg);
        let dir = tmp("resume");
        let dest = dir.join("model.bin");
        let (res, _) = run(&dl(), &server.url(), &dest, &sha(&data));
        res.unwrap();
        assert_eq!(fs::read(&dest).unwrap(), data);
        let reqs = server.requests();
        assert_eq!(reqs.len(), 2, "one cut request plus one resumed request");
        assert_eq!(reqs[0].range, None);
        assert_eq!(
            reqs[1].range.as_deref(),
            Some("bytes=150000-"),
            "second request resumes where the first stopped"
        );
    }

    #[test]
    fn resumes_from_a_part_file_left_by_an_earlier_run() {
        let data = payload(200_000);
        let server = Server::start(ServerConfig::new(data.clone()));
        let dir = tmp("part");
        let dest = dir.join("model.bin");
        fs::write(part_path(&dest), &data[..80_000]).unwrap();
        let (res, _) = run(&dl(), &server.url(), &dest, &sha(&data));
        res.unwrap();
        assert_eq!(fs::read(&dest).unwrap(), data);
        assert_eq!(server.requests()[0].range.as_deref(), Some("bytes=80000-"));
    }

    #[test]
    fn checksum_mismatch_deletes_the_file_and_errors() {
        let data = payload(50_000);
        let server = Server::start(ServerConfig::new(data.clone()));
        let dir = tmp("mismatch");
        let dest = dir.join("model.bin");
        let wrong = "0".repeat(64);
        let (res, _) = run(&dl(), &server.url(), &dest, &wrong);
        match res {
            Err(DownloadError::ChecksumMismatch { expected, actual }) => {
                assert_eq!(expected, wrong);
                assert_eq!(actual, sha(&data));
            }
            other => panic!("expected a checksum mismatch, got {other:?}"),
        }
        assert!(!dest.exists());
        assert!(!part_path(&dest).exists());
        assert_eq!(server.requests().len(), 1, "a bad checksum is not retried");
    }

    #[test]
    fn a_200_instead_of_206_restarts_from_zero() {
        let data = payload(120_000);
        let mut cfg = ServerConfig::new(data.clone());
        cfg.ignore_range = true;
        let server = Server::start(cfg);
        let dir = tmp("200");
        let dest = dir.join("model.bin");
        // junk that must NOT end up in the result
        fs::write(part_path(&dest), vec![0xAA; 30_000]).unwrap();
        let (res, _) = run(&dl(), &server.url(), &dest, &sha(&data));
        res.unwrap();
        assert_eq!(
            fs::read(&dest).unwrap(),
            data,
            "the stale part file was discarded"
        );
        assert_eq!(server.requests()[0].range.as_deref(), Some("bytes=30000-"));
    }

    #[test]
    fn cancel_stops_the_download_and_keeps_the_part_for_a_later_resume() {
        let data = payload(500_000);
        let server = Server::start(ServerConfig::new(data.clone()));
        let dir = tmp("cancel");
        let dest = dir.join("model.bin");
        let cancel = CancelToken::new();
        let c2 = cancel.clone();
        let result = dl().download(
            &server.url(),
            &dest,
            Some(&sha(&data)),
            &mut |received, _| {
                if received > 100_000 {
                    c2.cancel();
                }
            },
            &cancel,
        );
        assert_eq!(result, Err(DownloadError::Cancelled));
        assert!(!dest.exists());
        let kept = fs::metadata(part_path(&dest)).unwrap().len();
        assert!(
            kept > 0 && kept < 500_000,
            "partial data kept for resume ({kept})"
        );
        // ... and a fresh run finishes the job
        let (res, _) = run(&dl(), &server.url(), &dest, &sha(&data));
        res.unwrap();
        assert_eq!(fs::read(&dest).unwrap(), data);
    }

    #[test]
    fn refuses_when_there_is_not_enough_disk_space_before_writing_anything() {
        let data = payload(1_000_000);
        let server = Server::start(ServerConfig::new(data.clone()));
        let dir = tmp("space");
        let dest = dir.join("model.bin");
        let d = Downloader::new()
            .unwrap()
            .with_backoff(vec![])
            .with_free_space(Box::new(|_| Ok(1_050_000))); // needs 1.1 MB, has 1.05 MB
        let (res, _) = run(&d, &server.url(), &dest, &sha(&data));
        assert_eq!(
            res,
            Err(DownloadError::DiskSpace {
                needed: 1_100_000,
                available: 1_050_000
            })
        );
        assert!(!part_path(&dest).exists(), "nothing was written");
        assert!(res.unwrap_err().to_string().contains("MB"));
    }

    #[test]
    fn enough_space_exactly_at_the_limit_is_accepted() {
        let data = payload(100_000);
        let server = Server::start(ServerConfig::new(data.clone()));
        let dir = tmp("space-ok");
        let d = Downloader::new()
            .unwrap()
            .with_free_space(Box::new(|_| Ok(110_000)));
        let (res, _) = run(&d, &server.url(), &dir.join("m.bin"), &sha(&data));
        res.unwrap();
    }

    #[test]
    fn transient_server_errors_are_retried_then_succeed() {
        let data = payload(60_000);
        let mut cfg = ServerConfig::new(data.clone());
        cfg.fail_first = 2; // two 503s, then fine
        let server = Server::start(cfg);
        let dir = tmp("retry");
        let (res, _) = run(&dl(), &server.url(), &dir.join("m.bin"), &sha(&data));
        res.unwrap();
        assert_eq!(server.requests().len(), 3);
    }

    #[test]
    fn gives_up_after_three_tries() {
        let mut cfg = ServerConfig::new(payload(10));
        cfg.fail_first = 100;
        let server = Server::start(cfg);
        let dir = tmp("giveup");
        let (res, _) = run(&dl(), &server.url(), &dir.join("m.bin"), &"0".repeat(64));
        assert!(matches!(res, Err(DownloadError::Failed(_))), "{res:?}");
        assert_eq!(server.requests().len(), 3);
    }

    #[test]
    fn a_404_is_fatal_and_not_retried() {
        let mut cfg = ServerConfig::new(payload(10));
        cfg.status_override = Some(404);
        let server = Server::start(cfg);
        let dir = tmp("404");
        let (res, _) = run(&dl(), &server.url(), &dir.join("m.bin"), &"0".repeat(64));
        assert_eq!(res, Err(DownloadError::Status(404)));
        assert_eq!(server.requests().len(), 1);
    }

    #[test]
    fn an_intact_existing_file_is_not_downloaded_again() {
        let data = payload(10_000);
        let server = Server::start(ServerConfig::new(data.clone()));
        let dir = tmp("exists");
        let dest = dir.join("m.bin");
        fs::write(&dest, &data).unwrap();
        let (res, events) = run(&dl(), &server.url(), &dest, &sha(&data));
        res.unwrap();
        assert_eq!(server.requests().len(), 0);
        assert_eq!(events.last(), Some(&(10_000, Some(10_000))));
    }

    #[test]
    fn a_corrupt_existing_file_is_replaced() {
        let data = payload(10_000);
        let server = Server::start(ServerConfig::new(data.clone()));
        let dir = tmp("corrupt");
        let dest = dir.join("m.bin");
        fs::write(&dest, b"garbage").unwrap();
        let (res, _) = run(&dl(), &server.url(), &dest, &sha(&data));
        res.unwrap();
        assert_eq!(fs::read(&dest).unwrap(), data);
    }

    #[test]
    fn a_complete_part_file_is_verified_and_finished_without_downloading_again() {
        // The server answers a Range past the end with 416; the .part is already whole.
        let data = payload(20_000);
        let server = Server::start(ServerConfig::new(data.clone()));
        let dir = tmp("complete-part");
        let dest = dir.join("m.bin");
        fs::write(part_path(&dest), &data).unwrap();
        let (res, _) = run(&dl(), &server.url(), &dest, &sha(&data));
        res.unwrap();
        assert_eq!(fs::read(&dest).unwrap(), data);
    }

    #[test]
    fn content_range_parsing() {
        assert_eq!(
            parse_content_range("bytes 100-999/1000"),
            Some((Some(100), Some(1000)))
        );
        assert_eq!(
            parse_content_range("bytes */1000"),
            Some((None, Some(1000)))
        );
        assert_eq!(parse_content_range("bytes 0-9/*"), Some((Some(0), None)));
        assert_eq!(parse_content_range("items 1-2/3"), None);
    }

    #[test]
    fn sha256_of_known_input() {
        let dir = tmp("sha");
        let f = dir.join("abc");
        fs::write(&f, b"abc").unwrap();
        assert_eq!(
            sha256_file(&f).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn without_a_checksum_the_file_is_downloaded_unverified_and_always_afresh() {
        let data = payload(30_000);
        let server = Server::start(ServerConfig::new(data.clone()));
        let dir = tmp("nosha");
        let dest = dir.join("installer.bin");
        fs::write(&dest, b"stale older installer").unwrap();
        let mut last = (0, None);
        dl().download(
            &server.url(),
            &dest,
            None,
            &mut |r, t| last = (r, t),
            &CancelToken::new(),
        )
        .unwrap();
        assert_eq!(
            fs::read(&dest).unwrap(),
            data,
            "an unverifiable old file is replaced, never trusted"
        );
        assert_eq!(server.requests().len(), 1);
        assert_eq!(last, (30_000, Some(30_000)));
        assert!(!part_path(&dest).exists());
    }
}
