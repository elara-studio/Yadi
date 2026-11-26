//! Pure window-placement maths in physical pixels. No Tauri types, so it is unit-testable.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub const fn new(x: i32, y: i32, w: i32, h: i32) -> Self {
        Self { x, y, w, h }
    }

    pub fn right(&self) -> i32 {
        self.x + self.w
    }

    pub fn bottom(&self) -> i32 {
        self.y + self.h
    }

    pub fn center(&self) -> (i32, i32) {
        (self.x + self.w / 2, self.y + self.h / 2)
    }

    pub fn contains(&self, p: (i32, i32)) -> bool {
        p.0 >= self.x && p.0 < self.right() && p.1 >= self.y && p.1 < self.bottom()
    }
}

/// Distance from the screen edge for the default mascot spot.
pub const DEFAULT_MARGIN: i32 = 24;
/// Gap between the mascot and the chat window.
pub const CHAT_GAP: i32 = 8;

fn clamp_axis(value: i32, size: i32, lo: i32, hi: i32) -> i32 {
    // If the window is bigger than the area, pin it to the start.
    let max = (hi - size).max(lo);
    value.clamp(lo, max)
}

/// Keeps a window of `size` fully inside a visible monitor.
/// The monitor holding the window centre wins; if none does (monitor unplugged,
/// window far off-screen) the primary monitor is used.
pub fn clamp_to_monitors(
    pos: (i32, i32),
    size: (i32, i32),
    monitors: &[Rect],
    primary: Rect,
) -> (i32, i32) {
    let rect = Rect::new(pos.0, pos.1, size.0, size.1);
    let target = monitors
        .iter()
        .find(|m| m.contains(rect.center()))
        .copied()
        .unwrap_or(primary);
    (
        clamp_axis(pos.0, size.0, target.x, target.right()),
        clamp_axis(pos.1, size.1, target.y, target.bottom()),
    )
}

/// First-launch position: bottom-right corner of the primary monitor.
pub fn default_mascot_position(primary: Rect, size: (i32, i32)) -> (i32, i32) {
    (
        primary.right() - size.0 - DEFAULT_MARGIN,
        primary.bottom() - size.1 - DEFAULT_MARGIN,
    )
}

/// Chat window position next to the mascot. It opens on the side of the mascot that has
/// more room (so it flips automatically near a screen edge) and is clamped on screen.
pub fn chat_position(mascot: Rect, chat_size: (i32, i32), monitor: Rect, gap: i32) -> (i32, i32) {
    let (cx, cy) = mascot.center();
    let (mon_cx, mon_cy) = monitor.center();

    let x = if cx > mon_cx {
        mascot.x - gap - chat_size.0
    } else {
        mascot.right() + gap
    };

    // Align bottoms when the mascot is in the lower half, tops otherwise.
    let y = if cy > mon_cy {
        mascot.bottom() - chat_size.1
    } else {
        mascot.y
    };

    (
        clamp_axis(x, chat_size.0, monitor.x, monitor.right()),
        clamp_axis(y, chat_size.1, monitor.y, monitor.bottom()),
    )
}

/// Where the chat goes when the mascot is at `mascot` and the chat sits `offset` away from it
/// (the offset the chat had when it was placed or last dragged). Kept on a visible monitor.
pub fn follow_position(
    mascot: (i32, i32),
    offset: (i32, i32),
    chat_size: (i32, i32),
    monitors: &[Rect],
    primary: Rect,
) -> (i32, i32) {
    clamp_to_monitors(
        (mascot.0 + offset.0, mascot.1 + offset.1),
        chat_size,
        monitors,
        primary,
    )
}

