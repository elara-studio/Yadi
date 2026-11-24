//! Streaming transcription. `Transcriber` turns decoder output into `stt:partial` /
//! `stt:final` events and is written against the small `Decoder` trait, so its logic is
//! unit-tested with a fake decoder. `SherpaDecoder` is the real sherpa-onnx implementation.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use sherpa_onnx::{
    OnlineModelConfig, OnlineRecognizer, OnlineRecognizerConfig, OnlineStream,
    OnlineTransducerModelConfig,
};

use super::text::{polish_final, polish_partial};

pub const SAMPLE_RATE: i32 = 16_000;

/// The default live-recognition model. Chosen by measurement (see docs/stt-notes.md): the smaller
/// 20M model drops the first words of an utterance and could not reach the 30% WER target.
pub const PREFERRED_MODEL: &str = "stt-stream-zipformer-en-2023-06-26";
/// Fallback for machines with little memory.
pub const SMALL_MODEL: &str = "stt-stream-zipformer-en-20m";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SttEvent {
    /// The current, unfinished segment (replaces the previous partial).
    Partial(String),
    /// A finished segment.
    Final { id: u64, text: String },
}

/// What the transcriber needs from a streaming recogniser.
pub trait Decoder {
    fn accept(&mut self, samples: &[f32]);
    /// Decodes everything that is ready.
    fn decode(&mut self);
    /// The raw (unpolished) hypothesis for the current segment.
    fn text(&mut self) -> String;
    fn is_endpoint(&mut self) -> bool;
    /// Starts a new segment.
    fn reset(&mut self);
    /// No more audio will arrive: flush the tail.
    fn input_finished(&mut self);
}

pub struct Transcriber<D: Decoder> {
    decoder: D,
    last_partial: String,
    next_id: u64,
}

impl<D: Decoder> Transcriber<D> {
    pub fn new(decoder: D) -> Self {
        Self {
            decoder,
            last_partial: String::new(),
            next_id: 0,
        }
    }

    /// Feeds one chunk of 16 kHz mono audio. Emits a partial when the hypothesis changed and a
    /// final when the recogniser detects an endpoint.
    pub fn push(&mut self, samples: &[f32], emit: &mut dyn FnMut(SttEvent)) {
        self.decoder.accept(samples);
        self.decoder.decode();
        let raw = self.decoder.text();
        if self.decoder.is_endpoint() {
            self.finish_segment(&raw, emit);
            self.decoder.reset();
            return;
        }
        let partial = polish_partial(&raw);
        if !partial.is_empty() && partial != self.last_partial {
            self.last_partial.clone_from(&partial);
            emit(SttEvent::Partial(partial));
        }
    }

    /// End of recording: flushes the decoder so the last words are not lost.
    pub fn finish(&mut self, emit: &mut dyn FnMut(SttEvent)) {
        self.decoder.input_finished();
        self.decoder.decode();
        let raw = self.decoder.text();
        self.finish_segment(&raw, emit);
        self.decoder.reset();
    }

    fn finish_segment(&mut self, raw: &str, emit: &mut dyn FnMut(SttEvent)) {
        let text = polish_final(raw);
        self.last_partial.clear();
        if !text.is_empty() {
            let id = self.next_id;
            self.next_id += 1;
            emit(SttEvent::Final { id, text });
        }
    }
}

// ---- the real recogniser -------------------------------------------------------------------

/// Paths of the files inside an extracted sherpa-onnx streaming transducer model.
#[derive(Debug, PartialEq, Eq)]
pub struct ModelFiles {
    pub encoder: PathBuf,
    pub decoder: PathBuf,
    pub joiner: PathBuf,
    pub tokens: PathBuf,
}

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

/// Recogniser settings that trade speed for accuracy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Options {
    /// Use the int8-quantised encoder and joiner (smaller and faster, slightly less accurate).
    pub int8: bool,
    /// `modified_beam_search` instead of `greedy_search` (more accurate, slower).
    pub beam_search: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            int8: true,
            beam_search: false,
        }
    }
}

