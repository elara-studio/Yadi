import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AppEvent } from "@yadi/core";
import { useKeyboardControls } from "./useKeyboardControls";
import { Controller, mascotStateFor, type ControllerPorts } from "../mascot/controller";

function Harness({ send, yEnabled }: { send: (e: AppEvent) => void; yEnabled?: boolean }) {
  useKeyboardControls(send, yEnabled);
  return (
    <div>
      <textarea aria-label="editor" />
      <input aria-label="field" />
      <div aria-label="rich" contentEditable suppressContentEditableWarning />
      <button>btn</button>
    </div>
  );
}

const setup = () => {
  const send = vi.fn();
  render(<Harness send={send} />);
  return send;
};

describe("useKeyboardControls", () => {
  it("Y with focus on body emits KEY_Y", () => {
    const send = setup();
    fireEvent.keyDown(document.body, { key: "y" });
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "KEY_Y" });
  });

  it("with Y switched off (Settings open) Y emits nothing, but Esc still works", () => {
    const send = vi.fn();
    render(<Harness send={send} yEnabled={false} />);
    const y = fireEvent.keyDown(document.body, { key: "y" });
    expect(y).toBe(true); // not prevented
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "KEY_ESC" });
  });

  it("capital Y (caps lock) also works", () => {
    const send = setup();
    fireEvent.keyDown(document.body, { key: "Y" });
    expect(send).toHaveBeenCalledWith({ type: "KEY_Y" });
  });

  it("Y when focus is in a textarea, input or contenteditable emits nothing", () => {
    const send = setup();
    for (const label of ["editor", "field", "rich"]) {
      fireEvent.keyDown(screen.getByLabelText(label), { key: "y" });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("a held Y (repeat) emits once", () => {
    const send = setup();
    fireEvent.keyDown(document.body, { key: "y" });
    fireEvent.keyDown(document.body, { key: "y", repeat: true });
    fireEvent.keyDown(document.body, { key: "y", repeat: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("Y with Ctrl, Cmd, Alt or Shift is ignored", () => {
    const send = setup();
    for (const mod of ["ctrlKey", "metaKey", "altKey", "shiftKey"]) {
      fireEvent.keyDown(document.body, { key: "y", [mod]: true });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("other keys are ignored", () => {
    const send = setup();
    fireEvent.keyDown(document.body, { key: "a" });
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(send).not.toHaveBeenCalled();
  });

  it("Esc outside an editor emits KEY_ESC and is prevented", () => {
    const send = setup();
    const notPrevented = fireEvent.keyDown(document.body, { key: "Escape" });
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "KEY_ESC" });
    expect(notPrevented).toBe(false);
  });

  it("Esc in an editor emits only EDIT_END and is not prevented", () => {
    const send = setup();
    const notPrevented = fireEvent.keyDown(screen.getByLabelText("editor"), { key: "Escape" });
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "EDIT_END" });
    expect(notPrevented).toBe(true);
  });

  it("never prevents default for keys typed in an editor", () => {
    setup();
    expect(fireEvent.keyDown(screen.getByLabelText("editor"), { key: "y" })).toBe(true);
  });

  it("Y outside an editor is prevented", () => {
    setup();
    expect(fireEvent.keyDown(document.body, { key: "y" })).toBe(false);
  });

  it("removes its listener on unmount", () => {
    const send = vi.fn();
    const { unmount } = render(<Harness send={send} />);
    unmount();
    fireEvent.keyDown(document.body, { key: "y" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("keyboard -> Controller integration", () => {
  function wire() {
    const calls: string[] = [];
    const ports: ControllerPorts = {
      showChat: () => void calls.push("showChat"),
      hideChat: () => void calls.push("hideChat"),
      focusChat: () => void calls.push("focusChat"),
      broadcast: (p) => void calls.push(`state:${p.state}`),
      showView: () => {},
      startAudio: () => {},
      startStt: () => {},
      runFinalPass: () => ({ text: null, notice: null }),
      showNotice: () => {},
      broadcastProgress: () => {},
      stopStt: () => {},
      broadcastTranscript: () => {},
      runPipeline: () => new Promise(() => {}),
      startOllama: async () => {},
      warmModel: async () => {},
      broadcastResult: () => {},
      broadcastError: () => {},
      clearAttachments: () => {},
      recordSavings: () => {},
      stopAudio: () => {},
      clearAudio: () => {},
      log: (m) => void calls.push(m),
    };
    const controller = new Controller(ports);
    // The chat window's `emit("app:event")` arrives in the Controller's handleAppEvent.
    render(<Harness send={(e) => controller.handleAppEvent(e)} />);
    return { controller, calls };
  }
  const key = (k: string) => fireEvent.keyDown(document.body, { key: k });

  it("walks idle -> recording -> processing -> result with Y, then Esc, Esc to minimized", () => {
    const { controller, calls } = wire();
    controller.dispatch({ type: "SUMMON" });
    expect(controller.model.state).toBe("idle");

    key("y");
    expect(controller.model.state).toBe("recording");
    expect(mascotStateFor(controller.model)).toBe("listening");

    controller.handleAppEvent({ type: "TRANSCRIPT_CHANGED", hasTranscript: true });
    key("y");
    expect(controller.model.state).toBe("processing");
    expect(mascotStateFor(controller.model)).toBe("thinking");

    controller.handleAppEvent({ type: "PROCESS_DONE" });
    expect(controller.model.state).toBe("result");
    expect(mascotStateFor(controller.model)).toBe("done");

    key("Escape");
    expect(controller.model.state).toBe("minimized");
    expect(calls).toContain("hideChat");
  });

  it("Esc while recording stops it and returns to idle; a second Esc minimizes", () => {
    const { controller } = wire();
    controller.dispatch({ type: "SUMMON" });
    key("y");
    key("Escape");
    expect(controller.model.state).toBe("idle");
    key("Escape");
    expect(controller.model.state).toBe("minimized");
  });

  it("Y does nothing while editing", () => {
    const { controller } = wire();
    controller.dispatch({ type: "SUMMON" });
    controller.dispatch({ type: "EDIT_START" });
    key("y");
    expect(controller.model.state).toBe("idle");
    expect(controller.model.editing).toBe(true);
  });
});
