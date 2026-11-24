import { beforeEach, describe, expect, it } from "vitest";
import { addVocabulary, clearVocabulary, getVocabulary } from "./store";

describe("vocabulary stub", () => {
  beforeEach(clearVocabulary);

  it("adds words and returns them", () => {
    expect(addVocabulary("Kotlin")).toBe(true);
    expect(addVocabulary("  Hilt  ")).toBe(true);
    expect(getVocabulary()).toEqual(["Kotlin", "Hilt"]);
  });

  it("ignores empty text and duplicates regardless of case", () => {
    addVocabulary("Kotlin");
    expect(addVocabulary("kotlin")).toBe(false);
    expect(addVocabulary("   ")).toBe(false);
    expect(getVocabulary()).toEqual(["Kotlin"]);
  });
});
