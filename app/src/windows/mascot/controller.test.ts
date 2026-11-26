import { describe, expect, it, vi } from "vitest";
import { EmptyTranscriptError, LlmError, type PipelineResult } from "@yadi/core";
import {
  Controller,
  PROCESS_MESSAGES,
  classifyProcessError,
  errorMessage,
  mascotStateFor,
  type ControllerPorts,
  type ProcessErrorPayload,
  type ResultPayload,
} from "./controller";

function setup(initial?: ConstructorParameters<typeof Controller>[1]) {
  const calls: string[] = [];
  const ports: ControllerPorts = {
    showChat: vi.fn(() => void calls.push("showChat")),
    hideChat: vi.fn(() => void calls.push("hideChat")),
    focusChat: vi.fn(() => void calls.push("focusChat")),
    showView: vi.fn((v) => void calls.push(`view:${v}`)),
    startAudio: vi.fn(),
    startStt: vi.fn(),
    runFinalPass: vi.fn(async () => ({ text: null, notice: null })),
    showNotice: vi.fn(),
    broadcastProgress: vi.fn(),
    stopStt: vi.fn(),
    broadcastTranscript: vi.fn(),
    // By default the language model never answers, so a run stays in "processing".
    runPipeline: vi.fn(() => new Promise<PipelineResult>(() => {})),
    startOllama: vi.fn(async () => {}),
    warmModel: vi.fn(async () => {}),
    broadcastResult: vi.fn(),
    broadcastError: vi.fn(),
    clearAttachments: vi.fn(),
    stopAudio: vi.fn(),
    clearAudio: vi.fn(),
    broadcast: vi.fn((p) => void calls.push(`broadcast:${p.state}:${p.editing}`)),
    log: vi.fn(),
  };
  return { controller: new Controller(ports, initial), ports, calls };
}

describe("Controller", () => {
  it("starts minimized", () => {
    expect(setup().controller.model.state).toBe("minimized");
  });

  it("SUMMON shows and focuses the chat, broadcasting the new state first", () => {
    const { controller, calls } = setup();
    controller.dispatch({ type: "SUMMON" });
    expect(calls).toEqual(["broadcast:idle:false", "showChat", "focusChat"]);
  });

  it("broadcasts only when the model changed", () => {
    const { controller, ports } = setup();
    controller.dispatch({ type: "SUMMON" });
    controller.dispatch({ type: "SUMMON" }); // idle -> idle, only focusChat
    expect(ports.broadcast).toHaveBeenCalledTimes(1);
    expect(ports.focusChat).toHaveBeenCalledTimes(2);
  });

  it("walks idle -> recording -> processing -> result with Y, driving the microphone", async () => {
    const { controller, ports } = setup();
    controller.dispatch({ type: "SUMMON" });
    controller.dispatch({ type: "KEY_Y" });
    expect(controller.model.state).toBe("recording");
    controller.dispatch({ type: "TRANSCRIPT_CHANGED", hasTranscript: true });
    controller.dispatch({ type: "KEY_Y" });
    expect(controller.model.state).toBe("processing");
    controller.dispatch({ type: "PROCESS_DONE" });
    expect(controller.model.state).toBe("result");
    await controller.whenSettled();
    expect(ports.startAudio).toHaveBeenCalledTimes(1);
    expect(ports.stopAudio).toHaveBeenCalledTimes(1); // Y with a transcript stops recording
    expect(ports.runFinalPass).toHaveBeenCalledTimes(1);
  });

  it("toggleChat opens when minimized", () => {
    const { controller } = setup();
    controller.toggleChat();
    expect(controller.model.state).toBe("idle");
  });

  it("toggleChat while recording stops and hides (two Escs)", async () => {
    const { controller, ports } = setup({
      state: "recording",
      editing: false,
      hasTranscript: true,
    });
    controller.toggleChat();
    expect(controller.model.state).toBe("minimized");
    expect(ports.hideChat).toHaveBeenCalledTimes(1);
    await controller.whenSettled();
    expect(ports.stopAudio).toHaveBeenCalledTimes(1);
  });

  it("toggleChat while editing cancels the edit, then hides", () => {
    const { controller } = setup({ state: "idle", editing: true, hasTranscript: true });
    controller.toggleChat();
    expect(controller.model).toMatchObject({ state: "minimized", editing: false });
  });

  it("openAbout summons the chat and switches it to the About view", () => {
    const { controller, calls } = setup();
    controller.openAbout();
    expect(controller.model.state).toBe("idle");
    expect(calls).toEqual(["broadcast:idle:false", "showChat", "focusChat", "view:about"]);
  });

  it("handleAppEvent applies known events from the chat window", () => {
    const { controller } = setup({ state: "idle", editing: false, hasTranscript: false });
    controller.handleAppEvent({ type: "KEY_Y" });
    expect(controller.model.state).toBe("recording");
  });

  it("handleAppEvent SYNC rebroadcasts without changing state", () => {
    const { controller, ports } = setup();
    controller.handleAppEvent({ type: "SYNC" });
    expect(ports.broadcast).toHaveBeenCalledWith({ state: "minimized", editing: false });
    expect(controller.model.state).toBe("minimized");
  });

  it.each([null, undefined, 42, "KEY_Y", {}, { type: 5 }, { type: "NOPE" }])(
    "handleAppEvent ignores bad payload %j",
    (payload) => {
      const { controller } = setup();
      controller.handleAppEvent(payload);
      expect(controller.model.state).toBe("minimized");
    },
  );

  it("notifies subscribers and supports unsubscribe", () => {
    const { controller } = setup();
    const seen: string[] = [];
    const off = controller.subscribe((m) => seen.push(m.state));
    controller.dispatch({ type: "SUMMON" });
    off();
    controller.dispatch({ type: "KEY_ESC" });
    expect(seen).toEqual(["idle"]);
  });
});

