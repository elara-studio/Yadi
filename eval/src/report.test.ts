import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mean, percentile } from "./stats";
import {
  summarize,
  summaryMarkdown,
  slug,
  writeResults,
  type CaseResult,
  type RunMeta,
} from "./report";
import { CHECKS } from "./scorers";

const result = (over: Partial<CaseResult> = {}): CaseResult => ({
  id: "a",
  category: "cat1",
  holdout: false,
  score: 1,
  checks: Object.fromEntries(CHECKS.map((k) => [k, true])) as CaseResult["checks"],
  failed: [],
  tokens_in: 100,
  tokens_out: 50,
  latency_ms: 1000,
  degraded: false,
  judge_failed: false,
  prompt: "Task: x",
  warnings: [],
  ...over,
});
const meta: RunMeta = {
  model: "qwen3:4b",
  judge_model: "qwen3:4b",
  date: "2026-11-24",
  cases_requested: null,
};

describe("stats", () => {
  it("mean and nearest-rank percentiles", () => {
    expect(mean([])).toBe(0);
    expect(mean([1, 2, 3])).toBe(2);
    const v = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 95)).toBe(100);
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([], 50)).toBe(0);
    expect(percentile([3, 1, 2], 50)).toBe(2); // unsorted input
  });
});

describe("summarize", () => {
  const rs = [
    result({ id: "a", category: "x", score: 1, latency_ms: 100 }),
    result({
      id: "b",
      category: "x",
      score: 0.5,
      failed: ["concise"],
      checks: { ...result().checks, concise: false },
      latency_ms: 300,
    }),
    result({
      id: "c",
      category: "y",
      score: 0,
      holdout: true,
      degraded: true,
      judge_failed: true,
      tokens_out: 200,
      latency_ms: 900,
    }),
    result({ id: "d", category: "y", score: 1, holdout: true, latency_ms: 500 }),
  ];
  const s = summarize(rs);

  it("overall, hold-out and tuning-set means", () => {
    expect(s.cases).toBe(4);
    expect(s.mean_score).toBeCloseTo(0.625);
    expect(s.mean_holdout).toBeCloseTo(0.5);
    expect(s.mean_non_holdout).toBeCloseTo(0.75);
  });
  it("per category and per check", () => {
    expect(s.per_category.x).toEqual({ n: 2, mean: 0.75 });
    expect(s.per_category.y).toEqual({ n: 2, mean: 0.5 });
    expect(s.per_check.concise).toBe(0.75);
    expect(s.per_check.template).toBe(1);
  });
  it("token ratio, latency percentiles, degraded and judge failures, failures list", () => {
    expect(s.mean_token_ratio).toBeCloseTo((0.5 + 0.5 + 2 + 0.5) / 4);
    expect(s.latency_p50_ms).toBe(300);
    expect(s.latency_p95_ms).toBe(900);
    expect(s.degraded).toBe(1);
    expect(s.judge_failures).toBe(1);
    expect(s.failures).toEqual([{ id: "b", failed: ["concise"] }]);
  });
  it("handles a run with no hold-out cases", () => {
    expect(summarize([result()]).mean_holdout).toBeNull();
    expect(summarize([]).mean_score).toBe(0);
  });
});

describe("markdown and files", () => {
  it("the summary block names the model, judge, scores, latency and failures", () => {
    const md = summaryMarkdown(meta, summarize([result()]));
    expect(md).toContain("## 2026-11-24 · qwen3:4b");
    expect(md).toContain("**Mean score: 1.000**");
    expect(md).toContain("hold-out n/a");
    expect(md).toContain("p50 1000 ms, p95 1000 ms");
    expect(md).toContain("Failures: none");
  });
  it("warns when the judge is the model under test", () => {
    expect(summaryMarkdown(meta, summarize([result()]))).toContain("weak judge");
    expect(
      summaryMarkdown({ ...meta, judge_model: "bigger:8b" }, summarize([result()])),
    ).not.toContain("weak judge");
  });
  it("shows a subset and a note", () => {
    const md = summaryMarkdown(
      { ...meta, cases_requested: ["a", "b"], note: "runner validation" },
      summarize([result()]),
    );
    expect(md).toContain("(subset: a, b)");
    expect(md).toContain("> runner validation");
  });
  it("slug makes model tags file-safe", () => {
    expect(slug("qwen3:4b-instruct-2507-q4_K_M")).toBe("qwen3-4b-instruct-2507-q4-K-M");
    expect(slug("library/gemma:2b")).toBe("library-gemma-2b");
  });
  it("writeResults writes the JSON and appends to SUMMARY.md with one header", () => {
    const dir = mkdtempSync(join(tmpdir(), "yadi-eval-"));
    const rs = [result()];
    const file = writeResults(dir, meta, rs, summarize(rs));
    expect(file.endsWith("20261124-qwen3-4b.json")).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).summary.cases).toBe(1);
    writeResults(dir, { ...meta, model: "other:1b" }, rs, summarize(rs));
    const md = readFileSync(join(dir, "SUMMARY.md"), "utf8");
    expect(md.match(/# Eval summary/g)).toHaveLength(1);
    expect(md).toContain("qwen3:4b");
    expect(md).toContain("other:1b");
  });
});
