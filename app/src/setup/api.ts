import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  HardwareProfile,
  HotkeyPermission,
  MicStatus,
  ModelStatus,
  OllamaStatus,
  Progress,
  PullProgress,
  Selection,
} from "./types";

/** Everything the wizard does to the outside world, so screens can be tested with a fake. */
export interface SetupApi {
  /** True for the simulated, development-only setup (`YADI_MOCK_SETUP=1`). */
  readonly mock: boolean;

  getState(): Promise<unknown>;
  saveState(state: unknown): Promise<void>;

  hardware(): Promise<HardwareProfile>;
  selection(): Promise<Selection>;
  listModels(): Promise<ModelStatus[]>;

  ollamaStatus(): Promise<OllamaStatus>;
  ollamaInstall(): Promise<void>;
  ollamaStart(): Promise<void>;
  ollamaHas(tag: string): Promise<boolean>;
  ollamaPull(tag: string): Promise<void>;
  ollamaCancelPull(tag: string): Promise<void>;
  onPullProgress(cb: (p: PullProgress) => void): () => void;

  downloadModel(id: string, force: boolean): Promise<void>;
  cancelDownload(id: string): Promise<void>;
  /** Progress of one download by id (a speech model, or "ollama-installer"). */
  onDownloadProgress(id: string, cb: (p: Progress) => void): () => void;

  micStatus(): Promise<MicStatus>;
  micRequest(): Promise<MicStatus>;

  hotkeyStatus(): Promise<HotkeyPermission>;
  /** Shows the system prompt, then waits up to a minute for the permission to be granted. */
  hotkeyRequest(): Promise<void>;
  /** Switches the summon method to the Cmd/Ctrl+Shift+Y chord. */
  useChordFallback(): Promise<void>;
  /** Switches the summon method to Hold-Y and starts listening for it. */
  useHoldY(): Promise<void>;
  /** Short text for the finished screen, e.g. "Hold the Y key" or "Cmd+Shift+Y". */
  summonDescription(): Promise<string>;

  appVersion(): Promise<string>;
}

function subscribe<T>(event: string, cb: (payload: T) => void): () => void {
  const pending = listen<T>(event, (e) => cb(e.payload));
  return () => void pending.then((unlisten) => unlisten());
}

/** The real implementation: Tauri commands and events. */
export function createTauriSetupApi(): SetupApi {
  return {
    mock: false,
    getState: () => invoke("get_setup_state"),
    saveState: (state) => invoke("save_setup_state", { state }),
    hardware: () => invoke("get_hardware_profile"),
    selection: () => invoke("select_model_tier"),
    listModels: () => invoke("list_models"),

    ollamaStatus: () => invoke("ollama_status"),
    ollamaInstall: async () => void (await invoke("ollama_install", { consent: true })),
    ollamaStart: async () => void (await invoke("ollama_start")),
    ollamaHas: (tag) => invoke("ollama_has", { tag }),
    ollamaPull: (tag) => invoke("ollama_pull", { tag }),
    ollamaCancelPull: (tag) => invoke("ollama_cancel_pull", { tag }),
    onPullProgress: (cb) => subscribe<PullProgress>("ollama:pull", cb),

    downloadModel: (id, force) => invoke("download_model", { id, force }),
    cancelDownload: (id) => invoke("cancel_download", { id }),
    onDownloadProgress: (id, cb) =>
      subscribe<{ id: string; received: number; total: number | null; phase?: string }>(
        "download:progress",
        (p) => {
          if (p.id === id) cb({ received: p.received, total: p.total, phase: p.phase ?? null });
        },
      ),

    micStatus: () => invoke("mic_permission_status"),
    micRequest: () => invoke("mic_request_permission"),

    hotkeyStatus: () => invoke("hotkey_permission_status"),
    hotkeyRequest: async () => void (await invoke("hotkey_request_permission")),
    useChordFallback: async () => {
      const settings = await invoke<{ summon: Record<string, unknown> }>("get_settings");
      await invoke("set_settings", {
        settings: { ...settings, summon: { ...settings.summon, mode: "chord" } },
      });
    },
    useHoldY: async () => {
      const settings = await invoke<{ summon: Record<string, unknown> }>("get_settings");
      await invoke("set_settings", {
        settings: { ...settings, summon: { ...settings.summon, mode: "longpress-y" } },
      });
    },
    summonDescription: async () => {
      const s = await invoke<{ summon: { mode: string; chord: string } }>("get_settings");
      return s.summon.mode === "chord" ? s.summon.chord : "Hold the Y key";
    },

    appVersion: async () => {
      const { getVersion } = await import("@tauri-apps/api/app");
      return getVersion();
    },
  };
}

/** Is the development-only simulated setup switched on? */
export function isMockSetup(): Promise<boolean> {
  return invoke<boolean>("setup_mock_enabled");
}