describe("mascotStateFor", () => {
  it.each([
    ["setup", "setup"],
    ["minimized", "asleep"],
    ["idle", "idle"],
    ["recording", "listening"],
    ["processing", "thinking"],
    ["result", "done"],
  ] as const)("%s -> %s", (state, expected) => {
    expect(mascotStateFor({ state, editing: false, hasTranscript: false })).toBe(expected);
  });

  it.each([
    ["idle", "waiting"],
    ["result", "waiting"],
    ["recording", "listening"],
    ["processing", "thinking"],
    ["minimized", "asleep"],
  ] as const)("with Settings open: %s -> %s", (state, expected) => {
    expect(mascotStateFor({ state, editing: false, hasTranscript: false }, true)).toBe(expected);
  });
});

describe("audio wiring", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("startRecording starts the microphone, stopRecording stops it", async () => {
    const { controller, ports } = setup({ state: "idle", editing: false, hasTranscript: false });
    controller.dispatch({ type: "KEY_Y" });
    await flush();
    expect(ports.startAudio).toHaveBeenCalledTimes(1);
    controller.dispatch({ type: "KEY_ESC" });
    await controller.whenSettled();
    expect(ports.stopAudio).toHaveBeenCalledTimes(1);
    expect(controller.model.state).toBe("idle");
  });

  it("result + Y clears the recording then starts a new one", async () => {
    const { controller, ports } = setup({ state: "result", editing: false, hasTranscript: true });
    controller.dispatch({ type: "KEY_Y" });
    await flush();
    expect(ports.clearAudio).toHaveBeenCalledTimes(1);
    expect(ports.startAudio).toHaveBeenCalledTimes(1);
    expect(controller.model.state).toBe("recording");
  });

  it("a rejected audio_start sends RECORD_FAILED and returns to idle", async () => {
    const { controller, ports } = setup({ state: "idle", editing: false, hasTranscript: false });
    (ports.startAudio as ReturnType<typeof vi.fn>).mockRejectedValue({
      kind: "no-device",
      message: "No microphone was found.",
    });
    controller.dispatch({ type: "KEY_Y" });
    expect(controller.model.state).toBe("recording");
    await flush();
    expect(controller.model.state).toBe("idle");
    expect(ports.stopAudio).toHaveBeenCalled(); // RECORD_FAILED from recording also stops
  });

  it("an audio:error while recording returns to idle with its message", () => {
    const { controller, ports } = setup({
      state: "recording",
      editing: false,
      hasTranscript: true,
    });
    controller.handleAudioError({
      kind: "device-lost",
      message: "The microphone was disconnected.",
    });
    expect(controller.model.state).toBe("idle");
    expect(ports.showNotice).toHaveBeenCalledWith("The microphone was disconnected.");
  });

  it("a failing stopAudio is logged, not thrown", async () => {
    const { controller, ports } = setup({
      state: "recording",
      editing: false,
      hasTranscript: true,
    });
    (ports.stopAudio as ReturnType<typeof vi.fn>).mockRejectedValue("boom");
    controller.dispatch({ type: "KEY_ESC" });
    await flush();
    expect(ports.log).toHaveBeenCalledWith("audio command failed: boom");
  });

  it.each([
    ["plain text", "plain text"],
    [{ kind: "x", message: "typed" }, "typed"],
    [{ nope: 1 }, "Recording failed"],
    [undefined, "Recording failed"],
  ])("errorMessage(%j)", (input, expected) => {
    expect(errorMessage(input)).toBe(expected);
  });
});

