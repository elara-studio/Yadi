import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const { addVocabulary, clearVocabulary, getVocabulary, loadVocabulary } = await import("./store");

beforeEach(() => {
  clearVocabulary();
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("vocabulary store", () => {
  it("adds trimmed words, once, ignoring case", () => {
    expect(addVocabulary("  Kubernetes ")).toBe(true);
    expect(addVocabulary("kubernetes")).toBe(false);
    expect(addVocabulary("   ")).toBe(false);
    expect(getVocabulary()).toEqual(["Kubernetes"]);
  });

  it("saves a new word through to Rust, and nothing for a repeat", () => {
    addVocabulary("Yadi");
    addVocabulary("yadi");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("add_vocabulary", { word: "Yadi" });
  });

  it("a failing save never breaks typing", () => {
    invoke.mockRejectedValue(new Error("disk full"));
    expect(addVocabulary("Yadi")).toBe(true);
    invoke.mockImplementation(() => {
      throw new Error("not in tauri");
    });
    expect(addVocabulary("Elara")).toBe(true);
    expect(getVocabulary()).toEqual(["Yadi", "Elara"]);
  });

  it("loads the saved list from Rust", async () => {
    invoke.mockResolvedValue(["Yadi", "Ollama"]);
    expect(await loadVocabulary()).toEqual(["Yadi", "Ollama"]);
    expect(addVocabulary("ollama")).toBe(false);
  });
});
