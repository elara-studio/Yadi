import { readFileSync } from "node:fs";

/** One line of `eval/cases.jsonl` (see eval/README.md). Optional fields are genuinely absent in some cases. */
export interface EvalCase {
  id: string;
  category: string;
  transcript: string;
  must_include: string[];
  must_not_add?: string[];
  must_not_include?: string[];
  role?: string;
  expect_clarify?: boolean;
  attachment?: string;
  traps?: string[];
}

export function parseCases(jsonl: string): EvalCase[] {
  return jsonl
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((line, i) => {
      const c = JSON.parse(line) as EvalCase;
      if (
        typeof c.id !== "string" ||
        typeof c.transcript !== "string" ||
        !Array.isArray(c.must_include)
      ) {
        throw new Error(`cases.jsonl line ${i + 1} is not a valid case`);
      }
      return c;
    });
}

export function loadCases(path: string): EvalCase[] {
  return parseCases(readFileSync(path, "utf8"));
}

/**
 * Hold-out set (PLAN Task 17): cases whose 1-based position in the file is divisible by 4.
 * Prompt tuning (Task 18) must never look at these.
 */
export function isHoldout(index0: number): boolean {
  return (index0 + 1) % 4 === 0;
}

export function holdoutIds(cases: readonly EvalCase[]): Set<string> {
  return new Set(cases.filter((_, i) => isHoldout(i)).map((c) => c.id));
}

/** Keeps only the requested ids (all if none are given), in file order. Unknown ids are an error. */
export function selectCases(
  cases: readonly EvalCase[],
  ids: readonly string[] | undefined,
): EvalCase[] {
  if (!ids || ids.length === 0) return [...cases];
  const known = new Set(cases.map((c) => c.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new Error(`unknown case id(s): ${unknown.join(", ")}`);
  const wanted = new Set(ids);
  return cases.filter((c) => wanted.has(c.id));
}