describe("speech recognition wiring", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const recording = () => setup({ state: "recording", editing: false, hasTranscript: false });

  it("starts the microphone first, then speech recognition", async () => {
    const { controller, ports } = setup({ state: "idle", editing: false, hasTranscript: false });
    const order: string[] = [];
    (ports.startAudio as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await flush();
      order.push("audio");
    });
    (ports.startStt as ReturnType<typeof vi.fn>).mockImplementation(() => void order.push("stt"));
    controller.dispatch({ type: "KEY_Y" });
    await flush();
    await flush();
    expect(order).toEqual(["audio", "stt"]);
  });

  it("a failing stt_start (model missing) ends the recording with its message", async () => {
    const { controller, ports } = setup({ state: "idle", editing: false, hasTranscript: false });
    (ports.startStt as ReturnType<typeof vi.fn>).mockRejectedValue(
      "The speech recognition model is not installed yet.",
    );
    controller.dispatch({ type: "KEY_Y" });
    await flush();
    await flush();
    expect(controller.model.state).toBe("idle");
    expect(ports.stopAudio).toHaveBeenCalled();
  });

  it("stops the microphone first, then flushes speech recognition", async () => {
    const { controller, ports } = recording();
    const order: string[] = [];
    (ports.stopAudio as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await flush();
      order.push("audio");
    });
    (ports.stopStt as ReturnType<typeof vi.fn>).mockImplementation(() => void order.push("stt"));
    controller.dispatch({ type: "KEY_ESC" });
    await controller.whenSettled();
    expect(order).toEqual(["audio", "stt"]);
  });

  it("a failing stopStt is logged and does not break whenSettled", async () => {
    const { controller, ports } = recording();
    (ports.stopStt as ReturnType<typeof vi.fn>).mockRejectedValue("boom");
    controller.dispatch({ type: "KEY_ESC" });
    await expect(controller.whenSettled()).resolves.toBeUndefined();
    expect(ports.log).toHaveBeenCalledWith("audio command failed: boom");
  });

  it("a partial updates the transcript, broadcasts it and sets hasTranscript", () => {
    const { controller, ports } = recording();
    controller.handleSttPartial({ text: "Write a short" });
    expect(controller.model.hasTranscript).toBe(true);
    expect(ports.broadcastTranscript).toHaveBeenLastCalledWith({
      segments: [],
      partial: "Write a short",
    });
  });

  it("a final replaces the partial", () => {
    const { controller, ports } = recording();
    controller.handleSttPartial({ text: "Write a short" });
    controller.handleSttFinal({ id: 0, text: "Write a short email." });
    expect(ports.broadcastTranscript).toHaveBeenLastCalledWith({
      segments: [{ id: 0, text: "Write a short email." }],
      partial: "",
    });
  });

  it("Y after speech goes to processing; Y with no speech says nothing heard", () => {
    const heard = recording();
    heard.controller.handleSttPartial({ text: "hello" });
    heard.controller.dispatch({ type: "KEY_Y" });
    expect(heard.controller.model.state).toBe("processing");

    const silent = recording();
    silent.controller.dispatch({ type: "KEY_Y" });
    expect(silent.controller.model.state).toBe("idle");
  });

  it("an empty partial after speech does not keep hasTranscript true", () => {
    const { controller } = recording();
    controller.handleSttPartial({ text: "hi" });
    controller.handleSttPartial({ text: "" });
    expect(controller.model.hasTranscript).toBe(false);
  });

  it("ignores malformed stt events", () => {
    const { controller, ports } = recording();
    for (const bad of [null, undefined, 3, "x", {}, { text: 5 }]) controller.handleSttPartial(bad);
    for (const bad of [null, {}, { id: "0", text: "x" }, { id: 0 }]) controller.handleSttFinal(bad);
    expect(ports.broadcastTranscript).not.toHaveBeenCalled();
    expect(controller.model.hasTranscript).toBe(false);
  });

  it("clearSession empties the transcript and broadcasts the empty snapshot", () => {
    const { controller, ports } = setup({ state: "result", editing: false, hasTranscript: true });
    controller.handleSttFinal({ id: 0, text: "Old." });
    controller.dispatch({ type: "KEY_Y" }); // result + Y: clear, then record
    expect(ports.broadcastTranscript).toHaveBeenLastCalledWith({ segments: [], partial: "" });
    expect(controller.model.hasTranscript).toBe(false);
    expect(ports.clearAudio).toHaveBeenCalled();
  });

  it("SYNC also resends the transcript", () => {
    const { controller, ports } = recording();
    controller.handleSttFinal({ id: 0, text: "Hello." });
    (ports.broadcastTranscript as ReturnType<typeof vi.fn>).mockClear();
    controller.handleAppEvent({ type: "SYNC" });
    expect(ports.broadcastTranscript).toHaveBeenCalledWith({
      segments: [{ id: 0, text: "Hello." }],
      partial: "",
    });
  });
});

