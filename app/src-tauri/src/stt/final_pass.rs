//! Final pass: after recording, the whole recording is transcribed again with an offline Whisper
//! English model, and that text replaces the live transcript (PLAN Task 11).
//!
//! Long recordings are cut at silence boundaries into chunks of at most 25 s (Whisper's window)
//! and the pieces are joined. The result replaces the live transcript wholesale; if anything
//! fails or takes longer than the timeout, the live transcript is kept.
//!
//! Privacy (D12): audio is taken out of the in-memory buffer (which frees it) and never written
//! to disk; nothing here logs text.

use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use sherpa_onnx::{
    OfflineModelConfig, OfflineRecognizer, OfflineRecognizerConfig, OfflineWhisperModelConfig,
};

use crate::audio::SAMPLE_RATE;
use crate::audio::session::RecordingBuffer;

/// Whisper's context window is 30 s; chunks stay a little below that.
pub const MAX_CHUNK_SECONDS: f32 = 25.0;
/// Recordings shorter than this are not worth a second pass.
pub const MIN_SECONDS: f32 = 0.3;

const FRAME: usize = 320; // 20 ms at 16 kHz
const MIN_SILENCE_FRAMES: usize = 15; // 0.3 s of quiet makes a usable cut point
/// A frame is quiet if its RMS is below this fraction of the loudest frame (and at least `FLOOR`).
const RELATIVE_QUIET: f32 = 0.06;
const FLOOR: f32 = 0.004;

fn frame_rms(samples: &[f32]) -> Vec<f32> {
    samples
        .chunks(FRAME)
        .map(|f| (f.iter().map(|s| s * s).sum::<f32>() / f.len() as f32).sqrt())
        .collect()
}

/// Splits `samples` into ranges of at most `max_seconds`, preferring to cut in the middle of the
/// latest silence in the last half of the allowed window, and falling back to a hard cut.
pub fn split_at_silence(samples: &[f32], max_seconds: f32) -> Vec<Range<usize>> {
    let max = (max_seconds * SAMPLE_RATE as f32) as usize;
    if samples.len() <= max {
        return std::iter::once(0..samples.len()).collect();
    }
    let rms = frame_rms(samples);
    let loudest = rms.iter().copied().fold(0.0f32, f32::max);
    let quiet_below = (loudest * RELATIVE_QUIET).max(FLOOR);
    let quiet: Vec<bool> = rms.iter().map(|r| *r < quiet_below).collect();

    let mut ranges = Vec::new();
    let mut start = 0usize;
    while samples.len() - start > max {
        let window_start = start + max / 2;
        let window_end = start + max;
        // latest silence run inside the window; cut in its middle
        let mut cut = None;
        let mut frame = window_start / FRAME;
        let last_frame = window_end / FRAME;
        while frame < last_frame.min(quiet.len()) {
            if quiet[frame] {
                let run_start = frame;
                while frame < last_frame.min(quiet.len()) && quiet[frame] {
                    frame += 1;
                }
                if frame - run_start >= MIN_SILENCE_FRAMES {
                    cut = Some((run_start + frame) / 2 * FRAME);
                }
            } else {
                frame += 1;
            }
        }
        let end = cut
            .filter(|c| *c > start)
            .unwrap_or(window_end)
            .min(samples.len());
        ranges.push(start..end);
        start = end;
    }
    ranges.push(start..samples.len());
    ranges
}

/// True when a chunk contains no real signal (Whisper tends to invent text for silence).
pub fn is_silent(chunk: &[f32]) -> bool {
    chunk.iter().all(|s| s.abs() < 1e-4)
}

/// An offline recogniser for one chunk of 16 kHz mono audio.
pub trait OfflineEngine {
    fn transcribe(&self, samples: &[f32]) -> Result<String, String>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FinalPassError {
    TimedOut,
    Failed(String),
}

/// Transcribes all chunks. `elapsed` is the injected clock (time since the pass started).
/// Progress is `(chunks done, chunks total)`.
pub fn run(
    samples: &[f32],
    engine: &dyn OfflineEngine,
    timeout: Duration,
    elapsed: &dyn Fn() -> Duration,
    progress: &mut dyn FnMut(usize, usize),
) -> Result<String, FinalPassError> {
    let ranges = split_at_silence(samples, MAX_CHUNK_SECONDS);
    let total = ranges.len();
    progress(0, total);
    let mut pieces = Vec::new();
    for (i, range) in ranges.into_iter().enumerate() {
        if elapsed() > timeout {
            return Err(FinalPassError::TimedOut);
        }
        let chunk = &samples[range];
        if !is_silent(chunk) {
            let text = engine.transcribe(chunk).map_err(FinalPassError::Failed)?;
            let text = text.trim();
            if !text.is_empty() {
                pieces.push(text.to_string());
            }
        }
        progress(i + 1, total);
    }
    if elapsed() > timeout {
        return Err(FinalPassError::TimedOut);
    }
    Ok(pieces.join(" "))
}

/// What the UI gets back. `text` replaces the live transcript when present; `notice` is a short
/// message for the user. The pipeline always continues, whatever happened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Outcome {
    pub text: Option<String>,
    pub notice: Option<String>,
}

