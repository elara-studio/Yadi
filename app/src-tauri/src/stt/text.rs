//! Light clean-up of recogniser output (PLAN Task 10): capitalise the first letter and finish a
//! segment with a full stop. Real clean-up happens later in the prompt pipeline.
//!
//! The English zipformer models emit UPPERCASE words, so all-caps text is lower-cased first.
//! Text that already has lower-case letters keeps its casing.

fn has_lowercase(s: &str) -> bool {
    s.chars().any(|c| c.is_lowercase())
}

/// Lower-cases all-caps text, fixes the pronoun "I", and capitalises the first letter.
pub fn polish_partial(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let base = if has_lowercase(trimmed) {
        trimmed.to_string()
    } else {
        trimmed.to_lowercase()
    };
    let words: Vec<String> = base.split_whitespace().map(fix_pronoun_i).collect();
    capitalise_first(&words.join(" "))
}

/// Like `polish_partial`, plus a final full stop when the segment does not already end in
/// sentence punctuation.
pub fn polish_final(raw: &str) -> String {
    let mut s = polish_partial(raw);
    if !s.is_empty() && !s.ends_with(['.', '?', '!']) {
        s.push('.');
    }
    s
}

/// `i` -> `I`, `i'm` -> `I'm`, `i'll` -> `I'll` ...
fn fix_pronoun_i(word: &str) -> String {
    if word == "i" {
        return "I".to_string();
    }
    if let Some(rest) = word.strip_prefix("i'")
        && !rest.is_empty()
    {
        return format!("I'{rest}");
    }
    word.to_string()
}

fn capitalise_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_caps_model_output_becomes_a_sentence() {
        assert_eq!(
            polish_final("WRITE A SHORT EMAIL TO MY MANAGER"),
            "Write a short email to my manager."
        );
    }

    #[test]
    fn partials_get_a_capital_but_no_full_stop() {
        assert_eq!(polish_partial("WRITE A SHORT"), "Write a short");
    }

    #[test]
    fn existing_punctuation_is_not_doubled() {
        assert_eq!(polish_final("Is this working?"), "Is this working?");
        assert_eq!(polish_final("Done."), "Done.");
        assert_eq!(polish_final("Wow!"), "Wow!");
    }

    #[test]
    fn mixed_case_text_keeps_its_casing() {
        assert_eq!(
            polish_final("use the Kotlin Hilt module"),
            "Use the Kotlin Hilt module."
        );
    }

    #[test]
    fn the_pronoun_i_is_capitalised() {
        assert_eq!(
            polish_final("I THINK I'M DONE AND I'LL GO"),
            "I think I'm done and I'll go."
        );
        assert_eq!(polish_partial("MY IPHONE"), "My iphone");
    }

    #[test]
    fn empty_and_whitespace_stay_empty() {
        assert_eq!(polish_final(""), "");
        assert_eq!(polish_final("   "), "");
        assert_eq!(polish_partial("  \n"), "");
    }

    #[test]
    fn extra_whitespace_is_collapsed() {
        assert_eq!(polish_final("  HELLO    WORLD "), "Hello world.");
    }
}
