import { LlmError, runPipeline, type Attachment, type LlmClient } from "@yadi/core";
import type { EvalCase } from "./cases";
import { judgeCase } from "./judge";
import type { CaseResult } from "./report";
import {
  CHECKS,
  caseScore,
  deterministicChecks,
  failedChecks,
  tokenCounts,
  type CheckResults,
} from "./scorers";

export interface RunEvalOptions {
  cases: readonly EvalCase[];
  holdout: ReadonlySet<string>;
  /** The model under test: runs the pipeline. */
  llm: LlmClient;
  /** The grader for the judged checks (the same client as `llm` when no separate judge is given). */
  judge: LlmClient;
  /** Milliseconds clock, injected for tests. */
  now?: () => number;
  onCase?: (result: CaseResult, index: number, total: number) => void;
  signal?: AbortSignal;
}

/** Attachment cases get metadata only; the pipeline must refer to the attachment, not invent it. */
function attachmentsFor(c: EvalCase): Attachment[] {
  return c.attachment ? [{ name: c.attachment, type: "attachment" }] : [];
}

/**
 * Runs every case through the pipeline and scores it with the seven checks.
 * A model that cannot be reached stops the whole run (`LlmError` propagates); a bad answer from
 * the model is just a lower score.
 */
export async function runEval(options: RunEvalOptions): Promise<CaseResult[]> {
  const now = options.now ?? Date.now;
  const results: CaseResult[] = [];
  for (const [i, c] of options.cases.entries()) {
    const started = now();
    const out = await runPipeline({
      transcript: c.transcript,
      attachments: attachmentsFor(c),
      llm: options.llm,
      signal: options.signal,
    });
    const latency = now() - started;

    const judged = await judgeCase(options.judge, c, out.prompt, options.signal);
    const checks: CheckResults = {
      ...deterministicChecks(c, out.prompt),
      faithful: judged?.faithful ?? false,
      no_invention: judged?.no_invention ?? false,
      assumptions: judged?.assumptions ?? false,
    };
    const tokens = tokenCounts(c, out.prompt);
    const result: CaseResult = {
      id: c.id,
      category: c.category,
      holdout: options.holdout.has(c.id),
      score: caseScore(checks),
      checks: Object.fromEntries(CHECKS.map((k) => [k, checks[k]])) as CheckResults,
      failed: failedChecks(checks),
      tokens_in: tokens.input,
      tokens_out: tokens.output,
      latency_ms: latency,
      degraded: out.degraded,
      judge_failed: judged === null,
      prompt: out.prompt,
      warnings: out.warnings,
    };
    results.push(result);
    options.onCase?.(result, i, options.cases.length);
  }
  return results;
}

export { LlmError };
