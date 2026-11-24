//! Chord fallback: a normal global shortcut (default Cmd/Ctrl+Shift+Y) that fires
//! `hotkey:summon`. Registered only when `summon.mode == "chord"`.

use std::str::FromStr;

use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::settings::{Settings, SummonMode};
use crate::windows::MASCOT_LABEL;

/// Makes the registered shortcuts match `settings`: removes ours, then registers the chord
/// if the mode asks for it. Returns a readable error if the OS refuses the shortcut.
pub fn apply(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    if settings.summon.mode != SummonMode::Chord {
        return Ok(());
    }
    let chord = &settings.summon.chord;
    let shortcut =
        Shortcut::from_str(chord).map_err(|e| format!("invalid shortcut '{chord}': {e}"))?;
    gs.on_shortcut(shortcut, |app, _shortcut, event| {
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
