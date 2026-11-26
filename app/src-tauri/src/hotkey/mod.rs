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
///
/// `ask`: whether a missing permission may be asked for now. At launch it is `false`, so the
/// system prompt only appears when the person chooses Hold-Y (in setup or in Settings); without
/// permission the hook is then not even tried, because trying can make macOS ask as well.
pub fn apply(app: &AppHandle, settings: &Settings, ask: bool) -> Result<(), String> {
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
                if !ask {
                    return Err("Hold-Y needs Accessibility permission".into());
                }
                permissions::request(&app.config().identifier);
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
/// chord and leave a notice with a "Fix" action. No permission prompt is shown here: the setup
/// wizard (or choosing Hold-Y in Settings) is where Yadi asks.
pub fn init(app: &AppHandle, settings: &Settings) {
    app.manage(HookState::new());
    app.manage(NoticeState::default());
    #[cfg(target_os = "macos")]
    watch_permissions(app);
    if let Err(reason) = apply(app, settings, false) {
        log::warn!("long-press hook unavailable ({reason}); using the chord fallback");
        let mut fallback = settings.clone();
        fallback.summon.mode = SummonMode::Chord;
        if let Err(e) = chord::apply(app, &fallback) {
            log::warn!("chord fallback could not be registered: {e}");
        }
        let notice = fallback_notice(&fallback.summon.chord, !permissions::status().all_granted());
        set_notice(app, Some(notice));
    }
}

fn set_notice(app: &AppHandle, notice: Option<Notice>) {
    *app.state::<NoticeState>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = notice;
}

/// True when a permission that was granted a moment ago is gone now.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn permission_lost(was_granted: bool, is_granted: bool) -> bool {
    was_granted && !is_granted
}

/// True when a permission that was missing a moment ago is there now.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn permission_gained(was_granted: bool, is_granted: bool) -> bool {
    !was_granted && is_granted
}

/// macOS permission changes while Yadi runs, when Hold-Y is the chosen summon:
/// - switched off: the keyboard hook silently stops seeing keys, so switch to the chord with a
///   notice (the saved setting is not changed);
/// - switched on (for example during setup): start Hold-Y right away, no restart needed.
///
/// Nothing to watch on other systems.
#[cfg(target_os = "macos")]
fn watch_permissions(app: &AppHandle) {
    let app = app.clone();
    std::thread::Builder::new()
        .name("yadi-permission-watch".into())
        .spawn(move || {
            let mut was_granted = permissions::status().all_granted();
            loop {
                std::thread::sleep(std::time::Duration::from_secs(2));
                let granted = permissions::status().all_granted();
                let current = app
                    .state::<crate::settings::SettingsState>()
                    .0
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone();
                let hold_y = current.summon.mode == SummonMode::LongpressY;
                if hold_y && permission_lost(was_granted, granted) {
                    log::warn!("keyboard permission was switched off; using the chord instead");
                    app.state::<HookState>().shared.set_enabled(false);
                    let mut chord_settings = current.clone();
                    chord_settings.summon.mode = SummonMode::Chord;
                    if let Err(e) = chord::apply(&app, &chord_settings) {
                        log::warn!("chord fallback could not be registered: {e}");
                    }
                    let notice = fallback_notice(&chord_settings.summon.chord, true);
                    set_notice(&app, Some(notice.clone()));
                    let _ = app.emit_to(crate::windows::CHAT_LABEL, "app:notice", notice);
                } else if hold_y && permission_gained(was_granted, granted) {
                    match apply(&app, &current, false) {
                        Ok(()) => {
                            log::info!("keyboard permission granted; Hold-Y is on");
                            set_notice(&app, None);
                        }
                        Err(e) => log::warn!("keyboard permission granted but Hold-Y failed: {e}"),
                    }
                }
                was_granted = granted;
            }
        })
        .ok();
}

/// Settings is recording a new shortcut: the current summon chord stops listening meanwhile.
#[tauri::command]
pub fn summon_capture_start(app: AppHandle) -> Result<(), String> {
    chord::pause(&app)
}

/// Recording ended (saved, cancelled or the screen closed): the summon chord listens again.
#[tauri::command]
pub fn summon_capture_end(app: AppHandle) -> Result<(), String> {
    chord::resume(&app)
}

#[tauri::command]
pub fn get_notice(state: tauri::State<NoticeState>) -> Option<Notice> {
    state.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[tauri::command]
pub fn open_permission_settings(app: AppHandle) -> Result<(), String> {
    permissions::open_settings(&app.config().identifier)
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

    #[test]
    fn only_a_granted_permission_that_disappears_counts_as_lost() {
        assert!(permission_lost(true, false));
        assert!(!permission_lost(true, true));
        assert!(!permission_lost(false, false)); // never had it: the startup fallback handled that
        assert!(!permission_lost(false, true)); // just granted
    }

    #[test]
    fn only_a_missing_permission_that_appears_counts_as_gained() {
        assert!(permission_gained(false, true));
        assert!(!permission_gained(true, true));
        assert!(!permission_gained(false, false));
        assert!(!permission_gained(true, false));
    }
}
