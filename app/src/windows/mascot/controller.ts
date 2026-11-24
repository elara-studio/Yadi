import {
  type AppEvent,
  type AppState,
  type Effect,
  type Model,
  initialModel,
  transition,
} from "@yadi/core";
import type { MascotState } from "../../components/Mascot";

/** Payload of the `app:state` event (Controller -> chat window). */
export interface AppStatePayload {
  state: AppState;
  editing: boolean;
}

/** Everything the Controller needs from the outside world, injected so it is testable. */
export type ChatView = "chat" | "about";

export interface ControllerPorts {
  showChat(): void | Promise<void>;
  hideChat(): void | Promise<void>;
  focusChat(): void | Promise<void>;
  broadcast(payload: AppStatePayload): void | Promise<void>;
  /** Tells the chat window which screen to show (`app:view`). */
  showView(view: ChatView): void | Promise<void>;
  /** Diagnostics only. Never pass transcripts, audio or prompts here. */
  log(message: string): void;
}

const EVENT_TYPES: ReadonlySet<string> = new Set([
  "SUMMON",
  "KEY_Y",
  "KEY_ESC",
  "EDIT_START",
  "EDIT_END",
  "SETUP_DONE",
  "TRANSCRIPT_CHANGED",
  "PROCESS_DONE",
  "PROCESS_FAILED",
  "RECORD_FAILED",
  "NEW_SESSION",
]);

/** Mascot animation for each app state. */
export function mascotStateFor(model: Model): MascotState {
  switch (model.state) {
    case "recording":
      return "listening";
    case "processing":
      return "thinking";
    case "result":
      return "done";
    default:
      return "idle";
  }
}

function sameModel(a: Model, b: Model): boolean {
  return a.state === b.state && a.editing === b.editing && a.hasTranscript === b.hasTranscript;
}

export type Listener = (model: Model) => void;

/**
 * Owns the app state machine in the mascot window (the window that is always visible, so its
 * webview is never throttled). Applies events through the reducer, runs the resulting effects
 * and broadcasts `app:state`.
 *
 * Recording/processing effects are stubs until Tasks 10 and 19: they only log the effect name.
 */
export class Controller {
  private current: Model;
  private listeners = new Set<Listener>();

  /**
   * Starts in `minimized` (mascot visible, chat hidden). Task 15 will start in `setup` until
   * the first-run wizard has finished.
   */
  constructor(
    private readonly ports: ControllerPorts,
    initial: Model = { ...initialModel, state: "minimized" },
  ) {
    this.current = initial;
  }

  get model(): Model {
    return this.current;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispatch(event: AppEvent): void {
    const { model, effects } = transition(this.current, event);
    const changed = !sameModel(model, this.current);
    this.current = model;
    if (changed) {
      this.broadcast();
      this.listeners.forEach((l) => l(model));
    }
    effects.forEach((effect) => this.run(effect));
  }

  /** Handles a payload received on `app:event` from the chat window. Unknown input is ignored. */
  handleAppEvent(payload: unknown): void {
    if (typeof payload !== "object" || payload === null) return;
    const type = (payload as { type?: unknown }).type;
    if (typeof type !== "string") return;
    if (type === "SYNC") {
      // The chat window just loaded and wants the current state.
      this.broadcast();
      return;
    }
    if (!EVENT_TYPES.has(type)) {
      this.ports.log(`ignored unknown app:event "${type}"`);
      return;
    }
    this.dispatch(payload as AppEvent);
  }

  /** Mascot click / tray "Show / Hide": open the chat, or stop what is running and hide it. */
  toggleChat(): void {
    if (this.isMinimized()) {
      this.dispatch({ type: "SUMMON" });
      return;
    }
    // Esc semantics (D8): a first Esc may only cancel an edit or stop recording; keep going
    // until the chat is hidden. Bounded so it can never loop.
    for (let i = 0; i < 3 && !this.isMinimized(); i++) {
      this.dispatch({ type: "KEY_ESC" });
    }
  }

  /** Tray "About": open the chat if hidden and switch it to the About screen. */
  openAbout(): void {
    this.dispatch({ type: "SUMMON" });
    void this.ports.showView("about");
  }

  private isMinimized(): boolean {
    return this.current.state === "minimized";
  }

  private broadcast(): void {
    const { state, editing } = this.current;
    void this.ports.broadcast({ state, editing });
  }

  private run(effect: Effect): void {
    switch (effect.type) {
      case "showChat":
        void this.ports.showChat();
        break;
      case "hideChat":
        void this.ports.hideChat();
        break;
      case "focusChat":
        void this.ports.focusChat();
        break;
      default:
        // startRecording, stopRecording, startProcessing, cancelProcessing, clearSession,
        // notify: stubs until later tasks. Log the effect name only, never its content.
        this.ports.log(`effect (stub): ${effect.type}`);
    }
  }
}
