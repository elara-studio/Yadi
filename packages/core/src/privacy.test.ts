import { describe, expect, it } from "vitest";
import { REDACTED, redactForLog, redactValue } from "./privacy";

describe("redactValue", () => {
  it("strips every field that holds the person's words", () => {
    const payload = {
      type: "TRANSCRIPT_SET_TEXT",
      text: "my secret plan",
      transcript: "more secrets",
      prompt: "Task: secret",
      partial: "half a sec",
      clean_text: "clean secret",
      preview: "file start",
      content: "chat content",
      words: ["a", "b"],
      attachments: [{ name: "x" }],
      segments: [{ id: 1, text: "secret" }],
    };
    const out = redactValue(payload) as Record<string, unknown>;
    expect(out.type).toBe("TRANSCRIPT_SET_TEXT");
    for (const key of Object.keys(payload).filter((k) => k !== "type")) {
      expect(out[key]).toBe(REDACTED);
    }
    expect(JSON.stringify(out)).not.toMatch(/secret|landlord/);
  });

  it("finds sensitive fields at any depth and in arrays", () => {
    const out = redactValue({ a: { b: [{ text: "deep secret", id: 3 }] } });
    expect(out).toEqual({ a: { b: [{ text: REDACTED, id: 3 }] } });
  });

  it("ignores the case of the key", () => {
    expect(redactValue({ Text: "x", PROMPT: "y" })).toEqual({ Text: REDACTED, PROMPT: REDACTED });
  });

  it("keeps harmless facts such as ids, counts, kinds and short messages", () => {
    const payload = { kind: "device-lost", count: 3, ok: true, message: "The microphone stopped" };
    expect(redactValue(payload)).toEqual(payload);
  });

  it("reduces a long string under an ordinary key to its length", () => {
    const out = redactValue({ note: "x".repeat(500) }) as { note: string };
    expect(out.note).toBe("[text of 500 characters]");
  });

  it("does not follow endless nesting", () => {
    const deep: Record<string, unknown> = {};
    let cur = deep;
    for (let i = 0; i < 20; i++) cur = cur.next = {};
    expect(JSON.stringify(redactValue(deep))).toContain("[nested]");
  });

  it("does not modify its input", () => {
    const input = { text: "keep me" };
    redactValue(input);
    expect(input.text).toBe("keep me");
  });
});

describe("redactForLog", () => {
  it("is one short line that never contains the words", () => {
    const line = redactForLog({ type: "X", text: "I hate my landlord", items: [{ preview: "s" }] });
    expect(line).toBe(`{"type":"X","text":"${REDACTED}","items":"${REDACTED}"}`);
  });

  it("is capped in length", () => {
    const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, i]));
    expect(redactForLog(many).length).toBeLessThanOrEqual(301);
  });

  it("copes with values JSON cannot print", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(redactForLog(circular)).toContain("[nested]");
    expect(redactForLog(undefined)).toBe("undefined");
    expect(redactForLog(12)).toBe("12");
    expect(redactForLog(null)).toBe("null");
    expect(redactForLog(10n)).toBe("[unprintable]");
  });
});
