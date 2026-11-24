import { extractJson, type ChatMessage, type LlmClient } from "@yadi/core";
import type { EvalCase } from "./cases";
import type { JudgedChecks } from "./scorers";

/** What the judge model answers (index-aligned with the lists it was given). */
export interface JudgeAnswer {
  /** For each `must_include` item: is it present in the prompt (any wording; numbers and names exact)? */
  included: boolean[];
  /** For each `must_not_add` item: does the prompt state it as a fact? */
  stated_as_fact: boolean[];
  /** Does the prompt state something as fact that the transcript does not say, without marking it "Assumed:"? */
  unmarked_inference: boolean;
}

export function judgeSchema(included: number, notAdd: number): object {
  const bools = (n: number) => ({
    type: "array",
    items: { type: "boolean" },
    minItems: n,
    maxItems: n,
  });
  return {
    type: "object",
    properties: {
      included: bools(included),
      stated_as_fact: bools(notAdd),
      unmarked_inference: { type: "boolean" },
    },
    required: ["included", "stated_as_fact", "unmarked_inference"],
    additionalProperties: false,
  };
}

const numbered = (items: readonly string[]) =>
  items.map((t, i) => `${i + 1}. ${t}`).join("\n") || "(none)";

export function judgeMessages(c: EvalCase, prompt: string): ChatMessage[] {
  const system = [
    "You are a strict, literal grader of a prompt that was rewritten from a spoken transcript.",
    "Judge only what is written. Do not be generous.",
    "Answer with JSON only: {included: boolean[], stated_as_fact: boolean[], unmarked_inference: boolean}.",
    "- included[i]: true only if item i from LIST A is present in the PROMPT, in any wording, with every number and name exact.",
    "- stated_as_fact[i]: true only if item i from LIST B appears in the PROMPT as something the user said or as a fact. A mention that is a question to ask the user, or a line starting with 'Assumed:', is false.",
    "- unmarked_inference: true if the PROMPT states any detail as fact that the TRANSCRIPT does not say or clearly imply, and that is not marked with 'Assumed:'. Otherwise false.",
    "The arrays must have exactly as many entries as their lists.",
  ].join("\n");
  const user = [
    `TRANSCRIPT:\n"""\n${c.transcript}\n"""`,
    `PROMPT:\n"""\n${prompt}\n"""`,
    `LIST A (must be present):\n${numbered(c.must_include)}`,
    `LIST B (must NOT be stated as fact):\n${numbered(c.must_not_add ?? [])}`,
  ].join("\n\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export function parseJudgeAnswer(raw: string, included: number, notAdd: number): JudgeAnswer {
  const v = extractJson(raw) as Partial<JudgeAnswer>;
  const isBools = (x: unknown, n: number): x is boolean[] =>
    Array.isArray(x) && x.length === n && x.every((b) => typeof b === "boolean");
  if (!isBools(v.included, included))
    throw new Error(`judge: "included" must be ${included} booleans`);
  if (!isBools(v.stated_as_fact, notAdd))
    throw new Error(`judge: "stated_as_fact" must be ${notAdd} booleans`);
  if (typeof v.unmarked_inference !== "boolean")
    throw new Error('judge: "unmarked_inference" must be a boolean');
  return {
    included: v.included,
    stated_as_fact: v.stated_as_fact,
    unmarked_inference: v.unmarked_inference,
  };
}

export function toJudgedChecks(a: JudgeAnswer): JudgedChecks {
  return {
    faithful: a.included.every(Boolean),
    no_invention: !a.stated_as_fact.some(Boolean),
    assumptions: !a.unmarked_inference,
  };
}

/**
 * Runs the judge for one case. One repair retry on an unreadable answer; if it still fails the
 * three judged checks cannot be trusted, so the result is `null` (the caller counts them as failed
 * and records a judge failure).
 */
export async function judgeCase(
  judge: LlmClient,
  c: EvalCase,
  prompt: string,
  signal?: AbortSignal,
): Promise<JudgedChecks | null> {
  const notAdd = c.must_not_add?.length ?? 0;
  const schema = judgeSchema(c.must_include.length, notAdd);
  const messages = judgeMessages(c, prompt);
  let raw = await judge.chat({ messages, schema, signal });
  try {
    return toJudgedChecks(parseJudgeAnswer(raw, c.must_include.length, notAdd));
  } catch {
    raw = await judge.chat({
      messages: [
        ...messages,
        { role: "assistant", content: raw },
        {
          role: "user",
          content:
            "That was not valid. Reply with ONLY the JSON object, with exactly the required number of booleans in each list.",
        },
      ],
      schema,
      signal,
    });
    try {
      return toJudgedChecks(parseJudgeAnswer(raw, c.must_include.length, notAdd));
    } catch {
      return null;
    }
  }
}
