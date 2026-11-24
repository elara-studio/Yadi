import { describe, expect, it, vi } from "vitest";
import { Controller, errorMessage, mascotStateFor, type ControllerPorts } from "./controller";

function setup(initial?: ConstructorParameters<typeof Controller>[1]) {
  const calls: string[] = [];
  const ports: ControllerPorts = {
    showChat: vi.fn(() => void calls.push("showChat")),
    hideChat: vi.fn(() => void calls.push("hideChat")),
    focusChat: vi.fn(() => void calls.push("focusChat")),
    showView: vi.fn((v) => void calls.push(`view:${v}`)),
    startAudio: vi.fn(),
    startStt: vi.fn(),
    stopStt: vi.fn(),
    broadcastTranscript: vi.fn(),
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
    expect(ports.log).toHaveBeenCalledWith("effect (stub): startProcessing");
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
    ["setup", "idle"],
    ["minimized", "idle"],
    ["idle", "idle"],
    ["recording", "listening"],
    ["processing", "thinking"],
    ["result", "done"],
  ] as const)("%s -> %s", (state, expected) => {
    expect(mascotStateFor({ state, editing: false, hasTranscript: false })).toBe(expected);
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
    expect(ports.log).toHaveBeenCalledWith("effect (stub): notify");
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
