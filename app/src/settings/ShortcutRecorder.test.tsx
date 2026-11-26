import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const invoke = vi.fn((cmd: string) => Promise.resolve(cmd === "" ? null : undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const { ShortcutRecorder } = await import("./ShortcutRecorder");

const keys = () => screen.getByTestId("shortcut-keys");

beforeEach(() => invoke.mockClear());

describe("ShortcutRecorder", () => {
  it("shows the current shortcut", () => {
    render(<ShortcutRecorder chord="CommandOrControl+Shift+Y" onChange={() => {}} mac />);
    expect(keys()).toHaveTextContent("⌘⇧Y");
  });

  it("records the keys pressed together and pauses the global shortcut meanwhile", async () => {
    const onChange = vi.fn();
    render(<ShortcutRecorder chord="CommandOrControl+Shift+Y" onChange={onChange} mac />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Change" })));
    expect(invoke).toHaveBeenCalledWith("summon_capture_start");
    expect(screen.getByRole("status")).toHaveTextContent("Press the keys");

    act(() => void fireEvent.keyDown(window, { code: "AltLeft", altKey: true }));
    expect(keys()).toHaveTextContent("⌥…");
    await act(async () => void fireEvent.keyDown(window, { code: "KeyK", altKey: true }));

    expect(onChange).toHaveBeenCalledWith("Alt+K");
    expect(invoke).toHaveBeenCalledWith("summon_capture_end");
    expect(screen.getByRole("button", { name: "Change" })).toBeInTheDocument();
  });

  it("keeps keys away from the rest of the window while recording", async () => {
    const outside = vi.fn();
    window.addEventListener("keydown", outside);
    render(<ShortcutRecorder chord="Alt+Y" onChange={() => {}} mac />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Change" })));
    act(() => void fireEvent.keyDown(document.body, { code: "KeyY", key: "y" }));
    expect(outside).not.toHaveBeenCalled();
    window.removeEventListener("keydown", outside);
  });

  it("explains instead of accepting a key without a modifier", async () => {
    const onChange = vi.fn();
    render(<ShortcutRecorder chord="Alt+Y" onChange={onChange} mac />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Change" })));
    act(() => void fireEvent.keyDown(window, { code: "KeyY", shiftKey: true }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Shift alone is not enough");
  });

  it("Esc cancels and keeps the old shortcut", async () => {
    const onChange = vi.fn();
    render(<ShortcutRecorder chord="Alt+Y" onChange={onChange} mac />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Change" })));
    await act(async () => void fireEvent.keyDown(window, { code: "Escape", key: "Escape" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(keys()).toHaveTextContent("⌥Y");
    expect(invoke).toHaveBeenCalledWith("summon_capture_end");
  });
});
