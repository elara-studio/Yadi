import { CLARIFY_LINE, FakeLlmClient } from "@yadi/core";
import { describe, expect, it } from "vitest";
import type { EvalCase } from "./cases";
import { runEval } from "./runEval";

const simple: EvalCase = {
  id: "s-01",
  category: "demo",
  transcript:
    "um so my react app is slow when I filter a list of 5000 items and I want a short answer",
  must_include: ["React", "5000 items"],
  must_not_add: ["Redux"],
};
const withAttachment: EvalCase = {
  ...simple,
  id: "s-02",
  transcript: "summarise the attached resume in three bullets",
  must_include: ["resume", "three bullets"],
  attachment: "resume",
};

const CLEAN = "My React app is slow when I filter a list of 5000 items. I want a short answer.";
const normalize = JSON.stringify({ clean_text: CLEAN });
const analysis = JSON.stringify({
  task_type: "coding",
  task: "Speed up the filtered list.",
  role: { value: "React developer", evidence: "My React app" },
  context: [{ text: "The list has 5000 items", evidence: "list of 5000 items" }],
  constraints: [{ text: "A short answer", evidence: "short answer" }],
  output_format: null,
  missing_info: [],
});
const judgeOk = JSON.stringify({
  included: [true, true],
  stated_as_fact: [false],
  unmarked_inference: false,
});

describe("runEval", () => {
  it("scores a clean run with a fake model and a fake judge", async () => {
    const llm = new FakeLlmClient([normalize, analysis]);
    const judge = new FakeLlmClient([judgeOk]);
    const seen: string[] = [];
    let t = 0;
    const results = await runEval({
      cases: [simple],
      holdout: new Set(),
      llm,
      judge,
      now: () => (t += 250),
      onCase: (r, i, n) => seen.push(`${r.id} ${i + 1}/${n}`),
    });
    const r = results[0]!;
    expect(r.id).toBe("s-01");
    expect(r.checks).toMatchObject({
      faithful: true,
      no_invention: true,
      assumptions: true,
      retractions: true,
      clarify: true,
      template: true,
    });
    expect(r.failed).toEqual(["concise"].filter(() => !r.checks.concise));
    expect(r.latency_ms).toBe(250);
    expect(r.degraded).toBe(false);
    expect(r.prompt).toContain(CLARIFY_LINE);
    expect(seen).toEqual(["s-01 1/1"]);
  });

  it("a hallucinating prompt gets a lower score because the judge says it stated a forbidden fact", async () => {
    const good = await runEval({
      cases: [simple],
      holdout: new Set(),
      llm: new FakeLlmClient([normalize, analysis]),
      judge: new FakeLlmClient([judgeOk]),
    });
    const hallucinated = JSON.stringify({
      included: [true, true],
      stated_as_fact: [true],
      unmarked_inference: true,
    });
    const bad = await runEval({
      cases: [simple],
      holdout: new Set(),
      llm: new FakeLlmClient([normalize, analysis]),
      judge: new FakeLlmClient([hallucinated]),
    });
    expect(bad[0]!.score).toBeLessThan(good[0]!.score);
    expect(bad[0]!.failed).toEqual(expect.arrayContaining(["no_invention", "assumptions"]));
  });

  it("an unreadable judge fails the three judged checks and is recorded", async () => {
    const r = (
      await runEval({
        cases: [simple],
        holdout: new Set(),
        llm: new FakeLlmClient([normalize, analysis]),
        judge: new FakeLlmClient(["x", "y"]),
      })
    )[0]!;
    expect(r.judge_failed).toBe(true);
    expect(r.failed).toEqual(expect.arrayContaining(["faithful", "no_invention", "assumptions"]));
  });

  it("a degraded pipeline run is scored and flagged", async () => {
    const r = (
      await runEval({
        cases: [simple],
        holdout: new Set(),
        llm: new FakeLlmClient(["bad", "bad"]),
        judge: new FakeLlmClient([judgeOk]),
      })
    )[0]!;
    expect(r.degraded).toBe(true);
    expect(r.prompt).toContain("Task: ");
  });

  it("attachment cases pass attachment metadata to the pipeline, and the prompt lists it", async () => {
    const llm = new FakeLlmClient([
      JSON.stringify({ clean_text: "Summarise the attached resume in three bullets." }),
      analysis,
    ]);
    const r = (
      await runEval({
        cases: [withAttachment],
        holdout: new Set(),
        llm,
        judge: new FakeLlmClient([judgeOk]),
      })
    )[0]!;
    expect(llm.requests[1]?.messages.at(-1)?.content).toContain("resume (attachment)");
    expect(r.prompt).toContain("- [Attached: resume (attachment)]");
  });

  it("marks hold-out cases", async () => {
    const results = await runEval({
      cases: [simple, { ...simple, id: "s-09" }],
      holdout: new Set(["s-09"]),
      llm: new FakeLlmClient([normalize, analysis, normalize, analysis]),
      judge: new FakeLlmClient([judgeOk, judgeOk]),
    });
    expect(results.map((r) => r.holdout)).toEqual([false, true]);
  });

  it("an unreachable model stops the whole run", async () => {
    const { LlmError } = await import("@yadi/core");
    await expect(
      runEval({
        cases: [simple],
        holdout: new Set(),
        llm: new FakeLlmClient([new LlmError("Cannot reach Ollama")]),
        judge: new FakeLlmClient([]),
      }),
    ).rejects.toThrow("Cannot reach Ollama");
  });
});
