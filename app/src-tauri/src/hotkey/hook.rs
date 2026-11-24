//! Platform-independent part of the global keyboard hook: shared state, the timer that turns a
//! long press into a summon, and the entry point that starts the OS hook (macOS / Windows).

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use super::engine::{Engine, Output};
use super::longpress::DEFAULT_THRESHOLD_MS;

/// Tag on synthetic events so the hook can ignore its own replays ("YADI" in ASCII).
pub const SYNTHETIC_TAG: i64 = 0x5941_4449;

/// How often the timer checks whether a held Y reached the threshold.
const TICK: Duration = Duration::from_millis(15);

pub type SummonFn = Arc<dyn Fn() + Send + Sync + 'static>;

#[derive(Debug)]
pub enum HookError {
    /// The OS refused to install the hook (macOS: Accessibility / Input Monitoring missing).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    PermissionDenied(String),
    Failed(String),
}

impl std::fmt::Display for HookError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HookError::PermissionDenied(m) | HookError::Failed(m) => f.write_str(m),
        }
    }
}

/// Milliseconds on a monotonic clock, shared by the hook callback and the timer.
pub fn now_ms() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// State shared by the hook callback thread, the timer thread and the Tauri commands.
pub struct Shared {
    engine: Mutex<Engine>,
    /// When false the hook passes every event through untouched (chord mode).
    enabled: AtomicBool,
    /// True while the Yadi chat window has keyboard focus (own-window rule).
    chat_focused: AtomicBool,
    threshold_ms: AtomicU32,
}

impl Shared {
    pub fn new(threshold_ms: u32) -> Self {
        Self {
            engine: Mutex::new(Engine::new(threshold_ms)),
            enabled: AtomicBool::new(false),
            chat_focused: AtomicBool::new(false),
            threshold_ms: AtomicU32::new(threshold_ms),
        }
    }

    /// A panic in one callback must never disable the hook for good.
    pub fn engine(&self) -> MutexGuard<'_, Engine> {
        self.engine.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    pub fn set_enabled(&self, on: bool) {
        let was = self.enabled.swap(on, Ordering::Relaxed);
        if was && !on {
            let threshold = self.threshold_ms.load(Ordering::Relaxed);
            self.engine().reset(threshold);
        }
    }

    pub fn chat_focused(&self) -> bool {
        self.chat_focused.load(Ordering::Relaxed)
    }

    pub fn set_chat_focused(&self, focused: bool) {
        self.chat_focused.store(focused, Ordering::Relaxed);
    }

    pub fn set_threshold(&self, ms: u32) {
        self.threshold_ms.store(ms, Ordering::Relaxed);
        self.engine().set_threshold(ms);
    }
}

/// Owner of the shared state and of the one-time OS hook installation.
pub struct HookState {
    pub shared: Arc<Shared>,
    started: Mutex<bool>,
}

impl HookState {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(Shared::new(DEFAULT_THRESHOLD_MS)),
            started: Mutex::new(false),
        }
    }

    /// Installs the OS hook and the timer once; later calls are no-ops. Errors are returned,
    /// never panicked, so the caller can fall back to the chord.
    pub fn ensure_started(&self, on_summon: SummonFn) -> Result<(), HookError> {
        let mut started = self.started.lock().unwrap_or_else(|e| e.into_inner());
        if *started {
            return Ok(());
        }
        super::platform::start(self.shared.clone(), on_summon.clone())?;
        spawn_ticker(self.shared.clone(), on_summon);
        *started = true;
        Ok(())
    }
}

impl Default for HookState {
    fn default() -> Self {
        Self::new()
    }
}

fn spawn_ticker(shared: Arc<Shared>, on_summon: SummonFn) {
    let spawned = thread::Builder::new()
        .name("yadi-hook-timer".into())
        .spawn(move || {
            loop {
                thread::sleep(TICK);
                if !shared.enabled() {
                    continue;
                }
                let out = shared.engine().on_tick(now_ms());
                if out == Some(Output::Summon) {
                    // Log the fact only, never key content.
                    log::info!("summon fired (long press)");
                    on_summon();
                }
            }
        });
    if let Err(e) = spawned {
        log::error!("could not start the hook timer: {e}");
    }
}
