export type SummonMode = "longpress-y" | "chord";

/** Mirrors `Settings` in src-tauri/src/settings.rs. */
export interface Settings {
  summon: {
    mode: SummonMode;
    threshold_ms: number;
    chord: string;
  };
  finalPass: {
    enabled: boolean;
    timeout_seconds: number;
  };
}

export const MIN_THRESHOLD_MS = 250;
export const MAX_THRESHOLD_MS = 900;
