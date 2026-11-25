import { describe, expect, it } from "vitest";
import {
  type AppEvent,
  type AppState,
  type Effect,
  type Model,
  MSG_NOTHING_HEARD,
  MSG_PROCESS_FAILED,
  MSG_RECORD_FAILED,
  initialModel,
  transition,
} from "./machine";

const m = (state: AppState, extra: Partial<Model> = {}): Model => ({
  state,
  editing: false,
  hasTranscript: false,
  ...extra,
});

const e = (...types: Effect["type"][]): Effect[] => types.map((type) => ({ type }) as Effect);

interface Row {
  name: string;
  from: Model;
  event: AppEvent;
  to: Model;
  effects: Effect[];
}

const KEY_Y: AppEvent = { type: "KEY_Y" };
const ESC: AppEvent = { type: "KEY_ESC" };
const SUMMON: AppEvent = { type: "SUMMON" };

const rows: Row[] = [
  // SUMMON
  {
    name: "minimized + SUMMON",
    from: m("minimized"),
    event: SUMMON,
    to: m("idle"),
    effects: e("showChat", "focusChat"),
  },
  ...(["idle", "recording", "processing", "result"] as const).map((s) => ({
    name: `${s} + SUMMON keeps state, focuses`,
    from: m(s),
    event: SUMMON,
    to: m(s),
    effects: e("focusChat"),
  })),
  {
    name: "setup + SUMMON keeps the wizard and focuses it",
    from: m("setup"),
    event: SUMMON,
    to: m("setup"),
    effects: e("focusChat"),
  },
  // KEY_Y
  {
    name: "idle + Y starts recording",
    from: m("idle"),
    event: KEY_Y,
    to: m("recording"),
    effects: e("startRecording"),
  },
  {
    name: "recording + Y with transcript processes",
    from: m("recording", { hasTranscript: true }),
    event: KEY_Y,
    to: m("processing", { hasTranscript: true }),
    effects: e("stopRecording", "startProcessing"),
  },
  {
    name: "recording + Y without transcript says nothing heard",
    from: m("recording"),
    event: KEY_Y,
    to: m("idle"),
    effects: [...e("stopRecording"), { type: "notify", message: MSG_NOTHING_HEARD }],
  },
  {
    name: "processing + Y ignored",
    from: m("processing", { hasTranscript: true }),
    event: KEY_Y,
    to: m("processing", { hasTranscript: true }),
    effects: [],
  },
  {
    name: "result + Y clears then records",
    from: m("result", { hasTranscript: true }),
    event: KEY_Y,
    to: m("recording"),
    effects: e("clearSession", "startRecording"),
  },
  {
    name: "minimized + Y ignored",
    from: m("minimized"),
    event: KEY_Y,
    to: m("minimized"),
    effects: [],
  },
  { name: "setup + Y ignored", from: m("setup"), event: KEY_Y, to: m("setup"), effects: [] },
  // KEY_ESC
  {
    name: "recording + Esc stops, keeps transcript",
    from: m("recording", { hasTranscript: true }),
    event: ESC,
    to: m("idle", { hasTranscript: true }),
    effects: e("stopRecording"),
  },
  {
    name: "processing + Esc cancels, keeps transcript",
    from: m("processing", { hasTranscript: true }),
    event: ESC,
    to: m("idle", { hasTranscript: true }),
    effects: e("cancelProcessing"),
  },
  {
    name: "idle + Esc minimizes",
    from: m("idle"),
    event: ESC,
    to: m("minimized"),
    effects: e("hideChat"),
  },
  {
    name: "result + Esc minimizes",
    from: m("result"),
    event: ESC,
    to: m("minimized"),
    effects: e("hideChat"),
  },
  {
    name: "setup + Esc minimizes",
    from: m("setup"),
    event: ESC,
    to: m("minimized"),
    effects: e("hideChat"),
  },
  {
    name: "minimized + Esc is no-op",
    from: m("minimized"),
    event: ESC,
    to: m("minimized"),
    effects: [],
  },
  // process outcome
  {
    name: "processing + PROCESS_DONE",
    from: m("processing", { hasTranscript: true }),
    event: { type: "PROCESS_DONE" },
    to: m("result", { hasTranscript: true }),
    effects: [],
  },
  {
    name: "processing + PROCESS_FAILED",
    from: m("processing", { hasTranscript: true }),
    event: { type: "PROCESS_FAILED" },
    to: m("idle", { hasTranscript: true }),
    effects: [{ type: "notify", message: MSG_PROCESS_FAILED }],
  },
  {
    name: "processing + PROCESS_FAILED custom message",
    from: m("processing"),
    event: { type: "PROCESS_FAILED", message: "Ollama is not running" },
    to: m("idle"),
    effects: [{ type: "notify", message: "Ollama is not running" }],
  },
  {
    name: "recording + PROCESS_DONE ignored",
    from: m("recording"),
    event: { type: "PROCESS_DONE" },
    to: m("recording"),
    effects: [],
  },
  {
    name: "idle + PROCESS_FAILED ignored",
    from: m("idle"),
    event: { type: "PROCESS_FAILED" },
    to: m("idle"),
    effects: [],
  },
  // PROCESS_RETRY
  {
    name: "idle with a transcript + PROCESS_RETRY starts processing again",
    from: m("idle", { hasTranscript: true }),
    event: { type: "PROCESS_RETRY" },
    to: m("processing", { hasTranscript: true }),
    effects: e("startProcessing"),
  },
  {
    name: "idle without a transcript + PROCESS_RETRY ignored",
    from: m("idle"),
    event: { type: "PROCESS_RETRY" },
    to: m("idle"),
    effects: [],
  },
  {
    name: "idle while editing + PROCESS_RETRY ignored",
    from: m("idle", { hasTranscript: true, editing: true }),
    event: { type: "PROCESS_RETRY" },
    to: m("idle", { hasTranscript: true, editing: true }),
    effects: [],
  },
  {
    name: "recording + PROCESS_RETRY ignored",
    from: m("recording", { hasTranscript: true }),
    event: { type: "PROCESS_RETRY" },
    to: m("recording", { hasTranscript: true }),
    effects: [],
  },
  {
    name: "result + PROCESS_RETRY makes the prompt again (e.g. after fixing a word)",
    from: m("result", { hasTranscript: true }),
    event: { type: "PROCESS_RETRY" },
    to: m("processing", { hasTranscript: true }),
    effects: e("startProcessing"),
  },
  {
    name: "processing + PROCESS_RETRY ignored",
    from: m("processing", { hasTranscript: true }),
    event: { type: "PROCESS_RETRY" },
    to: m("processing", { hasTranscript: true }),
    effects: [],
  },
  // RECORD_FAILED
  {
    name: "recording + RECORD_FAILED stops and returns to idle",
    from: m("recording"),
    event: { type: "RECORD_FAILED" },
    to: m("idle"),
    effects: [...e("stopRecording"), { type: "notify", message: MSG_RECORD_FAILED }],
  },
  {
    name: "processing + RECORD_FAILED cancels",
    from: m("processing"),
    event: { type: "RECORD_FAILED", message: "No microphone" },
    to: m("idle"),
    effects: [...e("cancelProcessing"), { type: "notify", message: "No microphone" }],
  },
  {
    name: "idle + RECORD_FAILED",
    from: m("idle"),
    event: { type: "RECORD_FAILED" },
    to: m("idle"),
    effects: [{ type: "notify", message: MSG_RECORD_FAILED }],
  },
  {
    name: "result + RECORD_FAILED",
    from: m("result"),
    event: { type: "RECORD_FAILED" },
    to: m("idle"),
    effects: [{ type: "notify", message: MSG_RECORD_FAILED }],
  },
  {
    name: "minimized + RECORD_FAILED only notifies",
    from: m("minimized"),
    event: { type: "RECORD_FAILED" },
    to: m("minimized"),
    effects: [{ type: "notify", message: MSG_RECORD_FAILED }],
  },
  {
    name: "setup + RECORD_FAILED only notifies",
    from: m("setup"),
    event: { type: "RECORD_FAILED" },
    to: m("setup"),
    effects: [{ type: "notify", message: MSG_RECORD_FAILED }],
  },
  // setup
  {
    name: "setup + SETUP_DONE",
    from: m("setup"),
    event: { type: "SETUP_DONE" },
    to: m("idle"),
    effects: [],
  },
  {
    name: "idle + SETUP_DONE ignored",
    from: m("idle"),
    event: { type: "SETUP_DONE" },
    to: m("idle"),
    effects: [],
  },
  // setup (re)start
  {
    name: "minimized + SETUP_START shows the wizard",
    from: m("minimized"),
    event: { type: "SETUP_START" },
    to: m("setup"),
    effects: e("showChat", "focusChat"),
  },
  ...(["idle", "result"] as const).map((s) => ({
    name: `${s} + SETUP_START re-runs setup`,
    from: m(s, { hasTranscript: true }),
    event: { type: "SETUP_START" } as AppEvent,
    to: m("setup", { hasTranscript: true }),
    effects: [] as Effect[],
  })),
  {
    name: "idle + editing + SETUP_START leaves editing",
    from: m("idle", { editing: true }),
    event: { type: "SETUP_START" },
    to: m("setup"),
    effects: [],
  },
  ...(["recording", "processing", "setup"] as const).map((s) => ({
    name: `${s} + SETUP_START is ignored`,
    from: m(s),
    event: { type: "SETUP_START" } as AppEvent,
    to: m(s),
    effects: [] as Effect[],
  })),
  // transcript flag
  {
    name: "TRANSCRIPT_CHANGED true",
    from: m("recording"),
    event: { type: "TRANSCRIPT_CHANGED", hasTranscript: true },
    to: m("recording", { hasTranscript: true }),
    effects: [],
  },
  {
    name: "TRANSCRIPT_CHANGED false",
    from: m("idle", { hasTranscript: true }),
    event: { type: "TRANSCRIPT_CHANGED", hasTranscript: false },
    to: m("idle"),
    effects: [],
  },
  {
    name: "TRANSCRIPT_CHANGED same value is no-op",
    from: m("idle", { hasTranscript: true }),
    event: { type: "TRANSCRIPT_CHANGED", hasTranscript: true },
    to: m("idle", { hasTranscript: true }),
    effects: [],
  },
  // editing
  {
    name: "idle + EDIT_START",
    from: m("idle", { hasTranscript: true }),
    event: { type: "EDIT_START" },
    to: m("idle", { hasTranscript: true, editing: true }),
    effects: [],
  },
  {
    name: "result + EDIT_START",
    from: m("result"),
    event: { type: "EDIT_START" },
    to: m("result", { editing: true }),
    effects: [],
  },
  ...(["recording", "processing", "setup", "minimized"] as const).map((s) => ({
    name: `${s} + EDIT_START blocked`,
    from: m(s),
    event: { type: "EDIT_START" } as AppEvent,
    to: m(s),
    effects: [] as Effect[],
  })),
  {
    name: "EDIT_START while already editing is no-op",
    from: m("idle", { editing: true }),
    event: { type: "EDIT_START" },
    to: m("idle", { editing: true }),
    effects: [],
  },
  {
    name: "EDIT_END ends editing",
    from: m("idle", { editing: true }),
    event: { type: "EDIT_END" },
    to: m("idle"),
    effects: [],
  },
  {
    name: "EDIT_END when not editing is no-op",
    from: m("idle"),
    event: { type: "EDIT_END" },
    to: m("idle"),
    effects: [],
  },
  {
    name: "Y while editing is no-op",
    from: m("idle", { editing: true }),
    event: KEY_Y,
    to: m("idle", { editing: true }),
    effects: [],
  },
  {
    name: "Y while editing in result is no-op",
    from: m("result", { editing: true, hasTranscript: true }),
    event: KEY_Y,
    to: m("result", { editing: true, hasTranscript: true }),
    effects: [],
  },
  {
    name: "Esc while editing only cancels edit",
    from: m("idle", { editing: true }),
    event: ESC,
    to: m("idle"),
    effects: [],
  },
  // new session
  {
    name: "idle + NEW_SESSION clears",
    from: m("idle", { hasTranscript: true }),
    event: { type: "NEW_SESSION" },
    to: m("idle"),
    effects: e("clearSession"),
  },
  {
    name: "result + NEW_SESSION clears",
    from: m("result", { hasTranscript: true, editing: true }),
    event: { type: "NEW_SESSION" },
    to: m("idle"),
    effects: e("clearSession"),
  },
  {
    name: "recording + NEW_SESSION ignored",
    from: m("recording", { hasTranscript: true }),
    event: { type: "NEW_SESSION" },
    to: m("recording", { hasTranscript: true }),
    effects: [],
  },
];

