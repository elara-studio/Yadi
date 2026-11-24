//! Pure sample conversions: channel downmix and regrouping into fixed-size chunks.

/// Averages interleaved frames down to mono. `channels == 0` or a trailing partial frame is ignored.
pub fn downmix_to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    match channels {
        0 => Vec::new(),
        1 => interleaved.to_vec(),
        n => interleaved
            .chunks_exact(n)
            .map(|frame| frame.iter().sum::<f32>() / n as f32)
            .collect(),
    }
}

/// Regroups an arbitrary stream of samples into chunks of exactly `size` samples.
#[derive(Debug)]
pub struct Chunker {
    size: usize,
    buf: Vec<f32>,
}

impl Chunker {
    pub fn new(size: usize) -> Self {
        assert!(size > 0, "chunk size must be positive");
        Self {
            size,
            buf: Vec::with_capacity(size * 2),
        }
    }

    pub fn push(&mut self, samples: &[f32]) -> Vec<Vec<f32>> {
        self.buf.extend_from_slice(samples);
        let mut out = Vec::new();
        while self.buf.len() >= self.size {
            let rest = self.buf.split_off(self.size);
            out.push(std::mem::replace(&mut self.buf, rest));
        }
        out
    }

    /// The final, shorter chunk, if any samples are left.
    pub fn flush(&mut self) -> Option<Vec<f32>> {
        if self.buf.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.buf))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mono_is_unchanged() {
        assert_eq!(downmix_to_mono(&[0.1, 0.2, 0.3], 1), vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn stereo_is_averaged() {
        assert_eq!(
            downmix_to_mono(&[1.0, 0.0, 0.5, 0.5, -1.0, 1.0], 2),
            vec![0.5, 0.5, 0.0]
        );
    }

    #[test]
    fn three_channels_are_averaged() {
        let out = downmix_to_mono(&[0.3, 0.6, 0.9], 3);
        assert_eq!(out.len(), 1);
        assert!((out[0] - 0.6).abs() < 1e-6);
    }

    #[test]
    fn trailing_partial_frame_and_zero_channels_are_ignored() {
        assert_eq!(downmix_to_mono(&[1.0, 1.0, 5.0], 2), vec![1.0]);
        assert!(downmix_to_mono(&[1.0], 0).is_empty());
    }

    #[test]
    fn chunker_emits_exact_sizes_and_keeps_the_remainder() {
        let mut c = Chunker::new(4);
        assert!(c.push(&[1.0, 2.0, 3.0]).is_empty());
        let out = c.push(&[4.0, 5.0, 6.0, 7.0, 8.0, 9.0]);
        assert_eq!(
            out,
            vec![vec![1.0, 2.0, 3.0, 4.0], vec![5.0, 6.0, 7.0, 8.0]]
        );
        assert_eq!(c.flush(), Some(vec![9.0]));
        assert_eq!(c.flush(), None);
    }
}
