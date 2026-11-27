import type { Analysis, EvidencedText } from "./types";

/** The model's answer could not be read as the JSON the stage needs. */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

/**
 * Pulls a JSON object out of a model answer. Tolerates a `<think>` block, a code fence, and
 * text around the object.
 */
export function extractJson(raw: string): unknown {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence?.[1]) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new ParseError("no JSON object in the answer");
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new ParseError(`invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function parseNormalize(raw: string): { clean_text: string } {
  const v = extractJson(raw) as { clean_text?: unknown };
  if (typeof v.clean_text !== "string" || v.clean_text.trim() === "") {
    throw new ParseError("clean_text is missing or empty");
  }
  return { clean_text: v.clean_text.trim() };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function evidencedList(v: unknown): EvidencedText[] {
  if (!Array.isArray(v)) return [];
  const out: EvidencedText[] = [];
  for (const item of v) {
    if (
      typeof item === "object" &&
      item !== null &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      const { text, evidence, repeats_task, turned_down } = item as {
        text: string;
        evidence?: unknown;
        repeats_task?: unknown;
        turned_down?: unknown;
      };
      out.push({
        text,
        evidence: str(evidence),
        ...(repeats_task === true && { repeats_task: true }),
        ...(turned_down === true && { turned_down: true }),
      });
    }
  }
  return out;
}

/**
 * Reads the Analyze answer. Shape problems that make the answer unusable (no JSON, no task) are a
 * `ParseError`; sloppy details (a string where an object was expected, a missing evidence) are
 * kept as empty evidence so the validator drops them and counts them.
 */
export function parseAnalysis(raw: string): Analysis {
  const v = extractJson(raw) as Record<string, unknown>;
  const task = str(v.task).trim();
  if (task === "") throw new ParseError("task is missing or empty");

  let role: Analysis["role"] = null;
  if (typeof v.role === "object" && v.role !== null) {
    const r = v.role as { value?: unknown; evidence?: unknown };
    if (str(r.value).trim() !== "")
      role = { value: str(r.value).trim(), evidence: str(r.evidence) };
  } else if (typeof v.role === "string" && v.role.trim() !== "") {
    role = { value: v.role.trim(), evidence: "" }; // a bare string has no proof: it will be dropped
  }

  let outputFormat: Analysis["output_format"] = null;
  if (typeof v.output_format === "object" && v.output_format !== null) {
    const o = v.output_format as { text?: unknown; evidence?: unknown; repeats_task?: unknown };
    if (str(o.text).trim() !== "")
      outputFormat = {
        text: str(o.text).trim(),
        evidence: str(o.evidence),
        ...(o.repeats_task === true && { repeats_task: true }),
      };
  } else if (typeof v.output_format === "string" && v.output_format.trim() !== "") {
    outputFormat = { text: v.output_format.trim(), evidence: "" };
  }

  return {
    task_type: str(v.task_type).trim() || "other",
    task,
    role,
    context: evidencedList(v.context),
    constraints: evidencedList(v.constraints),
    output_format: outputFormat,
    missing_info: Array.isArray(v.missing_info)
      ? v.missing_info.filter((m): m is string => typeof m === "string")
      : [],
  };
}