describe("final pass in the processing flow", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  /** A recording with live text, ready for Y to start processing. */
  function recordedSession() {
    const t = setup({ state: "recording", editing: false, hasTranscript: false });
    t.controller.handleSttFinal({ id: 0, text: "Right a short emile." });
    return t;
  }
  const finalPass = (ports: ControllerPorts) => ports.runFinalPass as ReturnType<typeof vi.fn>;
  const lastTranscript = (ports: ControllerPorts) =>
    (ports.broadcastTranscript as ReturnType<typeof vi.fn>).mock.lastCall?.[0];

  it("runs after the recording has settled and replaces the live transcript in one step", async () => {
    const { controller, ports } = recordedSession();
    finalPass(ports).mockResolvedValue({ text: "Write a short email.", notice: null });
    controller.dispatch({ type: "KEY_Y" });
    expect(controller.model.state).toBe("processing");
    await controller.whenSettled();
    await flush();
    expect(ports.stopAudio).toHaveBeenCalled();
    expect(finalPass(ports)).toHaveBeenCalledTimes(1);
    expect(lastTranscript(ports)).toEqual({
      segments: [{ id: 1, text: "Write a short email." }],
      partial: "",
    });
  });

  it("the final pass waits for stopAudio and stopStt to finish", async () => {
    const { controller, ports } = recordedSession();
    const order: string[] = [];
    (ports.stopAudio as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await flush();
      order.push("stopAudio");
    });
    (ports.stopStt as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await flush();
      order.push("stopStt");
    });
    finalPass(ports).mockImplementation(async () => {
      order.push("finalPass");
      return { text: null, notice: null };
    });
    controller.dispatch({ type: "KEY_Y" });
    await flush();
    await flush();
    await flush();
    expect(order).toEqual(["stopAudio", "stopStt", "finalPass"]);
  });

  it("shows the Transcribing stage while it runs and clears it afterwards", async () => {
    const { controller, ports } = recordedSession();
    controller.dispatch({ type: "KEY_Y" });
    await controller.whenSettled();
    await flush();
    const calls = (ports.broadcastProgress as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls[0]).toEqual({ stage: "transcribing", done: 0, total: 0 });
    // The next stage (cleaning, by the language model) follows straight away.
    expect(calls[1]).toMatchObject({ stage: "cleaning" });
  });

  it("forwards chunk progress only while processing", async () => {
    const { controller, ports } = recordedSession();
    controller.handleFinalProgress({ done: 1, total: 3 }); // still recording: ignored
    expect(ports.broadcastProgress).not.toHaveBeenCalled();
    controller.dispatch({ type: "KEY_Y" });
    await controller.whenSettled();
    await flush();
    controller.handleFinalProgress({ done: 1, total: 3 });
    expect(ports.broadcastProgress).toHaveBeenCalledWith({
      stage: "transcribing",
      done: 1,
      total: 3,
    });
    controller.handleFinalProgress({ done: "x" });
    controller.handleFinalProgress(null);
  });

  it("a failed or skipped pass keeps the live transcript and shows the notice", async () => {
    const { controller, ports } = recordedSession();
    finalPass(ports).mockResolvedValue({ text: null, notice: "Polishing took too long." });
    controller.dispatch({ type: "KEY_Y" });
    await controller.whenSettled();
    await flush();
    expect(lastTranscript(ports)).toEqual({
      segments: [{ id: 0, text: "Right a short emile." }],
      partial: "",
    });
    expect(ports.showNotice).toHaveBeenCalledWith("Polishing took too long.");
  });

  it("a thrown error from the command is treated as a failed pass", async () => {
    const { controller, ports } = recordedSession();
    finalPass(ports).mockRejectedValue("ipc broke");
    controller.dispatch({ type: "KEY_Y" });
    await controller.whenSettled();
    await flush();
    expect(ports.showNotice).toHaveBeenCalledWith(
      "Polishing the transcript failed, so the live transcript was kept.",
    );
    expect(lastTranscript(ports).segments[0].text).toBe("Right a short emile.");
  });

  it("Esc before the pass starts cancels it and keeps the audio for the next recording", async () => {
    const { controller, ports } = recordedSession();
    controller.dispatch({ type: "KEY_Y" }); // processing: waits for the stop sequence
    controller.dispatch({ type: "KEY_ESC" }); // cancel immediately
    await controller.whenSettled();
    await flush();
    expect(finalPass(ports)).not.toHaveBeenCalled();
    expect(controller.model.state).toBe("idle");
  });

  it("a result that arrives after cancelling is ignored", async () => {
    const { controller, ports } = recordedSession();
    let release: (v: { text: string; notice: null }) => void = () => {};
    finalPass(ports).mockReturnValue(new Promise((r) => (release = r)));
    controller.dispatch({ type: "KEY_Y" });
    await controller.whenSettled();
    await flush();
    controller.dispatch({ type: "KEY_ESC" }); // cancel while Whisper is still running
    release({ text: "Late text.", notice: null });
    await flush();
    expect(lastTranscript(ports).segments.map((s: { text: string }) => s.text)).toEqual([
      "Right a short emile.",
    ]);
    expect(controller.model.state).toBe("idle");
  });

  it("after a cancelled pass, the next recording's pass only replaces its own text", async () => {
    const { controller, ports } = recordedSession();
    finalPass(ports).mockResolvedValueOnce({ text: "Polished first.", notice: null });
    controller.dispatch({ type: "KEY_Y" });
    await controller.whenSettled();
    await flush();
    controller.dispatch({ type: "KEY_ESC" }); // pipeline not done yet (Task 19): cancel, back to idle
    controller.dispatch({ type: "KEY_Y" }); // record again
    controller.handleSttFinal({ id: 0, text: "live second" });
    finalPass(ports).mockResolvedValueOnce({ text: "Polished second.", notice: null });
    controller.dispatch({ type: "KEY_Y" });
    await controller.whenSettled();
    await flush();
    expect(lastTranscript(ports).segments.map((s: { text: string }) => s.text)).toEqual([
      "Polished first.",
      "Polished second.",
    ]);
  });

  it("notify effects reach the chat window as notices", () => {
    const { controller, ports } = setup({
      state: "recording",
      editing: false,
      hasTranscript: false,
    });
    controller.dispatch({ type: "KEY_Y" }); // nothing heard
    expect(ports.showNotice).toHaveBeenCalledWith("Nothing heard");
  });
});

