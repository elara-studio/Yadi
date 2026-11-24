//! `FileSource`: plays a 16 kHz mono WAV file as if it were a microphone. Used by tests and by
//! the speech-recognition integration tests (Tasks 10/11). Reading audio from a file the user
//! points at is fine; Yadi never *writes* audio.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use super::queue::ChunkQueue;
use super::{AudioError, AudioErrorKind, AudioSource, CHUNK_SAMPLES, Msg, SAMPLE_RATE};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pace {
    /// One chunk per 100 ms, like a live microphone.
    Realtime,
    /// As fast as the queue accepts (tests, Task 10/11 fixtures).
    #[allow(dead_code)]
    Fast,
}

pub type Sleeper = Arc<dyn Fn(Duration) + Send + Sync>;

pub struct FileSource {
    path: PathBuf,
    pace: Pace,
    sleeper: Sleeper,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

fn bad(msg: impl Into<String>) -> AudioError {
    AudioError::new(AudioErrorKind::UnsupportedFormat, msg)
}

/// Reads a 16 kHz mono WAV (16-bit integer or 32-bit float) into samples.
pub fn read_wav(path: &Path) -> Result<Vec<f32>, AudioError> {
    let mut reader = hound::WavReader::open(path)
        .map_err(|e| AudioError::new(AudioErrorKind::Other, format!("cannot open WAV: {e}")))?;
    let spec = reader.spec();
    if spec.channels != 1 || spec.sample_rate != SAMPLE_RATE {
        return Err(bad(format!(
            "expected 16 kHz mono, got {} Hz with {} channel(s)",
            spec.sample_rate, spec.channels
        )));
    }
    match (spec.sample_format, spec.bits_per_sample) {
        (hound::SampleFormat::Int, 16) => reader
            .samples::<i16>()
            .map(|s| {
                s.map(|v| f32::from(v) / 32_768.0)
                    .map_err(|e| bad(e.to_string()))
            })
            .collect(),
        (hound::SampleFormat::Float, 32) => reader
            .samples::<f32>()
            .map(|s| s.map_err(|e| bad(e.to_string())))
            .collect(),
        (f, b) => Err(bad(format!("unsupported WAV sample format {f:?}/{b}-bit"))),
    }
}

/// Splits samples into 100 ms chunks (the last one may be shorter).
pub fn split_chunks(samples: &[f32]) -> Vec<Vec<f32>> {
    samples.chunks(CHUNK_SAMPLES).map(<[f32]>::to_vec).collect()
}

impl FileSource {
    pub fn new(path: impl Into<PathBuf>, pace: Pace) -> Self {
        Self::with_sleeper(path, pace, Arc::new(thread::sleep))
    }

    /// Injects the sleep function so real-time pacing can be tested without waiting.
    pub fn with_sleeper(path: impl Into<PathBuf>, pace: Pace, sleeper: Sleeper) -> Self {
        Self {
            path: path.into(),
            pace,
            sleeper,
            stop: Arc::new(AtomicBool::new(false)),
            thread: None,
        }
    }
}

impl AudioSource for FileSource {
    fn start(&mut self, out: Arc<ChunkQueue>) -> Result<(), AudioError> {
        let chunks = split_chunks(&read_wav(&self.path)?);
        self.stop.store(false, Ordering::Relaxed);
        let stop = self.stop.clone();
        let pace = self.pace;
        let sleeper = self.sleeper.clone();
        self.thread = Some(thread::spawn(move || {
            for chunk in chunks {
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                out.push(Msg::Chunk(chunk));
                if pace == Pace::Realtime {
                    sleeper(Duration::from_millis(100));
                }
            }
            out.push(Msg::End);
        }));
        Ok(())
    }

    fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::PathBuf;

