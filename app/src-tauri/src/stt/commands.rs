//! `stt_start` / `stt_stop` and the worker that feeds the recogniser.
//!
//! Order used by the Controller: `audio_start` then `stt_start`; on stop, `audio_stop` then
//! `stt_stop`. The worker also ends by itself when the audio session ends.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::json;
use sherpa_onnx::OnlineRecognizer;
use tauri::{AppHandle, Emitter, State};

use super::stream::{
    Options, PREFERRED_MODEL, SMALL_MODEL, SherpaDecoder, SttEvent, Transcriber, load_recognizer,
};
use crate::audio::Msg;
use crate::audio::commands::AudioState;
use crate::audio::queue::ChunkQueue;
use crate::models::{installed_dir, models_dir};

#[derive(Default)]
pub struct SttState {
    recognizer: Mutex<Option<Arc<OnlineRecognizer>>>,
    worker: Mutex<Option<Worker>>,
}

struct Worker {
    stop: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}

/// The preferred streaming model if installed, otherwise the small one.
fn installed_stream_model(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let root = models_dir(app)?;
    [PREFERRED_MODEL, SMALL_MODEL]
        .iter()
        .find_map(|id| installed_dir(&root, id))
        .ok_or_else(|| "The speech recognition model is not installed yet.".to_string())
}

fn emit_event(app: &AppHandle, event: SttEvent) {
    let _ = match event {
        SttEvent::Partial(text) => app.emit("stt:partial", json!({ "text": text })),
        SttEvent::Final { id, text } => app.emit("stt:final", json!({ "id": id, "text": text })),
    };
}

fn run_worker(
    app: AppHandle,
    recognizer: Arc<OnlineRecognizer>,
    queue: Arc<ChunkQueue>,
    stop: Arc<AtomicBool>,
) {
    let mut transcriber = Transcriber::new(SherpaDecoder::new(recognizer));
    let mut latencies: Vec<u128> = Vec::new();
    let mut finals = 0u64;

    let mut feed = |chunk: &[f32], transcriber: &mut Transcriber<SherpaDecoder>| {
        let started = Instant::now();
        let mut partial = false;
        transcriber.push(chunk, &mut |event| {
            match &event {
                SttEvent::Partial(_) => partial = true,
                SttEvent::Final { .. } => finals += 1,
            }
            emit_event(&app, event);
        });
        if partial {
            latencies.push(started.elapsed().as_micros());
        }
    };

    loop {
        match queue.pop_timeout(Duration::from_millis(50)) {
            Some(Msg::Chunk(chunk)) => feed(&chunk, &mut transcriber),
            Some(Msg::End) | Some(Msg::Error(_)) => break,
            None => {
                if stop.load(Ordering::Relaxed) {
                    while let Some(msg) = queue.try_pop() {
                        if let Msg::Chunk(chunk) = msg {
                            feed(&chunk, &mut transcriber);
                        }
                    }
                    break;
                }
            }
        }
    }
    transcriber.finish(&mut |event| {
        if matches!(event, SttEvent::Final { .. }) {
            finals += 1;
        }
        emit_event(&app, event);
    });

    latencies.sort_unstable();
    let median_ms = latencies
        .get(latencies.len() / 2)
        .map(|us| *us as f64 / 1000.0);
    // Counts and timings only: never the text.
    log::info!(
        "speech recognition ended: {finals} segment(s), {} partial update(s), median chunk-to-partial processing time {} ms",
        latencies.len(),
        median_ms.map_or("n/a".to_string(), |m| format!("{m:.1}"))
    );
}

#[tauri::command]
pub async fn stt_start(
    app: AppHandle,
    audio: State<'_, AudioState>,
    stt: State<'_, SttState>,
) -> Result<(), String> {
    let queue = audio
        .subscribe()
        .ok_or("Recording has not started, so there is nothing to transcribe.")?;

    // Load the model lazily, off the UI thread, and keep it for later recordings.
    let cached = stt
        .recognizer
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let recognizer = match cached {
        Some(r) => r,
        None => {
            let dir = installed_stream_model(&app)?;
            let loaded = tauri::async_runtime::spawn_blocking(move || {
                load_recognizer(&dir, Options::default())
            })
            .await
            .map_err(|e| format!("model loading failed: {e}"))??;
            *stt.recognizer.lock().unwrap_or_else(|e| e.into_inner()) = Some(loaded.clone());
            loaded
        }
    };

    // A new recording replaces any worker still running.
    if let Some(old) = stt.worker.lock().unwrap_or_else(|e| e.into_inner()).take() {
        old.stop.store(true, Ordering::Relaxed);
        let _ = old.handle.join();
    }
    let stop = Arc::new(AtomicBool::new(false));
    let worker_stop = stop.clone();
    let handle = thread::Builder::new()
        .name("yadi-stt".into())
        .spawn(move || run_worker(app, recognizer, queue, worker_stop))
        .map_err(|e| format!("could not start speech recognition: {e}"))?;
    *stt.worker.lock().unwrap_or_else(|e| e.into_inner()) = Some(Worker { stop, handle });
    Ok(())
}

/// Flushes the decoder (the last words become a final segment) and ends the worker.
#[tauri::command]
pub async fn stt_stop(stt: State<'_, SttState>) -> Result<(), String> {
    let worker = stt.worker.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(w) = worker {
        w.stop.store(true, Ordering::Relaxed);
        tauri::async_runtime::spawn_blocking(move || {
            let _ = w.handle.join();
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
