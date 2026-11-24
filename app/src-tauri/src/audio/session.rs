//! A recording session: drains a source's queue on its own thread, keeps the full recording in
//! memory, measures the level, watches for a silent (permission-less) microphone and fans the
//! chunks out to subscribers (speech recognition, Tasks 10/11).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use super::level::{LevelMeter, SilenceWatchdog};
use super::permission::probable_denial_error;
use super::queue::ChunkQueue;
use super::{AudioError, AudioSource, Msg};

/// Receives what the UI needs to know about a running session.
pub trait AudioEvents: Send + Sync + 'static {
    /// RMS level of the last ~1/15 s, 0.0 to 1.0.
    fn level(&self, rms: f32);
    fn error(&self, error: &AudioError);
}

/// The whole recording, in memory only (needed for the final transcription pass, Task 11).
/// 16 kHz mono f32 is about 3.8 MB per minute.
#[derive(Clone, Default)]
pub struct RecordingBuffer(Arc<Mutex<Vec<f32>>>);

impl RecordingBuffer {
    fn lock(&self) -> MutexGuard<'_, Vec<f32>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn append(&self, samples: &[f32]) {
        self.lock().extend_from_slice(samples);
    }
    pub fn len(&self) -> usize {
        self.lock().len()
    }
    /// Takes the samples out (used by the final pass, Task 11), leaving the buffer empty and with its memory released.
    #[allow(dead_code)] // used by the final pass (Task 11)
    pub fn take(&self) -> Vec<f32> {
        std::mem::take(&mut *self.lock())
    }
    /// Empties the buffer and frees its memory.
    pub fn clear(&self) {
        *self.lock() = Vec::new();
    }
}

