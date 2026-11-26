//! Chord fallback: a normal global shortcut (default Cmd/Ctrl+Shift+Y) that fires
//! `hotkey:summon`. Registered only when `summon.mode == "chord"`.

use std::str::FromStr;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::settings::{Settings, SummonMode};
use crate::windows::MASCOT_LABEL;

/// The chord currently meant to be registered (also while paused), so it can be restored.
static ACTIVE: Mutex<Option<String>> = Mutex::new(None);

fn active() -> std::sync::MutexGuard<'static, Option<String>> {
    ACTIVE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Makes the registered shortcuts match `settings`: removes ours, then registers the chord
/// if the mode asks for it. Returns a readable error if the OS refuses the shortcut.
pub fn apply(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    *active() = None;
    if settings.summon.mode != SummonMode::Chord {
        return Ok(());
    }
    register(app, &settings.summon.chord)?;
    *active() = Some(settings.summon.chord.clone());
    Ok(())
}

fn register(app: &AppHandle, chord: &str) -> Result<(), String> {
    let shortcut =
        Shortcut::from_str(chord).map_err(|e| format!("invalid shortcut '{chord}': {e}"))?;
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                // Log the fact only, never any key content.
                log::info!("summon fired (chord)");
                let _ = app.emit_to(MASCOT_LABEL, "hotkey:summon", ());
            }
        })
        .map_err(|e| format!("could not register '{chord}': {e}"))?;
    log::info!("summon chord registered");
    Ok(())
}

/// While Settings records a new shortcut: let every key reach the window, even the current
/// chord (otherwise the OS would swallow it and summon Yadi instead).
pub fn pause(app: &AppHandle) -> Result<(), String> {
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| e.to_string())
}

/// Puts back whatever chord is active (the saved one, or the fallback chord). Safe to call
/// when nothing was paused.
pub fn resume(app: &AppHandle) -> Result<(), String> {
    let chord = active().clone();
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| e.to_string())?;
    match chord {
        Some(chord) => register(app, &chord),
        None => Ok(()),
    }
}
