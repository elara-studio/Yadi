import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const emit = vi.fn(() => Promise.resolve());
const handlers = new Map<string, (e: { payload: unknown }) => void>();
const listen = vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
  handlers.set(name, cb);
  return Promise.resolve(() => handlers.delete(name));
});

const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>((cmd) =>
  Promise.resolve(cmd === "get_notice" ? null : undefined),
);

vi.mock("@tauri-apps/api/event", () => ({ emit, listen }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("0.1.0") }));

vi.mock("../../setup/SetupWizard", () => ({
  SetupWizard: ({
    onFinished,
    onOpenAbout,
  }: {
    onFinished: () => void;
    onOpenAbout?: () => void;
  }) => (
    <div data-testid="wizard-stub">
      <button onClick={onFinished}>finish-setup</button>
      <button onClick={onOpenAbout}>open-about</button>
    </div>
  ),
}));

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

  it("lists Transcribing as the first stage while processing and shows chunk progress", async () => {
    render(<ChatWindow />);
    await act(async () => {});
    expect(screen.queryByLabelText("Progress")).not.toBeInTheDocument();
    act(() => handlers.get("app:state")?.({ payload: { state: "processing", editing: false } }));
    expect(screen.getByLabelText("Progress")).toHaveTextContent("Transcribing…");
    act(() =>
      handlers.get("app:progress")?.({ payload: { stage: "transcribing", done: 1, total: 3 } }),
    );
    expect(screen.getByLabelText("Progress")).toHaveTextContent("Transcribing 1/3");
    act(() => handlers.get("app:state")?.({ payload: { state: "idle", editing: false } }));
    expect(screen.queryByLabelText("Progress")).not.toBeInTheDocument();
  });

  it("shows runtime notices sent as app:notice", async () => {
    render(<ChatWindow />);
    await act(async () => {});
    act(() =>
      handlers.get("app:notice")?.({
        payload: { message: "Nothing heard", action: null },
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing heard");
  });

  it("shows the setup wizard instead of the chat while the app is in the setup state", async () => {
    render(<ChatWindow />);
    await act(async () => {});
    act(() => handlers.get("app:state")?.({ payload: { state: "setup", editing: false } }));
    expect(await screen.findByTestId("wizard-stub")).toBeInTheDocument();
    expect(screen.queryByTestId("transcript")).not.toBeInTheDocument();
    expect(screen.queryByText(KEY_HINT)).not.toBeInTheDocument();
  });

  it("finishing the wizard tells the Controller SETUP_DONE", async () => {
    render(<ChatWindow />);
    await act(async () => {});
    act(() => handlers.get("app:state")?.({ payload: { state: "setup", editing: false } }));
    fireEvent.click(await screen.findByText("finish-setup"));
    expect(emit).toHaveBeenCalledWith("app:event", { type: "SETUP_DONE" });
  });

  it("the wizard's licences link opens About", async () => {
    render(<ChatWindow />);
    await act(async () => {});
    act(() => handlers.get("app:state")?.({ payload: { state: "setup", editing: false } }));
    fireEvent.click(await screen.findByText("open-about"));
    expect(await screen.findByRole("heading", { name: "Yadi" })).toBeInTheDocument();
    expect(screen.queryByTestId("wizard-stub")).not.toBeInTheDocument();
  });

  it("Settings -> Re-run setup saves a fresh progress file and asks for SETUP_START", async () => {
    const defaults = invoke.getMockImplementation();
    invoke.mockImplementation((cmd: string) =>
      cmd === "get_settings"
        ? Promise.resolve({
            summon: { mode: "longpress-y", threshold_ms: 400, chord: "CommandOrControl+Shift+Y" },
            finalPass: { enabled: true, timeout_seconds: 20 },
          })
        : Promise.resolve(cmd === "get_notice" ? null : undefined),
    );
    render(<ChatWindow />);
    await act(async () => {});
    fireEvent.click(screen.getByLabelText("Settings"));
    fireEvent.click(await screen.findByRole("button", { name: "Repair models" }));
    await waitFor(() => expect(emit).toHaveBeenCalledWith("app:event", { type: "SETUP_START" }));
    const save = invoke.mock.calls.find((c) => c[0] === "save_setup_state");
    expect(save?.[1]).toMatchObject({
      state: { repair: true, steps: { welcome: "pending", ollama: "pending" } },
    });
    if (defaults) invoke.mockImplementation(defaults);
  });
});
