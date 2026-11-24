import { describe, expect, it } from "vitest";
import { estimateTokens } from "./tokens";

describe("estimateTokens (approximate)", () => {
  it("is about one token per four characters, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("x".repeat(400))).toBe(100);
  });
});
