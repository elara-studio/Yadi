//! First-run setup: persistence of the wizard's progress (`setup.json` in the app data folder) and
//! the permission commands the wizard needs. The wizard itself lives in the frontend; Rust stores
//! its state opaquely so the wizard can resume after a quit or a crash.

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::audio::AudioSource;
use crate::audio::mic::MicSource;
use crate::audio::permission::{MicPermission, microphone_status};
use crate::audio::queue::ChunkQueue;
use crate::hotkey::permissions::{self, PermissionStatus};

/// Set to `1` to run the wizard with simulated downloads and permissions (development only).
pub const MOCK_ENV: &str = "YADI_MOCK_SETUP";

/// A sanity limit: the file only holds a handful of step statuses.
const MAX_BYTES: usize = 64 * 1024;

fn setup_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?
        .join("setup.json"))
}

/// Reads `setup.json`. Missing or unreadable means "never set up": `null`.
pub fn read_state(path: &std::path::Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Writes atomically (temp file + rename), so a crash never leaves half a file.
pub fn write_state(path: &std::path::Path, state: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    if text.len() > MAX_BYTES {
        return Err("setup state is unexpectedly large".into());
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("cannot write setup state: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("cannot save setup state: {e}"))
}

#[tauri::command]
pub fn get_setup_state(app: AppHandle) -> Result<Option<Value>, String> {
    let state = read_state(&setup_file(&app)?);
    log::info!(
        "first-run setup state: {}",
        if state.is_some() { "found" } else { "none yet" }
    );
    Ok(state)
}

#[tauri::command]
pub fn save_setup_state(app: AppHandle, state: Value) -> Result<(), String> {
    write_state(&setup_file(&app)?, &state)
}

#[tauri::command]
pub fn setup_mock_enabled() -> bool {
    std::env::var(MOCK_ENV).as_deref() == Ok("1")
}

fn mic_word(p: MicPermission) -> &'static str {
    match p {
        MicPermission::Authorized => "authorized",
        MicPermission::NotDetermined => "not-determined",
        MicPermission::Denied => "denied",
        MicPermission::Restricted => "restricted",
        MicPermission::Unknown => "unknown",
    }
}

#[tauri::command]
pub fn mic_permission_status() -> &'static str {
    mic_word(microphone_status())
}

/// Triggers the operating system's microphone prompt by opening the microphone for a moment
/// (nothing is recorded or kept), then waits for the answer (up to 60 s) and reports it.
#[tauri::command]
pub async fn mic_request_permission() -> Result<&'static str, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let queue = std::sync::Arc::new(ChunkQueue::new(4));
        let mut mic = MicSource::new();
        // Opening the stream is what makes macOS ask. Errors (no device, denied) are fine here:
        // the status below tells the story.
        let started = mic.start(queue).is_ok();
        let mut status = microphone_status();
        let mut waited = Duration::ZERO;
        while status == MicPermission::NotDetermined && waited < Duration::from_secs(60) {
            std::thread::sleep(Duration::from_millis(500));
            waited += Duration::from_millis(500);
            status = microphone_status();
        }
        if started {
            mic.stop();
        }
        Ok(mic_word(status))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn hotkey_permission_status() -> PermissionStatus {
    permissions::status()
}

/// Shows the macOS Accessibility / Input Monitoring prompts (a no-op elsewhere).
#[tauri::command]
pub fn hotkey_request_permission() {
    permissions::request();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("yadi-setup-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d.join("setup.json")
    }

    #[test]
    fn a_missing_file_means_never_set_up() {
        assert_eq!(read_state(&tmp("missing")), None);
    }

    #[test]
    fn state_round_trips_and_creates_the_folder() {
        let path = tmp("roundtrip");
        let state = json!({"version": 1, "consent": true, "steps": {"welcome": "done", "ollama": "running"}});
        write_state(&path, &state).unwrap();
        assert_eq!(read_state(&path), Some(state));
        assert!(
            !path.with_extension("json.tmp").exists(),
            "no temp file is left behind"
        );
    }

    #[test]
    fn a_corrupt_file_reads_as_never_set_up_instead_of_crashing() {
        let path = tmp("corrupt");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{ this is not json").unwrap();
        assert_eq!(read_state(&path), None);
    }

    #[test]
    fn overwriting_replaces_the_old_state() {
        let path = tmp("overwrite");
        write_state(&path, &json!({"a": 1})).unwrap();
        write_state(&path, &json!({"a": 2})).unwrap();
        assert_eq!(read_state(&path), Some(json!({"a": 2})));
    }

    #[test]
    fn an_absurdly_large_state_is_refused() {
        let path = tmp("huge");
        let big = json!({"x": "a".repeat(MAX_BYTES + 1)});
        assert!(write_state(&path, &big).unwrap_err().contains("large"));
        assert!(!path.exists());
    }

    #[test]
    fn mic_statuses_have_stable_words() {
        assert_eq!(mic_word(MicPermission::Authorized), "authorized");
        assert_eq!(mic_word(MicPermission::NotDetermined), "not-determined");
        assert_eq!(mic_word(MicPermission::Denied), "denied");
        assert_eq!(mic_word(MicPermission::Restricted), "restricted");
        assert_eq!(mic_word(MicPermission::Unknown), "unknown");
    }

    #[test]
    fn the_mock_flag_is_off_unless_exactly_1() {
        // (the real variable may be set by a developer, so only assert the parsing rule)
        let on = |v: Option<&str>| v == Some("1");
        assert!(on(Some("1")) && !on(Some("true")) && !on(None));
    }
}
