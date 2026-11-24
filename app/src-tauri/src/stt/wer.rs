//! Word error rate, used by the speech integration tests.
//!
//! WER = (substitutions + deletions + insertions) / number of reference words, from the
//! word-level Levenshtein distance. Both texts are normalised first: lower-cased, every
//! character that is not a letter, digit or apostrophe becomes a space, then split on
//! whitespace. An empty reference gives 0.0 for an empty hypothesis and 1.0 otherwise.

pub fn normalise(text: &str) -> Vec<String> {
    text.to_lowercase()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '\'' {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .map(str::to_string)
        .collect()
}

pub fn wer(reference: &str, hypothesis: &str) -> f32 {
    let r = normalise(reference);
    let h = normalise(hypothesis);
    if r.is_empty() {
        return if h.is_empty() { 0.0 } else { 1.0 };
    }
    // classic dynamic programme over words
    let mut prev: Vec<usize> = (0..=h.len()).collect();
    for (i, rw) in r.iter().enumerate() {
        let mut cur = vec![i + 1];
        for (j, hw) in h.iter().enumerate() {
            let cost = usize::from(rw != hw);
            cur.push((prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1));
        }
        prev = cur;
    }
    prev[h.len()] as f32 / r.len() as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_text_is_zero() {
        assert_eq!(wer("the cat sat", "The cat, sat."), 0.0);
    }

    #[test]
    fn one_substitution_in_four_words() {
        assert!((wer("the cat sat down", "the cat sit down") - 0.25).abs() < 1e-6);
    }

    #[test]
    fn deletions_and_insertions_count() {
        assert!((wer("a b c d", "a c d") - 0.25).abs() < 1e-6); // one deletion
        assert!((wer("a b", "a x b") - 0.5).abs() < 1e-6); // one insertion
    }

    #[test]
    fn can_exceed_one_and_handles_empty() {
        assert!(wer("a", "x y z") > 1.0);
        assert_eq!(wer("a b", ""), 1.0);
        assert_eq!(wer("", ""), 0.0);
        assert_eq!(wer("", "x"), 1.0);
    }

    #[test]
    fn apostrophes_are_kept_punctuation_is_not() {
        assert_eq!(normalise("I'm here, OK?"), vec!["i'm", "here", "ok"]);
    }
}
