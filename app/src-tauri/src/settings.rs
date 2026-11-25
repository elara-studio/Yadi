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

/// The second, more accurate transcription pass after recording (PLAN Task 11).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct FinalPassSettings {
    pub enabled: bool,
    /// Give up and keep the live transcript after this many seconds.
    pub timeout_seconds: u32,
}

impl Default for FinalPassSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            timeout_seconds: 20,
        }
    }
}

/// Which microphone to record from. `None` = the system default.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct MicrophoneSettings {
    pub device: Option<String>,
}

/// A language model chosen by the user instead of the one picked for this hardware.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct LlmSettings {
    /// A catalogue id (`models.json`). `None` = the hardware tier's model.
    pub model_id: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub summon: Summon,
    #[serde(rename = "finalPass")]
    pub final_pass: FinalPassSettings,
    pub microphone: MicrophoneSettings,
    pub llm: LlmSettings,
}

fn clean_optional(value: Option<String>, max: usize) -> Option<String> {
    value
        .map(|v| v.trim().chars().take(max).collect::<String>())
        .filter(|v| !v.is_empty())
}

impl Settings {
    /// Clamps the threshold to 250..=900 ms and falls back to the default chord when empty.
    pub fn normalized(mut self) -> Self {
        self.summon.threshold_ms = longpress::clamp_threshold(self.summon.threshold_ms);
        let trimmed = self.summon.chord.trim();
        self.final_pass.timeout_seconds = self.final_pass.timeout_seconds.clamp(5, 120);
        self.microphone.device = clean_optional(self.microphone.device.take(), 200);
        self.llm.model_id = clean_optional(self.llm.model_id.take(), 100);
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

/// "Reset everything": default settings (applied to the summon hotkey too) and an empty
/// vocabulary. Downloaded models and the setup progress are kept.
#[tauri::command]
pub fn reset_everything(app: AppHandle, state: State<SettingsState>) -> Result<Settings, String> {
    let settings = Settings::default();
    hotkey::apply(&app, &settings)?;
    save(&app, &settings)?;
    *state.0.lock().expect("settings lock") = settings.clone();
    crate::vocabulary::clear(&app)?;
    log::info!("settings and vocabulary were reset");
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
    fn final_pass_defaults_to_enabled_with_a_20_second_timeout() {
        let s = Settings::default();
        assert!(s.final_pass.enabled);
        assert_eq!(s.final_pass.timeout_seconds, 20);
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["finalPass"]["enabled"], true);
        assert_eq!(v["finalPass"]["timeout_seconds"], 20);
        // old settings files without the field still load
        let old: Settings = serde_json::from_str(r#"{"summon":{"mode":"chord"}}"#).unwrap();
        assert!(old.final_pass.enabled);
    }

    #[test]
    fn final_pass_timeout_is_clamped() {
        let mut s = Settings::default();
        s.final_pass.timeout_seconds = 0;
        assert_eq!(s.clone().normalized().final_pass.timeout_seconds, 5);
        s.final_pass.timeout_seconds = 9_999;
        assert_eq!(s.normalized().final_pass.timeout_seconds, 120);
    }

    #[test]
    fn microphone_and_model_choices_default_to_automatic_and_load_from_old_files() {
        let s = Settings::default();
        assert_eq!(s.microphone.device, None);
        assert_eq!(s.llm.model_id, None);
        let old: Settings = serde_json::from_str(r#"{"summon":{"mode":"chord"}}"#).unwrap();
        assert_eq!(old.microphone, MicrophoneSettings::default());
        assert_eq!(old.llm, LlmSettings::default());
    }

    #[test]
    fn microphone_and_model_choices_are_trimmed_and_blank_means_automatic() {
        let mut s = Settings::default();
        s.microphone.device = Some("  USB Mic  ".into());
        s.llm.model_id = Some("   ".into());
        let n = s.normalized();
        assert_eq!(n.microphone.device.as_deref(), Some("USB Mic"));
        assert_eq!(n.llm.model_id, None);
        let mut long = Settings::default();
        long.microphone.device = Some("x".repeat(500));
        assert_eq!(
            long.normalized().microphone.device.unwrap().chars().count(),
            200
        );
    }

    #[test]
    fn choices_round_trip_through_json() {
        let mut s = Settings::default();
        s.microphone.device = Some("Studio".into());
        s.llm.model_id = Some("qwen3-8b".into());
        let back: Settings = serde_json::from_value(serde_json::to_value(&s).unwrap()).unwrap();
        assert_eq!(back, s);
    }

    /// `set_settings` clamps the hold time and then hands it to the detector.
    #[test]
    fn a_new_hold_time_reaches_the_detector_clamped() {
        use crate::hotkey::{apply_threshold, hook::Shared};
        let shared = Shared::new(400);
        for (asked, expected) in [(700, 700), (100, 250), (5_000, 900), (250, 250), (900, 900)] {
            let mut s = Settings::default();
            s.summon.threshold_ms = asked;
            let applied = s.normalized();
            apply_threshold(&shared, &applied);
            assert_eq!(shared.threshold(), expected, "asked for {asked}");
        }
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
