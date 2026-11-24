/**
 * Custom vocabulary: words and phrases the user wants Yadi to get right (names, jargon).
 * Stub for Task 12: held in memory only. Task 21 persists it and feeds it to recognition and
 * the prompt pipeline; the API below is what the transcript view already uses.
 */

const words = new Map<string, string>(); // lower-case key -> word as the user typed it

/** Adds a word or phrase. Returns false when it was empty or already known (ignoring case). */
export function addVocabulary(word: string): boolean {
  const trimmed = word.trim();
  if (trimmed === "") return false;
  const key = trimmed.toLowerCase();
  if (words.has(key)) return false;
  words.set(key, trimmed);
  return true;
}

export function getVocabulary(): string[] {
  return [...words.values()];
}

/** Test helper. */
export function clearVocabulary(): void {
  words.clear();
}
