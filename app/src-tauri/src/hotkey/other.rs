//! Placeholder for systems without a keyboard hook (Yadi targets macOS and Windows only).

use std::sync::Arc;

use super::hook::{HookError, Shared, SummonFn};

pub fn start(_shared: Arc<Shared>, _on_summon: SummonFn) -> Result<(), HookError> {
    Err(HookError::Failed(
        "the global keyboard hook is only available on macOS and Windows".into(),
    ))
}
