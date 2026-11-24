//! Persistent settings (tauri-plugin-store, `settings.json`) and the `get_settings` /
//! `set_settings` commands. The data model and its validation are pure and unit-tested.

use std::str::FromStr;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_global_shortcut::Shortcut;
use tauri_plugin_store::StoreExt;

use crate::hotkey::{self, longpress};

const STORE_FILE: &str = "settings.json";
const STORE_KEY: &str = "settings";
pub const DEFAULT_CHORD: &str = "CommandOrControl+Shift+Y";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SummonMode {
    /// Hold Y anywhere (needs the global keyboard hook, Task 07).
    LongpressY,
    /// A modifier chord such as Cmd/Ctrl+Shift+Y.
    Chord,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Summon {
    pub mode: SummonMode,
    pub threshold_ms: u32,
    pub chord: String,
}

impl Default for Summon {
    fn default() -> Self {
        Self {
            mode: SummonMode::LongpressY,
            threshold_ms: longpress::DEFAULT_THRESHOLD_MS,
            chord: DEFAULT_CHORD.to_string(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub summon: Summon,
}

impl Settings {
    /// Clamps the threshold to 250..=900 ms and falls back to the default chord when empty.
    pub fn normalized(mut self) -> Self {
        self.summon.threshold_ms = longpress::clamp_threshold(self.summon.threshold_ms);
        let trimmed = self.summon.chord.trim();
        self.summon.chord = if trimmed.is_empty() {
            DEFAULT_CHORD.to_string()
        } else {
            trimmed.to_string()
        };
        self
    }

    /// `Ok` when the settings can be applied. A chord must parse and include a modifier:
    /// a bare key as a global shortcut would hijack that key everywhere.
    pub fn validate(&self) -> Result<(), String> {
        validate_chord(&self.summon.chord)
    }
}

pub fn validate_chord(chord: &str) -> Result<(), String> {
    let shortcut =
        Shortcut::from_str(chord).map_err(|e| format!("'{chord}' is not a valid shortcut: {e}"))?;
    if shortcut.mods.is_empty() {
        return Err(format!(
            "'{chord}' needs at least one modifier key (Ctrl, Alt, Shift or Cmd)"
        ));
    }
    Ok(())
}

/// Live settings shared with commands and, from Task 07, the keyboard hook.
pub struct SettingsState(pub Mutex<Settings>);

/// Reads settings from the store; missing or unreadable data yields defaults.
pub fn load(app: &AppHandle) -> Settings {
    app.store(STORE_FILE)
        .ok()
        .and_then(|s| s.get(STORE_KEY))
        .and_then(|v| serde_json::from_value::<Settings>(v).ok())
        .unwrap_or_default()
        .normalized()
}

fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let value = serde_json::to_value(settings).map_err(|e| e.to_string())?;
    store.set(STORE_KEY, value);
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_settings(state: State<SettingsState>) -> Settings {
    state.0.lock().expect("settings lock").clone()
}

#[tauri::command]
pub fn set_settings(
    app: AppHandle,
    state: State<SettingsState>,
    settings: Settings,
) -> Result<Settings, String> {
    let settings = settings.normalized();
    settings.validate()?;
    // Apply first: if the chord cannot be registered (taken by another app) nothing changes.
    hotkey::apply(&app, &settings)?;
    save(&app, &settings)?;
    *state.0.lock().expect("settings lock") = settings.clone();
    Ok(settings)
}

/// Called once from `setup`: loads settings, shares them, and starts the summon hotkey.
pub fn init(app: &AppHandle) {
    let settings = load(app);
    log::info!(
        "settings loaded: summon mode {:?}, threshold {} ms",
        settings.summon.mode,
        settings.summon.threshold_ms
    );
    app.manage(SettingsState(Mutex::new(settings.clone())));
    hotkey::init(app, &settings);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_plan() {
        let s = Settings::default();
        assert_eq!(s.summon.mode, SummonMode::LongpressY);
        assert_eq!(s.summon.threshold_ms, 400);
        assert_eq!(s.summon.chord, "CommandOrControl+Shift+Y");
    }

    #[test]
    fn serialises_with_plan_field_names() {
        let v = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(v["summon"]["mode"], "longpress-y");
        assert_eq!(v["summon"]["threshold_ms"], 400);
        assert_eq!(v["summon"]["chord"], "CommandOrControl+Shift+Y");
        let chord_mode = serde_json::to_value(SummonMode::Chord).unwrap();
        assert_eq!(chord_mode, "chord");
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let s: Settings = serde_json::from_str(r#"{"summon":{"mode":"chord"}}"#).unwrap();
        assert_eq!(s.summon.mode, SummonMode::Chord);
        assert_eq!(s.summon.threshold_ms, 400);
        let empty: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, Settings::default());
    }

    #[test]
    fn unknown_mode_is_rejected_by_serde() {
        assert!(serde_json::from_str::<Settings>(r#"{"summon":{"mode":"nope"}}"#).is_err());
    }

    #[test]
    fn normalize_clamps_threshold_and_fixes_empty_chord() {
        let mut s = Settings::default();
        s.summon.threshold_ms = 50;
        s.summon.chord = "   ".into();
        let n = s.normalized();
        assert_eq!(n.summon.threshold_ms, 250);
        assert_eq!(n.summon.chord, DEFAULT_CHORD);

        let mut s = Settings::default();
        s.summon.threshold_ms = 9_999;
        s.summon.chord = "  Alt+Space ".into();
        let n = s.normalized();
        assert_eq!(n.summon.threshold_ms, 900);
        assert_eq!(n.summon.chord, "Alt+Space");
    }

    #[test]
    fn default_chord_is_a_valid_shortcut() {
        assert_eq!(validate_chord(DEFAULT_CHORD), Ok(()));
        assert_eq!(validate_chord("Ctrl+Alt+K"), Ok(()));
    }

    #[test]
    fn invalid_or_modifierless_chords_are_rejected() {
        assert!(validate_chord("not a shortcut").is_err());
        assert!(validate_chord("").is_err());
        let err = validate_chord("Y").unwrap_err();
        assert!(err.contains("modifier"), "{err}");
    }

    #[test]
    fn settings_validate_uses_the_chord() {
        let mut s = Settings::default();
        assert!(s.validate().is_ok());
        s.summon.chord = "Y".into();
        assert!(s.validate().is_err());
    }
}
