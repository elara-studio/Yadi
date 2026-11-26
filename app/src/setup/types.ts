/** Shapes of what the Rust side returns to the wizard (see hardware.rs, tiers.rs, ollama/). */

export type Gpu =
  { kind: "none" } | { kind: "apple-silicon" } | { kind: "nvidia"; vram_bytes: number };

export interface HardwareProfile {
  ram_bytes: number;
  free_disk_bytes: number;
  cpu_cores: number;
  arch: string;
  os: string;
  gpu: Gpu;
}

export interface TierInfo {
  id: string;
  llm_model_id: string;
  llm_tag: string;
  stt_final_model_id: string;
  stt_stream_model_id: string;
  installed_bytes: number;
  disk_needed_bytes: number;
  memory_needed_bytes: number;
}

export type Selection =
  ({ result: "tier" } & TierInfo) | { result: "unsupported"; why: unknown; reason: string };

export type OllamaStatus =
  | { state: "running"; version: string }
  | { state: "installed"; path: string }
  | { state: "missing" };

export interface ModelStatus {
  id: string;
  kind: "stt-stream" | "stt-final" | "llm";
  /** Download size in bytes (archive for speech models, weights for LLMs). */
  size_bytes?: number | null;
  ollama_tag?: string | null;
  installed: boolean;
}

export type MicStatus = "authorized" | "denied" | "not-determined" | "restricted" | "unknown";

export interface HotkeyPermission {
  accessibility: boolean;
  input_monitoring: boolean;
}

/** Progress of something being downloaded. `total` is null while unknown. */
export interface Progress {
  received: number;
  total: number | null;
  /** Work that follows the last byte (the bar is already full): "unpacking", "verifying", ... */
  phase?: string | null;
}

export interface PullProgress {
  status: string;
  completed?: number | null;
  total?: number | null;
}
