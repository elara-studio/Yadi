import { describe, expect, it } from "vitest";
import { stripFillers } from "./stage0";

describe("stripFillers (Stage 0)", () => {
  it.each([
    ["um so I have an app", "so I have an app"],
    ["I have uh a problem", "I have a problem"],
    ["it is, uhm, slow", "it is, slow"],
    ["well er I think so", "well I think so"],
    ["erm that is wrong", "that is wrong"],
    ["hmm let me think", "let me think"],
    ["ummm ok", "ok"],
    ["hmmmm no", "no"],
    ["UM yes UH no", "yes no"],
    ["so, um, anyway", "so, anyway"],
    ["wait, um, no", "wait, no"],
    ["it works... um.", "it works..."],
  ])("%j -> %j", (input, expected) => {
    expect(stripFillers(input)).toBe(expected);
  });

  it("leaves words that merely contain a filler alone", () => {
    const t = "an umbrella after the perm in Hummus Terminal";
    expect(stripFillers(t)).toBe(t);
  });

  it("does not touch hyphenated words or contractions that contain a filler", () => {
    expect(stripFillers("don't use Er-diagrams")).toBe("don't use Er-diagrams");
    expect(stripFillers("an uh-oh moment, a well-um case")).toBe("an uh-oh moment, a well-um case");
    expect(stripFillers("it's um-hum")).toBe("it's um-hum");
  });

  it("collapses whitespace and trims", () => {
    expect(stripFillers("  a   b\n\nc  ")).toBe("a b c");
    expect(stripFillers("")).toBe("");
    expect(stripFillers("   ")).toBe("");
  });

  it("removes only fillers: no other words disappear", () => {
    expect(stripFillers("like you know basically I mean it")).toBe(
      "like you know basically I mean it",
    );
  });

  it("a transcript that is only fillers becomes empty", () => {
    expect(stripFillers("um uh hmm")).toBe("");
  });
});
