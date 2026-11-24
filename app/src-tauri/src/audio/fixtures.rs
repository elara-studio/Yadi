//! Test helpers for the speech fixtures made by `scripts/gen-fixtures.sh` (macOS `say`).
//! Tests that need them skip with a clear message when they are absent.

use std::path::PathBuf;

/// Path of `scripts/fixtures/<name>.wav`, or `None` (after printing why) if it does not exist.
pub fn wav(name: &str) -> Option<PathBuf> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/fixtures")
        .join(format!("{name}.wav"));
    if path.exists() {
        Some(path)
    } else {
        eprintln!(
            "SKIPPED: fixture {name}.wav not found. Run scripts/gen-fixtures.sh (macOS) to create it."
        );
        None
    }
}

/// The reference sentence for a fixture (`<name>.txt`).
pub fn reference(name: &str) -> Option<String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/fixtures")
        .join(format!("{name}.txt"));
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::file_source::{FileSource, Pace, read_wav};
    use crate::audio::session::{AudioEvents, RecordingBuffer, Session};
    use crate::audio::{AudioError, Msg, SAMPLE_RATE};
    use std::sync::Arc;
    use std::time::Duration;

    struct Quiet;
    impl AudioEvents for Quiet {
        fn level(&self, _: f32) {}
        fn error(&self, _: &AudioError) {}
    }

    #[test]
    fn say_fixtures_are_16khz_mono_speech_of_plausible_length() {
        for name in ["sentence-1", "sentence-2", "sentence-3"] {
            let Some(path) = wav(name) else { return };
            let samples = read_wav(&path).expect("fixture should be 16 kHz mono");
            let seconds = samples.len() as f32 / SAMPLE_RATE as f32;
            assert!((1.5..=15.0).contains(&seconds), "{name}: {seconds:.1} s");
            let peak = samples.iter().fold(0.0f32, |m, v| m.max(v.abs()));
            assert!(peak > 0.05, "{name} looks silent (peak {peak})");
            assert!(reference(name).is_some_and(|r| r.split_whitespace().count() >= 5));
        }
    }

    #[test]
    fn a_fixture_streams_through_a_session_completely() {
        let Some(path) = wav("sentence-1") else {
            return;
        };
        let expected = read_wav(&path).unwrap().len();
        let buffer = RecordingBuffer::default();
        let mut session = Session::start(
            Box::new(FileSource::new(&path, Pace::Fast)),
            Arc::new(Quiet),
            buffer.clone(),
            false,
        )
        .unwrap();
        let sub = session.subscribe();
        let mut chunks = 0;
        while let Some(m) = sub.pop_timeout(Duration::from_secs(3)) {
            match m {
                Msg::Chunk(c) => {
                    chunks += 1;
                    assert!(c.len() <= 1_600);
                }
                Msg::End => break,
                Msg::Error(e) => panic!("unexpected error: {e}"),
            }
        }
        session.stop();
        assert!(chunks > 10);
        assert_eq!(
            buffer.len(),
            expected,
            "the in-memory recording holds every sample"
        );
    }
}
