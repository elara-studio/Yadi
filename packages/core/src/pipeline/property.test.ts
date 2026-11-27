import { describe, expect, it } from "vitest";
import { renderPrompt, tidyItem } from "./render";
import type { Analysis } from "./types";
import { normalizeForMatch, validateAnalysis } from "./validate";

/** Small seeded generator so the property test is repeatable. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS =
  "app list slow fast filter React Python query table image login screen crash user report email draft summary team budget week Monday error build deploy test cache index memory server cloud design chart".split(
    " ",
  );

describe("property: nothing unbacked reaches the rendered prompt", () => {
  it("every context and constraint line in the prompt is backed by evidence from the transcript (500 random runs)", () => {
    for (let run = 0; run < 500; run++) {
      const r = rng(run + 1);
      const pick = () => WORDS[Math.floor(r() * WORDS.length)] as string;
      const sentence = () => Array.from({ length: 3 + Math.floor(r() * 6) }, pick).join(" ");
      const number = () => String(Math.floor(r() * 5000));

      // a transcript with a few digits
      const transcript = `${sentence()} ${number()} ${sentence()}. ${sentence()}.`;
      const words = transcript.split(" ");
      const realQuote = () => {
        const start = Math.floor(r() * (words.length - 2));
        return words.slice(start, start + 2 + Math.floor(r() * 3)).join(" ");
      };
      const item = () => {
        const kind = r();
        const text = kind < 0.25 ? `${sentence()} ${number()}` : sentence();
        const evidence = kind < 0.4 ? sentence() /* made up */ : kind < 0.5 ? "" : realQuote();
        return { text, evidence };
      };

      const analysis: Analysis = {
        task_type: "other",
        task: sentence(),
        role:
          r() < 0.6 ? { value: sentence(), evidence: r() < 0.5 ? realQuote() : sentence() } : null,
        context: Array.from({ length: Math.floor(r() * 5) }, item),
        constraints: Array.from({ length: Math.floor(r() * 4) }, item),
        output_format: r() < 0.5 ? item() : null,
        missing_info: Array.from({ length: Math.floor(r() * 5) }, sentence),
      };

      const { analysis: valid } = validateAnalysis(analysis, {
        transcript,
        stage0: transcript,
        clean: transcript,
      });
      const prompt = renderPrompt(valid);

      // Collect every bullet from the Context and Constraints sections of the prompt.
      const bullets: { section: "Context" | "Constraints"; text: string }[] = [];
      let section: "Context" | "Constraints" | null = null;
      for (const line of prompt.split("\n")) {
        if (line === "Context:") section = "Context";
        else if (line === "Constraints:") section = "Constraints";
        else if (!line.startsWith("- ")) section = null;
        else if (section) bullets.push({ section, text: line.slice(2) });
      }

      const source = normalizeForMatch(transcript);
      const original = { Context: analysis.context, Constraints: analysis.constraints };
      for (const b of bullets) {
        const backing = original[b.section].filter((i) => tidyItem(i.text) === b.text);
        expect(backing.length, `run ${run}: "${b.text}" has no source item`).toBeGreaterThan(0);
        // at least one source item with that text carries real evidence
        const proven = backing.some((i) => {
          const e = normalizeForMatch(i.evidence);
          return e !== "" && source.includes(e);
        });
        expect(proven, `run ${run}: "${b.text}" is not backed by evidence`).toBe(true);
        // and its numbers are all in the transcript
        for (const n of b.text.match(/\d+/g) ?? [])
          expect(transcript, `run ${run}: invented ${n}`).toContain(n);
      }

      // the role line only appears with proven evidence
      if (prompt.startsWith("Role: ")) {
        const e = normalizeForMatch(analysis.role?.evidence ?? "");
        expect(e !== "" && source.includes(e), `run ${run}: unproven role`).toBe(true);
      }
    }
  });
});
