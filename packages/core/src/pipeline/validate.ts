import type { Analysis, DroppedItem, DroppedReport, ValidAnalysis } from "./types";

/**
 * The proof rule (decision D11). Every detail the model claims must carry evidence that is an exact
 * quote of what the person said; anything that cannot be proven is removed before rendering.
 */

/** Lower-case, punctuation to spaces, single spaces. Used to compare quotes loosely. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NUMBER = /\d+(?:[.,]\d+)*/g;

/** Digits as written, thousands commas removed ("1,000" -> "1000"). */
export function numbersIn(text: string): string[] {
  return (text.match(NUMBER) ?? []).map((n) => n.replace(/,(?=\d{3}\b)/g, ""));
}

const MAX_MISSING = 3;
const MAX_MISSING_LENGTH = 160;

export interface Sources {
  /** The original transcript, the Stage 0 text and the Stage 1 clean text. */
  transcript: string;
  stage0: string;
  clean: string;
}

export interface Validated {
  analysis: ValidAnalysis;
  dropped: DroppedReport;
}

export function validateAnalysis(analysis: Analysis, sources: Sources): Validated {
  const texts = [sources.transcript, sources.stage0, sources.clean].map(normalizeForMatch);
  const knownNumbers = new Set(
    [sources.transcript, sources.stage0, sources.clean].flatMap(numbersIn),
  );
  const dropped: DroppedItem[] = [];

  const proven = (evidence: string): boolean => {
    const e = normalizeForMatch(evidence);
    return e !== "" && texts.some((t) => t.includes(e));
  };
  const inventsNumber = (text: string): boolean =>
    numbersIn(text).some((n) => !knownNumbers.has(n));

  /** Keeps an item only when it has proof and invents no numbers; records why otherwise. */
  function check(field: DroppedItem["field"], text: string, evidence: string): boolean {
    if (evidence.trim() === "") {
      dropped.push({ field, text, reason: "no-evidence" });
      return false;
    }
    if (!proven(evidence)) {
      dropped.push({ field, text, reason: "evidence-not-in-transcript" });
      return false;
    }
    if (inventsNumber(text)) {
      dropped.push({ field, text, reason: "invented-number" });
      return false;
    }
    return true;
  }

  function evidencedItems(field: "context" | "constraints", items: Analysis["context"]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of items) {
      const text = item.text.replace(/\s+/g, " ").trim();
      if (text === "" || !check(field, text, item.evidence)) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }
    return out;
  }

  // role: no proof, no role line
  let role: string | null = null;
  if (analysis.role) {
    const value = analysis.role.value.replace(/\s+/g, " ").trim();
    if (value !== "" && check("role", value, analysis.role.evidence)) role = value;
  }

  // task: has no evidence of its own, but may not invent numbers; otherwise fall back to the clean text
  let task = analysis.task.replace(/\s+/g, " ").trim();
  if (task === "" || inventsNumber(task)) {
    if (task !== "") dropped.push({ field: "task", text: task, reason: "invented-number" });
    task = sources.clean.replace(/\s+/g, " ").trim();
  }

  const context = evidencedItems("context", analysis.context);
  const constraints = evidencedItems("constraints", analysis.constraints);

  let outputFormat: string | null = null;
  if (analysis.output_format) {
    const text = analysis.output_format.text.replace(/\s+/g, " ").trim();
    if (text !== "" && check("output_format", text, analysis.output_format.evidence))
      outputFormat = text;
  }

  const missing: string[] = [];
  for (const m of analysis.missing_info) {
    const text = m.replace(/\s+/g, " ").trim().slice(0, MAX_MISSING_LENGTH);
    if (text !== "" && !missing.some((x) => x.toLowerCase() === text.toLowerCase()))
      missing.push(text);
    if (missing.length === MAX_MISSING) break;
  }

  return {
    analysis: {
      task_type: analysis.task_type,
      task,
      role,
      context,
      constraints,
      output_format: outputFormat,
      missing_info: missing,
    },
    dropped: { count: dropped.length, items: dropped },
  };
}
