/** Rough token count (about 4 characters per token). Approximate: for display only. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