impl Outcome {
    fn keep_live(notice: Option<&str>) -> Self {
        Self {
            text: None,
            notice: notice.map(str::to_string),
        }
    }
}

/// Takes the recording out of `buffer` (this frees it, whatever happens next), transcribes it and
/// reports what to do with the result. `load_engine` is only called when there is something to do.
pub fn finalize(
    buffer: &RecordingBuffer,
    enabled: bool,
    timeout: Duration,
    load_engine: &dyn Fn() -> Result<Arc<dyn OfflineEngine + Send + Sync>, String>,
    progress: &mut dyn FnMut(usize, usize),
) -> Outcome {
    let samples = buffer.take(); // the buffer is empty from here on
    if !enabled {
        return Outcome::keep_live(None);
    }
    if (samples.len() as f32) < MIN_SECONDS * SAMPLE_RATE as f32 {
        return Outcome::keep_live(None);
    }
    let engine = match load_engine() {
        Ok(e) => e,
        Err(e) => {
            log::warn!("final pass unavailable: {e}");
            return Outcome::keep_live(Some(
                "The accuracy model is not available, so the live transcript was kept.",
            ));
        }
    };
    let started = Instant::now();
    match run(
        &samples,
        engine.as_ref(),
        timeout,
        &|| started.elapsed(),
        progress,
    ) {
        Ok(text) if text.trim().is_empty() => Outcome::keep_live(None),
        Ok(text) => {
            log::info!(
                "final pass finished in {} ms ({} s of audio)",
                started.elapsed().as_millis(),
                samples.len() / SAMPLE_RATE as usize
            );
            Outcome {
                text: Some(text),
                notice: None,
            }
        }
        Err(FinalPassError::TimedOut) => {
            log::warn!(
                "final pass timed out after {} ms",
                started.elapsed().as_millis()
            );
            Outcome::keep_live(Some(
                "Polishing the transcript took too long, so the live transcript was kept.",
            ))
        }
        Err(FinalPassError::Failed(e)) => {
            log::warn!("final pass failed: {e}");
            Outcome::keep_live(Some(
                "Polishing the transcript failed, so the live transcript was kept.",
            ))
        }
    }
}

// ---- the real Whisper engine -------------------------------------------------------------------

/// Whisper sizes in order of preference when several are installed (`base.en` is the default).
pub const MODEL_PREFERENCE: [&str; 3] = [
    "stt-final-whisper-base-en",
    "stt-final-whisper-tiny-en",
    "stt-final-whisper-small-en",
];

struct WhisperFiles {
    encoder: PathBuf,
    decoder: PathBuf,
    tokens: PathBuf,
}

fn find_files(dir: &Path) -> Result<WhisperFiles, String> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else {
                    out.push(p);
                }
            }
        }
    }
    let mut files = Vec::new();
    walk(dir, &mut files);
    let name = |p: &PathBuf| {
        p.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string()
    };
    // prefer int8 (smaller, faster) for both parts
    let pick = |needle: &str| -> Option<PathBuf> {
        let mut m: Vec<&PathBuf> = files
            .iter()
            .filter(|p| {
                let n = name(p);
                n.contains(needle) && n.ends_with(".onnx")
            })
            .collect();
        m.sort_by_key(|p| !name(p).contains(".int8."));
        m.first().map(|p| (*p).clone())
    };
    Ok(WhisperFiles {
        encoder: pick("encoder").ok_or("Whisper model has no encoder file")?,
        decoder: pick("decoder").ok_or("Whisper model has no decoder file")?,
        tokens: files
            .iter()
            .find(|p| name(p).ends_with("tokens.txt"))
            .cloned()
            .ok_or("Whisper model has no tokens file")?,
    })
}

pub struct WhisperEngine {
    recognizer: Arc<OfflineRecognizer>,
}

