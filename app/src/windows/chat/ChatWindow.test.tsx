import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const emit = vi.fn(() => Promise.resolve());
const handlers = new Map<string, (e: { payload: unknown }) => void>();
const listen = vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
  handlers.set(name, cb);
  return Promise.resolve(() => handlers.delete(name));
});

const invoke = vi.fn<(cmd: string) => Promise<unknown>>((cmd) =>
  Promise.resolve(cmd === "get_notice" ? null : undefined),
);

vi.mock("@tauri-apps/api/event", () => ({ emit, listen }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("0.1.0") }));

const { ChatWindow, KEY_HINT } = await import("./ChatWindow");

describe("ChatWindow", () => {
  beforeEach(() => {
    emit.mockClear();
    invoke.mockClear();
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

  it("shows a startup notice with a Fix button that opens the permission settings", async () => {
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === "get_notice"
          ? { message: "Hold-Y needs keyboard permission.", action: "fix-permissions" }
          : undefined,
      ),
    );
    render(<ChatWindow />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Hold-Y needs keyboard permission.");
    fireEvent.click(screen.getByRole("button", { name: "Fix" }));
    expect(invoke).toHaveBeenCalledWith("open_permission_settings");
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "get_notice" ? null : undefined),
    );
  });

  it("a notice without an action has no Fix button", async () => {
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === "get_notice" ? { message: "Hold-Y is unavailable.", action: null } : undefined,
      ),
    );
    render(<ChatWindow />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Fix" })).not.toBeInTheDocument();
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "get_notice" ? null : undefined),
    );
  });

  it("the gear button opens Settings", async () => {
    render(<ChatWindow />);
    fireEvent.click(screen.getByLabelText("Settings"));
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith("get_settings");
    expect(screen.queryByText(KEY_HINT)).not.toBeInTheDocument();
  });

  it("shows the transcript: finished segments plus the revising partial", async () => {
    render(<ChatWindow />);
    await act(async () => {});
    expect(screen.getByText("Press Y and start talking.")).toBeInTheDocument();
    act(() =>
      handlers.get("app:transcript")?.({
        payload: { segments: [{ id: 0, text: "Write a short email." }], partial: "Thanks a" },
      }),
    );
    const box = screen.getByTestId("transcript");
    expect(box).toHaveTextContent("Write a short email. Thanks a");
    expect(screen.queryByText("Press Y and start talking.")).not.toBeInTheDocument();
  });
});
