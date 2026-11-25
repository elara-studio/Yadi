#!/usr/bin/env -S pnpm exec tsx
/**
 * Confirms that no few-shot example of the prompt pipeline copies an eval case (Task 18: the
 * examples must be newly written, never taken from `eval/cases.jsonl`, or the eval would measure
 * memorisation). A normalised example text that equals, contains or is contained in a normalised
 * case transcript is a failure.
 *
 *   pnpm --filter @yadi/eval run check:fewshot
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FEWSHOT_EXAMPLES, normalizeForMatch } from "@yadi/core";
import { parseCases } from "./src/cases";

const here = dirname(fileURLToPath(import.meta.url));
const cases = parseCases(readFileSync(join(here, "cases.jsonl"), "utf8"));

const problems: string[] = [];
for (const [i, example] of FEWSHOT_EXAMPLES.entries()) {
  const text = normalizeForMatch(example.cleanText);
  for (const c of cases) {
    const transcript = normalizeForMatch(c.transcript);
    if (text === transcript || text.includes(transcript) || transcript.includes(text)) {
      problems.push(`few-shot example ${i + 1} overlaps eval case ${c.id}`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(
  `check-fewshot: OK (${FEWSHOT_EXAMPLES.length} examples checked against ${cases.length} cases)`,
);
