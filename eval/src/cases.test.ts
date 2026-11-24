import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { holdoutIds, isHoldout, loadCases, parseCases, selectCases } from "./cases";

const file = join(dirname(fileURLToPath(import.meta.url)), "../cases.jsonl");

describe("cases", () => {
  it("loads the real eval set", () => {
    const cases = loadCases(file);
    expect(cases).toHaveLength(42);
    expect(new Set(cases.map((c) => c.id)).size).toBe(42);
    expect(cases.every((c) => c.transcript.length > 0 && c.must_include.length > 0)).toBe(true);
  });

  it("the hold-out set is every 4th case by 1-based position in the file", () => {
    expect(isHoldout(3)).toBe(true); // position 4
    expect(isHoldout(0)).toBe(false);
    expect(isHoldout(7)).toBe(true); // position 8
    const ids = [...holdoutIds(loadCases(file))];
    expect(ids).toEqual([
      "and-04",
      "data-01",
      "wr-02",
      "gen-02",
      "math-01",
      "corr-03",
      "ramble-02",
      "att-02",
      "ml-01",
      "sens-01",
    ]);
  });

  it("selectCases keeps file order, and rejects unknown ids", () => {
    const cases = loadCases(file);
    expect(selectCases(cases, ["gen-02", "and-01"]).map((c) => c.id)).toEqual(["and-01", "gen-02"]);
    expect(selectCases(cases, undefined)).toHaveLength(42);
    expect(selectCases(cases, [])).toHaveLength(42);
    expect(() => selectCases(cases, ["nope"])).toThrow("unknown case id");
  });

  it("parseCases skips blank lines and rejects malformed cases", () => {
    expect(
      parseCases('{"id":"a","category":"c","transcript":"t","must_include":["x"]}\n\n'),
    ).toHaveLength(1);
    expect(() => parseCases('{"id":"a"}')).toThrow("not a valid case");
    expect(() => parseCases("not json")).toThrow();
  });
});
