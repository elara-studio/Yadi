import { describe, expect, it, vi } from "vitest";
import { Controller, mascotStateFor, type ControllerPorts } from "./controller";

function setup(initial?: ConstructorParameters<typeof Controller>[1]) {
  const calls: string[] = [];
  const ports: ControllerPorts = {
    showChat: vi.fn(() => void calls.push("showChat")),
    hideChat: vi.fn(() => void calls.push("hideChat")),
    focusChat: vi.fn(() => void calls.push("focusChat")),
    showView: vi.fn((v) => void calls.push(`view:${v}`)),
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

  it("walks idle -> recording -> processing -> result with Y and logs stub effects", () => {
    const { controller, ports } = setup();
    controller.dispatch({ type: "SUMMON" });
    controller.dispatch({ type: "KEY_Y" });
    expect(controller.model.state).toBe("recording");
    controller.dispatch({ type: "TRANSCRIPT_CHANGED", hasTranscript: true });
    controller.dispatch({ type: "KEY_Y" });
    expect(controller.model.state).toBe("processing");
    controller.dispatch({ type: "PROCESS_DONE" });
    expect(controller.model.state).toBe("result");
    expect(ports.log).toHaveBeenCalledWith("effect (stub): startRecording");
    expect(ports.log).toHaveBeenCalledWith("effect (stub): startProcessing");
  });

  it("toggleChat opens when minimized", () => {
    const { controller } = setup();
    controller.toggleChat();
    expect(controller.model.state).toBe("idle");
  });

  it("toggleChat while recording stops and hides (two Escs)", () => {
    const { controller, ports } = setup({
      state: "recording",
      editing: false,
      hasTranscript: true,
    });
    controller.toggleChat();
    expect(controller.model.state).toBe("minimized");
    expect(ports.hideChat).toHaveBeenCalledTimes(1);
    expect(ports.log).toHaveBeenCalledWith("effect (stub): stopRecording");
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
