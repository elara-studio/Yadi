//! Tauri commands for recording: `audio_start`, `audio_stop`, `audio_clear`.
//! Events: `audio:level {rms}` about 15 times a second, `audio:error {kind, message}`.

use std::sync::{Arc, Mutex};

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

use super::file_source::{FileSource, Pace};
use super::mic::MicSource;
use super::permission::{MicPermission, blocking_error, microphone_status};
use super::session::{AudioEvents, RecordingBuffer, Session};
use super::{AudioError, AudioSource};

/// Development/testing hook: when set to the path of a 16 kHz mono WAV, recording plays that
/// file instead of using the microphone.
pub const AUDIO_FILE_ENV: &str = "YADI_AUDIO_FILE";

#[derive(Default)]
pub struct AudioState {
    session: Mutex<Option<Session>>,
    pub buffer: RecordingBuffer,
}

impl AudioState {
    /// A queue of the running session's audio chunks (for speech recognition), if recording.
    pub fn subscribe(&self) -> Option<std::sync::Arc<super::queue::ChunkQueue>> {
        let slot = self.session.lock().unwrap_or_else(|e| e.into_inner());
        slot.as_ref().map(Session::subscribe)
    }
}

struct TauriEvents(AppHandle);

impl AudioEvents for TauriEvents {
    fn level(&self, rms: f32) {
        let _ = self.0.emit("audio:level", json!({ "rms": rms }));
    }
    fn error(&self, error: &AudioError) {
        log::warn!("audio error: {:?}", error.kind);
        let _ = self.0.emit("audio:error", error);
    }
}

#[tauri::command]
pub fn audio_start(app: AppHandle, state: State<AudioState>) -> Result<(), AudioError> {
    let mut slot = state.session.lock().unwrap_or_else(|e| e.into_inner());
    // A new recording always starts cleanly; a stale session (e.g. one that failed) is dropped.
    if let Some(mut old) = slot.take() {
        old.stop();
    }
    let (source, watch_silence): (Box<dyn AudioSource>, bool) =
        match std::env::var_os(AUDIO_FILE_ENV) {
            Some(path) => {
                log::info!("recording from a test file ({AUDIO_FILE_ENV} is set)");
                (Box::new(FileSource::new(path, Pace::Realtime)), false)
            }
            None => {
                let status = microphone_status();
                log::info!("microphone permission: {status:?}");
                if let Some(err) = blocking_error(status) {
                    return Err(err);
                }
                // Without a native permission answer, fall back to the silence heuristic.
                let device = app
                    .try_state::<crate::settings::SettingsState>()
                    .and_then(|s| s.0.lock().ok().map(|s| s.microphone.device.clone()))
                    .flatten();
                (
                    Box::new(MicSource::with_device(device)),
                    status == MicPermission::Unknown,
                )
            }
        };
    let session = Session::start(
        source,
        Arc::new(TauriEvents(app)),
        state.buffer.clone(),
        watch_silence,
    )?;
    *slot = Some(session);
    Ok(())
}

/// Stops recording. The recording stays in memory (for the final pass) until `audio_clear`.
#[tauri::command]
pub fn audio_stop(state: State<AudioState>) {
    let mut slot = state.session.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut session) = slot.take() {
        session.stop();
    }
}

/// Frees the recording (called on `clearSession`).
#[tauri::command]
pub fn audio_clear(state: State<AudioState>) {
    audio_stop(state.clone());
    state.buffer.clear();
}