    /// Writes a synthetic mono 16-bit WAV to the system temp dir (tests only; synthetic tone,
    /// not user audio).
    pub fn write_sine_wav(name: &str, rate: u32, channels: u16, samples: usize) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("yadi-test-{}-{name}.wav", std::process::id()));
        let spec = hound::WavSpec {
            channels,
            sample_rate: rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(&path, spec).unwrap();
        for i in 0..samples {
            let v = ((i as f32 * 0.05).sin() * 8_000.0) as i16;
            for _ in 0..channels {
                w.write_sample(v).unwrap();
            }
        }
        w.finalize().unwrap();
        path
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::write_sine_wav;
    use super::*;
    use std::sync::Mutex;

    fn drain(q: &ChunkQueue) -> Vec<Msg> {
        std::iter::from_fn(|| q.try_pop()).collect()
    }

    #[test]
    fn chunks_are_100ms_with_a_shorter_remainder_then_end() {
        let wav = write_sine_wav("chunks", 16_000, 1, 4_000); // 2 x 1600 + 800
        let mut src = FileSource::new(&wav, Pace::Fast);
        let q = Arc::new(ChunkQueue::new(100));
        src.start(q.clone()).unwrap();
        src.thread.take().unwrap().join().unwrap();
        let msgs = drain(&q);
        let sizes: Vec<usize> = msgs
            .iter()
            .filter_map(|m| match m {
                Msg::Chunk(c) => Some(c.len()),
                _ => None,
            })
            .collect();
        assert_eq!(sizes, vec![1_600, 1_600, 800]);
        assert_eq!(msgs.last(), Some(&Msg::End));
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn realtime_pacing_sleeps_100ms_per_chunk() {
        let wav = write_sine_wav("pacing", 16_000, 1, 4_800); // 3 chunks
        let slept = Arc::new(Mutex::new(Vec::new()));
        let s2 = slept.clone();
        let mut src = FileSource::with_sleeper(
            &wav,
            Pace::Realtime,
            Arc::new(move |d| s2.lock().unwrap().push(d)),
        );
        let q = Arc::new(ChunkQueue::new(100));
        src.start(q).unwrap();
        src.thread.take().unwrap().join().unwrap();
        assert_eq!(*slept.lock().unwrap(), vec![Duration::from_millis(100); 3]);
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn fast_mode_never_sleeps() {
        let wav = write_sine_wav("fast", 16_000, 1, 3_200);
        let slept = Arc::new(Mutex::new(0));
        let s2 = slept.clone();
        let mut src = FileSource::with_sleeper(
            &wav,
            Pace::Fast,
            Arc::new(move |_| *s2.lock().unwrap() += 1),
        );
        src.start(Arc::new(ChunkQueue::new(100))).unwrap();
        src.thread.take().unwrap().join().unwrap();
        assert_eq!(*slept.lock().unwrap(), 0);
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn rejects_wrong_rate_or_channel_count_with_a_typed_error() {
        let stereo = write_sine_wav("stereo", 16_000, 2, 1_600);
        let err = read_wav(&stereo).unwrap_err();
        assert_eq!(err.kind, AudioErrorKind::UnsupportedFormat);
        assert!(err.message.contains("16 kHz mono"));
        let fast = write_sine_wav("rate", 44_100, 1, 1_600);
        assert_eq!(
            read_wav(&fast).unwrap_err().kind,
            AudioErrorKind::UnsupportedFormat
        );
        let _ = std::fs::remove_file(stereo);
        let _ = std::fs::remove_file(fast);
    }

    #[test]
    fn missing_file_is_an_error_not_a_panic() {
        let mut src = FileSource::new("/definitely/not/here.wav", Pace::Fast);
        assert!(src.start(Arc::new(ChunkQueue::new(4))).is_err());
    }

    #[test]
    fn samples_are_scaled_to_minus_one_to_one() {
        let wav = write_sine_wav("scale", 16_000, 1, 1_000);
        let samples = read_wav(&wav).unwrap();
        assert!(samples.iter().all(|s| s.abs() <= 1.0));
        assert!(samples.iter().any(|s| s.abs() > 0.1));
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn stop_interrupts_a_running_source() {
        let wav = write_sine_wav("stop", 16_000, 1, 160_000); // 100 chunks
        let mut src = FileSource::with_sleeper(
            &wav,
            Pace::Realtime,
            Arc::new(|_| thread::sleep(Duration::from_millis(5))),
        );
        let q = Arc::new(ChunkQueue::new(1_000));
        src.start(q.clone()).unwrap();
        thread::sleep(Duration::from_millis(30));
        src.stop();
        let n = drain(&q).len();
        assert!(n < 100, "stopped early, got {n} messages");
        let _ = std::fs::remove_file(wav);
    }
}
