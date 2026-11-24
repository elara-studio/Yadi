#!/usr/bin/env -S pnpm exec tsx
/**
 * Scores a local Ollama model on the prompt eval.
 *
 *   pnpm eval --model <ollama-tag> [--judge <tag>] [--cases id1,id2] [--out dir]
 *
 * Nothing is downloaded or installed: if Ollama is not running or a model is missing the script
 * prints the exact command to run yourself and stops.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { OllamaClient } from "@yadi/core";
import { holdoutIds, loadCases, selectCases } from "./src/cases";
import { summarize, summaryMarkdown, writeResults, type RunMeta } from "./src/report";
import { runEval } from "./src/runEval";

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.OLLAMA_HOST_URL ?? "http://127.0.0.1:11434";

const { values } = parseArgs({
  options: {
    model: { type: "string" },
    judge: { type: "string" },
    cases: { type: "string" },
    out: { type: "string" },
    note: { type: "string" },
  },
});

function fail(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

async function installedTags(): Promise<string[] | null> {
  try {
    const res = await fetch(`${BASE}/api/tags`);
    if (!res.ok) return null;
    const body = (await res.json()) as { models?: { name: string }[] };
    return (body.models ?? []).map((m) => m.name);
  } catch {
    return null;
  }
}

const has = (tags: string[], wanted: string) =>
  tags.some(
    (t) =>
      t === wanted ||
      t === `${wanted}:latest` ||
      (!wanted.includes(":") && t.startsWith(`${wanted}:`)),
  );

async function main() {
  const model = values.model;
  if (!model)
    fail(1, "Usage: pnpm eval --model <ollama-tag> [--judge <tag>] [--cases id1,id2] [--out dir]");
  const judgeModel = values.judge ?? model;

  const tags = await installedTags();
  if (!tags) {
    fail(
      2,
      `Ollama is not reachable at ${BASE}.\nInstall it from https://ollama.com/download and start it (open the Ollama app, or run: ollama serve), then run this again.`,
    );
  }
  for (const [what, tag] of [
    ["model", model],
    ["judge", judgeModel],
  ] as const) {
    if (!has(tags, tag)) {
      fail(
        3,
        `The ${what} "${tag}" is not installed. This script never downloads models. To get it, run:\n\n  ollama pull ${tag}\n`,
      );
    }
  }
  if (judgeModel === model) {
    console.warn(
      `WARNING: the judge is the same model as the one being tested ("${model}"): a weak judge. Prefer a larger local model with --judge <tag>.`,
    );
  }

  const all = loadCases(join(here, "cases.jsonl"));
  const holdout = holdoutIds(all);
  const ids = values.cases
    ? values.cases
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const selected = selectCases(all, ids);

  const llm = new OllamaClient({ model, fetch, baseUrl: BASE });
  const judge =
    judgeModel === model ? llm : new OllamaClient({ model: judgeModel, fetch, baseUrl: BASE });

  console.log(`Running ${selected.length} case(s) with ${model} (judge: ${judgeModel})`);
  const results = await runEval({
    cases: selected,
    holdout,
    llm,
    judge,
    onCase: (r, i, n) =>
      console.log(
        `[${i + 1}/${n}] ${r.id.padEnd(10)} ${r.score.toFixed(2)}${r.failed.length ? `  failed: ${r.failed.join(", ")}` : ""}${r.degraded ? "  (degraded)" : ""}`,
      ),
  });

  const meta: RunMeta = {
    model,
    judge_model: judgeModel,
    date: new Date().toISOString().slice(0, 10),
    cases_requested: ids ?? null,
    note: values.note,
  };
  const summary = summarize(results);
  const out = values.out ?? join(here, "results");
  const file = writeResults(out, meta, results, summary);
  console.log(
    `\n${summaryMarkdown(meta, summary)}\nResults written to ${file} and appended to ${join(out, "SUMMARY.md")}`,
  );
}

main().catch((e: unknown) => {
  if (e instanceof Error && e.name === "LlmError")
    fail(4, `The model could not be used: ${e.message}`);
  throw e;
});