describe("transcript edits", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  /** Idle, editing, with a two-segment transcript (recorded earlier). */
  function editingSession() {
    const t = setup({ state: "idle", editing: false, hasTranscript: false });
    t.controller.dispatch({ type: "KEY_Y" }); // recording
    t.controller.handleSttFinal({ id: 0, text: "Write a short emile." });
    t.controller.handleSttFinal({ id: 1, text: "Thanks." });
    t.controller.dispatch({ type: "KEY_ESC" }); // stop, back to idle, transcript kept
    t.controller.handleAppEvent({ type: "EDIT_START" });
    (t.ports.broadcastTranscript as ReturnType<typeof vi.fn>).mockClear();
    (t.ports.clearAudio as ReturnType<typeof vi.fn>).mockClear();
    return t;
  }
  const last = (ports: ControllerPorts) =>
    (ports.broadcastTranscript as ReturnType<typeof vi.fn>).mock.lastCall?.[0];

  it("replaces one word, broadcasts, and drops the old audio so a later pass cannot undo it", async () => {
    const { controller, ports } = editingSession();
    expect(controller.model.editing).toBe(true);
    controller.handleAppEvent({
      type: "TRANSCRIPT_REPLACE_WORD",
      segmentId: 0,
      wordIndex: 3,
      text: "email.",
    });
    await flush();
    expect(last(ports).segments[0]).toEqual({ id: 0, text: "Write a short email." });
    expect(ports.clearAudio).toHaveBeenCalledTimes(1);
  });

  it("sets the whole text", () => {
    const { controller, ports } = editingSession();
    controller.handleAppEvent({ type: "TRANSCRIPT_SET_TEXT", text: "Entirely different." });
    expect(last(ports).segments).toEqual([{ id: 2, text: "Entirely different." }]);
    expect(controller.model.hasTranscript).toBe(true);
  });

  it("emptying the text clears hasTranscript", () => {
    const { controller } = editingSession();
    controller.handleAppEvent({ type: "TRANSCRIPT_SET_TEXT", text: "   " });
    expect(controller.model.hasTranscript).toBe(false);
  });

  it("ignores edits unless the app is editing", () => {
    const { controller, ports } = editingSession();
    controller.handleAppEvent({ type: "EDIT_END" });
    controller.handleAppEvent({ type: "TRANSCRIPT_SET_TEXT", text: "sneaky" });
    expect(ports.broadcastTranscript).not.toHaveBeenCalled();
  });

  it("ignores edits during recording and processing", () => {
    for (const state of ["recording", "processing"] as const) {
      const { controller, ports } = setup({ state, editing: true, hasTranscript: true });
      controller.handleSttFinal({ id: 0, text: "Hello there." });
      (ports.broadcastTranscript as ReturnType<typeof vi.fn>).mockClear();
      controller.handleAppEvent({ type: "TRANSCRIPT_SET_TEXT", text: "nope" });
      expect(ports.broadcastTranscript).not.toHaveBeenCalled();
    }
  });

  it("a no-op edit changes nothing and keeps the audio", () => {
    const { controller, ports } = editingSession();
    controller.handleAppEvent({
      type: "TRANSCRIPT_REPLACE_WORD",
      segmentId: 0,
      wordIndex: 3,
      text: "emile.",
    });
    expect(ports.broadcastTranscript).not.toHaveBeenCalled();
    expect(ports.clearAudio).not.toHaveBeenCalled();
  });

  it("ignores malformed edit payloads", () => {
    const { controller, ports } = editingSession();
    controller.handleAppEvent({ type: "TRANSCRIPT_SET_TEXT", text: 5 });
    controller.handleAppEvent({
      type: "TRANSCRIPT_REPLACE_WORD",
      segmentId: "0",
      wordIndex: 1,
      text: "x",
    });
    controller.handleAppEvent({ type: "TRANSCRIPT_REPLACE_WORD", segmentId: 0 });
    expect(ports.broadcastTranscript).not.toHaveBeenCalled();
  });

  it("after an edit, a new recording's final pass only touches the new text", async () => {
    const { controller, ports } = editingSession();
    controller.handleAppEvent({
      type: "TRANSCRIPT_REPLACE_WORD",
      segmentId: 0,
      wordIndex: 3,
      text: "email.",
    });
    controller.handleAppEvent({ type: "EDIT_END" });
    controller.dispatch({ type: "KEY_Y" }); // record more
    controller.handleSttFinal({ id: 0, text: "live more" });
    (ports.runFinalPass as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: "Polished more.",
      notice: null,
    });
    controller.dispatch({ type: "KEY_Y" });
    await controller.whenSettled();
    await flush();
    expect(last(ports).segments.map((s: { text: string }) => s.text)).toEqual([
      "Write a short email.",
      "Thanks.",
      "Polished more.",
    ]);
  });
});

describe("first-run setup gating", () => {
  const minimized = () => setup({ state: "minimized", editing: false, hasTranscript: false });

  it("with setup unfinished, a summon opens the wizard instead of an idle chat", () => {
    const { controller, calls } = minimized();
    controller.setSetupComplete(false);
    controller.dispatch({ type: "SUMMON" });
    expect(controller.model.state).toBe("setup");
    expect(calls).toContain("showChat");
  });

  it("with setup finished, a summon goes to idle as usual", () => {
    const { controller } = minimized();
    controller.setSetupComplete(true);
    controller.dispatch({ type: "SUMMON" });
    expect(controller.model.state).toBe("idle");
  });

  it("SETUP_DONE completes setup: later summons go to idle", () => {
    const { controller } = minimized();
    controller.setSetupComplete(false);
    controller.dispatch({ type: "SUMMON" }); // wizard
    controller.handleAppEvent({ type: "SETUP_DONE" });
    expect(controller.model.state).toBe("idle");
    controller.dispatch({ type: "KEY_ESC" }); // hide
    controller.dispatch({ type: "SUMMON" });
    expect(controller.model.state).toBe("idle");
  });

  it("dismissing the wizard with Esc does not let a later summon skip setup", () => {
    const { controller } = minimized();
    controller.setSetupComplete(false);
    controller.dispatch({ type: "SETUP_START" });
    controller.dispatch({ type: "KEY_ESC" }); // wizard hidden
    expect(controller.model.state).toBe("minimized");
    controller.dispatch({ type: "SUMMON" });
    expect(controller.model.state).toBe("setup");
  });

  it("a summon while the wizard is open focuses it", () => {
    const { controller, calls } = minimized();
    controller.setSetupComplete(false);
    controller.dispatch({ type: "SETUP_START" });
    calls.length = 0;
    controller.dispatch({ type: "SUMMON" });
    expect(controller.model.state).toBe("setup");
    expect(calls).toContain("focusChat");
  });

  it("SETUP_START from the chat window (re-run / repair) reopens the wizard and marks setup unfinished", () => {
    const { controller } = setup({ state: "idle", editing: false, hasTranscript: false });
    controller.handleAppEvent({ type: "SETUP_START" });
    expect(controller.model.state).toBe("setup");
    controller.dispatch({ type: "KEY_ESC" });
    controller.dispatch({ type: "SUMMON" });
    expect(controller.model.state).toBe("setup");
  });

  it("SETUP_START is ignored while recording and does not mark setup unfinished", () => {
    const { controller } = setup({ state: "recording", editing: false, hasTranscript: true });
    controller.handleAppEvent({ type: "SETUP_START" });
    expect(controller.model.state).toBe("recording");
    controller.dispatch({ type: "KEY_ESC" });
    controller.dispatch({ type: "KEY_ESC" }); // hide
    controller.dispatch({ type: "SUMMON" });
    expect(controller.model.state).toBe("idle");
  });
});

