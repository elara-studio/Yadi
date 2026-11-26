//! Glue between raw OS key events and the long-press detector. Pure (no OS calls, no clock),
//! so the platform hooks stay thin and this logic is unit-tested with fake timestamps.
//!
//! The platform layer decides `is_y` (the key that produces the letter Y in the current
//! layout), fills in modifiers, drops its own synthetic events before they get here, and
//! executes the returned `Output`s.

use super::longpress::{Action, Event, Key, LongPressDetector, Mods};

/// One real key press or release as seen by the hook.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RawKey {
    pub down: bool,
    /// The key produces the letter Y (layout-aware, decided by the platform layer).
    pub is_y: bool,
    /// Platform key code, used to replay the key exactly.
    pub code: u32,
    pub mods: Mods,
    pub t: u64,
}

/// Something the platform layer must do besides swallowing or passing the current event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Output {
    /// Emit a synthetic press + release of the key with this code (the Y that was swallowed).
    ReplayTap { code: u32 },
    /// Emit a synthetic press of this key (the key that interrupted a pending Y; the original
    /// event is swallowed so the order Y, then this key is deterministic).
    ReplayDown { code: u32, mods: Mods },
    /// The user long-pressed Y.
    Summon,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Decision {
    /// Hide the current event from the rest of the system.
    pub swallow: bool,
    pub outputs: Vec<Output>,
}

impl Decision {
    fn pass() -> Self {
        Self::default()
    }
}

#[derive(Debug, Default)]
pub struct Engine {
    detector: LongPressDetector,
    /// Code of the physical key that produced the Y being tracked.
    y_code: u32,
}

impl Engine {
    pub fn new(threshold_ms: u32) -> Self {
        Self {
            detector: LongPressDetector::new(threshold_ms),
            y_code: 0,
        }
    }

    pub fn set_threshold(&mut self, threshold_ms: u32) {
        self.detector.set_threshold(threshold_ms);
    }

    /// Forgets any press in progress (used when interception is switched off).
    pub fn reset(&mut self, threshold_ms: u32) {
        self.detector = LongPressDetector::new(threshold_ms);
    }

    /// True while a Y press is being held and watched.
    pub fn is_tracking(&self) -> bool {
        self.detector.is_tracking()
    }

    /// Own-window rule: while the Yadi chat window is focused, a fresh Y is never intercepted
    /// (in-app Y must have no delay). A press already being tracked is finished normally so
    /// the long press that opened the chat does not leak its key-up.
    pub fn on_key(&mut self, key: RawKey, chat_focused: bool) -> Decision {
        if chat_focused && !self.detector.is_tracking() {
            return Decision::pass();
        }
        if key.is_y && key.down && !self.detector.is_tracking() {
            self.y_code = key.code;
        }
        let event = if key.down {
            Event::KeyDown {
                key: if key.is_y { Key::Y } else { Key::Other },
                mods: key.mods,
                t: key.t,
            }
        } else {
            Event::KeyUp {
                key: if key.is_y { Key::Y } else { Key::Other },
                t: key.t,
            }
        };
        match self.detector.handle(event) {
            None | Some(Action::PassThrough) => Decision::pass(),
            Some(Action::Swallow) => Decision {
                swallow: true,
                outputs: vec![],
            },
            Some(Action::ReplayTap) => Decision {
                swallow: true,
                outputs: vec![Output::ReplayTap { code: self.y_code }],
            },
            Some(Action::ReplayThenPass) => Decision {
                swallow: true,
                outputs: vec![
                    Output::ReplayTap { code: self.y_code },
                    Output::ReplayDown {
                        code: key.code,
                        mods: key.mods,
                    },
                ],
            },
            Some(Action::Summon) => Decision {
                swallow: true,
                outputs: vec![Output::Summon],
            },
        }
    }

    /// Timer tick. Returns `Summon` when the threshold was just reached.
    pub fn on_tick(&mut self, t: u64) -> Option<Output> {
        match self.detector.handle(Event::Tick { t }) {
            Some(Action::Summon) => Some(Output::Summon),
            _ => None,
        }
    }

