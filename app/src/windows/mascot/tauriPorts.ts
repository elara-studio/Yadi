import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { ControllerPorts } from "./controller";

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
  log: (message) => console.info(`[controller] ${message}`),
};
