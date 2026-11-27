import { describe, expect, it } from "vitest";
import { estimateTokens, tokensSaved } from "./tokens";

describe("estimateTokens (approximate)", () => {
  it("is about one token per four characters, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("x".repeat(400))).toBe(100);
  });
});

describe("tokensSaved", () => {
  it("is the difference when the prompt is shorter", () => {
    expect(tokensSaved(120, 45)).toBe(75);
  });
  it("is never negative", () => {
    expect(tokensSaved(20, 55)).toBe(0);
    expect(tokensSaved(30, 30)).toBe(0);
  });
});
