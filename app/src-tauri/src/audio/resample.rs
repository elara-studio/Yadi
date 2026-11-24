//! Streaming sample-rate conversion to 16 kHz using rubato's FFT resampler.

use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Indexing, Resampler};

use super::{AudioError, AudioErrorKind, SAMPLE_RATE};

pub struct StreamResampler {
    /// `None` when the input already is 16 kHz.
    inner: Option<Fft<f32>>,
    pending: Vec<f32>,
    /// Output samples still to be discarded (the resampler's initial delay).
    skip: usize,
}

fn err(e: impl std::fmt::Display) -> AudioError {
    AudioError::new(AudioErrorKind::UnsupportedFormat, format!("resampler: {e}"))
}

impl StreamResampler {
    pub fn new(input_rate: u32) -> Result<Self, AudioError> {
        if input_rate == SAMPLE_RATE {
            return Ok(Self {
                inner: None,
                pending: Vec::new(),
                skip: 0,
            });
        }
        // About 20 ms of input per processing block keeps latency low.
        let chunk = (input_rate as usize / 50).max(64);
        let fft = Fft::<f32>::new(
            input_rate as usize,
            SAMPLE_RATE as usize,
            chunk,
            1,
            FixedSync::Input,
        )
        .map_err(err)?;
        let skip = fft.output_delay();
        Ok(Self {
            inner: Some(fft),
            pending: Vec::new(),
            skip,
        })
    }

    /// Feeds mono samples at the input rate; returns whatever 16 kHz samples are ready.
    pub fn push(&mut self, mono: &[f32]) -> Result<Vec<f32>, AudioError> {
        let Some(fft) = self.inner.as_mut() else {
            return Ok(mono.to_vec());
        };
        self.pending.extend_from_slice(mono);
        let mut out = Vec::new();
        loop {
            let need = fft.input_frames_next();
            if self.pending.len() < need {
                break;
            }
            let block: Vec<f32> = self.pending.drain(..need).collect();
            let input = InterleavedSlice::new(&block, 1, need).map_err(err)?;
            let produced = fft.process(&input, None).map_err(err)?.take_data();
            Self::append(&mut out, produced, &mut self.skip);
        }
        Ok(out)
    }

    /// Processes the final partial block so the last words are not lost.
    pub fn finish(&mut self) -> Result<Vec<f32>, AudioError> {
        let Some(fft) = self.inner.as_mut() else {
            return Ok(Vec::new());
        };
        let mut out = Vec::new();
        if self.pending.is_empty() {
            return Ok(out);
        }
        let need = fft.input_frames_next();
        let valid = self.pending.len();
        let mut block = std::mem::take(&mut self.pending);
        block.resize(need, 0.0);
        let input = InterleavedSlice::new(&block, 1, need).map_err(err)?;
        let indexing = Indexing {
            input_offset: 0,
            output_offset: 0,
            partial_len: Some(valid),
            active_channels_mask: None,
        };
        let produced = fft
            .process(&input, Some(&indexing))
            .map_err(err)?
            .take_data();
        Self::append(&mut out, produced, &mut self.skip);
        Ok(out)
    }

    fn append(out: &mut Vec<f32>, produced: Vec<f32>, skip: &mut usize) {
        let drop = (*skip).min(produced.len());
        *skip -= drop;
        out.extend_from_slice(&produced[drop..]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, rate: u32, seconds: f32) -> Vec<f32> {
        (0..(rate as f32 * seconds) as usize)
            .map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / rate as f32).sin() * 0.8)
            .collect()
    }

    /// Frequency estimate from rising zero crossings.
    fn frequency(samples: &[f32], rate: u32) -> f32 {
        let crossings = samples
            .windows(2)
            .filter(|w| w[0] <= 0.0 && w[1] > 0.0)
            .count();
        crossings as f32 * rate as f32 / samples.len() as f32
    }

    fn run(rate: u32, feed: usize) -> Vec<f32> {
        let mut r = StreamResampler::new(rate).unwrap();
        let input = sine(440.0, rate, 1.0);
        let mut out = Vec::new();
        for piece in input.chunks(feed) {
            out.extend(r.push(piece).unwrap());
        }
        out.extend(r.finish().unwrap());
        out
    }

    #[test]
    fn forty_eight_khz_sine_becomes_16khz_with_the_same_pitch() {
        let out = run(48_000, 480);
        // about one second of audio comes out (initial delay trimmed, tail flushed)
        assert!((15_800..=16_200).contains(&out.len()), "len {}", out.len());
        let f = frequency(&out, 16_000);
        assert!((f - 440.0).abs() < 8.0, "pitch {f} Hz");
        let peak = out.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!((0.7..=0.9).contains(&peak), "peak {peak}");
    }

    #[test]
    fn forty_four_one_khz_sine_becomes_16khz_with_the_same_pitch() {
        let out = run(44_100, 1_000);
        assert!((15_700..=16_300).contains(&out.len()), "len {}", out.len());
        let f = frequency(&out, 16_000);
        assert!((f - 440.0).abs() < 8.0, "pitch {f} Hz");
    }

    #[test]
    fn sixteen_khz_input_passes_through_unchanged() {
        let mut r = StreamResampler::new(16_000).unwrap();
        let input = sine(300.0, 16_000, 0.1);
        assert_eq!(r.push(&input).unwrap(), input);
        assert!(r.finish().unwrap().is_empty());
    }

    #[test]
    fn output_length_does_not_depend_on_how_the_input_is_split() {
        let a = run(48_000, 100).len() as i64;
        let b = run(48_000, 4_800).len() as i64;
        assert!((a - b).abs() <= 2, "{a} vs {b}");
    }
}
