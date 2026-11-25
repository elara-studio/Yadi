/**
 * Privacy rule D12: transcripts, prompts, audio and attachment text are never logged or written
 * anywhere. Nothing should pass such data to a logger in the first place; this helper is the
 * safety net for the places that log a payload they did not build themselves.
 */

/** Object keys whose values are the person's words, their audio, or text derived from them. */
export const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  "text",
  "transcript",
  "prompt",
  "partial",
  "clean_text",
  "stage0_text",
  "preview",
  "content",
  "samples",
  "audio",
  "words",
  "word",
  "vocabulary",
  "items",
  "attachments",
  "segments",
  "recent",
]);

export const REDACTED = "[redacted]";
const MAX_STRING = 80;
const MAX_DEPTH = 5;
const MAX_LOG = 300;

function redact(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `[text of ${value.length} characters]` : value;
  }
  if (typeof value !== "object" || value === null) return value;
  if (depth >= MAX_DEPTH) return "[nested]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      SENSITIVE_KEYS.has(k.toLowerCase()) ? REDACTED : redact(v, depth + 1),
    ]),
  );
}

/** A copy of `value` with every sensitive field replaced and long strings reduced to a length. */
export function redactValue(value: unknown): unknown {
  return redact(value, 0);
}

/** One short log-safe line describing `value`. */
export function redactForLog(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(redactValue(value)) ?? String(value);
  } catch {
    text = "[unprintable]";
  }
  return text.length > MAX_LOG ? `${text.slice(0, MAX_LOG)}…` : text;
}
