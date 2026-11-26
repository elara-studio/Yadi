import type { SetupApi } from "./api";
import type {
  HotkeyPermission,
  MicStatus,
  ModelStatus,
  OllamaStatus,
  Progress,
  PullProgress,
  Selection,
} from "./types";

export interface MockOptions {
  /** Pause between simulated progress ticks. 0 makes everything instant (tests). */
  delayMs?: number;
  /** The saved wizard state to start from (resume). */
  state?: unknown;
  os?: string;
  /** Make a named operation fail once, to see the error screen. */
  failOnce?: "ollamaInstall" | "ollamaPull" | "downloadModel";
}

const TIER = {
  result: "tier" as const,
  id: "mid",
  llm_model_id: "llm-qwen3-4b-instruct-2507",
  llm_tag: "qwen3:4b-instruct-2507-q4_K_M",
  stt_final_model_id: "stt-final-whisper-base-en",
  stt_stream_model_id: "stt-stream-zipformer-en-2023-06-26",
  installed_bytes: 3_286_125_063,
  disk_needed_bytes: 4_929_187_595,
  memory_needed_bytes: 3_571_035_140,
};

/**
 * A simulated setup (development flag `YADI_MOCK_SETUP=1`, and tests): nothing is downloaded or
 * installed, permissions are granted when asked, and progress is faked.
 */
export function createMockSetupApi(options: MockOptions = {}): SetupApi {
  const delay = options.delayMs ?? 250;
  const os = options.os ?? "macos";
  const sleep = (ms: number) =>
    ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve();
  let saved: unknown = options.state ?? null;
  let ollama: OllamaStatus = { state: "missing" };
  const hasTags = new Set<string>();
  const installed = new Set<string>();
  let mic: MicStatus = "not-determined";
  let hotkey: HotkeyPermission = { accessibility: false, input_monitoring: false };
  let chord = false;
  let failOnce = options.failOnce;
  const cancelled = new Set<string>();
  const pullListeners = new Set<(p: PullProgress) => void>();
  const dlListeners = new Map<string, Set<(p: Progress) => void>>();

  const failIfScheduled = (what: NonNullable<MockOptions["failOnce"]>) => {
    if (failOnce === what) {
      failOnce = undefined;
      throw new Error(`Simulated network failure while doing ${what}. (Mock setup.)`);
    }
  };

  async function simulate(id: string, total: number, emit: (received: number) => void) {
    cancelled.delete(id);
    for (let i = 1; i <= 8; i++) {
      await sleep(delay);
      if (cancelled.has(id)) throw new Error("The download was cancelled.");
      emit(Math.round((total * i) / 8));
    }
  }
  const emitDownload = (id: string, total: number) => (received: number) =>
    dlListeners.get(id)?.forEach((cb) => cb({ received, total }));
  /** The work after the last byte, as the real backend reports it. */
  const emitPhase = async (id: string, phase: string) => {
    dlListeners.get(id)?.forEach((cb) => cb({ received: 0, total: null, phase }));
    await sleep(delay * 4);
  };

  return {
    mock: true,
    getState: async () => saved,
    saveState: async (s) => void (saved = JSON.parse(JSON.stringify(s))),
    hardware: async () => ({
      ram_bytes: 18 * 1024 ** 3,
      free_disk_bytes: 40_000_000_000,
      cpu_cores: 8,
      arch: os === "macos" ? "aarch64" : "x86_64",
      os,
      gpu: os === "macos" ? { kind: "apple-silicon" } : { kind: "none" },
    }),
    selection: async (): Promise<Selection> => ({ ...TIER }),
    listModels: async (): Promise<ModelStatus[]> => [
      {
        id: TIER.stt_stream_model_id,
        kind: "stt-stream",
        size_bytes: 310_414_022,
        installed: installed.has(TIER.stt_stream_model_id),
      },
      {
        id: TIER.stt_final_model_id,
        kind: "stt-final",
        size_bytes: 208_576_005,
        installed: installed.has(TIER.stt_final_model_id),
      },
      {
        id: TIER.llm_model_id,
        kind: "llm",
        size_bytes: 2_497_293_316,
        ollama_tag: TIER.llm_tag,
        installed: false,
      },
    ],

    ollamaStatus: async () => ollama,
    ollamaInstall: async () => {
      failIfScheduled("ollamaInstall");
      await simulate(
        "ollama-installer",
        180_000_000,
        emitDownload("ollama-installer", 180_000_000),
      );
      for (const phase of ["unpacking", "verifying", "installing"]) {
        await emitPhase("ollama-installer", phase);
      }
      ollama = { state: "installed", path: "/Applications/Ollama.app" };
    },
    ollamaStart: async () => {
      await sleep(delay);
      ollama = { state: "running", version: "0.0.0-mock" };
    },
    ollamaHas: async (tag) => hasTags.has(tag),
    ollamaPull: async (tag) => {
      failIfScheduled("ollamaPull");
      const total = 2_497_293_316;
      await simulate(`pull:${tag}`, total, (received) =>
        pullListeners.forEach((cb) => cb({ status: "pulling model", completed: received, total })),
      );
      pullListeners.forEach((cb) => cb({ status: "success" }));
      hasTags.add(tag);
    },
    ollamaCancelPull: async (tag) => void cancelled.add(`pull:${tag}`),
    onPullProgress: (cb) => {
      pullListeners.add(cb);
      return () => void pullListeners.delete(cb);
    },

    downloadModel: async (id) => {
      failIfScheduled("downloadModel");
      const total = id.includes("whisper") ? 208_576_005 : 310_414_022;
      await simulate(id, total, emitDownload(id, total));
      await emitPhase(id, "unpacking");
      installed.add(id);
    },
    cancelDownload: async (id) => void cancelled.add(id),
    onDownloadProgress: (id, cb) => {
      const set = dlListeners.get(id) ?? new Set();
      set.add(cb);
      dlListeners.set(id, set);
      return () => void set.delete(cb);
    },

    micStatus: async () => mic,
    micRequest: async () => {
      await sleep(delay);
      mic = "authorized";
      return mic;
    },

    hotkeyStatus: async () => hotkey,
    hotkeyRequest: async () => {
      await sleep(delay);
      hotkey = { accessibility: true, input_monitoring: true };
    },
    useChordFallback: async () => void (chord = true),
    summonDescription: async () =>
      chord ? (os === "macos" ? "Cmd+Shift+Y" : "Ctrl+Shift+Y") : "Hold the Y key",

    appVersion: async () => "0.1.0-mock",
  };
}
