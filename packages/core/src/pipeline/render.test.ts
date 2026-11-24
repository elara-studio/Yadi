import { describe, expect, it } from "vitest";
import { CLARIFY_LINE, renderMinimal, renderPrompt } from "./render";
import type { ValidAnalysis } from "./types";

const full: ValidAnalysis = {
  task_type: "coding",
  task: "Speed up the filtered list.",
  role: "React developer",
  context: ["The list has 5000 items", "Uses TypeScript"],
  constraints: ["A short answer"],
  output_format: "Short answer",
  missing_info: ["Which React version?", "Is the list virtualised?"],
};

describe("renderPrompt (golden outputs)", () => {
  it("renders every section in the fixed order", () => {
    expect(renderPrompt(full, [{ name: "profile.json", type: "json" }])).toBe(
      [
        "Role: React developer",
        "Task: Speed up the filtered list.",
        "Context:",
        "- The list has 5000 items",
        "- Uses TypeScript",
        "Constraints:",
        "- A short answer",
        "Output: Short answer",
        "Attachments:",
        "- [Attached: profile.json (json)]",
        "If anything is missing or ambiguous, ask me concise clarifying questions before answering.",
        "Likely missing: Which React version?; Is the list virtualised?",
      ].join("\n"),
    );
  });

  it("omits empty sections and the role line when there is no role", () => {
    const text = renderPrompt({
      ...full,
      role: null,
      context: [],
      constraints: [],
      output_format: null,
      missing_info: [],
    });
    expect(text).toBe(["Task: Speed up the filtered list.", CLARIFY_LINE].join("\n"));
  });

  it("empty missing_info omits the 'Likely missing' line", () => {
    expect(renderPrompt({ ...full, missing_info: [] })).not.toContain("Likely missing");
    expect(renderPrompt(full)).toContain("Likely missing: ");
  });

  it("always ends with the clarify line when nothing is missing", () => {
    const lines = renderPrompt({ ...full, missing_info: [] }).split("\n");
    expect(lines[lines.length - 1]).toBe(CLARIFY_LINE);
  });

  it("is deterministic", () => {
    expect(renderPrompt(full)).toBe(renderPrompt(structuredClone(full)));
  });

  it("flattens line breaks inside items", () => {
    const text = renderPrompt({ ...full, task: "Do\nthis\n\nnow", context: ["a\nb"] });
    expect(text).toContain("Task: Do this now");
    expect(text).toContain("- a b");
  });

  it("lists several attachments in the [Attached: name (type)] form", () => {
    const text = renderPrompt(full, [
      { name: "a.pdf", type: "pdf" },
      { name: "Pasted text", type: "text" },
    ]);
    expect(text).toContain(
      "Attachments:\n- [Attached: a.pdf (pdf)]\n- [Attached: Pasted text (text)]",
    );
  });

  it("never invents sections", () => {
    const text = renderPrompt(full);
    for (const heading of text.split("\n").filter((l) => /^[A-Z][a-z ]+:/.test(l))) {
      expect(heading).toMatch(
        /^(Role|Task|Context|Constraints|Output|Attachments|Likely missing|If anything)/,
      );
    }
  });
});

describe("renderMinimal", () => {
  it("is just the task and the clarify line", () => {
    expect(renderMinimal("Fix my login screen")).toBe(
      ["Task: Fix my login screen", CLARIFY_LINE].join("\n"),
    );
  });
  it("still lists attachments", () => {
    expect(renderMinimal("Summarise", [{ name: "n.txt", type: "txt" }])).toContain(
      "- [Attached: n.txt (txt)]",
    );
  });
});
