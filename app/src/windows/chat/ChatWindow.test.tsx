import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const emit = vi.fn(() => Promise.resolve());
const handlers = new Map<string, (e: { payload: unknown }) => void>();
const listen = vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
  handlers.set(name, cb);
  return Promise.resolve(() => handlers.delete(name));
});

vi.mock("@tauri-apps/api/event", () => ({ emit, listen }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("0.1.0") }));

const { ChatWindow, KEY_HINT } = await import("./ChatWindow");

describe("ChatWindow", () => {
  beforeEach(() => {
    emit.mockClear();
    handlers.clear();
  });

  it("shows the key hint row", () => {
    render(<ChatWindow />);
    expect(screen.getByText(KEY_HINT)).toBeInTheDocument();
    expect(KEY_HINT).toBe("Y = next step · Esc = stop / hide");
  });

  it("asks the Controller for the current state on load", async () => {
    render(<ChatWindow />);
    await act(async () => {});
    expect(emit).toHaveBeenCalledWith("app:event", { type: "SYNC" });
  });

  it("sends Y to the Controller as an app:event", () => {
    render(<ChatWindow />);
    fireEvent.keyDown(document.body, { key: "y" });
    expect(emit).toHaveBeenCalledWith("app:event", { type: "KEY_Y" });
  });

  it("shows the state broadcast by the Controller", async () => {
    render(<ChatWindow />);
    await act(async () => {});
    act(() => handlers.get("app:state")?.({ payload: { state: "recording", editing: false } }));
    expect(screen.getByTestId("chat-state")).toHaveTextContent("recording");
  });

  it("the i button opens About (view switch) and app:view can too", async () => {
    render(<ChatWindow />);
    await act(async () => {});
    expect(screen.getByLabelText("About Yadi")).toBeInTheDocument();
    act(() => handlers.get("app:view")?.({ payload: { view: "about" } }));
    await act(async () => {}); // let AboutView's async loading settle
    expect(screen.queryByText(KEY_HINT)).not.toBeInTheDocument();
  });
});
