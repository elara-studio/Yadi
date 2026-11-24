import { describe, expect, it } from "vitest";
import { ParseError, extractJson, parseAnalysis, parseNormalize } from "./parse";

describe("extractJson", () => {
  it("reads plain JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("ignores a <think> block, a code fence and surrounding words", () => {
    expect(extractJson('<think>hmm {not this}</think>\n{"a":2}')).toEqual({ a: 2 });
    expect(extractJson('Here you go:\n```json\n{"a":3}\n```\nDone.')).toEqual({ a: 3 });
    expect(extractJson('Sure! {"a":4} hope it helps')).toEqual({ a: 4 });
  });
  it("throws ParseError when there is no usable JSON", () => {
    for (const bad of ["", "no json here", "{broken", '{"a":}', "[1,2]"]) {
      expect(() => extractJson(bad), bad).toThrow(ParseError);
    }
  });
});

describe("parseNormalize", () => {
  it("returns the trimmed clean text", () => {
    expect(parseNormalize('{"clean_text":"  hello  "}')).toEqual({ clean_text: "hello" });
  });
  it("rejects missing, empty or non-string clean_text", () => {
    for (const bad of ["{}", '{"clean_text":""}', '{"clean_text":"   "}', '{"clean_text":5}']) {
      expect(() => parseNormalize(bad), bad).toThrow(ParseError);
    }
  });
});

describe("parseAnalysis", () => {
  const ok = {
    task_type: "coding",
    task: "Fix it",
    role: { value: "Engineer", evidence: "my code" },
    context: [{ text: "A", evidence: "a" }],
    constraints: [{ text: "B", evidence: "b" }],
    output_format: { text: "Code", evidence: "code" },
    missing_info: ["Q1?"],
  };

  it("reads a complete analysis", () => {
    expect(parseAnalysis(JSON.stringify(ok))).toEqual(ok);
  });

  it("needs a task", () => {
    expect(() => parseAnalysis(JSON.stringify({ ...ok, task: "  " }))).toThrow(ParseError);
    expect(() => parseAnalysis("{}")).toThrow(ParseError);
  });

  it("defaults the missing parts", () => {
    const a = parseAnalysis('{"task":"Do x"}');
    expect(a).toEqual({
      task_type: "other",
      task: "Do x",
      role: null,
      context: [],
      constraints: [],
      output_format: null,
      missing_info: [],
    });
  });

  it("keeps sloppy items with empty evidence so the validator can count them", () => {
    const a = parseAnalysis(
      JSON.stringify({
        task: "t",
        role: "Expert",
        output_format: "Markdown",
        context: [{ text: "no evidence" }, "a bare string", { text: 5 }, null],
        constraints: "not a list",
        missing_info: ["ok", 3, null],
      }),
    );
    expect(a.role).toEqual({ value: "Expert", evidence: "" });
    expect(a.output_format).toEqual({ text: "Markdown", evidence: "" });
    expect(a.context).toEqual([{ text: "no evidence", evidence: "" }]);
    expect(a.constraints).toEqual([]);
    expect(a.missing_info).toEqual(["ok"]);
  });

  it("empty role or format objects become null", () => {
    const a = parseAnalysis(
      JSON.stringify({
        task: "t",
        role: { value: " ", evidence: "x" },
        output_format: { text: "" },
      }),
    );
    expect(a.role).toBeNull();
    expect(a.output_format).toBeNull();
  });
});
