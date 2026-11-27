import type { Attachment, ValidAnalysis } from "./types";
import { normalizeForMatch } from "./validate";

/** Always the last fixed line: it tells the receiving assistant to ask instead of guessing. */
export const CLARIFY_LINE = "If anything is missing or unclear, ask me before answering.";

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * Words that carry no detail of their own: articles, pronouns, request framing ("help me",
 * "I want") and the "Assumed:" label. An item made only of these and of words the task already
 * has adds nothing to the prompt.
 */
const FRAMING_WORDS = new Set(
  (
    "a an the and or but of to for from in on at by with as into onto about this that these those " +
    "it its it's is are was were be been being am do does did done has have had will would can could " +
    "should shall may might must i me my mine we us our ours you your yours he him his she her they " +
    "them their there here so then just also really very please help want wants wanted need needs " +
    "needed like would i'm im it s t some any all assumed which what who whom whose when where how " +
    "make sure get got let lets let's"
  ).split(" "),
);

/** The detail words of `text`: normalized, without framing words. */
function detailWords(text: string): string[] {
  return normalizeForMatch(text)
    .split(" ")
    .filter((w) => w !== "" && !FRAMING_WORDS.has(w));
}

/** Same word, allowing simple endings: "restarts"/"restarting", "email"/"emails". */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4 || /\d/.test(a) || /\d/.test(b)) return false;
  const n = Math.min(a.length, b.length, 5);
  return a.slice(0, n) === b.slice(0, n) && Math.abs(a.length - b.length) <= 3;
}

/** True when every detail word of `item` already appears in `words`. */
function coveredBy(item: string[], words: readonly string[]): boolean {
  return item.every((w) => words.some((x) => sameWord(w, x)));
}

/**
 * Removes items that only repeat what the task (or a longer item kept before them) already says,
 * so the prompt never states a detail twice. Pure and deterministic; an item with even one new
 * detail word (a number, a name, a limit) is always kept.
 */
export function withoutRepeats(task: string, items: readonly string[]): string[] {
  const taskWords = detailWords(task);
  const words = items.map(detailWords);
  return items.filter((_, i) => {
    const own = words[i]!;
    if (own.length === 0 || coveredBy(own, taskWords)) return false;
    // A shorter item fully contained in another one is a repeat; of two equal ones, keep the first.
    return !words.some(
      (other, j) =>
        j !== i &&
        (other.length > own.length || (other.length === own.length && j < i)) &&
        coveredBy(own, other),
    );
  });
}

/**
 * Renders the prompt (decision D10): deterministic code, never the model. Empty sections are
 * omitted and details the task already states are not repeated. A request that is only a task
 * is written as a plain sentence instead of a one-line template. The same input always gives the
 * same text.
 */
export function renderPrompt(
  analysis: ValidAnalysis,
  attachments: readonly Attachment[] = [],
): string {
  const task = oneLine(analysis.task);
  const context = withoutRepeats(task, analysis.context.map(oneLine));
  const constraints = withoutRepeats(task, analysis.constraints.map(oneLine));
  // The output format is dropped when the task or a constraint already says it ("a short email").
  const output =
    analysis.output_format &&
    withoutRepeats([task, ...constraints].join(" "), [oneLine(analysis.output_format)])[0];

  const lines: string[] = [];
  if (analysis.role) lines.push(`Role: ${oneLine(analysis.role)}`);
  lines.push(`Task: ${task}`);
  if (context.length > 0) lines.push("Context:", ...context.map((c) => `- ${c}`));
  if (constraints.length > 0) lines.push("Constraints:", ...constraints.map((c) => `- ${c}`));
  if (output) lines.push(`Output: ${output}`);
  if (attachments.length > 0) {
    lines.push(
      "Attachments:",
      ...attachments.map((a) => `- [Attached: ${oneLine(a.name)} (${oneLine(a.type)})]`),
    );
  }
  // Only the task is left: a plain sentence says the same with less.
  if (lines.length === 1) lines[0] = task;
  lines.push(CLARIFY_LINE);
  if (analysis.missing_info.length > 0) {
    lines.push(`Likely missing: ${analysis.missing_info.map(oneLine).join("; ")}`);
  }
  return lines.join("\n");
}

/** The fallback when a model answer could not be used: just the cleaned request as the task. */
export function renderMinimal(text: string, attachments: readonly Attachment[] = []): string {
  return renderPrompt(
    {
      task_type: "other",
      task: text,
      role: null,
      context: [],
      constraints: [],
      output_format: null,
      missing_info: [],
    },
    attachments,
  );
}
