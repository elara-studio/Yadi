import { CLARIFY_LINE } from "@yadi/core";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCases, type EvalCase } from "./cases";
import {
  CHECKS,
  caseScore,
  checkClarify,
  checkConcise,
  checkRetractions,
  checkTemplate,
  deterministicChecks,
  failedChecks,
  tokenCounts,
} from "./scorers";

const cases = loadCases(join(dirname(fileURLToPath(import.meta.url)), "../cases.jsonl"));
const byId = (id: string) => cases.find((c) => c.id === id) as EvalCase;

const lines = (...l: string[]) => l.join("\n");

// and-01: long enough rambling transcript, 5 must_include facts, no expect_clarify
const and01 = byId("and-01");
const GOOD = lines(
  "Role: Android developer",
  "Task: Fix the lag when scrolling a RecyclerView.",
  "Context:",
  "- Android app",
  "- The RecyclerView lags when scrolling",
  "- It contains images",
  "- Possibly using Glide (not sure)",
  CLARIFY_LINE,
);

describe("deterministic checks", () => {
  describe("template", () => {
    it("a well-formed prompt passes", () => {
      expect(checkTemplate(and01, GOOD)).toBe(true);
    });
    it("needs a Task line once there are sections; the clarify line is optional", () => {
      expect(checkTemplate(and01, lines("Role: x", "Context:", "- a", "- b", CLARIFY_LINE))).toBe(
        false,
      );
      expect(checkTemplate(and01, lines("Task: x", "Context:", "- a"))).toBe(true);
      expect(checkTemplate(and01, lines("Fix the lag."))).toBe(true);
    });
    it("accepts a plain task sentence when nothing else is left", () => {
      expect(checkTemplate(and01, lines("Fix the lag.", CLARIFY_LINE))).toBe(true);
      expect(checkTemplate(and01, lines("Fix the lag.", CLARIFY_LINE, "Likely missing: q?"))).toBe(
        true,
      );
      expect(checkTemplate(and01, lines("Task: Fix the lag.", CLARIFY_LINE))).toBe(true);
    });
    it("a plain sentence may not carry other lines", () => {
      expect(checkTemplate(and01, lines("Fix the lag.", CLARIFY_LINE, "- a"))).toBe(false);
      expect(checkTemplate(and01, lines("Fix the lag.", "More prose.", CLARIFY_LINE))).toBe(false);
    });
    it("a Role line is never required", () => {
      expect(checkTemplate(and01, GOOD.replace("Role: Android developer\n", ""))).toBe(true);
    });
    it("rejects stray prose lines, wrong order and unknown headings", () => {
      expect(checkTemplate(and01, lines(GOOD, "Here is your improved prompt!"))).toBe(false);
      expect(
        checkTemplate(
          and01,
          lines(
            "Task: x",
            "Role: Android developer",
            "Context:",
            "- a",
            "- b",
            "- c",
            CLARIFY_LINE,
          ),
        ),
      ).toBe(false);
      expect(
        checkTemplate(
          and01,
          lines("Task: x", "Notes:", "Context:", "- a", "- b", "- c", CLARIFY_LINE),
        ),
      ).toBe(false);
    });
    it("accepts every optional section when in order", () => {
      const full = lines(
        "Role: R",
        "Task: T",
        "Context:",
        "- a",
        "- b",
        "- c",
        "Constraints:",
        "- k",
        "Output: markdown",
        "Attachments:",
        "- [Attached: n (t)]",
        CLARIFY_LINE,
        "Likely missing: q?",
      );
      expect(checkTemplate(and01, full)).toBe(true);
    });
  });

  describe("concise", () => {
    it("a prompt shorter than the transcript passes", () => {
      expect(checkConcise(and01, GOOD)).toBe(true);
    });
    it("a verbose prompt fails", () => {
      const verbose = lines(
        GOOD,
        "Context:",
        ...Array.from(
          { length: 30 },
          (_, i) => `- Please be very thorough and consider every possible angle number ${i}`,
        ),
      );
      expect(checkConcise(and01, verbose)).toBe(false);
    });
    it("the fixed clarify line does not count as filler", () => {
      const tiny = { ...and01, transcript: "fix my login bug" }; // 4 tokens
      expect(checkConcise(tiny, lines("Task: Fix my login bug", CLARIFY_LINE))).toBe(true);
    });
    it("very short transcripts get a 1.5x allowance", () => {
      const short = { ...and01, transcript: "x".repeat(80) }; // 20 tokens
      expect(checkConcise(short, lines("Task: " + "y".repeat(100), CLARIFY_LINE))).toBe(true); // 26 vs 20*1.5=30
      expect(checkConcise(short, lines("Task: " + "y".repeat(140), CLARIFY_LINE))).toBe(false); // 36 > 30
    });
    it("long transcripts get no allowance", () => {
      const long = { ...and01, transcript: "x".repeat(1000) }; // 250 tokens
      expect(checkConcise(long, lines("Task: " + "y".repeat(1100), CLARIFY_LINE))).toBe(false);
    });
  });

  describe("retractions", () => {
    const corr02 = byId("corr-02"); // must_not_include: ["four days", "4 days"]
    it("passes when the retracted thing is gone, case-insensitively", () => {
      expect(checkRetractions(corr02, "Task: a trip of three days")).toBe(true);
      expect(checkRetractions(corr02, "Task: a trip of FOUR DAYS")).toBe(false);
      expect(checkRetractions(corr02, "Task: a 4 days trip")).toBe(false);
    });
    it("cases without retractions always pass", () => {
      expect(checkRetractions(and01, "anything at all")).toBe(true);
    });
  });

  describe("clarify behaviour", () => {
    const needs = byId("and-04"); // expect_clarify: true
    it("a complete request needs no clarify line; 'Likely missing' needs it", () => {
      expect(checkClarify(and01, lines("Task: x"))).toBe(true);
      expect(checkClarify(needs, lines("Task: x", "Likely missing: which device?"))).toBe(false);
    });
    it("'Likely missing' is required when clarification is expected", () => {
      expect(checkClarify(needs, lines("Task: x", CLARIFY_LINE))).toBe(false);
      expect(
        checkClarify(needs, lines("Task: x", CLARIFY_LINE, "Likely missing: which device?")),
      ).toBe(true);
    });
    it("'Likely missing' is unnecessary when the case is self-contained", () => {
      expect(checkClarify(byId("good-01"), lines("Task: x", CLARIFY_LINE))).toBe(true);
      expect(
        checkClarify(byId("good-01"), lines("Task: x", CLARIFY_LINE, "Likely missing: anything?")),
      ).toBe(false);
    });
  });

  it("deterministicChecks bundles the four checks", () => {
    expect(deterministicChecks(and01, GOOD)).toEqual({
      template: true,
      concise: true,
      retractions: true,
      clarify: true,
    });
  });
});