    /// When `on_tick` is due (tests only; see `LongPressDetector::next_deadline`).
    #[cfg(test)]
    pub fn next_deadline(&self) -> Option<u64> {
        self.detector.next_deadline()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const Y: u32 = 16;
    const O: u32 = 31;

    fn key(down: bool, is_y: bool, code: u32, t: u64) -> RawKey {
        RawKey {
            down,
            is_y,
            code,
            mods: Mods::NONE,
            t,
        }
    }

    #[test]
    fn quick_tap_swallows_both_halves_and_replays_once() {
        let mut e = Engine::new(400);
        let down = e.on_key(key(true, true, Y, 0), false);
        assert!(down.swallow && down.outputs.is_empty());
        let up = e.on_key(key(false, true, Y, 80), false);
        assert!(up.swallow);
        assert_eq!(up.outputs, vec![Output::ReplayTap { code: Y }]);
    }

    #[test]
    fn replay_uses_the_physical_key_that_made_the_y() {
        // e.g. QWERTZ, where the Y letter is on another physical key
        let mut e = Engine::new(400);
        e.on_key(key(true, true, 6, 0), false);
        let up = e.on_key(key(false, true, 6, 50), false);
        assert_eq!(up.outputs, vec![Output::ReplayTap { code: 6 }]);
    }

    #[test]
    fn long_press_summons_via_tick_and_swallows_the_release() {
        let mut e = Engine::new(400);
        e.on_key(key(true, true, Y, 0), false);
        assert_eq!(e.next_deadline(), Some(400));
        assert_eq!(e.on_tick(399), None);
        assert_eq!(e.on_tick(400), Some(Output::Summon));
        assert_eq!(e.on_tick(450), None); // only once
        let up = e.on_key(key(false, true, Y, 900), false);
        assert!(up.swallow && up.outputs.is_empty());
        assert!(!e.is_tracking());
    }

    #[test]
    fn auto_repeat_downs_after_the_summon_are_swallowed() {
        let mut e = Engine::new(400);
        e.on_key(key(true, true, Y, 0), false);
        e.on_tick(400);
        let rep = e.on_key(key(true, true, Y, 430), false);
        assert!(rep.swallow && rep.outputs.is_empty());
    }

    #[test]
    fn release_after_threshold_without_a_tick_still_summons() {
        let mut e = Engine::new(400);
        e.on_key(key(true, true, Y, 0), false);
        let up = e.on_key(key(false, true, Y, 450), false);
        assert!(up.swallow);
        assert_eq!(up.outputs, vec![Output::Summon]);
    }

    #[test]
    fn typing_yo_replays_y_then_o_in_order_and_swallows_the_real_events() {
        let mut e = Engine::new(400);
        e.on_key(key(true, true, Y, 0), false);
        let o_down = e.on_key(key(true, false, O, 60), false);
        assert!(o_down.swallow);
        assert_eq!(
            o_down.outputs,
            vec![
                Output::ReplayTap { code: Y },
                Output::ReplayDown {
                    code: O,
                    mods: Mods::NONE
                }
            ]
        );
        // the physical Y release is swallowed (its tap was already replayed) ...
        let y_up = e.on_key(key(false, true, Y, 90), false);
        assert!(y_up.swallow && y_up.outputs.is_empty());
        // ... and the release of O passes through untouched
        let o_up = e.on_key(key(false, false, O, 120), false);
        assert!(!o_up.swallow && o_up.outputs.is_empty());
    }

    #[test]
    fn ctrl_y_passes_through() {
        let mut e = Engine::new(400);
        let mut k = key(true, true, Y, 0);
        k.mods = Mods::CTRL;
        assert_eq!(e.on_key(k, false), Decision::pass());
        assert!(!e.is_tracking());
        assert_eq!(e.next_deadline(), None);
    }

    #[test]
    fn own_window_rule_passes_y_through_while_chat_is_focused() {
        let mut e = Engine::new(400);
        let down = e.on_key(key(true, true, Y, 0), true);
        assert_eq!(down, Decision::pass());
        assert!(!e.is_tracking(), "no timing while the chat has focus");
        assert_eq!(e.on_key(key(false, true, Y, 50), true), Decision::pass());
    }

    #[test]
    fn a_press_already_tracked_is_finished_even_if_the_chat_gains_focus() {
        let mut e = Engine::new(400);
        e.on_key(key(true, true, Y, 0), false);
        assert_eq!(e.on_tick(400), Some(Output::Summon)); // chat opens and takes focus here
        let up = e.on_key(key(false, true, Y, 600), true);
        assert!(
            up.swallow,
            "the long press's release must not leak into the chat"
        );
        assert!(!e.is_tracking());
    }

    #[test]
    fn other_keys_pass_through_when_idle() {
        let mut e = Engine::new(400);
        assert_eq!(e.on_key(key(true, false, O, 0), false), Decision::pass());
        assert_eq!(e.on_key(key(false, false, O, 10), false), Decision::pass());
    }

    #[test]
    fn two_quick_taps_replay_twice() {
        let mut e = Engine::new(400);
        for base in [0u64, 200] {
            e.on_key(key(true, true, Y, base), false);
            let up = e.on_key(key(false, true, Y, base + 60), false);
            assert_eq!(up.outputs, vec![Output::ReplayTap { code: Y }]);
        }
    }

    #[test]
    fn threshold_can_change_between_presses() {
        let mut e = Engine::new(400);
        e.set_threshold(900);
        e.on_key(key(true, true, Y, 0), false);
        assert_eq!(e.on_tick(899), None);
        assert_eq!(e.on_tick(900), Some(Output::Summon));
    }
}
