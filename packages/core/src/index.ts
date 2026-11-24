export * from "./machine";

export const CORE_VERSION = "0.1.0";

/** Placeholder export so the package has a public surface; real modules arrive in later tasks. */
export function coreVersion(): string {
  return CORE_VERSION;
}
export * from "./transcript";
export * from "./setup";
export * from "./pipeline";
