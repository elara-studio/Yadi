import { invoke } from "@tauri-apps/api/core";

/** What Rust sends back for a file it could read (`Extracted` in src-tauri/src/attachments). */
export interface Extracted {
  name: string;
  type_label: string;
  size_bytes: number;
  text: string;
  truncated: boolean;
}

/** The file reading the chat window needs, injectable so it can be tested without Tauri. */
export interface AttachmentApi {
  fromPath(path: string): Promise<Extracted>;
  fromBytes(name: string, bytes: Uint8Array): Promise<Extracted>;
}

/** Rust errors arrive as `{kind, message}`; the message is written for the user. */
export function attachmentErrorMessage(e: unknown): string {
  if (typeof e === "object" && e !== null && "message" in e && typeof e.message === "string") {
    return e.message;
  }
  if (typeof e === "string" && e !== "") return e;
  return "This file could not be read.";
}

export const tauriAttachmentApi: AttachmentApi = {
  fromPath: (path) => invoke<Extracted>("attachment_from_path", { path }),
  // The file travels as the raw request body (no JSON), its name in a header.
  fromBytes: (name, bytes) =>
    invoke<Extracted>("attachment_from_bytes", bytes, {
      headers: { "x-file-name": encodeURIComponent(name) },
    }),
};
