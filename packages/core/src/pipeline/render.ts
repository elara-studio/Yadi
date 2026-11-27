import type { Attachment, ValidAnalysis } from "./types";
import { normalizeForMatch } from "./validate";

/**
 * Tells the receiving assistant to ask instead of guessing. Only added when something is likely
 * missing (or the analysis failed and nobody checked); a complete request does not need it.
 */
export const CLARIFY_LINE = "If anything is missing or unclear, ask me before answering.";

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Spoken linking words that can open an item ("And it should be in English") but add nothing. */
const LEADING_LINK = /^(?:(?:and|so|but|also|oh|yeah)(?:\s*,\s*|\s+))+/i;

/**
 * One item as a tidy line: no leading linking words, no trailing comma or semicolon, first letter
 * capitalised. Only removes or re-cases words, so it cannot change a detail.
 */
export function tidyItem(s: string): string {
  const text = oneLine(s)
    .replace(LEADING_LINK, "")
    .replace(/[\s,;]+$/, "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Words that carry no detail of their own: articles, pronouns, request framing ("help me",
 * "I want", "the user", "the task is") and the "Assumed:" label. An item made only of these and of words the task already
 * has adds nothing to the prompt.
 */
const FRAMING_WORDS = new Set(
  (
    "a an the and or but of to for from in on at by with as into onto about this that these those " +
    "it its it's is are was were be been being am do does did done has have had will would can could " +
    "should shall may might must i me my mine we us our ours you your yours he him his she her they " +
    "them their there here so then just also really very please help want wants wanted need needs " +
    "needed like would i'm im it s t some any all assumed which what who whom whose when where how " +
    "make sure get got let lets let's user person task request goal " +
    // words that only frame a limit: "Keep it short", "Friendly tone", "Plain style"
    "keep tone style format needed required include including use using"
  ).split(" "),
);

/** Irregular forms that a suffix rule cannot reach. */
const IRREGULAR: Record<string, string> = {
  written: "write",
  wrote: "write",
  built: "build",
  made: "make",
  ran: "run",
  sent: "send",
  taken: "take",
  took: "take",
  given: "give",
  gave: "give",
  no: "not",
};

/** A rough stem: irregular forms and plain endings ("days" -> "day", "uses" -> "use"). */
export function stem(word: string): string {
  if (IRREGULAR[word]) return IRREGULAR[word];
  if (/\d/.test(word) || word.length <= 3) return word;
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3 && !word.endsWith("ss"))
      return word.slice(0, -suffix.length);
  }
  return word;
}

/** The detail words of `text`: normalized and stemmed, without framing words. */
function detailWords(text: string): string[] {
  return normalizeForMatch(text)
    .split(" ")
    .filter((w) => w !== "" && !FRAMING_WORDS.has(w))
    .map(stem)
    .filter((w) => !FRAMING_WORDS.has(w)); // "uses" -> "use"
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
 * True when `item` says what `other` says in other words: at least two of its detail words are in
 * `other` and at most one is not, and that one is no number. "Two people traveling" is a near
 * repeat of "Two people: me and my sister"; "Budget 400 euros" is not one of "Budget 500 euros".
 */
function nearRepeat(item: string[], other: readonly string[]): boolean {
  const missing = item.filter((w) => !other.some((x) => sameWord(w, x)));
  return (
    item.length - missing.length >= 2 && missing.length <= 1 && !missing.some((w) => /\d/.test(w))
  );
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
  /** Adds the clarify line even when nothing is listed as missing (the minimal fallback). */
  alwaysClarify = false,
): string {
  const task = oneLine(analysis.task);
  const tidy = (items: readonly string[]) => items.map(tidyItem).filter((s) => s !== "");
  const constraints = withoutRepeats(task, tidy(analysis.constraints));
  // A detail the model filed under both headings, even in other words, is kept once: as the constraint.
  const constraintWords = constraints.map(detailWords);
  const context = withoutRepeats(task, tidy(analysis.context)).filter((item) => {
    const own = detailWords(item);
    return !constraintWords.some((c) => nearRepeat(own, c));
  });
  // The output format is dropped when the task or a constraint already says it ("a short email").
  const output =
    analysis.output_format &&
    withoutRepeats([task, ...constraints].join(" "), tidy([analysis.output_format]))[0];

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
  if (analysis.missing_info.length > 0) {
    lines.push(CLARIFY_LINE, `Likely missing: ${analysis.missing_info.map(oneLine).join("; ")}`);
  } else if (alwaysClarify) {
    lines.push(CLARIFY_LINE);
  }
  return lines.join("\n");
}

/**
 * The fallback when a model answer could not be used: just the cleaned request as the task, with
 * the clarify line, since nothing checked what might be missing.
 */
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
    true,
  );
}
