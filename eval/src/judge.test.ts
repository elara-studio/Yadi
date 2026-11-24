import { FakeLlmClient } from "@yadi/core";
import { describe, expect, it } from "vitest";
import type { EvalCase } from "./cases";
import { judgeCase, judgeMessages, judgeSchema, parseJudgeAnswer, toJudgedChecks } from "./judge";

const c: EvalCase = {
  id: "t",
  category: "x",
  transcript: "fix the lag in my android app, maybe glide",
  must_include: ["Android", "lag", "Glide (unsure)"],
  must_not_add: ["Kotlin", "Android 14"],
};
const ok = (over: object = {}) =>
  JSON.stringify({
    included: [true, true, true],
    stated_as_fact: [false, false],
    unmarked_inference: false,
    ...over,
  });

describe("judge", () => {
  it("builds a strict prompt with both numbered lists and the schema sizes", () => {
    const m = judgeMessages(c, "Task: fix the lag");
    expect(m[0]?.content).toMatch(/strict, literal grader/);
    expect(m[1]?.content).toContain("1. Android");
    expect(m[1]?.content).toContain("2. Android 14");
    expect(m[1]?.content).toContain("Task: fix the lag");
    const schema = judgeSchema(3, 2) as {
      properties: { included: { minItems: number }; stated_as_fact: { maxItems: number } };
    };
    expect(schema.properties.included.minItems).toBe(3);
    expect(schema.properties.stated_as_fact.maxItems).toBe(2);
  });

  it("a case with no must_not_add shows '(none)' and expects an empty list", () => {
    const m = judgeMessages({ ...c, must_not_add: undefined }, "p");
    expect(m[1]?.content).toContain("(none)");
  });

  it("turns an answer into the three judged checks", () => {
    expect(toJudgedChecks(parseJudgeAnswer(ok(), 3, 2))).toEqual({
      faithful: true,
      no_invention: true,
      assumptions: true,
    });
    expect(
      toJudgedChecks(parseJudgeAnswer(ok({ included: [true, false, true] }), 3, 2)).faithful,
    ).toBe(false);
    expect(
      toJudgedChecks(parseJudgeAnswer(ok({ stated_as_fact: [false, true] }), 3, 2)).no_invention,
    ).toBe(false);
    expect(
      toJudgedChecks(parseJudgeAnswer(ok({ unmarked_inference: true }), 3, 2)).assumptions,
    ).toBe(false);
  });

  it("rejects answers with the wrong number or kind of values", () => {
    for (const bad of [
      ok({ included: [true] }),
      ok({ stated_as_fact: [] }),
      ok({ unmarked_inference: "no" }),
      ok({ included: ["yes", "yes", "yes"] }),
      "{}",
      "garbage",
    ]) {
      expect(() => parseJudgeAnswer(bad, 3, 2), bad).toThrow();
    }
  });

  it("judgeCase uses one call when the answer is fine", async () => {
    const llm = new FakeLlmClient([ok()]);
    expect(await judgeCase(llm, c, "p")).toEqual({
      faithful: true,
      no_invention: true,
      assumptions: true,
    });
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.schema).toBeDefined();
  });

  it("judgeCase retries once with a repair message and then trusts the answer", async () => {
    const llm = new FakeLlmClient(["not json", ok({ unmarked_inference: true })]);
    expect(await judgeCase(llm, c, "p")).toMatchObject({ assumptions: false });
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]?.messages.at(-1)?.content).toMatch(/not valid/);
  });

  it("judgeCase gives null when the judge cannot be read twice", async () => {
    expect(await judgeCase(new FakeLlmClient(["x", "y"]), c, "p")).toBeNull();
  });
});