describe("prompt pipeline in the processing flow", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const TRANSCRIPT = "Write a short email to my landlord about the broken heater.";

  function pipelineResult(prompt: string, degraded = false): PipelineResult {
    return {
      prompt,
      degraded,
      stage0_text: TRANSCRIPT,
      clean_text: TRANSCRIPT,
      analysis: null,
      dropped: { count: 0, items: [] },
      warnings: [],
    };
  }

  function session(timeoutMs?: number) {
    const t = setup({ state: "recording", editing: false, hasTranscript: false });
    // `setup` has no timeout argument, so build the controller again when one is wanted.
    const controller =
      timeoutMs === undefined
        ? t.controller
        : new Controller(
            t.ports,
            { state: "recording", editing: false, hasTranscript: false },
            timeoutMs,
          );
    controller.handleSttFinal({ id: 0, text: TRANSCRIPT });
    return { ...t, controller };
  }
  const pipeline = (ports: ControllerPorts) => ports.runPipeline as ReturnType<typeof vi.fn>;
  const lastResult = (ports: ControllerPorts) =>
    (ports.broadcastResult as ReturnType<typeof vi.fn>).mock.lastCall?.[0] as ResultPayload | null;
  const lastError = (ports: ControllerPorts) =>
    (ports.broadcastError as ReturnType<typeof vi.fn>).mock
      .lastCall?.[0] as ProcessErrorPayload | null;

  /** Y to stop and process, then let every pending promise settle. */
  async function process(controller: Controller) {
    controller.dispatch({ type: "KEY_Y" });
    await controller.whenSettled();
    await flush();
    await flush();
  }

  it("idle -> recording -> Y -> processing -> result with a fake STT and a fake model", async () => {
    const { controller, ports } = session();
    pipeline(ports).mockResolvedValue(pipelineResult("Task: Write a short email."));
    await process(controller);
    expect(controller.model.state).toBe("result");
    expect(pipeline(ports)).toHaveBeenCalledTimes(1);
    expect(pipeline(ports).mock.calls[0][0].transcript).toBe(TRANSCRIPT);
    expect(lastResult(ports)).toMatchObject({
      prompt: "Task: Write a short email.",
      degraded: false,
      tokensIn: Math.ceil(TRANSCRIPT.length / 4),
      tokensOut: Math.ceil("Task: Write a short email.".length / 4),
    });
  });

  it("reports the stages in order, with the cleaned text, and clears them at the end", async () => {
    const { controller, ports } = session();
    pipeline(ports).mockImplementation(async (o) => {
      o.onStage?.("normalize", { clean_text: "Write a short email to my landlord." });
      o.onStage?.("analyze", {});
      o.onStage?.("render", { prompt: "x" });
      return pipelineResult("Task: x");
    });
    await process(controller);
    const calls = (ports.broadcastProgress as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls.map((c) => c?.stage ?? null)).toEqual([
      "transcribing",
      "cleaning",
      "analysing",
      "writing",
      null,
    ]);
    expect(calls[2].clean).toBe("Write a short email to my landlord.");
  });

  it("a degraded prompt is flagged in the result", async () => {
    const { controller, ports } = session();
    pipeline(ports).mockResolvedValue(pipelineResult("Task: minimal", true));
    await process(controller);
    expect(controller.model.state).toBe("result");
    expect(lastResult(ports)?.degraded).toBe(true);
  });

  it("Esc aborts the request in flight and returns to idle with the transcript intact", async () => {
    const { controller, ports } = session();
    let signal: AbortSignal | undefined;
    pipeline(ports).mockImplementation(
      (o) =>
        new Promise((_, reject) => {
          signal = o.signal;
          o.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );
    await process(controller);
    expect(controller.model.state).toBe("processing");
    expect(signal?.aborted).toBe(false);
    controller.dispatch({ type: "KEY_ESC" });
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(controller.model.state).toBe("idle");
    expect(ports.broadcastResult).not.toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.anything() }),
    );
    expect(ports.broadcastError).not.toHaveBeenCalled();
    expect(
      (ports.broadcastTranscript as ReturnType<typeof vi.fn>).mock.lastCall?.[0].segments[0].text,
    ).toBe(TRANSCRIPT);
  });

  it("a result that arrives after Esc is ignored", async () => {
    const { controller, ports } = session();
    let finish: (r: PipelineResult) => void = () => {};
    pipeline(ports).mockImplementation(() => new Promise((r) => (finish = r)));
    await process(controller);
    controller.dispatch({ type: "KEY_ESC" });
    finish(pipelineResult("Task: too late"));
    await flush();
    expect(controller.model.state).toBe("idle");
    expect(ports.broadcastResult).not.toHaveBeenCalled();
  });

  it("gives up after the timeout and offers a retry", async () => {
    const { controller, ports } = session(20);
    pipeline(ports).mockImplementation(
      (o) =>
        new Promise((_, reject) =>
          o.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          ),
        ),
    );
    await process(controller);
    await new Promise((r) => setTimeout(r, 60));
    expect(controller.model.state).toBe("idle");
    expect(lastError(ports)).toEqual({ kind: "timeout", message: PROCESS_MESSAGES.timeout });
    expect(ports.showNotice).toHaveBeenCalledWith(PROCESS_MESSAGES.timeout);
  });

  it("an unreachable Ollama is started once, then the run is tried again", async () => {
    const { controller, ports } = session();
    pipeline(ports)
      .mockRejectedValueOnce(new LlmError("Cannot reach Ollama: connection refused"))
      .mockResolvedValueOnce(pipelineResult("Task: ok"));
    await process(controller);
    expect(ports.startOllama).toHaveBeenCalledTimes(1);
    expect(pipeline(ports)).toHaveBeenCalledTimes(2);
    expect(controller.model.state).toBe("result");
  });

  it("an Ollama that cannot be started ends in an 'unreachable' error with Retry", async () => {
    const { controller, ports } = session();
    pipeline(ports).mockRejectedValue(new LlmError("Cannot reach Ollama: connection refused"));
    (ports.startOllama as ReturnType<typeof vi.fn>).mockRejectedValue("Ollama is not installed.");
    await process(controller);
    expect(ports.startOllama).toHaveBeenCalledTimes(1);
    expect(pipeline(ports)).toHaveBeenCalledTimes(1);
    expect(controller.model.state).toBe("idle");
    expect(lastError(ports)?.kind).toBe("unreachable");
  });

  it("a second unreachable answer after starting Ollama is an error, not a loop", async () => {
    const { controller, ports } = session();
    pipeline(ports).mockRejectedValue(new LlmError("Cannot reach Ollama: connection refused"));
    await process(controller);
    expect(ports.startOllama).toHaveBeenCalledTimes(1);
    expect(pipeline(ports)).toHaveBeenCalledTimes(2);
    expect(lastError(ports)?.kind).toBe("unreachable");
  });

  it("a missing model is reported as such and Ollama is not restarted", async () => {
    const { controller, ports } = session();
    pipeline(ports).mockRejectedValue(new LlmError("model 'x' not found", 404));
    await process(controller);
    expect(ports.startOllama).not.toHaveBeenCalled();
    expect(lastError(ports)).toEqual({
      kind: "model-missing",
      message: PROCESS_MESSAGES["model-missing"],
    });
  });

  it("an unexpected failure is a plain 'failed' error and the log has no text in it", async () => {
    const { controller, ports } = session();
    pipeline(ports).mockRejectedValue(new Error(`boom ${TRANSCRIPT}`));
    await process(controller);
    expect(lastError(ports)?.kind).toBe("failed");
    const logged = (ports.log as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(logged).not.toContain("landlord");
  });

  it("Retry (PROCESS_RETRY) after a failure runs the pipeline again and clears the error", async () => {
    const { controller, ports } = session();
    pipeline(ports).mockRejectedValueOnce(new Error("boom"));
    await process(controller);
    expect(controller.model.state).toBe("idle");
    pipeline(ports).mockResolvedValueOnce(pipelineResult("Task: second try"));
    controller.handleAppEvent({ type: "PROCESS_RETRY" });
    await flush();
    await flush();
    expect(controller.model.state).toBe("result");
    expect(lastError(ports)).toBeNull();
    expect(lastResult(ports)?.prompt).toBe("Task: second try");
  });

  it("keeps the last 10 prompts, newest first", async () => {
    const { controller, ports } = session();
    for (let i = 1; i <= 12; i++) {
      pipeline(ports).mockResolvedValueOnce(pipelineResult(`Task: ${i}`));
      if (i === 1) await process(controller);
      else {
        controller.handleAppEvent({ type: "PROCESS_RETRY" });
        await flush();
        await flush();
      }
    }
    const recent = lastResult(ports)?.recent ?? [];
    expect(recent).toHaveLength(10);
    expect(recent[0].prompt).toBe("Task: 12");
    expect(recent[9].prompt).toBe("Task: 3");
  });

  it("an empty transcript is reported as 'empty'", async () => {
    const { controller, ports } = session();
    pipeline(ports).mockRejectedValue(new EmptyTranscriptError());
    await process(controller);
    expect(lastError(ports)?.kind).toBe("empty");
  });

  it("a new recording clears the previous result and error", async () => {
    const { controller, ports } = session();
    pipeline(ports).mockResolvedValue(pipelineResult("Task: one"));
    await process(controller);
    expect(controller.model.state).toBe("result");
    controller.dispatch({ type: "KEY_Y" }); // result + Y = next recording
    expect(lastResult(ports)).toBeNull();
    expect(lastError(ports)).toBeNull();
  });

  it("SYNC sends the current result and error to a chat window that just loaded", async () => {
    const { controller, ports } = session();
    pipeline(ports).mockResolvedValue(pipelineResult("Task: one"));
    await process(controller);
    (ports.broadcastResult as ReturnType<typeof vi.fn>).mockClear();
    controller.handleAppEvent({ type: "SYNC" });
    expect(lastResult(ports)?.prompt).toBe("Task: one");
  });

  it("warms the language model when setup is known to be complete, and after setup finishes", async () => {
    const { controller, ports } = setup();
    controller.setSetupComplete(false);
    expect(ports.warmModel).not.toHaveBeenCalled();
    controller.setSetupComplete(true);
    expect(ports.warmModel).toHaveBeenCalledTimes(1);
    const second = setup({ state: "setup", editing: false, hasTranscript: false });
    second.controller.dispatch({ type: "SETUP_DONE" });
    expect(second.ports.warmModel).toHaveBeenCalledTimes(1);
  });

  it("a failing warm-up is ignored", async () => {
    const { controller, ports } = setup();
    (ports.warmModel as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no ollama"));
    controller.setSetupComplete(true);
    await flush();
    expect(controller.model.state).toBe("minimized");
  });
});

