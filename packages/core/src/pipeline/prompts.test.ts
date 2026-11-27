import { describe, expect, it } from "vitest";
import { normalizeMessages } from "./prompts";

describe("normalizeMessages", () => {
  const system = normalizeMessages("text", [])[0]!.content;

  it("keeps only the final version of a self-correction", () => {
    expect(system).toMatch(/keep only the final version and drop the words they took back/);
  });

  it("keeps a real change only when the request is about the change", () => {
    expect(system).toMatch(/keep the old version only if the request is about the change itself/);
    expect(system).toContain('"Remind me to prepare for the review on Friday."');
    expect(system).toContain('"Tell the client the review moved from Thursday to Friday."');
  });

  it("passes the transcript as data in the user message, never in the system prompt", () => {
    const [sys, user] = normalizeMessages("my words here", ["Kotlin"]);
    expect(sys!.content).not.toContain("my words here");
    expect(sys!.content).toContain("Preferred spellings");
    expect(user!.content).toContain("my words here");
  });

  it("never has two blank lines in a row", () => {
    expect(system).not.toMatch(/\n\n\n/);
  });
});
