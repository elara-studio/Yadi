/**
 * Attachments (Task 20): the pure rules shared by the chat window and the Controller.
 * Text extraction itself happens in Rust (`attachment_from_path` / `attachment_from_bytes`).
 */

import { ATTACHMENT_PREVIEW_CHARS, sanitizeAttachmentText } from "./pipeline/prompts";
import type { Attachment } from "./pipeline/types";

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 10 * 1024 * 1024;

export const PASTED_TEXT_NAME = "Pasted text";
export const PASTED_TEXT_TYPE = "pasted text";

/** A file or pasted text that has been read. The text stays in the chat window (memory only). */
export interface AttachmentItem {
  id: string;
  name: string;
  /** Short label for the chip and for `[Attached: name (type)]`, e.g. "pdf". */
  type: string;
  size: number;
  text: string;
  /** The text was cut because it was very long. */
  truncated?: boolean;
}

/** What the Controller needs: no full text, only the start (to infer the topic). */
export interface AttachmentMeta {
  name: string;
  type: string;
  preview: string;
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Can another attachment of `size` bytes be added? Returns a short, friendly reason when not, or
 * null when it is fine. Checked before reading a file, so a file that is too big is never read.
 */
export function attachmentLimitProblem(
  existing: readonly Pick<AttachmentItem, "size">[],
  size: number,
): string | null {
  if (existing.length >= MAX_ATTACHMENTS) {
    return `You can attach up to ${MAX_ATTACHMENTS} files. Remove one to add another.`;
  }
  if (size > MAX_ATTACHMENT_BYTES) {
    return `This file is ${formatAttachmentSize(size)}; the limit is ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)} per file.`;
  }
  const total = existing.reduce((sum, a) => sum + a.size, 0);
  if (total + size > MAX_ATTACHMENTS_TOTAL_BYTES) {
    return `Attachments can add up to ${formatAttachmentSize(MAX_ATTACHMENTS_TOTAL_BYTES)} in total. Remove one to add this.`;
  }
  return null;
}

/** Pasted text becomes a "Pasted text" attachment (control characters removed). */
export function pastedTextItem(id: string, raw: string): AttachmentItem | null {
  const text = sanitizeAttachmentText(raw).replace(/\r\n?/g, "\n").trim();
  if (text === "") return null;
  return {
    id,
    name: PASTED_TEXT_NAME,
    type: PASTED_TEXT_TYPE,
    size: new TextEncoder().encode(text).length,
    text,
  };
}

/** The metadata the Controller hands to the pipeline: name, type and the first characters. */
export function attachmentMeta(items: readonly AttachmentItem[]): AttachmentMeta[] {
  return items.map((a) => ({
    name: a.name,
    type: a.type,
    preview: a.text.slice(0, ATTACHMENT_PREVIEW_CHARS),
  }));
}

/** Validates the payload of an `ATTACHMENTS_SET` event. Anything malformed is dropped. */
export function parseAttachmentMeta(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  const out: Attachment[] = [];
  for (const item of raw.slice(0, MAX_ATTACHMENTS)) {
    if (typeof item !== "object" || item === null) continue;
    const { name, type, preview } = item as Record<string, unknown>;
    if (typeof name !== "string" || typeof type !== "string") continue;
    out.push({
      name: name.slice(0, 200),
      type: type.slice(0, 40),
      preview: typeof preview === "string" ? preview.slice(0, ATTACHMENT_PREVIEW_CHARS) : undefined,
    });
  }
  return out;
}

/** A fence of backticks longer than any run inside the text, so the text cannot close it early. */
export function fenceFor(text: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

/** "Copy with attachment text": every attachment's content in a labelled fenced block. */
export function attachmentCopyText(items: readonly AttachmentItem[]): string {
  return items
    .map((a) => {
      const fence = fenceFor(a.text);
      const note = a.truncated ? " (cut, the file is longer)" : "";
      return `Attachment: ${a.name} (${a.type})${note}\n${fence}\n${a.text}\n${fence}`;
    })
    .join("\n\n");
}
