/** Rough token count (about 4 characters per token). Approximate: for display only. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Approximate tokens Yadi saved: what the recorded message would have cost as it was, minus what
 * the finished prompt costs. Never negative (a prompt longer than the message saved nothing).
 */
export function tokensSaved(tokensIn: number, tokensOut: number): number {
  return Math.max(0, tokensIn - tokensOut);
}
