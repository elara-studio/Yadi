import {
  type AppEvent,
  type AppState,
  type Attachment,
  type Effect,
  EmptyTranscriptError,
  LlmError,
  type Model,
  type PipelineResult,
  type RunOptions,
  type StageName,
  Transcript,
  type TranscriptSnapshot,
  estimateTokens,
  initialModel,
  tokensSaved,
  parseAttachmentMeta,
  redactForLog,
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

/** The stages shown while processing, in order. */
export const PROCESS_STAGES = ["transcribing", "cleaning", "analysing", "writing"] as const;
export type ProcessStage = (typeof PROCESS_STAGES)[number];

/**
 * Payload of `app:progress`. `done`/`total` count chunks of the transcribing stage; 0/0 = not
 * known yet. `clean` is the cleaned-up transcript, sent once the "cleaning" stage has finished.
 */
export interface ProgressPayload {
  stage: ProcessStage;
  done: number;
  total: number;
  clean?: string;
}

/** One finished prompt kept in memory (never written anywhere). */
export interface RecentItem {
  prompt: string;
  at: number;
}

/** Payload of `app:result`: the finished prompt and what the result view shows around it. */
export interface ResultPayload {
  /** Different for every prompt made; the same when a result is only sent again (SYNC). */
  id: number;
  prompt: string;
  /** The model's answers could not be used, so this is a minimal prompt. */
  degraded: boolean;
  /** Approximate token counts (chars / 4): the recorded message as it was, and the prompt. */
  tokensIn: number;
  tokensOut: number;
  /** Approximate tokens saved by sending the prompt instead of the message; 0 when none. */
  tokensSaved: number;
  /** The last 10 prompts of this run of the app, newest first (includes this one). */
  recent: RecentItem[];
}

export type ProcessErrorKind = "unreachable" | "model-missing" | "timeout" | "empty" | "failed";

/** Payload of `app:error`: why processing failed, for the Retry panel. */
export interface ProcessErrorPayload {
  kind: ProcessErrorKind;
  message: string;
}

/** What the pipeline port receives (the port adds the language-model client). */
export type PipelineRunOptions = Omit<RunOptions, "llm">;

/** How long one prompt may take before it is cancelled (plan Task 19: 120 s). */
export const PROCESS_TIMEOUT_MS = 120_000;
export const RECENT_LIMIT = 10;

/** Edits the chat window sends to the Controller (the transcript lives here). */
export type TranscriptEditEvent =
  | { type: "TRANSCRIPT_SET_TEXT"; text: string }
  | { type: "TRANSCRIPT_REPLACE_WORD"; segmentId: number; wordIndex: number; text: string };

export type ChatView = "chat" | "about" | "settings";

/** The chat window says whether Settings is on screen (payload: boolean). */
export const SETTINGS_OPEN_EVENT = "app:settings-open";

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
  /** Runs the prompt pipeline with the language model chosen for this machine. */
  runPipeline(options: PipelineRunOptions): Promise<PipelineResult>;
  /** Starts Ollama if it is installed but not running. Rejects when it cannot. */
  startOllama(): Promise<void>;
  /** Loads the language model into memory in the background. Failures are ignored. */
  warmModel(): Promise<void>;
  /** Sends the finished prompt to the chat window (`app:result`); null clears it. */
  broadcastResult(result: ResultPayload | null): void | Promise<void>;
  /** Sends the reason processing failed (`app:error`); null clears it. */
  broadcastError(error: ProcessErrorPayload | null): void | Promise<void>;
  /** Tells the chat window to forget its attachments (`app:attachments-clear`): a new session. */
  clearAttachments(): void | Promise<void>;
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
  "SETUP_START",
  "TRANSCRIPT_CHANGED",
  "PROCESS_DONE",
  "PROCESS_FAILED",
  "PROCESS_RETRY",
  "RECORD_FAILED",
  "NEW_SESSION",
]);

/**
 * Mascot animation for each app state. `settingsOpen`: the chat shows Settings, where Y is
 * paused, so a ready or finished Yadi waits quietly instead of inviting a key press. Recording
 * and processing keep showing, because that work really is still going on.
 */
