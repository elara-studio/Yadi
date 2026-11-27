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

const { ChatWindow, KEY_HINT, RESULT_KEY_HINT } = await import("./ChatWindow");

/** Arguments of the most recent `summon_set_paused` call. */
const lastPause = () =>
  invoke.mock.calls.filter(([cmd]) => cmd === "summon_set_paused").at(-1)?.[1];

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

  it("can be dragged by its grip and its title bar, on every screen", async () => {
    render(<ChatWindow />);
    await act(async () => {});
    expect(screen.getByTestId("chat-grip")).toHaveAttribute("data-tauri-drag-region");
    expect(screen.getByTestId("chat-state").parentElement).toHaveAttribute(
      "data-tauri-drag-region",
    );
    // The buttons in the title bar stay clickable: only the bar itself drags.
    expect(screen.getByLabelText("Settings")).not.toHaveAttribute("data-tauri-drag-region");
    act(() => handlers.get("app:view")?.({ payload: { view: "settings" } }));
    expect(screen.getByTestId("chat-grip")).toBeInTheDocument();
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

  it("while Settings is shown, Y types normally and Hold-Y is paused; leaving resumes it", async () => {
    render(<ChatWindow />);
    await act(async () => {});
    act(() => handlers.get("app:state")?.({ payload: { state: "idle", editing: false } }));
    expect(lastPause()).toEqual({ paused: false });

    fireEvent.click(screen.getByLabelText("Settings"));
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith("summon_set_paused", { paused: true });
    expect(emit).toHaveBeenCalledWith("app:settings-open", true);
    emit.mockClear();
    fireEvent.keyDown(document.body, { key: "y" });
    expect(emit).not.toHaveBeenCalledWith("app:event", { type: "KEY_Y" });

    act(() => handlers.get("app:view")?.({ payload: { view: "chat" } }));
    await act(async () => {});
    expect(lastPause()).toEqual({ paused: false });
    expect(emit).toHaveBeenCalledWith("app:settings-open", false);
    fireEvent.keyDown(document.body, { key: "y" });
    expect(emit).toHaveBeenCalledWith("app:event", { type: "KEY_Y" });
  });

  it("hiding the chat on the Settings screen resumes Hold-Y", async () => {
    render(<ChatWindow />);
    await act(async () => {});
    act(() => handlers.get("app:state")?.({ payload: { state: "idle", editing: false } }));
    fireEvent.click(screen.getByLabelText("Settings"));
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith("summon_set_paused", { paused: true });
    act(() => handlers.get("app:state")?.({ payload: { state: "minimized", editing: false } }));
    await act(async () => {});
    expect(lastPause()).toEqual({ paused: false });
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
    expect(screen.getByLabelText("Progress")).toHaveTextContent("Writing");
    act(() =>
      handlers.get("app:progress")?.({ payload: { stage: "transcribing", done: 1, total: 3 } }),
    );
    expect(screen.getByLabelText("Progress")).toHaveTextContent("Transcribing 1/3");
    act(() => handlers.get("app:state")?.({ payload: { state: "idle", editing: false } }));
    expect(screen.queryByLabelText("Progress")).not.toBeInTheDocument();
  });

  describe("result and errors (Task 19)", () => {
    const RESULT = {
      id: 1,
      prompt: "Task: Fix the sink.",
      degraded: false,
      tokensIn: 10,
      tokensOut: 40,
      tokensSaved: 0,
      recent: [{ prompt: "Task: Fix the sink.", at: 1 }],
    };
    const SAVING = { ...RESULT, id: 2, tokensIn: 60, tokensOut: 15, tokensSaved: 45 };
    const SPOKEN = { segments: [{ id: 0, text: "so um fix the sink please" }], partial: "" };

    it("celebrates a prompt that saved tokens, once per new prompt", async () => {
      render(<ChatWindow />);
      await act(async () => {});
      act(() => handlers.get("app:state")?.({ payload: { state: "result", editing: false } }));
      act(() => handlers.get("app:result")?.({ payload: SAVING }));
      expect(await screen.findByTestId("celebration")).toHaveTextContent(
        "You saved ≈ 45 tokens by using Yadi",
      );
      // Clicking it closes it; the same result sent again (SYNC) does not bring it back.
      fireEvent.click(screen.getByRole("button", { name: /You saved/ }));
      expect(screen.queryByTestId("celebration")).not.toBeInTheDocument();
      act(() => handlers.get("app:result")?.({ payload: { ...SAVING } }));
      expect(screen.queryByTestId("celebration")).not.toBeInTheDocument();
      // A new prompt celebrates again.
      act(() => handlers.get("app:result")?.({ payload: { ...SAVING, id: 3 } }));
      expect(screen.getByTestId("celebration")).toBeInTheDocument();
    });

    it("does not celebrate a prompt that saved nothing", async () => {
      render(<ChatWindow />);
      await act(async () => {});
      act(() => handlers.get("app:state")?.({ payload: { state: "result", editing: false } }));
      act(() => handlers.get("app:result")?.({ payload: RESULT }));
      await screen.findByTestId("prompt-text");
      expect(screen.queryByTestId("celebration")).not.toBeInTheDocument();
    });

    it("shows the recorded message's tokens under the transcript, and the prompt's under it", async () => {
      render(<ChatWindow />);
      await act(async () => {});
      act(() => handlers.get("app:transcript")?.({ payload: SPOKEN }));
      act(() => handlers.get("app:state")?.({ payload: { state: "result", editing: false } }));
      act(() => handlers.get("app:result")?.({ payload: SAVING }));
      expect(await screen.findByTestId("transcript-tokens")).toHaveTextContent(
        "≈ 60 tokens as recorded",
      );
      expect(screen.getByTestId("token-line")).toHaveTextContent("≈ 15 tokens · saved ≈ 45");
    });

    it("shows the prompt card in the result state, above the transcript", async () => {
      render(<ChatWindow />);
      await act(async () => {});
      act(() => handlers.get("app:result")?.({ payload: RESULT }));
      act(() => handlers.get("app:state")?.({ payload: { state: "result", editing: false } }));
      expect(await screen.findByTestId("prompt-text")).toBeInTheDocument();
      expect(screen.getByTestId("transcript")).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByTestId("prompt-text")).toHaveTextContent("Task: Fix the sink."),
      );
      expect(screen.getByText(RESULT_KEY_HINT)).toBeInTheDocument();
      expect(RESULT_KEY_HINT).toBe("C = copy · Y = next step · Esc = stop / hide");
    });

    it("'Copy with attachment text' appears once something is attached, and copies the blocks", async () => {
      const writeText = vi.fn(() => Promise.resolve());
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      render(<ChatWindow />);
      await act(async () => {});
      act(() => handlers.get("app:result")?.({ payload: RESULT }));
      act(() => handlers.get("app:state")?.({ payload: { state: "result", editing: false } }));
      await screen.findByTestId("prompt-text");
      expect(screen.queryByText("Copy with attachment text")).not.toBeInTheDocument();

      const paste = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
      Object.defineProperty(paste, "clipboardData", {
        value: { files: [], getData: () => "the pasted words" },
      });
      act(() => void document.body.dispatchEvent(paste));
      expect(await screen.findByText("Pasted text")).toBeInTheDocument();
      expect(emit).toHaveBeenCalledWith("app:event", {
        type: "ATTACHMENTS_SET",
        items: [{ name: "Pasted text", type: "pasted text", preview: "the pasted words" }],
      });

      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Copy with attachment text" })),
      );
      expect(writeText).toHaveBeenCalledWith(
        "Task: Fix the sink.\n\nAttachment: Pasted text (pasted text)\n```\nthe pasted words\n```",
      );
    });

    it("does not show a stale prompt outside the result state", async () => {
      render(<ChatWindow />);
      await act(async () => {});
      act(() => handlers.get("app:result")?.({ payload: RESULT }));
      act(() => handlers.get("app:state")?.({ payload: { state: "idle", editing: false } }));
      expect(screen.queryByTestId("prompt-text")).not.toBeInTheDocument();
    });

    it("'Make it again' sends PROCESS_RETRY", async () => {
      render(<ChatWindow />);
      await act(async () => {});
      act(() => handlers.get("app:result")?.({ payload: RESULT }));
      act(() => handlers.get("app:state")?.({ payload: { state: "result", editing: false } }));
      fireEvent.click(await screen.findByRole("button", { name: "Make it again" }));
      expect(emit).toHaveBeenCalledWith("app:event", { type: "PROCESS_RETRY" });
    });

    it("shows the failure with Retry in idle, once, and Retry sends PROCESS_RETRY", async () => {
      render(<ChatWindow />);
      await act(async () => {});
      act(() => handlers.get("app:state")?.({ payload: { state: "idle", editing: false } }));
      act(() =>
        handlers.get("app:error")?.({
          payload: { kind: "timeout", message: "Making the prompt took too long and was stopped." },
        }),
      );
      // The state machine also raises the same text as a notice: it must not appear twice.
      act(() =>
        handlers.get("app:notice")?.({
          payload: { message: "Making the prompt took too long and was stopped.", action: null },
        }),
      );
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(emit).toHaveBeenCalledWith("app:event", { type: "PROCESS_RETRY" });
    });

    it("a missing model opens setup in repair mode", async () => {
      invoke.mockImplementation((cmd: string) =>
        Promise.resolve(
          cmd === "is_mock_setup" || cmd === "setup_mock_enabled"
            ? true
            : cmd === "get_notice"
              ? null
              : undefined,
        ),
      );
      render(<ChatWindow />);
      await act(async () => {});
      act(() => handlers.get("app:state")?.({ payload: { state: "idle", editing: false } }));
      act(() =>
        handlers.get("app:error")?.({
          payload: { kind: "model-missing", message: "The language model is not installed." },
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Open setup to install it" }));
      await waitFor(() => expect(emit).toHaveBeenCalledWith("app:event", { type: "SETUP_START" }));
      invoke.mockImplementation((cmd: string) =>
        Promise.resolve(cmd === "get_notice" ? null : undefined),
      );
    });

    it("the error panel is gone after a new run starts", async () => {
      render(<ChatWindow />);
      await act(async () => {});
      act(() => handlers.get("app:state")?.({ payload: { state: "idle", editing: false } }));
      act(() =>
        handlers.get("app:error")?.({ payload: { kind: "failed", message: "Making it failed." } }),
      );
      expect(screen.getByRole("alert")).toBeInTheDocument();
      act(() => handlers.get("app:error")?.({ payload: null }));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
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
    // The About page needs the generated licence data (gitignored). On a fresh checkout that file
    // does not exist yet and the page says so; either way the wizard has made way for About.
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Yadi" }) ??
          screen.queryByText(/Licence data was not generated/),
      ).toBeInTheDocument(),
    );
    // The wizard stays mounted underneath (hidden) so it keeps its place.
    expect(screen.getByTestId("setup-body")).not.toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: "Back to chat" }));
    expect(screen.getByTestId("setup-body")).toBeVisible();
    expect(screen.getByTestId("wizard-stub")).toBeInTheDocument();
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
