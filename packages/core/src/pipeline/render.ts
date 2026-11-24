import type { Attachment, ValidAnalysis } from "./types";

/** Always the last fixed line: it tells the receiving assistant to ask instead of guessing. */
export const CLARIFY_LINE =
  "If anything is missing or ambiguous, ask me concise clarifying questions before answering.";

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * Renders the prompt (decision D10): deterministic code, never the model. Empty sections are
 * omitted. The same input always gives the same text.
 */
export function renderPrompt(
  analysis: ValidAnalysis,
  attachments: readonly Attachment[] = [],
): string {
  const lines: string[] = [];
  if (analysis.role) lines.push(`Role: ${oneLine(analysis.role)}`);
  lines.push(`Task: ${oneLine(analysis.task)}`);
  if (analysis.context.length > 0) {
    lines.push("Context:", ...analysis.context.map((c) => `- ${oneLine(c)}`));
  }
  if (analysis.constraints.length > 0) {
    lines.push("Constraints:", ...analysis.constraints.map((c) => `- ${oneLine(c)}`));
  }
  if (analysis.output_format) lines.push(`Output: ${oneLine(analysis.output_format)}`);
  if (attachments.length > 0) {
    lines.push(
      "Attachments:",
      ...attachments.map((a) => `- [Attached: ${oneLine(a.name)} (${oneLine(a.type)})]`),
    );
  }
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