export function mascotStateFor(model: Model, settingsOpen = false): MascotState {
  if (settingsOpen && (model.state === "idle" || model.state === "result")) return "waiting";
  switch (model.state) {
    case "setup":
      return "setup";
    case "minimized":
      return "asleep";
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

/** Words for each failure, shown to the user. Never contains transcript text. */
export const PROCESS_MESSAGES: Record<ProcessErrorKind, string> = {
  unreachable: "Yadi could not reach the language model (Ollama). Make sure Ollama is running.",
  "model-missing": "The language model is not installed on this computer.",
  timeout: "Making the prompt took too long and was stopped.",
  empty: "There is nothing to turn into a prompt yet.",
  failed: "Making the prompt failed.",
};

/** Maps whatever the pipeline threw to a user-facing kind. */
export function classifyProcessError(e: unknown, timedOut: boolean): ProcessErrorKind {
  if (timedOut) return "timeout";
  if (e instanceof EmptyTranscriptError) return "empty";
  if (e instanceof LlmError) {
    if (e.status === 404 || /not found/i.test(e.message)) return "model-missing";
    if (e.status === undefined && /cannot reach|connect|refused|failed to fetch/i.test(e.message)) {
      return "unreachable";
    }
  }
  return "failed";
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
 * Processing runs the final pass, then the prompt pipeline (`makePrompt`), and ends with
 * PROCESS_DONE or PROCESS_FAILED.
 */
export class Controller {
  private current: Model;
  private listeners = new Set<Listener>();
  private readonly transcript = new Transcript();
  /** Resolves when the most recent recording has fully stopped and its last words have arrived. */
  private settled: Promise<void> = Promise.resolve();
  /** False until the first-run wizard has finished (or after "re-run setup"). */
  private setupComplete = true;
  /** Bumped when processing starts and when it is cancelled, so late results can be ignored. */
  private processingRun = 0;
  /** Cancels the language-model work of the current run. */
  private abort: AbortController | null = null;
  private recent: RecentItem[] = [];
  private lastResult: ResultPayload | null = null;
  private resultCount = 0;
  private lastError: ProcessErrorPayload | null = null;
  /** Name, type and the start of each attachment (the chat window keeps the full text). */
  private attachments: Attachment[] = [];

  /**
   * Starts in `minimized` (mascot visible, chat hidden). Task 15 will start in `setup` until
   * the first-run wizard has finished.
   */
  constructor(
    private readonly ports: ControllerPorts,
    initial: Model = { ...initialModel, state: "minimized" },
    private readonly processTimeoutMs: number = PROCESS_TIMEOUT_MS,
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

  /** Tells the Controller whether first-run setup is finished (read from `setup.json` at startup). */
  setSetupComplete(complete: boolean): void {
    this.setupComplete = complete;
    // Load the language model in the background so the first prompt is not slow.
    if (complete) void this.guard(this.ports.warmModel());
  }

  dispatch(event: AppEvent): void {
    // While setup is unfinished a summon must open the wizard, never skip it.
    if (event.type === "SUMMON" && !this.setupComplete && this.current.state === "minimized") {
      event = { type: "SETUP_START" };
    }
    if (event.type === "SETUP_DONE") {
      this.setupComplete = true;
      void this.guard(this.ports.warmModel());
    }
    if (
      event.type === "SETUP_START" &&
      ["minimized", "idle", "result"].includes(this.current.state)
    ) {
      this.setupComplete = false;
    }
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
      void this.ports.broadcastResult(this.lastResult);
      void this.ports.broadcastError(this.lastError);
      return;
    }
    if (type === "ATTACHMENTS_SET") {
      this.attachments = parseAttachmentMeta((payload as { items?: unknown }).items);
      return;
    }
    if (type === "TRANSCRIPT_SET_TEXT") {
      const { text } = payload as { text?: unknown };
      if (typeof text === "string") this.applyEdit(() => this.transcript.setText(text));
      return;
    }
    if (type === "TRANSCRIPT_REPLACE_WORD") {
      const { segmentId, wordIndex, text } = payload as Record<string, unknown>;
      if (
        typeof segmentId === "number" &&
        typeof wordIndex === "number" &&
        typeof text === "string"
      ) {
        this.applyEdit(() => this.transcript.replaceWord(segmentId, wordIndex, text));
      }
      return;
    }
    if (!EVENT_TYPES.has(type)) {
      this.ports.log(`ignored unknown app:event ${redactForLog(payload)}`);
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
      await this.makePrompt(run);
    })();
  }

  /**
   * Processing, stages 2-4: clean, analyse and write the prompt with the language model. Esc (or a
   * newer run) aborts the request; 120 s without an answer aborts it too. If Ollama is not
   * reachable it is started once and the run is tried again.
   */
  private async makePrompt(run: number): Promise<void> {
    const transcript = this.transcript.text();
    const abort = new AbortController();
    this.abort = abort;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, this.processTimeoutMs);
    const current = () => run === this.processingRun;
    const stage = (stageName: ProcessStage, clean?: string) => {
      if (current())
        void this.ports.broadcastProgress({ stage: stageName, done: 0, total: 0, clean });
    };
    const options: PipelineRunOptions = {
      transcript,
      attachments: this.attachments,
      signal: abort.signal,
      onStage: (name: StageName, data: unknown) => {
        if (name === "normalize") {
          stage("analysing", (data as { clean_text?: string }).clean_text);
        } else if (name === "analyze") {
          stage("writing");
        }
      },
    };
    try {
      stage("cleaning");
      let result: PipelineResult;
      try {
        result = await this.ports.runPipeline(options);
      } catch (e) {
        if (classifyProcessError(e, timedOut) !== "unreachable" || !current()) throw e;
        this.ports.log("language model unreachable; trying to start Ollama once");
        try {
          await this.ports.startOllama();
        } catch {
          throw e; // it could not be started: report the original "unreachable"
        }
        stage("cleaning");
        result = await this.ports.runPipeline(options);
      }
      if (!current()) return; // cancelled while the model was working
      this.finishWithResult(result, transcript);
    } catch (e) {
      if (!current()) return; // cancelled by the user: back to idle already, nothing to say
      const kind = classifyProcessError(e, timedOut);
      this.ports.log(`processing failed: ${kind}`); // never the text, never the model's answer
      this.lastError = { kind, message: PROCESS_MESSAGES[kind] };
      void this.ports.broadcastError(this.lastError);
      void this.ports.broadcastProgress(null);
      this.dispatch({ type: "PROCESS_FAILED", message: PROCESS_MESSAGES[kind] });
    } finally {
      clearTimeout(timer);
      if (this.abort === abort) this.abort = null;
    }
  }

  private finishWithResult(result: PipelineResult, transcript: string): void {
    this.recent = [{ prompt: result.prompt, at: Date.now() }, ...this.recent].slice(
      0,
      RECENT_LIMIT,
    );
    const tokensIn = estimateTokens(transcript);
    const tokensOut = estimateTokens(result.prompt);
    this.lastResult = {
      id: ++this.resultCount,
      prompt: result.prompt,
      degraded: result.degraded,
      tokensIn,
      tokensOut,
      tokensSaved: tokensSaved(tokensIn, tokensOut),
      recent: this.recent,
    };
    void this.ports.broadcastResult(this.lastResult);
    void this.ports.broadcastProgress(null);
    this.dispatch({ type: "PROCESS_DONE" });
  }

  /** Forgets the last result and error (a new recording or session starts). */
  private clearOutcome(): void {
    if (this.lastResult === null && this.lastError === null) return;
    this.lastResult = null;
    this.lastError = null;
    void this.ports.broadcastResult(null);
    void this.ports.broadcastError(null);
  }

  /**
   * Applies a user edit to the transcript. Only allowed while editing in idle or result (the
   * state machine's rule), so nothing can change the text mid-recording or mid-processing.
   * The recording's audio no longer matches the edited text, so it is dropped: a later final
   * pass must never overwrite the edit.
   */
  private applyEdit(change: () => boolean): void {
    const { state, editing } = this.current;
    if (!editing || (state !== "idle" && state !== "result")) return;
    if (!change()) return;
    this.transcript.markAudioFreed();
    void this.guard(this.ports.clearAudio());
    this.transcriptChanged();
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
        this.clearOutcome();
        this.transcript.beginRecording();
        this.startRecording();
        break;
      case "startProcessing":
        this.clearOutcome();
        this.startProcessing();
        break;
      case "cancelProcessing":
        this.processingRun++;
        this.abort?.abort();
        void this.ports.broadcastProgress(null);
        break;
      case "notify":
        void this.ports.showNotice(effect.message);
        break;
      case "stopRecording":
        this.stopRecording();
        break;
      case "clearSession":
        this.clearOutcome();
        this.attachments = [];
        void this.guard(this.ports.clearAttachments());
        this.transcript.clear();
        void this.ports.broadcastTranscript(this.transcript.snapshot());
        void this.guard(this.ports.clearAudio());
        break;
    }
  }
}
