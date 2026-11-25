//! Global summon shortcuts: the pure long-press detector and engine, the OS keyboard hook and
//! the chord fallback.

pub mod chord;
pub mod engine;
pub mod hook;
pub mod longpress;
pub mod permissions;

#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod platform;
#[cfg(windows)]
#[path = "windows.rs"]
mod platform;
#[cfg(not(any(target_os = "macos", windows)))]
#[path = "other.rs"]
mod platform;

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::settings::{Settings, SummonMode};
use crate::windows::MASCOT_LABEL;
use hook::{HookError, HookState, SummonFn};

/// Message for the user, shown in the chat window (`Fix` button when `action` is set).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Notice {
    pub message: String,
    /// `"fix-permissions"` makes the UI offer a button that calls `open_permission_settings`.
    pub action: Option<String>,
}

/// The chat webview loads after `setup`, so a startup notice is kept here until it asks.
#[derive(Default)]
pub struct NoticeState(pub Mutex<Option<Notice>>);

fn summon_fn(app: &AppHandle) -> SummonFn {
    let app = app.clone();
    Arc::new(move || {
        let _ = app.emit_to(MASCOT_LABEL, "hotkey:summon", ());
    })
}

/// Hands the (already clamped) hold time to the long-press detector.
pub fn apply_threshold(shared: &hook::Shared, settings: &Settings) {
    shared.set_threshold(settings.summon.threshold_ms);
}

/// Makes the OS-level summon match `settings`. Never panics. In long-press mode it installs
/// the keyboard hook (needs macOS permissions) and drops the chord; in chord mode it switches
/// the hook off and registers the chord. On error nothing was changed for the failing side.
pub fn apply(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let state = app.state::<HookState>();
    match settings.summon.mode {
        SummonMode::Chord => {
            chord::apply(app, settings)?;
            state.shared.set_enabled(false);
            Ok(())
        }
        SummonMode::LongpressY => {
            let perms = permissions::status();
            log::info!(
                "keyboard permissions: accessibility={}, input monitoring={}",
                perms.accessibility,
                perms.input_monitoring
            );
            if !perms.all_granted() {
                permissions::request();
            }
            state
                .ensure_started(summon_fn(app))
                .map_err(|e: HookError| e.to_string())?;
            apply_threshold(&state.shared, settings);
            chord::apply(app, settings)?; // unregisters any chord
            state.shared.set_enabled(true);
            Ok(())
        }
    }
}

/// The notice shown when Hold-Y cannot run and the chord is used instead.
pub fn fallback_notice(chord: &str, permission_missing: bool) -> Notice {
    if permission_missing {
        Notice {
            message: format!(
                "Hold-Y needs keyboard permission. Using {chord} instead until it is granted."
            ),
            action: Some("fix-permissions".to_string()),
        }
    } else {
        Notice {
            message: format!("Hold-Y is unavailable. Using {chord} instead."),
            action: None,
        }
    }
}

/// Startup: apply the saved settings; if the long-press hook cannot run, fall back to the
/// chord and leave a notice with a "Fix" action.
pub fn init(app: &AppHandle, settings: &Settings) {
    app.manage(HookState::new());
    app.manage(NoticeState::default());
    if let Err(reason) = apply(app, settings) {
        log::warn!("long-press hook unavailable ({reason}); using the chord fallback");
        let mut fallback = settings.clone();
        fallback.summon.mode = SummonMode::Chord;
        if let Err(e) = chord::apply(app, &fallback) {
            log::warn!("chord fallback could not be registered: {e}");
        }
        let notice = fallback_notice(&fallback.summon.chord, !permissions::status().all_granted());
        *app.state::<NoticeState>()
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(notice);
    }
}

#[tauri::command]
pub fn get_notice(state: tauri::State<NoticeState>) -> Option<Notice> {
    state.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[tauri::command]
pub fn open_permission_settings() -> Result<(), String> {
    permissions::open_settings()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_permission_notice_offers_the_fix_action() {
        let n = fallback_notice("CommandOrControl+Shift+Y", true);
        assert_eq!(n.action.as_deref(), Some("fix-permissions"));
        assert!(n.message.contains("permission"));
        assert!(n.message.contains("CommandOrControl+Shift+Y"));
    }

    #[test]
    fn other_failures_have_no_fix_action() {
        let n = fallback_notice("Alt+Space", false);
        assert_eq!(n.action, None);
        assert!(n.message.contains("Alt+Space"));
    }
}
