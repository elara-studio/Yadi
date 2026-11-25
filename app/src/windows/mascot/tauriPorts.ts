import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { OLLAMA_BASE, OllamaClient, runPipeline } from "@yadi/core";
import type { Selection } from "../../setup/types";
import type { ControllerPorts } from "./controller";

/** The language model chosen for this machine (the hardware tier's model). */
async function llmTag(): Promise<string> {
  const selection = await invoke<Selection>("select_model_tier");
  if (selection.result !== "tier") throw new Error("This computer cannot run the language model.");
  return selection.llm_tag;
}

export const tauriPorts: ControllerPorts = {
  showChat: () => invoke("show_chat"),
  hideChat: () => invoke("hide_chat"),
  focusChat: () => invoke("focus_chat"),
  broadcast: (payload) => emit("app:state", payload),
  startAudio: () => invoke("audio_start"),
  stopAudio: () => invoke("audio_stop"),
  clearAudio: () => invoke("audio_clear"),
  startStt: () => invoke("stt_start"),
  stopStt: () => invoke("stt_stop"),
  broadcastTranscript: (snapshot) => emit("app:transcript", snapshot),
  runFinalPass: () => invoke("final_pass_run"),
  showNotice: (message) => emit("app:notice", { message, action: null }),
  broadcastProgress: (progress) => emit("app:progress", progress),
  showView: (view) => emit("app:view", { view }),
  runPipeline: async (options) => {
    const llm = new OllamaClient({ model: await llmTag(), fetch: tauriFetch as typeof fetch });
    // The user's own words, as preferred spellings (the pipeline trims and caps them at 100).
    const vocabulary = await invoke<string[]>("get_vocabulary").catch(() => [] as string[]);
    return runPipeline({ vocabulary, ...options, llm });
  },
  startOllama: async () => void (await invoke("ollama_start")),
  warmModel: async () => {
    // An empty request makes Ollama load the model and keep it for 10 minutes.
    const status = await invoke<{ state: string }>("ollama_status");
    if (status.state !== "running") return;
    const model = await llmTag();
    await tauriFetch(`${OLLAMA_BASE}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, keep_alive: "10m" }),
    });
  },
  broadcastResult: (result) => emit("app:result", result),
  broadcastError: (error) => emit("app:error", error),
  clearAttachments: () => emit("app:attachments-clear"),
  log: (message) => console.info(`[controller] ${message}`),
};
