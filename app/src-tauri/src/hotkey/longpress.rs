//! Long-press detector for the Y key. Pure logic: no OS calls and no clock. Callers pass
//! timestamps (milliseconds) with every event, so tests drive it with a fake clock.
//!
//! Behaviour (PLAN Task 06), for the Y key only:
//! - Y down with Ctrl/Alt/Cmd/Win held        -> `PassThrough`, not tracked.
//! - Y down without modifiers                 -> `Swallow`, start timing; OS auto-repeat downs are swallowed.
//! - Y up before the threshold                -> `ReplayTap` (emit a synthetic Y press + release).
//! - threshold reached while Y is still down  -> `Summon` once, then swallow until Y is released.
//! - another key goes down while Y is pending -> `ReplayThenPass` (fast typing such as "yo").

pub const DEFAULT_THRESHOLD_MS: u32 = 400;
pub const MIN_THRESHOLD_MS: u32 = 250;
pub const MAX_THRESHOLD_MS: u32 = 900;

/// Clamps a configured threshold into the supported 250 to 900 ms range.
pub fn clamp_threshold(ms: u32) -> u32 {
    ms.clamp(MIN_THRESHOLD_MS, MAX_THRESHOLD_MS)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Y,
    Other,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Mods {
    pub ctrl: bool,
    pub alt: bool,
    /// Cmd on macOS, Win on Windows.
    pub meta: bool,
}

impl Mods {
    pub const NONE: Mods = Mods {
        ctrl: false,
        alt: false,
        meta: false,
    };
    pub const CTRL: Mods = Mods {
        ctrl: true,
        alt: false,
        meta: false,
    };

    pub fn any(&self) -> bool {
        self.ctrl || self.alt || self.meta
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    KeyDown { key: Key, mods: Mods, t: u64 },
    KeyUp { key: Key, t: u64 },
    Tick { t: u64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    /// Do not let the OS see this event.
    Swallow,
    /// Let the OS see this event unchanged.
    PassThrough,
    /// Emit a synthetic Y press and release (the real Y was swallowed).
    ReplayTap,
    /// Emit a synthetic Y press and release, then let the current (other) key through.
    ReplayThenPass,
    /// The user long-pressed Y: summon Yadi.
    Summon,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Idle,
    /// Y is down, timing since `since`.
    Pending {
        since: u64,
    },
    /// Summon fired; swallow Y until it is released.
    Summoned,
    /// Y was already replayed as a tap while still physically held; its release is swallowed.
    ReplayedHeld,
}

#[derive(Debug)]
pub struct LongPressDetector {
    threshold_ms: u64,
    state: State,
}

impl Default for LongPressDetector {
    fn default() -> Self {
        Self::new(DEFAULT_THRESHOLD_MS)
    }
}

impl LongPressDetector {
    /// `threshold_ms` is clamped to 250..=900.
    pub fn new(threshold_ms: u32) -> Self {
        Self {
            threshold_ms: u64::from(clamp_threshold(threshold_ms)),
            state: State::Idle,
        }
    }

    pub fn set_threshold(&mut self, threshold_ms: u32) {
        self.threshold_ms = u64::from(clamp_threshold(threshold_ms));
    }

    /// When the hook should deliver a `Tick`, if a Y press is being timed.
    pub fn next_deadline(&self) -> Option<u64> {
        match self.state {
            State::Pending { since } => Some(since + self.threshold_ms),
            _ => None,
        }
    }

    /// Feeds one event. `None` means "nothing to do" (only for a `Tick`).
    pub fn handle(&mut self, event: Event) -> Option<Action> {
        match event {
            Event::Tick { t } => self.on_tick(t),
            Event::KeyDown { key, mods, t } => Some(self.on_down(key, mods, t)),
            Event::KeyUp { key, t } => Some(self.on_up(key, t)),
        }
    }

    fn held_long_enough(&self, since: u64, t: u64) -> bool {
        t.saturating_sub(since) >= self.threshold_ms
    }

    fn on_tick(&mut self, t: u64) -> Option<Action> {
        if let State::Pending { since } = self.state
            && self.held_long_enough(since, t)
        {
            self.state = State::Summoned;
            return Some(Action::Summon);
        }
        None
    }

    fn on_down(&mut self, key: Key, mods: Mods, t: u64) -> Action {
        match (self.state, key) {
            (State::Idle, Key::Y) => {
                if mods.any() {
                    Action::PassThrough
                } else {
                    self.state = State::Pending { since: t };
                    Action::Swallow
                }
            }
            (State::Pending { since }, Key::Y) => {
                // OS auto-repeat. It also tells us time has passed.
                if self.held_long_enough(since, t) {
                    self.state = State::Summoned;
                    Action::Summon
                } else {
                    Action::Swallow
                }
            }
            (State::Pending { .. }, Key::Other) => {
                // Fast typing: the Y was a normal letter after all.
                self.state = State::ReplayedHeld;
                Action::ReplayThenPass
            }
            (State::Summoned, Key::Y) => Action::Swallow,
            // Auto-repeat after a replayed tap: let the OS repeat the letter naturally.
            (State::ReplayedHeld, Key::Y) => Action::PassThrough,
            (State::Idle | State::Summoned | State::ReplayedHeld, Key::Other) => {
                Action::PassThrough
            }
        }
    }

    fn on_up(&mut self, key: Key, t: u64) -> Action {
        match (self.state, key) {
            (State::Pending { since }, Key::Y) => {
                self.state = State::Idle;
                if self.held_long_enough(since, t) {
                    // Threshold passed but no Tick arrived in time.
                    Action::Summon
                } else {
                    Action::ReplayTap
                }
            }
            (State::Summoned | State::ReplayedHeld, Key::Y) => {
                self.state = State::Idle;
                Action::Swallow
            }
            _ => Action::PassThrough,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tiny fake clock: a test sets `now` and builds events from it.
    struct Fake {
        det: LongPressDetector,
        now: u64,
    }

    impl Fake {
        fn new() -> Self {
            Self {
                det: LongPressDetector::default(),
                now: 1_000,
            }
        }
        fn advance(&mut self, ms: u64) -> &mut Self {
            self.now += ms;
            self
        }
        fn down(&mut self, key: Key, mods: Mods) -> Option<Action> {
            self.det.handle(Event::KeyDown {
                key,
                mods,
                t: self.now,
            })
        }
        fn up(&mut self, key: Key) -> Option<Action> {
            self.det.handle(Event::KeyUp { key, t: self.now })
        }
        fn tick(&mut self) -> Option<Action> {
            self.det.handle(Event::Tick { t: self.now })
        }
    }

    use Action::*;

    #[test]
    fn quick_tap_replays_the_tap() {
        let mut f = Fake::new();
        assert_eq!(f.down(Key::Y, Mods::NONE), Some(Swallow));
        f.advance(80);
        assert_eq!(f.up(Key::Y), Some(ReplayTap));
    }

    #[test]
    fn hold_past_threshold_summons_exactly_once() {
        let mut f = Fake::new();
        assert_eq!(f.down(Key::Y, Mods::NONE), Some(Swallow));
        f.advance(399);
        assert_eq!(f.tick(), None);
        f.advance(1); // 400
        assert_eq!(f.tick(), Some(Summon));
        f.advance(100);
        assert_eq!(f.tick(), None);
        assert_eq!(f.up(Key::Y), Some(Swallow));
    }

    #[test]
    fn holding_three_seconds_still_summons_once() {
        let mut f = Fake::new();
        f.down(Key::Y, Mods::NONE);
        let mut summons = 0;
        // 3 s of 30 ms ticks interleaved with OS auto-repeat key-downs
        for i in 0..100 {
            f.advance(30);
            if i % 2 == 0 {
                if f.tick() == Some(Summon) {
                    summons += 1;
                }
            } else if f.down(Key::Y, Mods::NONE) == Some(Summon) {
                summons += 1;
            }
        }
        assert_eq!(summons, 1);
        assert_eq!(f.up(Key::Y), Some(Swallow));
        // and the detector is ready again
        assert_eq!(f.down(Key::Y, Mods::NONE), Some(Swallow));
    }

    #[test]
    fn auto_repeat_before_threshold_is_swallowed() {
        let mut f = Fake::new();
        f.down(Key::Y, Mods::NONE);
        f.advance(100);
        assert_eq!(f.down(Key::Y, Mods::NONE), Some(Swallow));
        f.advance(100);
        assert_eq!(f.down(Key::Y, Mods::NONE), Some(Swallow));
        f.advance(50);
        assert_eq!(f.up(Key::Y), Some(ReplayTap));
    }

    #[test]
    fn ctrl_y_passes_through_untracked() {
        let mut f = Fake::new();
        assert_eq!(f.down(Key::Y, Mods::CTRL), Some(PassThrough));
        f.advance(2_000);
        assert_eq!(f.tick(), None);
        assert_eq!(f.up(Key::Y), Some(PassThrough));
    }

    #[test]
    fn alt_and_meta_y_also_pass_through() {
        for mods in [
            Mods {
                alt: true,
                ..Mods::NONE
            },
            Mods {
                meta: true,
                ..Mods::NONE
            },
        ] {
            let mut f = Fake::new();
            assert_eq!(f.down(Key::Y, mods), Some(PassThrough));
        }
    }

    #[test]
    fn y_then_o_within_100ms_replays_then_passes() {
        let mut f = Fake::new();
        assert_eq!(f.down(Key::Y, Mods::NONE), Some(Swallow));
        f.advance(100);
        assert_eq!(f.down(Key::Other, Mods::NONE), Some(ReplayThenPass));
        // the physical Y release is swallowed: the tap was already replayed
        f.advance(20);
        assert_eq!(f.up(Key::Y), Some(Swallow));
        assert_eq!(f.up(Key::Other), Some(PassThrough));
    }

    #[test]
    fn y_held_while_typing_lets_os_repeat_through_after_replay() {
        let mut f = Fake::new();
        f.down(Key::Y, Mods::NONE);
        f.advance(50);
        assert_eq!(f.down(Key::Other, Mods::NONE), Some(ReplayThenPass));
        f.advance(50);
        assert_eq!(f.down(Key::Y, Mods::NONE), Some(PassThrough));
        assert_eq!(f.up(Key::Y), Some(Swallow));
    }

    #[test]
    fn two_quick_taps_give_two_replay_taps() {
        let mut f = Fake::new();
        assert_eq!(f.down(Key::Y, Mods::NONE), Some(Swallow));
        f.advance(60);
        assert_eq!(f.up(Key::Y), Some(ReplayTap));
        f.advance(90);
        assert_eq!(f.down(Key::Y, Mods::NONE), Some(Swallow));
        f.advance(60);
        assert_eq!(f.up(Key::Y), Some(ReplayTap));
    }

    #[test]
    fn threshold_edge_399_is_a_tap_400_is_a_summon() {
        let mut f = Fake::new();
        f.down(Key::Y, Mods::NONE);
        f.advance(399);
        assert_eq!(f.up(Key::Y), Some(ReplayTap));

        let mut g = Fake::new();
        g.down(Key::Y, Mods::NONE);
        g.advance(400);
        // no Tick was delivered, the release itself must notice the threshold
        assert_eq!(g.up(Key::Y), Some(Summon));
    }

    #[test]
    fn tick_edge_399_does_nothing_400_summons() {
        let mut f = Fake::new();
        f.down(Key::Y, Mods::NONE);
        f.advance(399);
        assert_eq!(f.tick(), None);
        f.advance(1);
        assert_eq!(f.tick(), Some(Summon));
    }

    #[test]
    fn other_keys_pass_through_when_idle() {
        let mut f = Fake::new();
        assert_eq!(f.down(Key::Other, Mods::NONE), Some(PassThrough));
        assert_eq!(f.up(Key::Other), Some(PassThrough));
        assert_eq!(f.tick(), None);
    }

    #[test]
    fn other_keys_pass_through_after_summon() {
        let mut f = Fake::new();
        f.down(Key::Y, Mods::NONE);
        f.advance(400);
        assert_eq!(f.tick(), Some(Summon));
        assert_eq!(f.down(Key::Other, Mods::NONE), Some(PassThrough));
    }

    #[test]
    fn unmatched_y_release_passes_through() {
        let mut f = Fake::new();
        assert_eq!(f.up(Key::Y), Some(PassThrough));
    }

    #[test]
    fn next_deadline_tracks_pending_press() {
        let mut f = Fake::new();
        assert_eq!(f.det.next_deadline(), None);
        f.down(Key::Y, Mods::NONE);
        assert_eq!(f.det.next_deadline(), Some(1_000 + 400));
        f.advance(400);
        f.tick();
        assert_eq!(f.det.next_deadline(), None);
    }

    #[test]
    fn threshold_is_clamped_to_250_900() {
        assert_eq!(clamp_threshold(0), 250);
        assert_eq!(clamp_threshold(249), 250);
        assert_eq!(clamp_threshold(250), 250);
        assert_eq!(clamp_threshold(900), 900);
        assert_eq!(clamp_threshold(5_000), 900);

        let mut f = Fake::new();
        f.det = LongPressDetector::new(10); // clamps to 250
        f.down(Key::Y, Mods::NONE);
        f.advance(249);
        assert_eq!(f.tick(), None);
        f.advance(1);
        assert_eq!(f.tick(), Some(Summon));
    }

    #[test]
    fn set_threshold_applies_to_the_next_press() {
        let mut f = Fake::new();
        f.det.set_threshold(900);
        f.down(Key::Y, Mods::NONE);
        f.advance(899);
        assert_eq!(f.tick(), None);
        f.advance(1);
        assert_eq!(f.tick(), Some(Summon));
    }
}
