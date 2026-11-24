import {
  type AppEvent,
  type AppState,
  type Effect,
  type Model,
  Transcript,
  type TranscriptSnapshot,
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
/** What `final_pass_run` returns: `text` replaces the live transcript when present. */
export interface FinalPassOutcome {
  text: string | null;
  notice: string | null;
}

/** Payload of `app:progress`. `done`/`total` count chunks of the stage; 0/0 = not known yet. */
export interface ProgressPayload {
  stage: "transcribing";
  done: number;
  total: number;
}

export type ChatView = "chat" | "about" | "settings";

export interface ControllerPorts {
  showChat(): void | Promise<void>;
  hideChat(): void | Promise<void>;
  focusChat(): void | Promise<void>;
  broadcast(payload: AppStatePayload): void | Promise<void>;
  /** Starts the microphone (Rust `audio_start`). Rejects with a typed audio error. */
  startAudio(): void | Promise<void>;
  /** Stops the microphone; the recording stays in memory. */
  stopAudio(): void | Promise<void>;
  /** Frees the in-memory recording. */
  clearAudio(): void | Promise<void>;
  /** Starts speech recognition on the running recording (Rust `stt_start`). */
  startStt(): void | Promise<void>;
  /** Flushes and stops speech recognition (the last words arrive as a final segment). */
  stopStt(): void | Promise<void>;
  /** Re-transcribes the whole recording with the accurate model (Rust `final_pass_run`). */
  runFinalPass(): Promise<FinalPassOutcome> | FinalPassOutcome;
  /** Shows a short message in the chat window (`app:notice`). */
  showNotice(message: string): void | Promise<void>;
  /** Tells the chat window which processing stage is running (`app:progress`); null = none. */
  broadcastProgress(progress: ProgressPayload | null): void | Promise<void>;
  /** Sends the transcript to the chat window (`app:transcript`). */
  broadcastTranscript(snapshot: TranscriptSnapshot): void | Promise<void>;
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

function textOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const text = (payload as { text?: unknown }).text;
  return typeof text === "string" ? text : null;
}

/** Typed audio errors arrive as `{kind, message}`; anything else is shown as text. */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (typeof e === "object" && e !== null && "message" in e && typeof e.message === "string") {
    return e.message;
  }
  return "Recording failed";
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
  private readonly transcript = new Transcript();
  /** Resolves when the most recent recording has fully stopped and its last words have arrived. */
  private settled: Promise<void> = Promise.resolve();
  /** Bumped when processing starts and when it is cancelled, so late results can be ignored. */
  private processingRun = 0;

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
      void this.ports.broadcastTranscript(this.transcript.snapshot());
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

  /** Microphone first, then speech recognition. A failure of either ends the recording. */
  private startRecording(): void {
    void (async () => {
      try {
        await this.ports.startAudio();
        await this.ports.startStt();
      } catch (e) {
        this.dispatch({ type: "RECORD_FAILED", message: errorMessage(e) });
      }
    })();
  }

  /** Stops the microphone first (so the audio tail is complete), then flushes speech recognition. */
  private stopRecording(): void {
    this.settled = this.settled.then(async () => {
      await this.guard(this.ports.stopAudio());
      await this.guard(this.ports.stopStt());
    });
  }

  /**
   * Resolves once the latest recording has stopped and the recogniser's flush has been requested.
   * The processing pipeline (Task 19) waits for this so the transcript is complete.
   */
  whenSettled(): Promise<void> {
    return this.settled;
  }

  /**
   * Processing, stage 1: wait for the recording to settle, then re-transcribe it with the accurate
   * model and swap the transcript in one step. If that fails or is disabled the live transcript
   * stays. The prompt pipeline (Task 19) continues from here.
   */
  private startProcessing(): void {
    const run = ++this.processingRun;
    void (async () => {
      await this.settled;
      if (run !== this.processingRun) return; // cancelled before the pass began: audio is kept
      const coveredSegments = this.transcript.segmentCount();
      void this.ports.broadcastProgress({ stage: "transcribing", done: 0, total: 0 });
      let outcome: FinalPassOutcome;
      try {
        outcome = await this.ports.runFinalPass();
      } catch {
        outcome = {
          text: null,
          notice: "Polishing the transcript failed, so the live transcript was kept.",
        };
      }
      // Rust empties the recording buffer whatever happened, so that audio is gone either way.
      if (outcome.text !== null && run === this.processingRun) {
        this.transcript.replaceRecordedAudio(outcome.text);
      }
      this.transcript.markAudioFreed(
        outcome.text !== null && run === this.processingRun
          ? this.transcript.segmentCount()
          : coveredSegments,
      );
      void this.ports.broadcastTranscript(this.transcript.snapshot());
      if (outcome.notice) void this.ports.showNotice(outcome.notice);
      if (run !== this.processingRun) return; // cancelled while the pass ran
      void this.ports.broadcastProgress(null);
      this.ports.log("processing pipeline is not implemented yet (Task 19)");
    })();
  }

  /** `stt:final-progress {done, total}` from Rust while the final pass runs. */
  handleFinalProgress(payload: unknown): void {
    if (typeof payload !== "object" || payload === null) return;
    const { done, total } = payload as { done?: unknown; total?: unknown };
    if (typeof done !== "number" || typeof total !== "number") return;
    if (this.current.state !== "processing") return;
    void this.ports.broadcastProgress({ stage: "transcribing", done, total });
  }

  /** `stt:partial {text}` from Rust. */
  handleSttPartial(payload: unknown): void {
    const text = textOf(payload);
    if (text === null) return;
    this.transcript.applyPartial(text);
    this.transcriptChanged();
  }

  /** `stt:final {id, text}` from Rust. */
  handleSttFinal(payload: unknown): void {
    if (typeof payload !== "object" || payload === null) return;
    const { id, text } = payload as { id?: unknown; text?: unknown };
    if (typeof id !== "number" || typeof text !== "string") return;
    this.transcript.applyFinal(id, text);
    this.transcriptChanged();
  }

  private transcriptChanged(): void {
    void this.ports.broadcastTranscript(this.transcript.snapshot());
    this.dispatch({ type: "TRANSCRIPT_CHANGED", hasTranscript: this.transcript.hasContent() });
  }

  private async guard(work: void | Promise<void>): Promise<void> {
    try {
      await work;
    } catch (e) {
      this.ports.log(`audio command failed: ${errorMessage(e)}`);
    }
  }

  /** `audio:error` from Rust (device unplugged, probable permission problem...). */
  handleAudioError(payload: unknown): void {
    this.dispatch({ type: "RECORD_FAILED", message: errorMessage(payload) });
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
      case "startRecording":
        this.transcript.beginRecording();
        this.startRecording();
        break;
      case "startProcessing":
        this.startProcessing();
        break;
      case "cancelProcessing":
        this.processingRun++;
        void this.ports.broadcastProgress(null);
        break;
      case "notify":
        void this.ports.showNotice(effect.message);
        break;
      case "stopRecording":
        this.stopRecording();
        break;
      case "clearSession":
        this.transcript.clear();
        void this.ports.broadcastTranscript(this.transcript.snapshot());
        void this.guard(this.ports.clearAudio());
        break;
    }
  }
}
