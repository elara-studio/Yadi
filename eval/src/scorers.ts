import { CLARIFY_LINE, estimateTokens } from "@yadi/core";
import type { EvalCase } from "./cases";

/** The seven checks of eval/README.md. */
export const CHECKS = [
  "faithful",
  "no_invention",
  "retractions",
  "template",
  "concise",
  "clarify",
  "assumptions",
] as const;
export type CheckName = (typeof CHECKS)[number];
export type CheckResults = Record<CheckName, boolean>;

// ---- deterministic checks --------------------------------------------------------------------------

const HEADINGS = [
  "Role:",
  "Task:",
  "Context:",
  "Constraints:",
  "Output:",
  "Attachments:",
  CLARIFY_LINE,
  "Likely missing:",
];

/** The fixed clarify line is not counted as "filler" by the conciseness check. */
const CLARIFY_TOKENS = estimateTokens(CLARIFY_LINE);

/** Very short transcripts get a 1.5x allowance instead of "shorter than the transcript". */
export const SHORT_TRANSCRIPT_TOKENS = 40;
export const SHORT_ALLOWANCE = 1.5;

/**
 * Template: the prompt follows the fixed layout.
 *  - the clarify line appears only when something is likely missing (or in a minimal fallback);
 *  - a request that is only a task may be a plain sentence, optionally followed by the clarify
 *    line and a "Likely missing:" line; otherwise a "Task:" line is required;
 *  - every other line starts a known section or is a bullet / attachment line;
 *  - sections appear in the fixed order.
 * Empty sections are omitted by design (D10), and details the task already states are not
 * repeated in Context, so no section other than the task is ever required.
 * A "Role:" line is never required: many eval roles ("general assistant") cannot be proven from
 * what was said, and inventing one would break the proof rule.
 */
export function checkTemplate(_c: EvalCase, prompt: string): boolean {
  const lines = prompt.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return false;
  const isHeading = (line: string) =>
    HEADINGS.some((h) => (h.endsWith(":") ? line.startsWith(h) : line === h));
  if (!isHeading(lines[0]!)) {
    // Plain form: "<task sentence>", then at most the clarify line and the "Likely missing:" line.
    const rest = lines.slice(1);
    if (rest.length === 0) return true;
    if (rest[0] !== CLARIFY_LINE) return false;
    return rest.length === 1 || (rest.length === 2 && rest[1]!.startsWith("Likely missing:"));
  }
  if (!lines.some((l) => l.startsWith("Task: "))) return false;
  const order = HEADINGS.map((h) => h.replace(/:$/, ""));
  let lastIndex = -1;
  let inList = false;
  for (const line of lines) {
    const heading = HEADINGS.find((h) => (h.endsWith(":") ? line.startsWith(h) : line === h));
    if (heading) {
      const idx = order.indexOf(heading.replace(/:$/, ""));
      if (idx < lastIndex) return false;
      lastIndex = idx;
      inList = heading === "Context:" || heading === "Constraints:" || heading === "Attachments:";
    } else if (!(inList && line.startsWith("- "))) {
      return false; // a stray line the template does not produce
    }
  }
  return true;
}

/**
 * Concise: the prompt (without the fixed clarify line) is shorter than the transcript, or at most
 * 1.5x for very short transcripts (under 40 tokens). Token counts are approximate (chars / 4).
 */
export function checkConcise(c: EvalCase, prompt: string): boolean {
  const input = estimateTokens(c.transcript);
  const overhead = prompt.split("\n").includes(CLARIFY_LINE) ? CLARIFY_TOKENS : 0;
  const output = Math.max(0, estimateTokens(prompt) - overhead);
  if (output <= input) return true;
  return input < SHORT_TRANSCRIPT_TOKENS && output <= input * SHORT_ALLOWANCE;
}

/** Retractions: nothing from `must_not_include` appears (case-insensitive substring). */
export function checkRetractions(c: EvalCase, prompt: string): boolean {
  const text = prompt.toLowerCase();
  return (c.must_not_include ?? []).every((bad) => !text.includes(bad.toLowerCase()));
}

/**
 * Clarify behaviour: "Likely missing:" (with the clarify line) is present when the case expects
 * clarifying questions and absent when it does not (no unnecessary questions).
 */
export function checkClarify(c: EvalCase, prompt: string): boolean {
  const lines = prompt.split("\n");
  const hasMissing = lines.some((l) => l.startsWith("Likely missing:"));
  if (hasMissing && !lines.includes(CLARIFY_LINE)) return false;
  return c.expect_clarify === true ? hasMissing : !hasMissing;
}

export type DeterministicChecks = Pick<
  CheckResults,
  "retractions" | "template" | "concise" | "clarify"
>;

export function deterministicChecks(c: EvalCase, prompt: string): DeterministicChecks {
  return {
    template: checkTemplate(c, prompt),
    concise: checkConcise(c, prompt),
    retractions: checkRetractions(c, prompt),
    clarify: checkClarify(c, prompt),
  };
}

/** Token counts used for the in/out ratio in the report (approximate). */
export function tokenCounts(c: EvalCase, prompt: string): { input: number; output: number } {
  return { input: estimateTokens(c.transcript), output: estimateTokens(prompt) };
}

// ---- combining ---------------------------------------------------------------------------------------

export type JudgedChecks = Pick<CheckResults, "faithful" | "no_invention" | "assumptions">;

/** A case's score is the share of the seven checks it passed. */
export function caseScore(results: CheckResults): number {
  return CHECKS.filter((k) => results[k]).length / CHECKS.length;
}

export function failedChecks(results: CheckResults): CheckName[] {
  return CHECKS.filter((k) => !results[k]);
}
