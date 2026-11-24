/// <reference types="node" />
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FEWSHOT_EXAMPLES } from "./fewshot";
import { parseAnalysis } from "./parse";
import { analyzeMessages } from "./prompts";
import { normalizeForMatch, validateAnalysis } from "./validate";

const here = dirname(fileURLToPath(import.meta.url));
const evalTranscripts: string[] = readFileSync(join(here, "../../../../eval/cases.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => (JSON.parse(l) as { transcript: string }).transcript);

describe("few-shot examples", () => {
  it("there are between 4 and 6", () => {
    expect(FEWSHOT_EXAMPLES.length).toBeGreaterThanOrEqual(4);
    expect(FEWSHOT_EXAMPLES.length).toBeLessThanOrEqual(6);
  });

  it("every piece of evidence is an exact quote of its example's text", () => {
    for (const ex of FEWSHOT_EXAMPLES) {
      const a = ex.analysis;
      const evidences = [
        ...(a.role ? [a.role.evidence] : []),
        ...a.context.map((c) => c.evidence),
        ...a.constraints.map((c) => c.evidence),
        ...(a.output_format ? [a.output_format.evidence] : []),
      ];
      for (const e of evidences) expect(ex.cleanText, e).toContain(e);
    }
  });

  it("each example survives its own validator untouched and round-trips through the parser", () => {
    for (const ex of FEWSHOT_EXAMPLES) {
      const parsed = parseAnalysis(JSON.stringify(ex.analysis));
      const { dropped } = validateAnalysis(parsed, {
        transcript: ex.cleanText,
        stage0: ex.cleanText,
        clean: ex.cleanText,
      });
      expect(dropped.items, ex.cleanText).toEqual([]);
    }
  });

  it("no example's text equals (or sits inside) an eval transcript", () => {
    const cases = evalTranscripts.map(normalizeForMatch);
    expect(cases.length).toBeGreaterThan(30);
    for (const ex of FEWSHOT_EXAMPLES) {
      const text = normalizeForMatch(ex.cleanText);
      for (const c of cases) {
        expect(c === text || c.includes(text) || text.includes(c), ex.cleanText).toBe(false);
      }
    }
  });

  it("examples teach 'Assumed:' labelling and asking about missing info", () => {
    const all = JSON.stringify(FEWSHOT_EXAMPLES.map((e) => e.analysis));
    expect(all).toContain("Assumed:");
    expect(FEWSHOT_EXAMPLES.some((e) => e.analysis.missing_info.length > 0)).toBe(true);
    expect(FEWSHOT_EXAMPLES.some((e) => e.analysis.missing_info.length === 0)).toBe(true);
    expect(FEWSHOT_EXAMPLES.some((e) => e.analysis.role === null)).toBe(true);
  });

  it("the analyze prompt alternates user/assistant turns after the system message", () => {
    const m = analyzeMessages("hello", []);
    expect(m[0]?.role).toBe("system");
    for (let i = 1; i < m.length - 1; i += 2) {
      expect(m[i]?.role).toBe("user");
      expect(m[i + 1]?.role).toBe("assistant");
    }
    expect(m.at(-1)?.role).toBe("user");
  });
});
