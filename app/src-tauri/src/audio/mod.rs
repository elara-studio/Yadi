//! Microphone capture as 16 kHz mono f32, behind a testable source abstraction.
//!
//! Privacy (decision D12): audio lives in memory only. Nothing here writes audio to disk and
//! nothing logs samples.

pub mod commands;
pub mod convert;
pub mod file_source;
#[cfg(test)]
pub mod fixtures;
pub mod level;
pub mod mic;
pub mod permission;
pub mod queue;
pub mod resample;
pub mod session;

use std::sync::Arc;

use serde::Serialize;

/// All audio inside Yadi is 16 kHz mono f32 (what the speech models expect).
pub const SAMPLE_RATE: u32 = 16_000;
/// About 100 ms of audio per chunk.
pub const CHUNK_SAMPLES: usize = 1_600;

pub type Chunk = Vec<f32>;

/// What a source puts on its queue.
#[derive(Clone, Debug, PartialEq)]
pub enum Msg {
    Chunk(Chunk),
    /// The source failed (device unplugged, permission, ...). Always delivered.
    Error(AudioError),
    /// A finite source (file) reached its end. Always delivered.
    End,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AudioErrorKind {
    NoDevice,
    PermissionDenied,
    /// Heuristic: the stream delivered only digital silence for 3 s.
    ProbablePermissionDenied,
    DeviceLost,
    UnsupportedFormat,
    Other,
}

/// A typed error the UI can show. Serialised as `{kind, message}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AudioError {
    pub kind: AudioErrorKind,
    pub message: String,
}

impl AudioError {
    pub fn new(kind: AudioErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for AudioError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// Something that produces audio chunks: the microphone, or a WAV file in tests.
pub trait AudioSource: Send {
    /// Starts producing; chunks and errors are pushed onto `out`.
    fn start(&mut self, out: Arc<queue::ChunkQueue>) -> Result<(), AudioError>;
    /// Stops producing. Safe to call more than once.
    fn stop(&mut self);
}
