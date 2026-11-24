/**
 * Stage 0 (deterministic): remove only obvious spoken fillers and tidy whitespace.
 * No language model is involved, so this can never add or change meaning.
 *
 * Fillers: um, uh, uhm, er, erm, hmm (with stretched spellings like "ummm" or "hmmmm").
 * Words that merely contain them ("umbrella", "after", "perm") are left alone.
 */
// Not part of a longer word: no letter, digit, apostrophe or hyphen-joined word on either side.
const FILLER =
  /(?<![\p{L}\p{N}'-])(?:um+|uh+|uhm+|erm+|er|hm+)(?![\p{L}\p{N}'])(?!-[\p{L}\p{N}])[,;.…]*/giu;

export function stripFillers(text: string): string {
  return text
    .replace(FILLER, " ")
    .replace(/\s+([,;.!?])/g, "$1") // "wait , no" -> "wait, no" after a filler was removed
    .replace(/^[,;.\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}
