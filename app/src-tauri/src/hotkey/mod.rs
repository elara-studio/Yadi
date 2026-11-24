//! Global summon shortcuts: the pure long-press detector and the chord fallback.

pub mod chord;
// Not called until the global keyboard hook is built (Task 07); fully unit-tested meanwhile.
#[allow(dead_code)]
pub mod longpress;
