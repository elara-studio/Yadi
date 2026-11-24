//! Ollama manager: detect it, install it (with consent), start it bound to localhost, and pull
//! models with progress. Yadi talks to Ollama only over `127.0.0.1:11434`.
//!
//! Safety (PLAN Task 14): nothing here installs Ollama or pulls a model unless the caller says so
//! (`consent == true` for installs). Tests use a mock HTTP server and injected steps; the real
//! install path is only exercised with `YADI_ALLOW_REAL_INSTALL=1`.

pub mod client;
pub mod commands;
pub mod install;
#[cfg(test)]
mod mock;
pub mod ndjson;
pub mod process;
