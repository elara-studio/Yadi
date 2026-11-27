import { describe, expect, it } from "vitest";
import { CLARIFY_LINE, renderMinimal, renderPrompt, withoutRepeats } from "./render";
import type { ValidAnalysis } from "./types";

const full: ValidAnalysis = {
  task_type: "coding",
  task: "Speed up the filtered list.",
  role: "React developer",
  context: ["The list has 5000 items", "Uses TypeScript"],
  constraints: ["A short answer"],
  output_format: "A numbered list",
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
        "Output: A numbered list",
        "Attachments:",
        "- [Attached: profile.json (json)]",
        "If anything is missing or unclear, ask me before answering.",
        "Likely missing: Which React version?; Is the list virtualised?",
      ].join("\n"),
    );
  });

  it("omits empty sections and the role line when there is no role", () => {
    const text = renderPrompt({ ...full, role: null, output_format: null, missing_info: [] });
    expect(text).not.toContain("Role:");
    expect(text).not.toContain("Output:");
    expect(text.startsWith("Task: Speed up the filtered list.\nContext:")).toBe(true);
  });

  it("writes a request that is only a task as a plain sentence", () => {
    const text = renderPrompt({
      ...full,
      role: null,
      context: [],
      constraints: [],
      output_format: null,
      missing_info: [],
    });
    expect(text).toBe(["Speed up the filtered list.", CLARIFY_LINE].join("\n"));
  });

  it("does not repeat in Context what the task already says", () => {
    const text = renderPrompt({
      task_type: "writing",
      task: "Write an email for a CV to send to the recruiter.",
      role: null,
      context: ["help me write an email for my CV", "send it to our recruiter"],
      constraints: [],
      output_format: "An email",
      missing_info: [],
    });
    expect(text).toBe(
      ["Write an email for a CV to send to the recruiter.", CLARIFY_LINE].join("\n"),
    );
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
      ["Fix my login screen", CLARIFY_LINE].join("\n"),
    );
  });
  it("still lists attachments", () => {
    expect(renderMinimal("Summarise", [{ name: "n.txt", type: "txt" }])).toContain(
      "- [Attached: n.txt (txt)]",
    );
  });
});

describe("withoutRepeats", () => {
  const task = "Explain why the Kubernetes pod keeps restarting and how to fix it.";

  it("drops items whose every detail is already in the task", () => {
    expect(withoutRepeats(task, ["The pod keeps restarting", "Kubernetes pod restarts"])).toEqual(
      [],
    );
  });

  it("keeps an item with even one new detail", () => {
    expect(
      withoutRepeats(task, ["The pod restarts every few minutes", "The memory limit is 256 Mi"]),
    ).toEqual(["The pod restarts every few minutes", "The memory limit is 256 Mi"]);
  });

  it("keeps a new number even when the words match", () => {
    expect(withoutRepeats("Write 3 bullet points", ["5 bullet points"])).toEqual([
      "5 bullet points",
    ]);
  });

  it("keeps negations the task does not have", () => {
    expect(withoutRepeats("Explain lists and tuples in Python", ["Do not use jargon"])).toEqual([
      "Do not use jargon",
    ]);
  });

  it("drops an item another, longer item already contains", () => {
    expect(
      withoutRepeats("Write a script", ["Runs every night", "It runs every night at 2 am"]),
    ).toEqual(["It runs every night at 2 am"]);
  });

  it("keeps only the first of two equal items", () => {
    expect(withoutRepeats("Write a script", ["Uses Bash", "uses bash"])).toEqual(["Uses Bash"]);
  });

  it("drops an 'Assumed:' item the task already states", () => {
    expect(withoutRepeats("Explain derivatives to a beginner", ["Assumed: beginner"])).toEqual([]);
  });
});