describe("classifyProcessError", () => {
  it("maps what the pipeline throws to a kind", () => {
    expect(classifyProcessError(new Error("x"), true)).toBe("timeout");
    expect(classifyProcessError(new EmptyTranscriptError(), false)).toBe("empty");
    expect(classifyProcessError(new LlmError("not found", 404), false)).toBe("model-missing");
    expect(classifyProcessError(new LlmError("model 'q' not found"), false)).toBe("model-missing");
    expect(classifyProcessError(new LlmError("Cannot reach Ollama: x"), false)).toBe("unreachable");
    expect(classifyProcessError(new LlmError("server error", 500), false)).toBe("failed");
    expect(classifyProcessError("weird", false)).toBe("failed");
  });
});

describe("attachments in the processing flow", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const meta = [{ name: "report.pdf", type: "pdf", preview: "Quarterly revenue" }];

  function recorded() {
    const t = setup({ state: "recording", editing: false, hasTranscript: false });
    t.controller.handleSttFinal({ id: 0, text: "Summarize this report." });
    return t;
  }
  async function process(controller: Controller) {
    controller.dispatch({ type: "KEY_Y" });
    await controller.whenSettled();
    await flush();
  }
  const pipelineOptions = (ports: ControllerPorts) =>
    (ports.runPipeline as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];

  it("hands the attachments' names, types and previews to the pipeline", async () => {
    const { controller, ports } = recorded();
    controller.handleAppEvent({ type: "ATTACHMENTS_SET", items: meta });
    await process(controller);
    expect(pipelineOptions(ports).attachments).toEqual(meta);
  });

  it("the pipeline gets no attachments when none were added", async () => {
    const { controller, ports } = recorded();
    await process(controller);
    expect(pipelineOptions(ports).attachments).toEqual([]);
  });

  it("the latest list replaces the earlier one (a removed chip is gone)", async () => {
    const { controller, ports } = recorded();
    controller.handleAppEvent({ type: "ATTACHMENTS_SET", items: meta });
    controller.handleAppEvent({ type: "ATTACHMENTS_SET", items: [] });
    await process(controller);
    expect(pipelineOptions(ports).attachments).toEqual([]);
  });

  it("malformed payloads are ignored safely", async () => {
    const { controller, ports } = recorded();
    controller.handleAppEvent({ type: "ATTACHMENTS_SET", items: "nope" });
    controller.handleAppEvent({ type: "ATTACHMENTS_SET", items: [null, 3, { name: 1 }] });
    await process(controller);
    expect(pipelineOptions(ports).attachments).toEqual([]);
  });

  it("a new session forgets the attachments and tells the chat window", async () => {
    const { controller, ports } = setup({ state: "idle", editing: false, hasTranscript: true });
    controller.handleAppEvent({ type: "ATTACHMENTS_SET", items: meta });
    controller.dispatch({ type: "NEW_SESSION" });
    expect(ports.clearAttachments).toHaveBeenCalledTimes(1);
    controller.dispatch({ type: "KEY_Y" });
    controller.handleSttFinal({ id: 0, text: "Hello again." });
    await process(controller);
    expect(pipelineOptions(ports).attachments).toEqual([]);
  });

  it("recording again in the same session keeps the attachments", () => {
    const { controller, ports } = setup({ state: "idle", editing: false, hasTranscript: false });
    controller.handleAppEvent({ type: "ATTACHMENTS_SET", items: meta });
    controller.dispatch({ type: "KEY_Y" }); // idle -> recording
    expect(ports.clearAttachments).not.toHaveBeenCalled();
  });
});

describe("privacy of the diagnostic log", () => {
  it("an unknown app:event is logged without any of its text fields", () => {
    const { controller, ports } = setup();
    controller.handleAppEvent({ type: "WHAT", text: "my landlord is awful", prompt: "Task: x" });
    const line = (ports.log as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(line).toContain("ignored unknown app:event");
    expect(line).toContain("WHAT");
    expect(line).not.toMatch(/landlord|Task: x/);
  });
});