impl ModelFiles {
    /// Finds the model files under `dir`. With `int8` it prefers the int8 encoder and joiner
    /// (with the full-precision decoder, the combination sherpa-onnx recommends), otherwise the
    /// full-precision files; falls back to whatever exists.
    pub fn find(dir: &Path, int8: bool) -> Result<Self, String> {
        let mut files = Vec::new();
        walk(dir, &mut files);
        let name = |p: &PathBuf| {
            p.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string()
        };
        let pick = |prefix: &str, prefer_int8: bool| -> Option<PathBuf> {
            let mut matches: Vec<&PathBuf> = files
                .iter()
                .filter(|p| {
                    let n = name(p);
                    n.starts_with(prefix) && n.ends_with(".onnx")
                })
                .collect();
            matches.sort_by_key(|p| name(p).contains(".int8.") != prefer_int8);
            matches.first().map(|p| (*p).clone())
        };
        let encoder = pick("encoder", int8).ok_or("model has no encoder .onnx file")?;
        let decoder = pick("decoder", false).ok_or("model has no decoder .onnx file")?;
        let joiner = pick("joiner", int8).ok_or("model has no joiner .onnx file")?;
        let tokens = files
            .iter()
            .find(|p| name(p) == "tokens.txt")
            .cloned()
            .ok_or("model has no tokens.txt")?;
        Ok(Self {
            encoder,
            decoder,
            joiner,
            tokens,
        })
    }
}

fn s(p: &Path) -> Option<String> {
    Some(p.to_string_lossy().into_owned())
}

/// Loads the streaming recogniser. Slow (hundreds of ms), so call it off the UI thread.
pub fn load_recognizer(dir: &Path, options: Options) -> Result<Arc<OnlineRecognizer>, String> {
    let started = Instant::now();
    let files = ModelFiles::find(dir, options.int8)?;
    let config = OnlineRecognizerConfig {
        model_config: OnlineModelConfig {
            transducer: OnlineTransducerModelConfig {
                encoder: s(&files.encoder),
                decoder: s(&files.decoder),
                joiner: s(&files.joiner),
            },
            tokens: s(&files.tokens),
            num_threads: 2,
            provider: Some("cpu".into()),
            ..Default::default()
        },
        decoding_method: Some(
            if options.beam_search {
                "modified_beam_search"
            } else {
                "greedy_search"
            }
            .into(),
        ),
        max_active_paths: 4,
        enable_endpoint: true,
        // sherpa-onnx's documented defaults: 2.4 s of silence before any speech, 1.2 s of
        // silence after speech ends a segment, 20 s caps an utterance.
        rule1_min_trailing_silence: 2.4,
        rule2_min_trailing_silence: 1.2,
        rule3_min_utterance_length: 20.0,
        ..Default::default()
    };
    let recognizer = OnlineRecognizer::create(&config)
        .ok_or("the speech model could not be loaded (corrupt or incompatible files)")?;
    log::info!(
        "speech model loaded in {} ms",
        started.elapsed().as_millis()
    );
    Ok(Arc::new(recognizer))
}

pub struct SherpaDecoder {
    recognizer: Arc<OnlineRecognizer>,
    stream: OnlineStream,
}

impl SherpaDecoder {
    pub fn new(recognizer: Arc<OnlineRecognizer>) -> Self {
        let stream = recognizer.create_stream();
        Self { recognizer, stream }
    }
}

impl Decoder for SherpaDecoder {
    fn accept(&mut self, samples: &[f32]) {
        self.stream.accept_waveform(SAMPLE_RATE, samples);
    }
    fn decode(&mut self) {
        while self.recognizer.is_ready(&self.stream) {
            self.recognizer.decode(&self.stream);
        }
    }
    fn text(&mut self) -> String {
        self.recognizer
            .get_result(&self.stream)
            .map(|r| r.text)
            .unwrap_or_default()
    }
    fn is_endpoint(&mut self) -> bool {
        self.recognizer.is_endpoint(&self.stream)
    }
    fn reset(&mut self) {
        self.recognizer.reset(&self.stream);
    }
    fn input_finished(&mut self) {
        // Streaming transducers need trailing silence to emit the final words. sherpa-onnx's examples
        // append 0.3 s; with the 2023-06-26 model fewer than ~1 s of total tail clipped the last words
        // ("rotate the" instead of "rotate the phone"), so a full second is used.
        let padding = vec![0.0f32; (SAMPLE_RATE as f32 * TAIL_PADDING_SECONDS) as usize];
        self.stream.accept_waveform(SAMPLE_RATE, &padding);
        self.stream.input_finished();
    }
}

