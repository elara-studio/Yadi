import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { ControllerPorts } from "./controller";

export const tauriPorts: ControllerPorts = {
  showChat: () => invoke("show_chat"),
  hideChat: () => invoke("hide_chat"),
  focusChat: () => invoke("focus_chat"),
  broadcast: (payload) => emit("app:state", payload),
  showView: (view) => emit("app:view", { view }),
  log: (message) => console.info(`[controller] ${message}`),
};
