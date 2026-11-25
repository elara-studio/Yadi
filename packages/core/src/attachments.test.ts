import { describe, expect, it } from "vitest";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  MAX_ATTACHMENT_BYTES,
  attachmentCopyText,
  attachmentLimitProblem,
  attachmentMeta,
  fenceFor,
  formatAttachmentSize,
  parseAttachmentMeta,
  pastedTextItem,
  type AttachmentItem,
} from "./attachments";
import { ATTACHMENT_PREVIEW_CHARS } from "./pipeline/prompts";

const item = (over: Partial<AttachmentItem> = {}): AttachmentItem => ({
  id: "1",
  name: "notes.txt",
  type: "txt",
  size: 100,
  text: "hello",
  ...over,
});

describe("formatAttachmentSize", () => {
  it("uses B, KB and MB", () => {
    expect(formatAttachmentSize(12)).toBe("12 B");
    expect(formatAttachmentSize(2048)).toBe("2 KB");
    expect(formatAttachmentSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("attachmentLimitProblem", () => {
  it("accepts a normal file", () => {
    expect(attachmentLimitProblem([], 1000)).toBeNull();
  });
  it("accepts exactly the per-file limit and refuses one byte more", () => {
    expect(attachmentLimitProblem([], MAX_ATTACHMENT_BYTES)).toBeNull();
    expect(attachmentLimitProblem([], MAX_ATTACHMENT_BYTES + 1)).toMatch(
      /limit is 5\.0 MB per file/,
    );
  });
  it("refuses an 11th attachment", () => {
    const ten = Array.from({ length: MAX_ATTACHMENTS }, () => ({ size: 1 }));
    expect(attachmentLimitProblem(ten.slice(0, 9), 1)).toBeNull();
    expect(attachmentLimitProblem(ten, 1)).toMatch(/up to 10 files/);
  });
  it("refuses when the total would pass 10 MB, and accepts exactly 10 MB", () => {
    const five = [{ size: MAX_ATTACHMENT_BYTES }];
    expect(attachmentLimitProblem(five, MAX_ATTACHMENT_BYTES)).toBeNull();
    expect(attachmentLimitProblem([{ size: MAX_ATTACHMENTS_TOTAL_BYTES - 1 }], 2)).toMatch(
      /10\.0 MB in total/,
    );
  });
  it("checks the count before the size", () => {
    const ten = Array.from({ length: MAX_ATTACHMENTS }, () => ({ size: 1 }));
    expect(attachmentLimitProblem(ten, MAX_ATTACHMENT_BYTES + 1)).toMatch(/up to 10 files/);
  });
});

describe("pastedTextItem", () => {
  it("makes a 'Pasted text' attachment with controls removed and CRLF fixed", () => {
    const got = pastedTextItem("p1", "  line one\r\nline\u0007 two\u001b[0m \n");
    expect(got).toMatchObject({
      id: "p1",
      name: "Pasted text",
      type: "pasted text",
      text: "line one\nline two[0m",
    });
    expect(got?.size).toBe(new TextEncoder().encode(got!.text).length);
  });
  it("ignores blank text", () => {
    expect(pastedTextItem("p", "  \n\t ")).toBeNull();
    expect(pastedTextItem("p", "\u0007\u0008")).toBeNull();
  });
  it("measures size in bytes, not characters", () => {
    expect(pastedTextItem("p", "é")?.size).toBe(2);
  });
});

describe("attachmentMeta", () => {
  it("sends name, type and only the first characters", () => {
    const long = "a".repeat(ATTACHMENT_PREVIEW_CHARS + 500);
    const [meta] = attachmentMeta([item({ text: long })]);
    expect(meta).toEqual({
      name: "notes.txt",
      type: "txt",
      preview: "a".repeat(ATTACHMENT_PREVIEW_CHARS),
    });
  });
});

describe("parseAttachmentMeta", () => {
  it("keeps well-formed items and drops the rest", () => {
    const got = parseAttachmentMeta([
      { name: "a.txt", type: "txt", preview: "hi" },
      { name: 5, type: "x" },
      null,
      "text",
      { name: "b", type: "pdf" },
    ]);
    expect(got).toEqual([
      { name: "a.txt", type: "txt", preview: "hi" },
      { name: "b", type: "pdf", preview: undefined },
    ]);
  });
  it("is empty for anything that is not a list", () => {
    expect(parseAttachmentMeta(undefined)).toEqual([]);
    expect(parseAttachmentMeta({})).toEqual([]);
  });
  it("caps the count, the name and the preview", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, type: "t" }));
    expect(parseAttachmentMeta(many)).toHaveLength(MAX_ATTACHMENTS);
    const [a] = parseAttachmentMeta([
      { name: "n".repeat(500), type: "t", preview: "p".repeat(9000) },
    ]);
    expect(a?.name).toHaveLength(200);
    expect(a?.preview).toHaveLength(ATTACHMENT_PREVIEW_CHARS);
  });
});

describe("fenceFor / attachmentCopyText", () => {
  it("uses three backticks unless the text has a longer run", () => {
    expect(fenceFor("plain")).toBe("```");
    expect(fenceFor("a ``` b")).toBe("````");
    expect(fenceFor("`````x")).toBe("``````");
  });
  it("labels every attachment and fences its text", () => {
    const text = attachmentCopyText([
      item({ name: "a.txt", type: "txt", text: "AAA" }),
      item({ id: "2", name: "b.md", type: "md", text: "x ``` y", truncated: true }),
    ]);
    expect(text).toBe(
      [
        "Attachment: a.txt (txt)\n```\nAAA\n```",
        "Attachment: b.md (md) (cut, the file is longer)\n````\nx ``` y\n````",
      ].join("\n\n"),
    );
  });
  it("is empty without attachments", () => {
    expect(attachmentCopyText([])).toBe("");
  });
});
