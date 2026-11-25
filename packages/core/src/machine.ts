/**
 * Pure reducer for Yadi's app modes (PLAN.md Task 02).
 * `transition(model, event)` never mutates its input and performs no I/O;
 * side effects are returned as data for the Controller to execute.
 */

export type AppState = "setup" | "minimized" | "idle" | "recording" | "processing" | "result";

export interface Model {
  state: AppState;
  editing: boolean;
  hasTranscript: boolean;
}

export type AppEvent =
  | { type: "SUMMON" }
  | { type: "KEY_Y" }
  | { type: "KEY_ESC" }
  | { type: "EDIT_START" }
  | { type: "EDIT_END" }
  | { type: "SETUP_DONE" }
  | { type: "SETUP_START" }
  | { type: "TRANSCRIPT_CHANGED"; hasTranscript: boolean }
  | { type: "PROCESS_DONE" }
  | { type: "PROCESS_FAILED"; message?: string }
  | { type: "PROCESS_RETRY" }
  | { type: "RECORD_FAILED"; message?: string }
  | { type: "NEW_SESSION" };

export type Effect =
  | { type: "showChat" }
  | { type: "hideChat" }
  | { type: "focusChat" }
  | { type: "startRecording" }
  | { type: "stopRecording" }
  | { type: "startProcessing" }
  | { type: "cancelProcessing" }
  | { type: "clearSession" }
  | { type: "notify"; message: string };

export interface Transition {
  model: Model;
  effects: Effect[];
}

export const MSG_NOTHING_HEARD = "Nothing heard";
export const MSG_PROCESS_FAILED = "Processing failed";
export const MSG_RECORD_FAILED = "Recording failed";

export const initialModel: Model = { state: "setup", editing: false, hasTranscript: false };

const showChat: Effect = { type: "showChat" };
const hideChat: Effect = { type: "hideChat" };
const focusChat: Effect = { type: "focusChat" };
const startRecording: Effect = { type: "startRecording" };
const stopRecording: Effect = { type: "stopRecording" };
const startProcessing: Effect = { type: "startProcessing" };
const cancelProcessing: Effect = { type: "cancelProcessing" };
const clearSession: Effect = { type: "clearSession" };
const notify = (message: string): Effect => ({ type: "notify", message });

function go(model: Model, patch: Partial<Model>, ...effects: Effect[]): Transition {
  return { model: { ...model, ...patch }, effects };
}

function noop(model: Model): Transition {
  return { model, effects: [] };
}

function onSummon(m: Model): Transition {
  if (m.state === "minimized") return go(m, { state: "idle" }, showChat, focusChat);
  return go(m, {}, focusChat);
}

function onKeyY(m: Model): Transition {
  if (m.editing) return noop(m);
  switch (m.state) {
    case "idle":
      return go(m, { state: "recording" }, startRecording);
    case "recording":
      return m.hasTranscript
        ? go(m, { state: "processing" }, stopRecording, startProcessing)
        : go(m, { state: "idle" }, stopRecording, notify(MSG_NOTHING_HEARD));
    case "result":
      return go(m, { state: "recording", hasTranscript: false }, clearSession, startRecording);
    default:
      return noop(m);
  }
}

function onKeyEsc(m: Model): Transition {
  if (m.editing) return go(m, { editing: false });
  switch (m.state) {
    case "recording":
      return go(m, { state: "idle" }, stopRecording);
    case "processing":
      return go(m, { state: "idle" }, cancelProcessing);
    case "idle":
    case "result":
    case "setup":
      return go(m, { state: "minimized" }, hideChat);
    default:
      return noop(m);
  }
}

function onRecordFailed(m: Model, message: string): Transition {
  switch (m.state) {
    case "minimized":
    case "setup":
      return go(m, {}, notify(message));
    case "recording":
      return go(m, { state: "idle", editing: false }, stopRecording, notify(message));
    case "processing":
      return go(m, { state: "idle", editing: false }, cancelProcessing, notify(message));
    default:
      return go(m, { state: "idle", editing: false }, notify(message));
  }
}

/**
 * Opens (or re-opens) the setup wizard: from the hidden state (showing the chat) or from idle /
 * result (re-run or repair). Never while recording or processing.
 */
function onSetupStart(m: Model): Transition {
  if (m.state === "minimized")
    return go(m, { state: "setup", editing: false }, showChat, focusChat);
  if (m.state === "idle" || m.state === "result") return go(m, { state: "setup", editing: false });
  return noop(m);
}

export function transition(model: Model, event: AppEvent): Transition {
  switch (event.type) {
    case "SUMMON":
      return onSummon(model);
    case "KEY_Y":
      return onKeyY(model);
    case "KEY_ESC":
      return onKeyEsc(model);
    case "EDIT_START":
      return (model.state === "idle" || model.state === "result") && !model.editing
        ? go(model, { editing: true })
        : noop(model);
    case "EDIT_END":
      return model.editing ? go(model, { editing: false }) : noop(model);
    case "SETUP_START":
      return onSetupStart(model);
    case "SETUP_DONE":
      return model.state === "setup" ? go(model, { state: "idle" }) : noop(model);
    case "TRANSCRIPT_CHANGED":
      return model.hasTranscript === event.hasTranscript
        ? noop(model)
        : go(model, { hasTranscript: event.hasTranscript });
    case "PROCESS_DONE":
      return model.state === "processing" ? go(model, { state: "result" }) : noop(model);
    case "PROCESS_FAILED":
      return model.state === "processing"
        ? go(model, { state: "idle" }, notify(event.message ?? MSG_PROCESS_FAILED))
        : noop(model);
    case "PROCESS_RETRY":
      // After a failed run or a fixed word the transcript is still there: make the prompt again.
      return (model.state === "idle" || model.state === "result") &&
        model.hasTranscript &&
        !model.editing
        ? go(model, { state: "processing" }, startProcessing)
        : noop(model);
    case "RECORD_FAILED":
      return onRecordFailed(model, event.message ?? MSG_RECORD_FAILED);
    case "NEW_SESSION":
      return model.state === "idle" || model.state === "result"
        ? go(model, { state: "idle", editing: false, hasTranscript: false }, clearSession)
        : noop(model);
    default:
      return noop(model);
  }
}
