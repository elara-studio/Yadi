//! The listener process itself: no windows, no tray. Every 100 ms it checks whether Yadi runs;
//! while it does, the listener's keyboard hook and shortcut are off. Otherwise it listens for
//! the summon from Yadi's saved settings and opens Yadi when it comes.

use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_log::{Target, TargetKind};

use crate::hotkey::hook::{HookState, SummonFn};
use crate::hotkey::permissions;
use crate::settings::{self, Settings, SummonMode};

const TICK: Duration = Duration::from_millis(100);
/// Ticks between re-reading the settings file and the keyboard permission.
const RECHECK_TICKS: u32 = 10;
/// After opening Yadi, further summons are ignored for this long (Yadi is starting).
const LAUNCH_GRACE: Duration = Duration::from_secs(15);

/// What the listener listens for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Plan {
    /// Yadi runs: it handles the summon itself.
    Off,
    HoldY {
        threshold_ms: u32,
    },
    Chord(String),
}

/// Same choice as Yadi makes at startup: Hold-Y when chosen and permitted, otherwise the chord.
pub fn plan(main_running: bool, settings: &Settings, hold_y_permitted: bool) -> Plan {
    if main_running {
        return Plan::Off;
    }
    match settings.summon.mode {
        SummonMode::LongpressY if hold_y_permitted => Plan::HoldY {
            threshold_ms: settings.summon.threshold_ms,
        },
        _ => Plan::Chord(settings.summon.chord.clone()),
    }
}

pub fn run(context: tauri::Context) {
    let app = tauri::Builder::default()
        .plugin(
            // Also a file (Yadi's log folder, "summon-listener.log"): launchd drops stdout, and
            // the file is the only way to see why a summon did not open Yadi. The listener
            // logs states only, never what is typed.
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir {
                        file_name: Some("summon-listener".into()),
                    }),
                ])
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let dir = super::data_dir(app.handle())?;
            let Some(lock) = super::try_hold(&dir.join(super::LISTENER_LOCK))? else {
                log::info!("summon listener already running; this copy exits");
                std::process::exit(0);
            };
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("yadi-summon-listener".into())
                .spawn(move || {
                    let _lock = lock; // held for the life of the listener
                    watch(handle, dir);
                })?;
            log::info!("summon listener started");
            Ok(())
        })
        .build(context)
        .expect("error while building the summon listener");
    app.run(|_app, event| {
        // The listener has no windows; nothing but the system should end it.
        if let tauri::RunEvent::ExitRequested {
            api, code: None, ..
        } = event
        {
            api.prevent_exit();
        }
    });
}

#[derive(Default)]
struct Launcher {
    last: Mutex<Option<Instant>>,
}

impl Launcher {
    fn summon(&self) {
        let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
        if last.is_some_and(|t| t.elapsed() < LAUNCH_GRACE) {
            return;
        }
        log::info!("summon while Yadi is closed; opening Yadi");
        match super::launch_main() {
            Ok(()) => *last = Some(Instant::now()),
            Err(e) => log::warn!("{e}"),
        }
    }

    fn yadi_is_up(&self) {
        *self.last.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

fn watch(app: AppHandle, dir: PathBuf) {
    let main_lock = dir.join(super::MAIN_LOCK);
    let settings_file = dir.join("settings.json");
    let hook = HookState::new();
    let launcher = Arc::new(Launcher::default());
    let on_summon: SummonFn = {
        let launcher = launcher.clone();
        Arc::new(move || launcher.summon())
    };

    let mut current = Plan::Off;
    let mut settings = Settings::default();
    let mut settings_stamp = None;
    let mut permitted = false;
    let mut was_running = true;
    let mut tick: u32 = 0;
    loop {
        let running = super::is_held(&main_lock);
        if running {
            launcher.yadi_is_up();
        }
        // Yadi just quit (its settings may have changed) or it is time for a fresh look.
        if !running && (was_running || tick.is_multiple_of(RECHECK_TICKS)) {
            let stamp = modified(&settings_file);
            if was_running || stamp != settings_stamp {
                settings = settings::read_file(&settings_file);
                settings_stamp = stamp;
            }
            let now = permissions::status().all_granted();
            if now != permitted || was_running {
                log::info!("summon listener: Accessibility granted: {now}");
            }
            permitted = now;
        }
        was_running = running;
        tick = tick.wrapping_add(1);

        let wanted = plan(running, &settings, permitted);
        // A Y still held when Yadi comes up is finished by the listener's hook first, so its
        // repeats and key-up do not leak into the focused app.
        let y_held = hook.shared.engine().is_tracking();
        if wanted != current && !(wanted == Plan::Off && y_held) {
            switch(&app, &hook, &on_summon, &wanted, &settings.summon.chord);
            current = wanted;
        }
        std::thread::sleep(TICK);
    }
}

/// Turns the hook and the shortcut on or off to match `wanted`. Failures are logged; the plan
/// still counts as applied, so a refused shortcut is not retried ten times a second.
fn switch(app: &AppHandle, hook: &HookState, on_summon: &SummonFn, wanted: &Plan, chord: &str) {
    let _ = app.global_shortcut().unregister_all();
    match wanted {
        Plan::Off => {
            hook.shared.set_enabled(false);
            log::info!("Yadi is running; summon listener resting");
        }
        Plan::HoldY { threshold_ms } => match hook.ensure_started(on_summon.clone()) {
            Ok(()) => {
                hook.shared.set_threshold(*threshold_ms);
                hook.shared.set_enabled(true);
                log::info!("summon listener: listening for Hold-Y");
            }
            Err(e) => {
                log::warn!("summon listener: Hold-Y unavailable ({e}); using the shortcut");
                register_chord(app, chord, on_summon);
            }
        },
        Plan::Chord(chord) => {
            hook.shared.set_enabled(false);
            register_chord(app, chord, on_summon);
        }
    }
}

fn register_chord(app: &AppHandle, chord: &str, on_summon: &SummonFn) {
    let Ok(shortcut) = Shortcut::from_str(chord) else {
        log::warn!("summon listener: invalid shortcut '{chord}'");
        return;
    };
    let on_summon = on_summon.clone();
    let registered = app
        .global_shortcut()
        .on_shortcut(shortcut, move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                on_summon();
            }
        });
    match registered {
        Ok(()) => log::info!("summon listener: listening for the shortcut"),
        Err(e) => log::warn!("summon listener: could not register '{chord}': {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rests_while_yadi_runs() {
        assert_eq!(plan(true, &Settings::default(), true), Plan::Off);
    }

    #[test]
    fn listens_for_hold_y_when_chosen_and_permitted() {
        let s = Settings::default();
        assert_eq!(
            plan(false, &s, true),
            Plan::HoldY {
                threshold_ms: s.summon.threshold_ms
            }
        );
    }

    #[test]
    fn falls_back_to_the_shortcut_without_permission_like_yadi_does() {
        let s = Settings::default();
        assert_eq!(plan(false, &s, false), Plan::Chord(s.summon.chord.clone()));
    }

    #[test]
    fn listens_for_the_chosen_shortcut() {
        let mut s = Settings::default();
        s.summon.mode = SummonMode::Chord;
        s.summon.chord = "Alt+Space".into();
        assert_eq!(plan(false, &s, true), Plan::Chord("Alt+Space".into()));
    }
}