/// Silence appended when a recording ends, so the last words are decoded.
pub const TAIL_PADDING_SECONDS: f32 = 1.0;

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    /// A scripted decoder: each `decode()` call advances to the next scripted state.
    struct Fake {
        script: VecDeque<(&'static str, bool)>, // (raw text, endpoint?)
        current: (&'static str, bool),
        tail: &'static str,
        finished: bool,
        resets: usize,
        accepted: usize,
    }
    impl Fake {
        fn new(script: &[(&'static str, bool)], tail: &'static str) -> Self {
            Self {
                script: script.iter().copied().collect(),
                current: ("", false),
                tail,
                finished: false,
                resets: 0,
                accepted: 0,
            }
        }
    }
    impl Decoder for Fake {
        fn accept(&mut self, samples: &[f32]) {
            self.accepted += samples.len();
        }
        fn decode(&mut self) {
            if self.finished {
                self.current = (self.tail, false);
            } else if let Some(next) = self.script.pop_front() {
                self.current = next;
            }
        }
        fn text(&mut self) -> String {
            self.current.0.to_string()
        }
        fn is_endpoint(&mut self) -> bool {
            self.current.1
        }
        fn reset(&mut self) {
            self.resets += 1;
            self.current = ("", false);
        }
        fn input_finished(&mut self) {
            self.finished = true;
        }
    }

    fn run(
        script: &[(&'static str, bool)],
        tail: &'static str,
        chunks: usize,
        finish: bool,
    ) -> (Vec<SttEvent>, Transcriber<Fake>) {
        let mut t = Transcriber::new(Fake::new(script, tail));
        let mut events = Vec::new();
        for _ in 0..chunks {
            t.push(&[0.0; 1600], &mut |e| events.push(e));
        }
        if finish {
            t.finish(&mut |e| events.push(e));
        }
        (events, t)
    }

    #[test]
    fn partials_revise_then_an_endpoint_finalises_the_segment() {
        let (events, t) = run(
            &[
                ("WRITE", false),
                ("WRITE A SHORT", false),
                ("WRITE A SHORT EMAIL", true),
            ],
            "",
            3,
            false,
        );
        assert_eq!(
            events,
            vec![
                SttEvent::Partial("Write".into()),
                SttEvent::Partial("Write a short".into()),
                SttEvent::Final {
                    id: 0,
                    text: "Write a short email.".into()
                },
            ]
        );
        assert_eq!(
            t.decoder.resets, 1,
            "a new segment starts after an endpoint"
        );
    }

    #[test]
    fn an_unchanged_hypothesis_emits_no_duplicate_partial() {
        let (events, _) = run(
            &[("HELLO", false), ("HELLO", false), ("HELLO", false)],
            "",
            3,
            false,
        );
        assert_eq!(events, vec![SttEvent::Partial("Hello".into())]);
    }

    #[test]
    fn silence_produces_no_events_and_a_blank_endpoint_makes_no_final() {
        let (events, t) = run(&[("", false), ("", true)], "", 2, false);
        assert!(events.is_empty());
        assert_eq!(t.decoder.resets, 1, "the decoder is still reset");
    }

    #[test]
    fn segment_ids_increase() {
        let (events, _) = run(&[("ONE", true), ("TWO", true)], "", 2, false);
        assert_eq!(
            events,
            vec![
                SttEvent::Final {
                    id: 0,
                    text: "One.".into()
                },
                SttEvent::Final {
                    id: 1,
                    text: "Two.".into()
                },
            ]
        );
    }

    #[test]
    fn finish_flushes_the_words_still_in_the_decoder() {
        let (events, _) = run(&[("HELLO THERE", false)], "HELLO THERE FRIEND", 1, true);
        assert_eq!(
            events,
            vec![
                SttEvent::Partial("Hello there".into()),
                SttEvent::Final {
                    id: 0,
                    text: "Hello there friend.".into()
                },
            ]
        );
    }

    #[test]
    fn finish_with_nothing_pending_emits_nothing() {
        let (events, _) = run(&[], "", 0, true);
        assert!(events.is_empty());
    }

    #[test]
    fn a_partial_after_a_final_is_emitted_again_even_if_it_matches_the_old_one() {
        let (events, _) = run(
            &[("YES", false), ("YES", true), ("YES", false)],
            "",
            3,
            false,
        );
        assert_eq!(
            events,
            vec![
                SttEvent::Partial("Yes".into()),
                SttEvent::Final {
                    id: 0,
                    text: "Yes.".into()
                },
                SttEvent::Partial("Yes".into()),
            ]
        );
    }

    #[test]
    fn model_files_prefer_int8_encoder_and_joiner_with_a_full_precision_decoder() {
        let dir = std::env::temp_dir().join(format!("yadi-mf-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sub = dir.join("model");
        std::fs::create_dir_all(&sub).unwrap();
        for f in [
            "encoder-a.onnx",
            "encoder-a.int8.onnx",
            "decoder-a.onnx",
            "decoder-a.int8.onnx",
            "joiner-a.onnx",
            "joiner-a.int8.onnx",
            "tokens.txt",
            "README.md",
        ] {
            std::fs::write(sub.join(f), b"x").unwrap();
        }
        let m = ModelFiles::find(&dir, true).unwrap();
        assert!(m.encoder.ends_with("encoder-a.int8.onnx"));
        assert!(m.joiner.ends_with("joiner-a.int8.onnx"));
        assert!(m.decoder.ends_with("decoder-a.onnx"));
        assert!(m.tokens.ends_with("tokens.txt"));
        std::fs::remove_file(sub.join("encoder-a.int8.onnx")).unwrap();
        assert!(
            ModelFiles::find(&dir, true)
                .unwrap()
                .encoder
                .ends_with("encoder-a.onnx"),
            "falls back to full precision"
        );
        std::fs::remove_file(sub.join("tokens.txt")).unwrap();
        assert!(ModelFiles::find(&dir, true).unwrap_err().contains("tokens"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Integration tests with the real model and the `say` fixtures. They skip (with a message)
/// when either is missing: install the model with
/// `YADI_MODELS_DIR=<dir> YADI_REAL_MODEL=stt-stream-zipformer-en-20m cargo test real_download -- --ignored`
/// and create fixtures with `scripts/gen-fixtures.sh`.
#[cfg(test)]
mod integration {
    use super::*;
    use crate::audio::file_source::{read_wav, split_chunks};
    use crate::audio::fixtures;
    use crate::stt::wer::wer;
    use std::sync::OnceLock;

    const MODEL_ID: &str = PREFERRED_MODEL;

    fn model_dir() -> Option<PathBuf> {
        let root = std::env::var_os("YADI_MODELS_DIR")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|h| {
                    PathBuf::from(h)
                        .join("Library/Application Support/com.elarasoftware.yadi/models")
                })
            })?;
        let dir = root.join(MODEL_ID);
        if dir.join(".complete").exists() {
            Some(dir)
        } else {
            eprintln!(
                "SKIPPED: model {MODEL_ID} is not installed under {}",
                root.display()
            );
            None
        }
    }

    fn recognizer() -> Option<Arc<OnlineRecognizer>> {
        static CACHE: OnceLock<Option<Arc<OnlineRecognizer>>> = OnceLock::new();
        CACHE
            .get_or_init(|| {
                model_dir().map(|d| load_recognizer(&d, Options::default()).expect("model loads"))
            })
            .clone()
    }

    struct Run {
        events: Vec<SttEvent>,
        /// Index into `events` at which `finish` was called.
        finish_at: usize,
        latencies_ms: Vec<f64>,
    }

    fn transcribe(rec: &Arc<OnlineRecognizer>, samples: &[f32]) -> Run {
        let mut t = Transcriber::new(SherpaDecoder::new(rec.clone()));
        let mut events = Vec::new();
        let mut latencies_ms = Vec::new();
        for chunk in split_chunks(samples) {
            let started = Instant::now();
            let before = events.len();
            t.push(&chunk, &mut |e| events.push(e));
            if events[before..]
                .iter()
                .any(|e| matches!(e, SttEvent::Partial(_)))
            {
                latencies_ms.push(started.elapsed().as_secs_f64() * 1000.0);
            }
        }
        let finish_at = events.len();
        t.finish(&mut |e| events.push(e));
        Run {
            events,
            finish_at,
            latencies_ms,
        }
    }

    fn finals(run: &Run) -> String {
        run.events
            .iter()
            .filter_map(|e| {
                if let SttEvent::Final { text, .. } = e {
                    Some(text.as_str())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    #[test]
    fn three_sentences_have_a_word_error_rate_of_at_most_30_percent() {
        let Some(rec) = recognizer() else { return };
        let mut all_latencies = Vec::new();
        for name in ["sentence-1", "sentence-2", "sentence-3"] {
            let (Some(path), Some(reference)) = (fixtures::wav(name), fixtures::reference(name))
            else {
                return;
            };
            let run = transcribe(&rec, &read_wav(&path).unwrap());
            let hyp = finals(&run);
            let w = wer(&reference, &hyp);
            let first_partial = run
                .events
                .iter()
                .position(|e| matches!(e, SttEvent::Partial(_)));
            let first_final = run
                .events
                .iter()
                .position(|e| matches!(e, SttEvent::Final { .. }));
            println!(
                "{name}: WER {:.0}% | ref: {reference} | hyp: {hyp}",
                w * 100.0
            );
            assert!(w <= 0.30, "{name}: WER {w:.2} > 0.30 (hyp: {hyp})");
            assert!(
                first_partial.is_some(),
                "{name}: expected at least one partial"
            );
            assert!(
                first_partial < first_final,
                "{name}: a partial must arrive before the final"
            );
            all_latencies.extend(run.latencies_ms);
        }
        all_latencies.sort_by(f64::total_cmp);
        let median = all_latencies[all_latencies.len() / 2];
        println!(
            "median chunk-to-partial processing time: {median:.1} ms over {} partial updates",
            all_latencies.len()
        );
    }

    #[test]
    fn stop_flushes_the_last_words() {
        let Some(rec) = recognizer() else { return };
        let (Some(path), Some(reference)) = (
            fixtures::wav("sentence-1"),
            fixtures::reference("sentence-1"),
        ) else {
            return;
        };
        let run = transcribe(&rec, &read_wav(&path).unwrap());
        let finals_before_stop = run.events[..run.finish_at]
            .iter()
            .filter(|e| matches!(e, SttEvent::Final { .. }))
            .count();
        let hyp = finals(&run);
        let last_word = reference.split_whitespace().last().unwrap();
        println!("finals before stop: {finals_before_stop}; after flush: {hyp}");
        assert!(
            hyp.to_lowercase().contains(last_word),
            "the final words '{last_word}' must survive the flush: {hyp}"
        );
        assert!(
            matches!(run.events.last(), Some(SttEvent::Final { .. })),
            "flush ends with a final segment"
        );
    }

    #[test]
    fn trailing_silence_ends_the_segment_without_waiting_for_stop() {
        let Some(rec) = recognizer() else { return };
        let Some(path) = fixtures::wav("sentence-2") else {
            return;
        };
        let mut samples = read_wav(&path).unwrap();
        samples.extend(std::iter::repeat_n(0.0f32, 16_000 * 3)); // 3 s of silence
        let run = transcribe(&rec, &samples);
        let endpoint_finals = run.events[..run.finish_at]
            .iter()
            .filter(|e| matches!(e, SttEvent::Final { .. }))
            .count();
        assert!(
            endpoint_finals >= 1,
            "the recogniser's endpoint detection should finalise the segment"
        );
    }

    /// Reports (does not assert) how the model copes with technical words.
    #[test]
    fn report_technical_words() {
        let Some(rec) = recognizer() else { return };
        let (Some(path), Some(reference)) = (
            fixtures::wav("sentence-4"),
            fixtures::reference("sentence-4"),
        ) else {
            return;
        };
        let run = transcribe(&rec, &read_wav(&path).unwrap());
        let hyp = finals(&run);
        println!(
            "TECH WORDS | ref: {reference} | hyp: {hyp} | WER {:.0}%",
            wer(&reference, &hyp) * 100.0
        );
    }
}
