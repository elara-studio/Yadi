import { mkdirSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CHECKS, type CheckName } from "./scorers";
import { mean, percentile } from "./stats";

export interface CaseResult {
  id: string;
  category: string;
  holdout: boolean;
  score: number;
  checks: Record<CheckName, boolean>;
  failed: CheckName[];
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  degraded: boolean;
  judge_failed: boolean;
  prompt: string;
  warnings: string[];
}

export interface RunMeta {
  model: string;
  judge_model: string;
  date: string; // YYYY-MM-DD
  cases_requested: string[] | null;
  note?: string;
}

export interface Summary {
  cases: number;
  mean_score: number;
  mean_holdout: number | null;
  mean_non_holdout: number | null;
  per_category: Record<string, { n: number; mean: number }>;
  per_check: Record<CheckName, number>;
  mean_token_ratio: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  degraded: number;
  judge_failures: number;
  failures: { id: string; failed: CheckName[] }[];
}

export function summarize(results: readonly CaseResult[]): Summary {
  const holdout = results.filter((r) => r.holdout);
  const rest = results.filter((r) => !r.holdout);
  const categories: Record<string, { n: number; mean: number }> = {};
  for (const cat of new Set(results.map((r) => r.category))) {
    const of = results.filter((r) => r.category === cat);
    categories[cat] = { n: of.length, mean: mean(of.map((r) => r.score)) };
  }
  const perCheck = Object.fromEntries(
    CHECKS.map((k) => [k, mean(results.map((r) => (r.checks[k] ? 1 : 0)))]),
  ) as Record<CheckName, number>;
  return {
    cases: results.length,
    mean_score: mean(results.map((r) => r.score)),
    mean_holdout: holdout.length ? mean(holdout.map((r) => r.score)) : null,
    mean_non_holdout: rest.length ? mean(rest.map((r) => r.score)) : null,
    per_category: categories,
    per_check: perCheck,
    mean_token_ratio: mean(
      results.map((r) => (r.tokens_in === 0 ? 0 : r.tokens_out / r.tokens_in)),
    ),
    latency_p50_ms: percentile(
      results.map((r) => r.latency_ms),
      50,
    ),
    latency_p95_ms: percentile(
      results.map((r) => r.latency_ms),
      95,
    ),
    degraded: results.filter((r) => r.degraded).length,
    judge_failures: results.filter((r) => r.judge_failed).length,
    failures: results
      .filter((r) => r.failed.length > 0)
      .map((r) => ({ id: r.id, failed: r.failed })),
  };
}

const f2 = (n: number | null) => (n === null ? "n/a" : n.toFixed(3));

/** A Markdown block for `eval/results/SUMMARY.md`. */
export function summaryMarkdown(meta: RunMeta, s: Summary): string {
  const weakJudge = meta.judge_model === meta.model;
  const cats = Object.entries(s.per_category)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k} ${f2(v.mean)} (${v.n})`)
    .join(", ");
  const checks = CHECKS.map((k) => `${k} ${f2(s.per_check[k])}`).join(", ");
  const failures = s.failures.length
    ? s.failures.map((f) => `${f.id} [${f.failed.join(", ")}]`).join("; ")
    : "none";
  return [
    `## ${meta.date} · ${meta.model}`,
    "",
    meta.note ? `> ${meta.note}\n` : "",
    `- Judge: \`${meta.judge_model}\`${weakJudge ? " (**same model as the one being tested: a weak judge**)" : ""}`,
    `- Cases: ${s.cases}${meta.cases_requested ? ` (subset: ${meta.cases_requested.join(", ")})` : ""}`,
    `- **Mean score: ${f2(s.mean_score)}** · hold-out ${f2(s.mean_holdout)} · tuning set ${f2(s.mean_non_holdout)}`,
    `- Per check: ${checks}`,
    `- Per category: ${cats}`,
    `- Mean token ratio (out/in): ${f2(s.mean_token_ratio)} (approximate tokens)`,
    `- Latency: p50 ${Math.round(s.latency_p50_ms)} ms, p95 ${Math.round(s.latency_p95_ms)} ms`,
    `- Degraded prompts: ${s.degraded} · judge failures: ${s.judge_failures}`,
    `- Failures: ${failures}`,
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Safe file-name part of a model tag (`qwen3:4b` -> `qwen3-4b`). */
export function slug(model: string): string {
  return model.replace(/[^A-Za-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Writes `<out>/<YYYYMMDD>-<model>.json` and appends to `<out>/SUMMARY.md`. Returns the JSON path. */
export function writeResults(
  outDir: string,
  meta: RunMeta,
  results: readonly CaseResult[],
  summary: Summary,
): string {
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${meta.date.replace(/-/g, "")}-${slug(meta.model)}.json`);
  writeFileSync(file, JSON.stringify({ meta, summary, results }, null, 2));
  const summaryFile = join(outDir, "SUMMARY.md");
  const header = existsSync(summaryFile)
    ? ""
    : "# Eval summary\n\nOne block per run, newest last. Scores are the mean share of the 7 checks passed (see eval/README.md). The hold-out set is every 4th case; prompt tuning never looks at it.\n\n";
  appendFileSync(summaryFile, `${header}${summaryMarkdown(meta, summary)}\n`);
  return file;
}
