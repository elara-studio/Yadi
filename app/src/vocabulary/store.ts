import { invoke } from "@tauri-apps/api/core";

/**
 * Custom vocabulary: words and phrases the user wants Yadi to spell correctly (names, jargon).
 * The saved list lives in Rust (`vocabulary.json`, tauri-plugin-store) and is the single source
 * of truth; this module keeps a copy for synchronous reads and writes changes through.
 */

const words = new Map<string, string>(); // lower-case key -> word as the user typed it

function save(command: string, args: Record<string, unknown>): void {
  try {
    invoke(command, args).catch(() => {}); // a failed save must never break typing
  } catch {
    // not running inside Tauri
  }
}

/** Adds a word or phrase. Returns false when it was empty or already known (ignoring case). */
export function addVocabulary(word: string): boolean {
  const trimmed = word.trim();
  if (trimmed === "") return false;
  const key = trimmed.toLowerCase();
  if (words.has(key)) return false;
  words.set(key, trimmed);
  save("add_vocabulary", { word: trimmed });
  return true;
}

export function getVocabulary(): string[] {
  return [...words.values()];
}

/** Reads the saved list from Rust into this copy. */
export async function loadVocabulary(): Promise<string[]> {
  const saved = await invoke<string[]>("get_vocabulary");
  words.clear();
  for (const w of saved) words.set(w.toLowerCase(), w);
  return getVocabulary();
}

/** Test helper. */
export function clearVocabulary(): void {
  words.clear();
}