describe("transition table", () => {
  it.each(rows)("$name", ({ from, event, to, effects }) => {
    const before = { ...from };
    const result = transition(from, event);
    expect(result.model).toEqual(to);
    expect(result.effects).toEqual(effects);
    expect(from).toEqual(before); // input never mutated
  });
});

describe("sequences", () => {
  const run = (start: Model, events: AppEvent[]) => {
    let model = start;
    const effects: Effect[] = [];
    for (const ev of events) {
      const r = transition(model, ev);
      model = r.model;
      effects.push(...r.effects);
    }
    return { model, effects };
  };

  it("double Esc from recording ends minimized", () => {
    const { model, effects } = run(m("recording"), [ESC, ESC]);
    expect(model.state).toBe("minimized");
    expect(effects).toEqual(e("stopRecording", "hideChat"));
  });

  it("result + Y emits clearSession before startRecording", () => {
    const { effects } = run(m("result", { hasTranscript: true }), [KEY_Y]);
    expect(effects.map((x) => x.type)).toEqual(["clearSession", "startRecording"]);
  });

  it("happy path: summon, record, speak, process, done, new recording", () => {
    const { model, effects } = run(m("minimized"), [
      SUMMON,
      KEY_Y,
      { type: "TRANSCRIPT_CHANGED", hasTranscript: true },
      KEY_Y,
      { type: "PROCESS_DONE" },
      KEY_Y,
    ]);
    expect(model).toEqual(m("recording"));
    expect(effects.map((x) => x.type)).toEqual([
      "showChat",
      "focusChat",
      "startRecording",
      "stopRecording",
      "startProcessing",
      "clearSession",
      "startRecording",
    ]);
  });

  it("transcript is kept when recording is stopped with Esc and resumed with Y", () => {
    const { model } = run(m("recording", { hasTranscript: true }), [ESC, KEY_Y]);
    expect(model).toEqual(m("recording", { hasTranscript: true }));
  });
});

describe("robustness", () => {
  it("unknown event is a no-op and returns the same model", () => {
    const model = m("idle");
    const result = transition(model, { type: "SOMETHING_ELSE" } as unknown as AppEvent);
    expect(result.model).toBe(model);
    expect(result.effects).toEqual([]);
  });

  it("initial model starts in setup", () => {
    expect(initialModel).toEqual(m("setup"));
  });

  it("Esc in an unreachable state is a no-op", () => {
    const result = transition({ ...m("idle"), state: "bogus" as AppState }, ESC);
    expect(result.effects).toEqual([]);
  });
});
