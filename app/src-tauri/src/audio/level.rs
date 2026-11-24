//! Level meter (RMS, ~15 updates per second) and the "probably no microphone permission"
//! silence watchdog. Both are pure and take sample counts, not clocks.

use super::SAMPLE_RATE;

/// Level updates per second sent to the UI.
pub const LEVEL_RATE_HZ: u32 = 15;

/// Emits one RMS value for every ~1/15 s of audio it is fed.
#[derive(Debug)]
pub struct LevelMeter {
    window: usize,
    sum_sq: f64,
    count: usize,
}

impl Default for LevelMeter {
    fn default() -> Self {
        Self {
            window: (SAMPLE_RATE / LEVEL_RATE_HZ) as usize,
            sum_sq: 0.0,
            count: 0,
        }
    }
}

impl LevelMeter {
    pub fn push(&mut self, samples: &[f32]) -> Vec<f32> {
        let mut out = Vec::new();
        for &s in samples {
            self.sum_sq += f64::from(s) * f64::from(s);
            self.count += 1;
            if self.count == self.window {
                out.push((self.sum_sq / self.count as f64).sqrt() as f32);
                self.sum_sq = 0.0;
                self.count = 0;
            }
        }
        out
    }
}

/// Peak amplitude at or below this counts as digital silence. A denied microphone delivers
/// exact zeros; even a quiet real microphone has noise far above this.
pub const SILENCE_PEAK: f32 = 1e-6;
/// How long digital silence must last before it is reported as a probable permission problem.
pub const SILENCE_SECONDS: u32 = 3;

/// Reports once if the first `SILENCE_SECONDS` of audio contained nothing but digital silence.
/// Only used where the OS gives no reliable permission answer (see `permission.rs`).
#[derive(Debug, Default)]
pub struct SilenceWatchdog {
    seen: usize,
    done: bool,
}

impl SilenceWatchdog {
    /// Returns true exactly once: when 3 s of audio have passed and all of it was silent.
    pub fn push(&mut self, samples: &[f32]) -> bool {
        if self.done {
            return false;
        }
        if samples.iter().any(|s| s.abs() > SILENCE_PEAK) {
            self.done = true; // real signal: the microphone works
            return false;
        }
        self.seen += samples.len();
        if self.seen >= (SAMPLE_RATE * SILENCE_SECONDS) as usize {
            self.done = true;
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rms_of_a_constant_signal() {
        let mut m = LevelMeter::default();
        let out = m.push(&vec![0.5; 1_066]);
        assert_eq!(out.len(), 1);
        assert!((out[0] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn rms_of_a_full_scale_sine_is_about_0_707() {
        let mut m = LevelMeter::default();
        let sine: Vec<f32> = (0..16_000)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 16_000.0).sin())
            .collect();
        let out = m.push(&sine);
        assert!(
            out.iter()
                .all(|v| (v - std::f32::consts::FRAC_1_SQRT_2).abs() < 0.02),
            "{out:?}"
        );
    }

    #[test]
    fn about_fifteen_updates_per_second() {
        let mut m = LevelMeter::default();
        let mut n = 0;
        for _ in 0..10 {
            n += m.push(&vec![0.1; 1_600]).len(); // ten 100 ms chunks = 1 s
        }
        assert!((14..=15).contains(&n), "got {n}");
    }

    #[test]
    fn partial_windows_carry_over_between_pushes() {
        let mut m = LevelMeter::default();
        assert!(m.push(&vec![0.2; 500]).is_empty());
        assert_eq!(m.push(&vec![0.2; 600]).len(), 1);
    }

    #[test]
    fn watchdog_fires_once_after_three_seconds_of_exact_silence() {
        let mut w = SilenceWatchdog::default();
        let mut fired = 0;
        for _ in 0..40 {
            if w.push(&vec![0.0; 1_600]) {
                fired += 1;
            }
        }
        assert_eq!(fired, 1);
    }

    #[test]
    fn watchdog_stays_quiet_when_there_is_any_signal() {
        let mut w = SilenceWatchdog::default();
        assert!(!w.push(&vec![0.0; 1_600]));
        let mut quiet_noise = vec![0.0; 1_600];
        quiet_noise[10] = 0.0005;
        assert!(!w.push(&quiet_noise));
        for _ in 0..60 {
            assert!(!w.push(&vec![0.0; 1_600]));
        }
    }

    #[test]
    fn watchdog_does_not_fire_before_three_seconds() {
        let mut w = SilenceWatchdog::default();
        for _ in 0..29 {
            assert!(!w.push(&vec![0.0; 1_600]));
        }
    }
}
