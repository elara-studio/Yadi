//! Live speech recognition (sherpa-onnx streaming recogniser). See `stream.rs`.
//!
//! Privacy (D12): transcripts are never logged or written to disk; logs carry counts and timings only.

pub mod commands;
pub mod final_pass;
pub mod stream;
pub mod text;
#[cfg(test)]
pub mod wer;
