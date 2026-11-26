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
  /** `device: null` = the system default microphone. */
  microphone: { device: string | null };
  /** `model_id: null` = the model Yadi picks for this computer. */
  llm: { model_id: string | null };
  /** `animations: false` = the mascot stands still. Missing in older data = on. */
  appearance?: { animations: boolean };
}

/** One entry of the microphone list (`audio_list_devices`). */
export interface InputDevice {
  name: string;
  is_default: boolean;
}

/** One language model Settings offers (`llm_options_list`). */
export interface LlmOption {
  id: string;
  tag: string;
  size_bytes: number;
  memory_needed_bytes: number;
  recommended: boolean;
  fits: boolean;
  warning: string | null;
  tested: boolean;
}

export const MIN_THRESHOLD_MS = 250;
export const MAX_THRESHOLD_MS = 900;