impl WhisperEngine {
    /// Slow (loads hundreds of MB); call off the UI thread.
    pub fn load(dir: &Path) -> Result<Self, String> {
        let started = Instant::now();
        let f = find_files(dir)?;
        let s = |p: &Path| Some(p.to_string_lossy().into_owned());
        let config = OfflineRecognizerConfig {
            model_config: OfflineModelConfig {
                whisper: OfflineWhisperModelConfig {
                    encoder: s(&f.encoder),
                    decoder: s(&f.decoder),
                    language: Some("en".into()),
                    task: Some("transcribe".into()),
                    tail_paddings: -1,
                    ..Default::default()
                },
                tokens: s(&f.tokens),
                num_threads: 4,
                provider: Some("cpu".into()),
                ..Default::default()
            },
            decoding_method: Some("greedy_search".into()),
            ..Default::default()
        };
        let recognizer = OfflineRecognizer::create(&config)
            .ok_or("the Whisper model could not be loaded (corrupt or incompatible files)")?;
        log::info!(
            "Whisper model loaded in {} ms",
            started.elapsed().as_millis()
        );
        Ok(Self {
            recognizer: Arc::new(recognizer),
        })
    }
}

impl OfflineEngine for WhisperEngine {
    fn transcribe(&self, samples: &[f32]) -> Result<String, String> {
        let stream = self.recognizer.create_stream();
        stream.accept_waveform(SAMPLE_RATE as i32, samples);
        self.recognizer.decode(&stream);
        stream
            .get_result()
            .map(|r| r.text)
            .ok_or_else(|| "Whisper returned no result".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    fn tone(seconds: f32, amp: f32) -> Vec<f32> {
        (0..(seconds * 16_000.0) as usize)
            .map(|i| (i as f32 * 0.3).sin() * amp)
            .collect()
    }
    fn silence(seconds: f32) -> Vec<f32> {
        vec![0.0; (seconds * 16_000.0) as usize]
    }
    fn secs(n: usize) -> f32 {
        n as f32 / 16_000.0
    }

    // ---- chunking ----

    #[test]
    fn a_short_recording_is_one_chunk() {
        let s = tone(10.0, 0.5);
        let ranges = split_at_silence(&s, 25.0);
        assert_eq!(ranges.len(), 1);
        assert_eq!(ranges[0], 0..s.len());
    }

    #[test]
    fn chunks_never_exceed_25_seconds_and_cover_everything_exactly() {
        let mut s = Vec::new();
        for _ in 0..8 {
            s.extend(tone(9.0, 0.5));
            s.extend(silence(0.6));
        }
        let ranges = split_at_silence(&s, 25.0);
        assert!(ranges.len() >= 3);
        let mut next = 0;
        for r in &ranges {
            assert_eq!(r.start, next, "no gap or overlap");
            assert!(secs(r.len()) <= 25.0 + 0.001, "{} s", secs(r.len()));
            next = r.end;
        }
        assert_eq!(next, s.len());
    }

    #[test]
    fn cuts_land_inside_silences_when_there_are_any() {
        let mut s = Vec::new();
        for _ in 0..6 {
            s.extend(tone(11.0, 0.5));
            s.extend(silence(1.0));
        }
        let ranges = split_at_silence(&s, 25.0);
        for r in &ranges[..ranges.len() - 1] {
            let around = &s[r.end.saturating_sub(800)..(r.end + 800).min(s.len())];
            assert!(
                around.iter().all(|v| v.abs() < 1e-6),
                "cut at {} s is not in silence",
                secs(r.end)
            );
        }
    }

    #[test]
    fn continuous_speech_with_no_pauses_is_cut_hard_at_the_limit() {
        let s = tone(60.0, 0.5);
        let ranges = split_at_silence(&s, 25.0);
        assert_eq!(ranges.len(), 3);
        assert_eq!(ranges[0].len(), 25 * 16_000);
        assert_eq!(ranges[2].end, s.len());
    }

    #[test]
    fn a_quiet_microphone_still_gets_silence_cuts() {
        // everything is 100x quieter: the threshold is relative to the loudest frame
        let mut s = Vec::new();
        for _ in 0..6 {
            s.extend(tone(11.0, 0.05));
            s.extend(silence(1.0));
        }
        let ranges = split_at_silence(&s, 25.0);
        let r = &ranges[0];
        let around = &s[r.end - 400..r.end + 400];
        assert!(around.iter().all(|v| v.abs() < 1e-6));
    }

    #[test]
    fn silence_detection() {
        assert!(is_silent(&silence(1.0)));
        assert!(!is_silent(&tone(0.1, 0.01)));
    }

    // ---- run / finalize ----

    struct Fake {
        calls: RefCell<Vec<usize>>,
        reply: Box<dyn Fn(usize) -> Result<String, String>>,
    }
    impl OfflineEngine for Fake {
        fn transcribe(&self, samples: &[f32]) -> Result<String, String> {
            let mut c = self.calls.borrow_mut();
            c.push(samples.len());
            (self.reply)(c.len())
        }
    }
    fn fake(reply: impl Fn(usize) -> Result<String, String> + 'static) -> Fake {
        Fake {
            calls: RefCell::default(),
            reply: Box::new(reply),
        }
    }
    const NO_LIMIT: Duration = Duration::from_secs(3600);

    #[test]
    fn chunk_texts_are_joined_in_order_and_progress_counts_up() {
        let mut s = Vec::new();
        for _ in 0..5 {
            s.extend(tone(9.0, 0.5));
            s.extend(silence(0.6));
        }
        let e = fake(|n| Ok(format!(" part{n} ")));
        let mut prog = Vec::new();
        let text = run(&s, &e, NO_LIMIT, &|| Duration::ZERO, &mut |d, t| {
            prog.push((d, t))
        })
        .unwrap();
        let chunks = e.calls.borrow().len();
        assert!(chunks >= 2);
        let expected: Vec<String> = (1..=chunks).map(|n| format!("part{n}")).collect();
        assert_eq!(text, expected.join(" "));
        assert_eq!(prog.first(), Some(&(0, chunks)));
        assert_eq!(prog.last(), Some(&(chunks, chunks)));
    }

    #[test]
    fn all_silent_chunks_are_skipped_without_calling_the_engine() {
        let e = fake(|_| Ok("hallucinated".into()));
        let text = run(
            &silence(5.0),
            &e,
            NO_LIMIT,
            &|| Duration::ZERO,
            &mut |_, _| {},
        )
        .unwrap();
        assert_eq!(text, "");
        assert!(e.calls.borrow().is_empty());
    }

    #[test]
    fn a_slow_engine_times_out_between_chunks() {
        let mut s = Vec::new();
        for _ in 0..6 {
            s.extend(tone(9.0, 0.5));
            s.extend(silence(0.6));
        }
        let e = fake(|_| Ok("x".into()));
        let now = Cell::new(Duration::ZERO);
        let clock = || {
            // every look at the clock is 8 s later than the last
            now.set(now.get() + Duration::from_secs(8));
            now.get()
        };
        let r = run(&s, &e, Duration::from_secs(20), &clock, &mut |_, _| {});
        assert_eq!(r, Err(FinalPassError::TimedOut));
        assert!(e.calls.borrow().len() < split_at_silence(&s, 25.0).len());
    }

    #[test]
    fn an_engine_error_is_reported() {
        let e = fake(|_| Err("decoder exploded".into()));
        let r = run(
            &tone(2.0, 0.5),
            &e,
            NO_LIMIT,
            &|| Duration::ZERO,
            &mut |_, _| {},
        );
        assert_eq!(r, Err(FinalPassError::Failed("decoder exploded".into())));
    }

    fn loader(e: Fake) -> impl Fn() -> Result<Arc<dyn OfflineEngine + Send + Sync>, String> {
        struct W(Fake);
        // test-only: the fake uses RefCell, but it is only ever used from the calling thread
        unsafe impl Send for W {}
        unsafe impl Sync for W {}
        impl OfflineEngine for W {
            fn transcribe(&self, s: &[f32]) -> Result<String, String> {
                self.0.transcribe(s)
            }
        }
        let shared: Arc<dyn OfflineEngine + Send + Sync> = Arc::new(W(e));
        move || Ok(shared.clone())
    }

    fn buffer_with(seconds: f32) -> RecordingBuffer {
        let b = RecordingBuffer::default();
        b.append(&tone(seconds, 0.5));
        b
    }

    #[test]
    fn success_replaces_the_text_and_empties_the_buffer() {
        let b = buffer_with(3.0);
        let out = finalize(
            &b,
            true,
            NO_LIMIT,
            &loader(fake(|_| Ok("Final text.".into()))),
            &mut |_, _| {},
        );
        assert_eq!(
            out,
            Outcome {
                text: Some("Final text.".into()),
                notice: None
            }
        );
        assert_eq!(b.len(), 0, "the audio buffer is freed after the final pass");
    }

    #[test]
    fn a_missing_model_keeps_the_live_transcript_with_a_notice_and_still_frees_the_buffer() {
        let b = buffer_with(3.0);
        let out = finalize(
            &b,
            true,
            NO_LIMIT,
            &|| Err("model not installed".into()),
            &mut |_, _| {},
        );
        assert_eq!(out.text, None);
        assert!(
            out.notice
                .as_deref()
                .unwrap()
                .contains("live transcript was kept")
        );
        assert_eq!(b.len(), 0);
    }

    #[test]
    fn disabled_skips_the_pass_silently_but_frees_the_buffer() {
        let b = buffer_with(3.0);
        let loads = Cell::new(0);
        let out = finalize(
            &b,
            false,
            NO_LIMIT,
            &|| {
                loads.set(loads.get() + 1);
                Err("must not be called".into())
            },
            &mut |_, _| {},
        );
        assert_eq!(
            out,
            Outcome {
                text: None,
                notice: None
            }
        );
        assert_eq!(loads.get(), 0, "the model is not even loaded");
        assert_eq!(b.len(), 0);
    }

    #[test]
    fn very_short_recordings_are_left_alone() {
        let b = buffer_with(0.1);
        let out = finalize(
            &b,
            true,
            NO_LIMIT,
            &|| Err("must not be called".into()),
            &mut |_, _| {},
        );
        assert_eq!(
            out,
            Outcome {
                text: None,
                notice: None
            }
        );
        assert_eq!(b.len(), 0);
    }

    #[test]
    fn a_failing_engine_keeps_the_live_transcript() {
        let b = buffer_with(3.0);
        let out = finalize(
            &b,
            true,
            NO_LIMIT,
            &loader(fake(|_| Err("boom".into()))),
            &mut |_, _| {},
        );
        assert_eq!(out.text, None);
        assert!(out.notice.is_some());
        assert_eq!(b.len(), 0);
    }

    #[test]
    fn a_timeout_keeps_the_live_transcript_with_a_notice() {
        let b = buffer_with(3.0);
        let out = finalize(
            &b,
            true,
            Duration::ZERO,
            &loader(fake(|_| Ok("late".into()))),
            &mut |_, _| {},
        );
        // the injected real clock has moved a little by the time it is read, so ZERO always trips
        assert_eq!(out.text, None);
        assert!(out.notice.as_deref().unwrap().contains("took too long"));
        assert_eq!(b.len(), 0);
    }

    #[test]
    fn whisper_files_are_found_and_int8_preferred() {
        let dir = std::env::temp_dir().join(format!("yadi-wf-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sub = dir.join("m");
        std::fs::create_dir_all(&sub).unwrap();
        for f in [
            "base.en-encoder.onnx",
            "base.en-encoder.int8.onnx",
            "base.en-decoder.onnx",
            "base.en-decoder.int8.onnx",
            "base.en-tokens.txt",
        ] {
            std::fs::write(sub.join(f), b"x").unwrap();
        }
        let f = find_files(&dir).unwrap();
        assert!(f.encoder.ends_with("base.en-encoder.int8.onnx"));
        assert!(f.decoder.ends_with("base.en-decoder.int8.onnx"));
        assert!(f.tokens.ends_with("base.en-tokens.txt"));
        std::fs::remove_file(sub.join("base.en-tokens.txt")).unwrap();
        assert!(find_files(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Integration tests with the real models and `say` fixtures. They skip with a message when the
/// models or fixtures are missing (see the notes in `stream.rs`).
#[cfg(test)]
mod integration {
    use super::*;
    use crate::audio::file_source::read_wav;
    use crate::audio::fixtures;
    use crate::stt::stream::{
        Options, PREFERRED_MODEL, SherpaDecoder, SttEvent, Transcriber, load_recognizer,
    };
    use crate::stt::wer::wer;

    fn models_root() -> Option<PathBuf> {
        std::env::var_os("YADI_MODELS_DIR")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|h| {
                    PathBuf::from(h)
                        .join("Library/Application Support/com.elarasoftware.yadi/models")
                })
            })
    }

    fn installed(id: &str) -> Option<PathBuf> {
        let dir = models_root()?.join(id);
        if dir.join(".complete").exists() {
            Some(dir)
        } else {
            eprintln!("SKIPPED: model {id} is not installed");
            None
        }
    }

    fn live_text(samples: &[f32]) -> Option<String> {
        let rec = load_recognizer(&installed(PREFERRED_MODEL)?, Options::default()).ok()?;
        let mut t = Transcriber::new(SherpaDecoder::new(rec));
        let mut finals = Vec::new();
        let mut keep = |e: SttEvent| {
            if let SttEvent::Final { text, .. } = e {
                finals.push(text);
            }
        };
        for chunk in samples.chunks(1600) {
            t.push(chunk, &mut keep);
        }
        t.finish(&mut keep);
        Some(finals.join(" "))
    }

    #[test]
    fn final_pass_is_at_least_as_accurate_as_live_on_two_of_three_sentences() {
        let Some(dir) = installed("stt-final-whisper-base-en") else {
            return;
        };
        let engine = WhisperEngine::load(&dir).expect("Whisper loads");
        let mut better_or_equal = 0;
        for name in ["sentence-1", "sentence-2", "sentence-3"] {
            let (Some(path), Some(reference)) = (fixtures::wav(name), fixtures::reference(name))
            else {
                return;
            };
            let samples = read_wav(&path).unwrap();
            let live = live_text(&samples).expect("live transcript");
            let started = Instant::now();
            let fin = run(
                &samples,
                &engine,
                Duration::from_secs(60),
                &|| started.elapsed(),
                &mut |_, _| {},
            )
            .unwrap();
            let (wl, wf) = (wer(&reference, &live), wer(&reference, &fin));
            println!(
                "{name}: live WER {:>3.0}% | final WER {:>3.0}% ({} ms)\n   ref:   {reference}\n   live:  {live}\n   final: {fin}",
                wl * 100.0,
                wf * 100.0,
                started.elapsed().as_millis()
            );
            if wf <= wl {
                better_or_equal += 1;
            }
        }
        assert!(
            better_or_equal >= 2,
            "final pass should be <= live WER on at least 2 of 3 sentences, was {better_or_equal}"
        );
    }

    /// About 20 s of speech: the three fixtures twice, with short pauses between.
    fn twenty_second_clip() -> Option<Vec<f32>> {
        let mut clip = Vec::new();
        for _ in 0..2 {
            for name in ["sentence-1", "sentence-2", "sentence-3"] {
                clip.extend(read_wav(&fixtures::wav(name)?).unwrap());
                clip.extend(std::iter::repeat_n(0.0f32, 8_000)); // 0.5 s pause
            }
        }
        Some(clip)
    }

    #[test]
    fn a_20_second_clip_through_finalize_reports_its_time_and_empties_the_buffer() {
        let Some(dir) = installed("stt-final-whisper-base-en") else {
            return;
        };
        let Some(clip) = twenty_second_clip() else {
            return;
        };
        let engine: Arc<dyn OfflineEngine + Send + Sync> =
            Arc::new(WhisperEngine::load(&dir).unwrap());
        let buffer = RecordingBuffer::default();
        buffer.append(&clip);
        let started = Instant::now();
        let mut progress = Vec::new();
        let out = finalize(
            &buffer,
            true,
            Duration::from_secs(60),
            &|| Ok(engine.clone()),
            &mut |d, t| progress.push((d, t)),
        );
        let took = started.elapsed();
        println!(
            "20 s clip ({:.1} s of audio): final pass took {} ms, {} chunk(s)\n   text: {}",
            clip.len() as f32 / 16_000.0,
            took.as_millis(),
            progress.last().map_or(0, |p| p.1),
            out.text.as_deref().unwrap_or("<none>")
        );
        assert!(
            out.text
                .as_deref()
                .is_some_and(|t| t.split_whitespace().count() >= 30)
        );
        assert_eq!(out.notice, None);
        assert_eq!(buffer.len(), 0, "buffer is empty after completion");
        assert_eq!(progress.last().map(|p| p.0), progress.last().map(|p| p.1));
    }

    #[test]
    fn with_the_whisper_model_missing_finalize_keeps_the_live_transcript() {
        let buffer = RecordingBuffer::default();
        buffer.append(&vec![0.1f32; 32_000]);
        let missing = std::env::temp_dir().join("yadi-no-such-model-dir");
        let out = finalize(
            &buffer,
            true,
            Duration::from_secs(20),
            &|| {
                WhisperEngine::load(&missing)
                    .map(|e| Arc::new(e) as Arc<dyn OfflineEngine + Send + Sync>)
            },
            &mut |_, _| {},
        );
        assert_eq!(out.text, None);
        assert!(out.notice.is_some());
        assert_eq!(buffer.len(), 0);
    }
}
