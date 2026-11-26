//! The summon listener: a small second copy of Yadi (the same program, started with
//! `--summon-listener`) that runs from login without windows, model or microphone. While Yadi
//! itself is running the listener does nothing; once Yadi is quit (or has not been opened since
//! login) it listens for the chosen summon (Hold-Y or the shortcut) and opens Yadi.
//!
//! "Is Yadi running?" is answered with a lock file: Yadi holds an exclusive lock on it for as
//! long as it runs, and the system releases it however Yadi ends (quit, crash, force quit).

pub mod agent;
pub mod run;

use std::fs::{self, File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager};

/// Starts this program as the summon listener instead of Yadi.
pub const LISTENER_ARG: &str = "--summon-listener";
/// Yadi was opened by the listener: show the chat as if the summon had reached a running Yadi.
pub const SUMMON_ARG: &str = "--summon";

/// Held by Yadi while it runs (in the app data folder).
const MAIN_LOCK: &str = "yadi-running.lock";
/// Held by the listener, so a second listener steps aside.
const LISTENER_LOCK: &str = "summon-listener.lock";

pub fn is_listener_process() -> bool {
    std::env::args().skip(1).any(|a| a == LISTENER_ARG)
}

static LAUNCH_SUMMON: AtomicBool = AtomicBool::new(false);

/// Remembers whether this Yadi was opened by the listener (`--summon`).
pub fn note_launch_args() {
    if std::env::args().skip(1).any(|a| a == SUMMON_ARG) {
        LAUNCH_SUMMON.store(true, Ordering::Relaxed);
    }
}

/// Asked once by the mascot when its listeners are ready: was Yadi opened by a summon?
#[tauri::command]
pub fn take_launch_summon() -> bool {
    LAUNCH_SUMMON.swap(false, Ordering::Relaxed)
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn open_lock_file(path: &Path) -> std::io::Result<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
}

/// Takes the exclusive lock without waiting. `Ok(None)`: someone else holds it.
fn try_hold(path: &Path) -> std::io::Result<Option<File>> {
    let file = open_lock_file(path)?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(e)) => Err(e),
    }
}

/// True when another process holds the exclusive lock on `path`.
fn is_held(path: &Path) -> bool {
    let Ok(file) = open_lock_file(path) else {
        return false;
    };
    match file.try_lock_shared() {
        Ok(()) => {
            let _ = file.unlock();
            false
        }
        Err(TryLockError::WouldBlock) => true,
        Err(TryLockError::Error(_)) => false,
    }
}

static MAIN_LOCK_FILE: OnceLock<File> = OnceLock::new();

/// Called first thing in Yadi's `setup`: tells the listener that Yadi runs. The listener only
/// peeks at the lock for an instant, so a few short retries are enough.
pub fn hold_main_lock(app: &AppHandle) {
    let path = match data_dir(app) {
        Ok(dir) => dir.join(MAIN_LOCK),
        Err(e) => {
            log::warn!("summon listener: {e}");
            return;
        }
    };
    for _ in 0..40 {
        match try_hold(&path) {
            Ok(Some(file)) => {
                let _ = MAIN_LOCK_FILE.set(file);
                return;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(e) => {
                log::warn!("summon listener: cannot lock {}: {e}", path.display());
                return;
            }
        }
    }
    log::warn!("summon listener: the running-lock stayed busy");
}

/// Registers the listener to start at login and starts it now. Called once setup is finished
/// (and at every later start, so a moved or updated Yadi is still the one that gets started).
#[tauri::command]
pub async fn summon_listener_ensure(app: AppHandle) -> Result<(), String> {
    let identifier = app.config().identifier.clone();
    tauri::async_runtime::spawn_blocking(move || agent::ensure(&identifier))
        .await
        .map_err(|e| e.to_string())?
}

/// Yadi is quitting: make sure the listener is there to bring it back.
pub fn on_main_exit(app: &AppHandle) {
    if let Ok(dir) = data_dir(app) {
        agent::wake(&dir.join(LISTENER_LOCK));
    }
}

/// The `.app` bundle this program runs from, if any (`…/Yadi.app/Contents/MacOS/Yadi`).
#[cfg(target_os = "macos")]
fn app_bundle(exe: &Path) -> Option<PathBuf> {
    let bundle = exe.parent()?.parent()?.parent()?;
    (bundle.extension()? == "app").then(|| bundle.to_path_buf())
}

/// Opens Yadi with `--summon`, detached from the listener.
fn launch_main() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("cannot find Yadi: {e}"))?;
    let mut cmd;
    #[cfg(target_os = "macos")]
    {
        // Through Launch Services, like a double-click, so Yadi is not the listener's child.
        if let Some(bundle) = app_bundle(&exe) {
            cmd = Command::new("/usr/bin/open");
            cmd.arg("-a").arg(bundle).arg("--args").arg(SUMMON_ARG);
        } else {
            cmd = Command::new(&exe);
            cmd.arg(SUMMON_ARG);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        cmd = Command::new(&exe);
        cmd.arg(SUMMON_ARG);
    }
    detach(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("cannot open Yadi: {e}"))?;
    // Collect the exit status so no zombie is left behind.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// No inherited console or streams, and its own process group, so ending one process never
/// takes the other with it.
fn detach(cmd: &mut Command) {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_held_lock_is_seen_by_others_and_released_on_drop() {
        let dir = std::env::temp_dir().join(format!("yadi-lock-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.lock");
        assert!(!is_held(&path));
        let held = try_hold(&path).unwrap().expect("free lock");
        assert!(is_held(&path));
        assert!(try_hold(&path).unwrap().is_none(), "only one holder");
        drop(held);
        assert!(!is_held(&path));
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn finds_the_app_bundle_only_inside_one() {
        assert_eq!(
            app_bundle(Path::new("/Applications/Yadi.app/Contents/MacOS/Yadi")),
            Some(PathBuf::from("/Applications/Yadi.app"))
        );
        assert_eq!(app_bundle(Path::new("/repo/target/debug/app")), None);
    }
}