/// The offset of the chat from the mascot (what `follow_position` adds back).
pub fn offset_between(chat: (i32, i32), mascot: (i32, i32)) -> (i32, i32) {
    (chat.0 - mascot.0, chat.1 - mascot.1)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRIMARY: Rect = Rect::new(0, 0, 1920, 1080);
    const SECOND: Rect = Rect::new(1920, 0, 1920, 1080);
    const SIZE: (i32, i32) = (128, 140);

    #[test]
    fn inside_screen_is_unchanged() {
        assert_eq!(
            clamp_to_monitors((500, 400), SIZE, &[PRIMARY], PRIMARY),
            (500, 400)
        );
    }

    #[test]
    fn off_screen_right_is_pulled_back() {
        // centre (1936, 470) is outside the only monitor -> primary clamp
        assert_eq!(
            clamp_to_monitors((1872, 400), SIZE, &[PRIMARY], PRIMARY),
            (1792, 400)
        );
    }

    #[test]
    fn partly_off_right_edge_is_pulled_back() {
        // centre (1900, 470) is still on screen, but the right edge sticks out
        assert_eq!(
            clamp_to_monitors((1836, 400), SIZE, &[PRIMARY], PRIMARY),
            (1792, 400)
        );
    }

    #[test]
    fn off_screen_bottom_is_pulled_up() {
        assert_eq!(
            clamp_to_monitors((500, 1040), SIZE, &[PRIMARY], PRIMARY),
            (500, 940)
        );
    }

    #[test]
    fn off_screen_left_and_top_are_pulled_in() {
        assert_eq!(
            clamp_to_monitors((-40, -20), SIZE, &[PRIMARY], PRIMARY),
            (0, 0)
        );
    }

    #[test]
    fn monitor_removed_falls_back_to_primary() {
        // Window was saved on a second monitor that is no longer attached.
        assert_eq!(
            clamp_to_monitors((2500, 300), SIZE, &[PRIMARY], PRIMARY),
            (1792, 300)
        );
    }

    #[test]
    fn stays_on_second_monitor_when_present() {
        assert_eq!(
            clamp_to_monitors((2500, 300), SIZE, &[PRIMARY, SECOND], PRIMARY),
            (2500, 300)
        );
    }

    #[test]
    fn no_monitors_listed_uses_primary() {
        assert_eq!(
            clamp_to_monitors((5000, 5000), SIZE, &[], PRIMARY),
            (1792, 940)
        );
    }

    #[test]
    fn window_larger_than_monitor_pins_to_origin() {
        let tiny = Rect::new(0, 0, 100, 100);
        assert_eq!(clamp_to_monitors((50, 50), SIZE, &[tiny], tiny), (0, 0));
    }

    #[test]
    fn default_position_is_bottom_right() {
        assert_eq!(default_mascot_position(PRIMARY, SIZE), (1768, 916));
    }

    #[test]
    fn chat_opens_left_when_mascot_is_on_the_right() {
        let mascot = Rect::new(1768, 916, 128, 140);
        let (x, y) = chat_position(mascot, (420, 560), PRIMARY, CHAT_GAP);
        assert_eq!(x, 1768 - 8 - 420);
        assert_eq!(y, 916 + 140 - 560); // bottoms aligned
    }

    #[test]
    fn chat_opens_right_when_mascot_is_on_the_left() {
        let mascot = Rect::new(20, 20, 128, 140);
        let (x, y) = chat_position(mascot, (420, 560), PRIMARY, CHAT_GAP);
        assert_eq!(x, 20 + 128 + 8);
        assert_eq!(y, 20); // tops aligned
    }

    #[test]
    fn chat_never_leaves_the_monitor_horizontally() {
        let monitor = Rect::new(0, 0, 600, 800);
        for x in [0, 100, 300, 472] {
            let mascot = Rect::new(x, 20, 128, 140);
            let (cx, _) = chat_position(mascot, (420, 560), monitor, CHAT_GAP);
            assert!(cx >= 0 && cx + 420 <= 600, "mascot x={x} gave chat x={cx}");
        }
    }

    #[test]
    fn chat_works_on_a_second_monitor() {
        let mascot = Rect::new(2000, 20, 128, 140);
        let (x, _) = chat_position(mascot, (420, 560), SECOND, CHAT_GAP);
        assert_eq!(x, 2000 + 128 + 8);
    }

    #[test]
    fn chat_stays_on_screen_vertically() {
        let mascot = Rect::new(20, 1000, 128, 140);
        let (_, y) = chat_position(mascot, (420, 560), PRIMARY, CHAT_GAP);
        assert!(y >= 0 && y + 560 <= 1080);
    }

    #[test]
    fn chat_keeps_its_distance_from_the_mascot_while_it_moves() {
        let offset = offset_between((1340, 496), (1768, 916));
        assert_eq!(offset, (-428, -420));
        // The mascot is dragged to the middle of the screen: the chat comes along.
        assert_eq!(
            follow_position((900, 500), offset, (420, 560), &[PRIMARY], PRIMARY),
            (472, 80)
        );
    }

    #[test]
    fn a_chat_dragged_to_the_other_side_stays_there_when_the_mascot_moves() {
        // The user pulled the chat to the right of the mascot.
        let offset = offset_between((900, 300), (700, 400));
        assert_eq!(offset, (200, -100));
        assert_eq!(
            follow_position((100, 400), offset, (420, 560), &[PRIMARY], PRIMARY),
            (300, 300)
        );
    }

    #[test]
    fn a_following_chat_is_pulled_back_when_the_mascot_nears_an_edge() {
        let offset = (-428, -420);
        // Mascot at the very left edge: the chat would be off screen, so it is held on screen.
        let (x, y) = follow_position((0, 600), offset, (420, 560), &[PRIMARY], PRIMARY);
        assert_eq!((x, y), (0, 180));
    }

    #[test]
    fn a_following_chat_can_cross_to_the_second_monitor() {
        let offset = (128 + 8, 0);
        let (x, _) = follow_position((2000, 20), offset, (420, 560), &[PRIMARY, SECOND], PRIMARY);
        assert_eq!(x, 2136);
    }
}