describe("scoring", () => {
  const all = (v: boolean) =>
    Object.fromEntries(CHECKS.map((k) => [k, v])) as Record<(typeof CHECKS)[number], boolean>;
  it("a perfect case scores 1, and each failed check costs 1/7", () => {
    expect(caseScore(all(true))).toBe(1);
    expect(caseScore({ ...all(true), concise: false })).toBeCloseTo(6 / 7);
    expect(caseScore(all(false))).toBe(0);
    expect(failedChecks({ ...all(true), faithful: false, template: false })).toEqual([
      "faithful",
      "template",
    ]);
  });
  it("there are exactly the seven checks of the eval README", () => {
    expect([...CHECKS]).toEqual([
      "faithful",
      "no_invention",
      "retractions",
      "template",
      "concise",
      "clarify",
      "assumptions",
    ]);
  });
  it("token counts are approximate chars/4", () => {
    expect(tokenCounts({ ...and01, transcript: "x".repeat(40) }, "y".repeat(8))).toEqual({
      input: 10,
      output: 2,
    });
  });
});

describe("canned pipeline outputs", () => {
  it("good output: every deterministic check passes", () => {
    expect(Object.values(deterministicChecks(and01, GOOD)).every(Boolean)).toBe(true);
  });
  it("hallucinating output is not caught by the deterministic checks (that is the judge's job)", () => {
    // a wrong fact in place of a right one, same length: only a reader (the judge) can tell
    const hallucinated = GOOD.replace("- Android app", "- Android 14");
    expect(Object.values(deterministicChecks(and01, hallucinated)).every(Boolean)).toBe(true);
  });
  it("verbose output fails the concise check only", () => {
    const verbose = lines(
      "Role: Android developer",
      "Task: " + "Please help me investigate in great depth ".repeat(40),
      "Context:",
      "- a",
      "- b",
      "- c",
      CLARIFY_LINE,
    );
    const r = deterministicChecks(and01, verbose);
    expect(r.concise).toBe(false);
    expect(r.template && r.retractions && r.clarify).toBe(true);
  });
});