pub struct Session {
    source: Box<dyn AudioSource>,
    subscribers: Arc<Mutex<Vec<Arc<ChunkQueue>>>>,
    stopping: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Session {
    /// Starts `source` and the processing thread. `watch_silence` enables the "3 s of digital
    /// silence" permission heuristic (used when the OS gives no native permission answer).
    pub fn start(
        mut source: Box<dyn AudioSource>,
        events: Arc<dyn AudioEvents>,
        buffer: RecordingBuffer,
        watch_silence: bool,
    ) -> Result<Self, AudioError> {
        let queue = Arc::new(ChunkQueue::new(50)); // about 5 s of slack
        source.start(queue.clone())?;

        let subscribers: Arc<Mutex<Vec<Arc<ChunkQueue>>>> = Arc::default();
        let stopping = Arc::new(AtomicBool::new(false));
        let thread = {
            let subscribers = subscribers.clone();
            let stopping = stopping.clone();
            thread::Builder::new()
                .name("yadi-audio-session".into())
                .spawn(move || {
                    let mut meter = LevelMeter::default();
                    let mut watchdog = SilenceWatchdog::default();
                    let mut level_updates = 0u64;
                    loop {
                        let msg = queue.pop_timeout(Duration::from_millis(50));
                        match msg {
                            Some(Msg::Chunk(chunk)) => {
                                buffer.append(&chunk);
                                for rms in meter.push(&chunk) {
                                    events.level(rms);
                                    level_updates += 1;
                                }
                                if watch_silence && watchdog.push(&chunk) {
                                    events.error(&probable_denial_error());
                                }
                                for sub in
                                    subscribers.lock().unwrap_or_else(|e| e.into_inner()).iter()
                                {
                                    sub.push(Msg::Chunk(chunk.clone()));
                                }
                            }
                            Some(Msg::Error(e)) => {
                                events.error(&e);
                                broadcast(&subscribers, Msg::Error(e));
                                break;
                            }
                            Some(Msg::End) => {
                                broadcast(&subscribers, Msg::End);
                                break;
                            }
                            None => {
                                if stopping.load(Ordering::Relaxed) {
                                    broadcast(&subscribers, Msg::End);
                                    break;
                                }
                            }
                        }
                    }
                    // Counts only: never log audio.
                    log::info!(
                        "audio session ended: {} samples recorded, {level_updates} level updates, {} chunks dropped",
                        buffer.len(),
                        queue.dropped()
                    );
                })
                .map_err(|e| {
                    AudioError::new(super::AudioErrorKind::Other, format!("session thread: {e}"))
                })?
        };
        Ok(Self {
            source,
            subscribers,
            stopping,
            thread: Some(thread),
        })
    }

    /// A queue that receives every chunk from now on, then `End`.
    #[allow(dead_code)] // used by speech recognition (Task 10)
    pub fn subscribe(&self) -> Arc<ChunkQueue> {
        let q = Arc::new(ChunkQueue::new(50));
        self.subscribers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(q.clone());
        q
    }

    /// Stops the source, lets the processing thread drain what is left, then joins it.
    pub fn stop(&mut self) {
        self.source.stop();
        self.stopping.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stop();
    }
}

fn broadcast(subscribers: &Mutex<Vec<Arc<ChunkQueue>>>, msg: Msg) {
    for sub in subscribers.lock().unwrap_or_else(|e| e.into_inner()).iter() {
        sub.push(msg.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::AudioErrorKind;
    use crate::audio::file_source::{FileSource, Pace, test_support::write_sine_wav};

    #[derive(Default)]
    struct Recorder {
        levels: Mutex<Vec<f32>>,
        errors: Mutex<Vec<AudioError>>,
    }
    impl AudioEvents for Recorder {
        fn level(&self, rms: f32) {
            self.levels.lock().unwrap().push(rms);
        }
        fn error(&self, e: &AudioError) {
            self.errors.lock().unwrap().push(e.clone());
        }
    }

    /// A source that sends a fixed list of messages.
    struct Scripted(Vec<Msg>);
    impl AudioSource for Scripted {
        fn start(&mut self, out: Arc<ChunkQueue>) -> Result<(), AudioError> {
            for m in self.0.drain(..) {
                out.push(m);
            }
            Ok(())
        }
        fn stop(&mut self) {}
    }

    fn wait_end(q: &ChunkQueue) -> Vec<Msg> {
        let mut got = Vec::new();
        while let Some(m) = q.pop_timeout(Duration::from_secs(3)) {
            let end = matches!(m, Msg::End | Msg::Error(_));
            got.push(m);
            if end {
                break;
            }
        }
        got
    }

    #[test]
    fn records_levels_and_fans_out_a_file_end_to_end() {
        let wav = write_sine_wav("session", 16_000, 1, 16_000); // exactly 1 s
        let events = Arc::new(Recorder::default());
        let buffer = RecordingBuffer::default();
        let mut s = Session::start(
            Box::new(FileSource::new(&wav, Pace::Fast)),
            events.clone(),
            buffer.clone(),
            false,
        )
        .unwrap();
        let sub = s.subscribe();
        let got = wait_end(&sub);
        s.stop();
        // every sample was kept in memory and every chunk reached the subscriber
        assert_eq!(buffer.len(), 16_000);
        let chunk_samples: usize = got
            .iter()
            .map(|m| if let Msg::Chunk(c) = m { c.len() } else { 0 })
            .sum();
        assert!(chunk_samples > 0 && chunk_samples <= 16_000);
        assert_eq!(got.last(), Some(&Msg::End));
        // about 15 level updates for 1 s of audio
        let n = events.levels.lock().unwrap().len();
        assert!((14..=15).contains(&n), "levels {n}");
        assert!(events.errors.lock().unwrap().is_empty());
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn a_source_error_is_reported_and_forwarded() {
        let events = Arc::new(Recorder::default());
        let err = AudioError::new(AudioErrorKind::DeviceLost, "unplugged");
        let mut s = Session::start(
            Box::new(Scripted(vec![
                Msg::Chunk(vec![0.1; 1_600]),
                Msg::Error(err.clone()),
            ])),
            events.clone(),
            RecordingBuffer::default(),
            false,
        )
        .unwrap();
        s.stop();
        assert_eq!(*events.errors.lock().unwrap(), vec![err]);
    }

    #[test]
    fn three_seconds_of_digital_silence_reports_probable_permission_denial() {
        let events = Arc::new(Recorder::default());
        let chunks = (0..31).map(|_| Msg::Chunk(vec![0.0; 1_600])).collect();
        let mut s = Session::start(
            Box::new(Scripted(chunks)),
            events.clone(),
            RecordingBuffer::default(),
            true,
        )
        .unwrap();
        thread::sleep(Duration::from_millis(300));
        s.stop();
        let errors = events.errors.lock().unwrap();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].kind, AudioErrorKind::ProbablePermissionDenied);
    }

    #[test]
    fn silence_is_fine_when_the_watchdog_is_off() {
        let events = Arc::new(Recorder::default());
        let chunks = (0..31).map(|_| Msg::Chunk(vec![0.0; 1_600])).collect();
        let mut s = Session::start(
            Box::new(Scripted(chunks)),
            events.clone(),
            RecordingBuffer::default(),
            false,
        )
        .unwrap();
        thread::sleep(Duration::from_millis(300));
        s.stop();
        assert!(events.errors.lock().unwrap().is_empty());
    }

    #[test]
    fn stop_drains_what_the_source_already_produced() {
        let buffer = RecordingBuffer::default();
        let chunks = (0..10).map(|_| Msg::Chunk(vec![0.2; 1_600])).collect();
        let mut s = Session::start(
            Box::new(Scripted(chunks)),
            Arc::new(Recorder::default()),
            buffer.clone(),
            false,
        )
        .unwrap();
        s.stop();
        assert_eq!(buffer.len(), 16_000);
    }

    #[test]
    fn a_source_that_fails_to_start_returns_its_error() {
        struct Broken;
        impl AudioSource for Broken {
            fn start(&mut self, _: Arc<ChunkQueue>) -> Result<(), AudioError> {
                Err(AudioError::new(AudioErrorKind::NoDevice, "no mic"))
            }
            fn stop(&mut self) {}
        }
        let err = Session::start(
            Box::new(Broken),
            Arc::new(Recorder::default()),
            RecordingBuffer::default(),
            false,
        )
        .err()
        .unwrap();
        assert_eq!(err.kind, AudioErrorKind::NoDevice);
    }

    #[test]
    fn buffer_take_and_clear_release_the_audio() {
        let b = RecordingBuffer::default();
        b.append(&[0.1, 0.2, 0.3]);
        assert_eq!(b.take(), vec![0.1, 0.2, 0.3]);
        assert_eq!(b.len(), 0);
        b.append(&[1.0]);
        b.clear();
        assert_eq!(b.len(), 0);
    }
}
