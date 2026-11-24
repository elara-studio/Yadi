import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AppState, TranscriptSnapshot } from "@yadi/core";
import { TranscriptView, type TranscriptSend } from "./TranscriptView";
import { useKeyboardControls } from "../windows/chat/useKeyboardControls";
import { clearVocabulary, getVocabulary } from "../vocabulary/store";

const snap = (partial = ""): TranscriptSnapshot => ({
  segments: [
    { id: 0, text: "Write a short emile to my manager." },
    { id: 1, text: "Thanks." },
  ],
  partial,
});

function setup(state: AppState = "idle", snapshot = snap(), editing = false) {
  const send = vi.fn<TranscriptSend>();
  const utils = render(
    <TranscriptView snapshot={snapshot} state={state} editing={editing} send={send} />,
  );
  return { send, ...utils };
}

const sent = (send: ReturnType<typeof vi.fn>) => send.mock.calls.map((c) => c[0]);

describe("TranscriptView", () => {
  beforeEach(clearVocabulary);

  describe("display", () => {
    it("shows finished segments normally and the partial lighter and italic", () => {
      const { container } = setup("recording", snap("and also"));
      expect(container.querySelectorAll(".transcript-final")).toHaveLength(2);
      const partial = container.querySelector(".transcript-partial");
      expect(partial).toHaveTextContent("and also");
      expect(screen.getByTestId("transcript")).toHaveTextContent(
        "Write a short emile to my manager. Thanks. and also",
      );
    });

    it("shows a hint when empty", () => {
      setup("idle", { segments: [], partial: "" });
      expect(screen.getByText("Press Y and start talking.")).toBeInTheDocument();
    });

    it("keeps the newest words in view while recording", () => {
      const { rerender, send } = setup("recording", snap("one"));
      const box = screen.getByTestId("transcript");
      Object.defineProperty(box, "scrollHeight", { configurable: true, value: 900 });
      rerender(
        <TranscriptView snapshot={snap("one two")} state="recording" editing={false} send={send} />,
      );
      expect(box.scrollTop).toBe(900);
    });
  });

  describe("word fixing", () => {
    it("double-clicking a word opens an inline input holding that word", async () => {
      const user = userEvent.setup();
      const { send } = setup();
      await user.dblClick(screen.getByRole("button", { name: "Edit word emile" }));
      expect(screen.getByRole("textbox", { name: "Replace word emile" })).toHaveValue("emile");
      expect(sent(send)).toEqual([{ type: "EDIT_START" }]);
    });

    it("Enter replaces only that word and ends editing", async () => {
      const user = userEvent.setup();
      const { send } = setup();
      await user.dblClick(screen.getByRole("button", { name: "Edit word emile" }));
      const input = screen.getByRole("textbox", { name: "Replace word emile" });
      await user.clear(input);
      await user.type(input, "email{Enter}");
      expect(sent(send)).toEqual([
        { type: "EDIT_START" },
        { type: "TRANSCRIPT_REPLACE_WORD", segmentId: 0, wordIndex: 3, text: "email" },
        { type: "EDIT_END" },
      ]);
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    });

    it("supports multi-word replacement text", async () => {
      const user = userEvent.setup();
      const { send } = setup();
      await user.dblClick(screen.getByRole("button", { name: "Edit word emile" }));
      const input = screen.getByRole("textbox", { name: "Replace word emile" });
      await user.clear(input);
      await user.type(input, "e mail{Enter}");
      expect(sent(send)).toContainEqual({
        type: "TRANSCRIPT_REPLACE_WORD",
        segmentId: 0,
        wordIndex: 3,
        text: "e mail",
      });
    });

    it("Esc keeps the original and sends no replacement", async () => {
      const user = userEvent.setup();
      const { send } = setup();
      await user.dblClick(screen.getByRole("button", { name: "Edit word emile" }));
      await user.type(screen.getByRole("textbox"), "zzz{Escape}");
      expect(sent(send)).toEqual([{ type: "EDIT_START" }, { type: "EDIT_END" }]);
      expect(screen.getByRole("button", { name: "Edit word emile" })).toBeInTheDocument();
    });

    it("an unchanged or emptied word sends no replacement", async () => {
      const user = userEvent.setup();
      const { send } = setup();
      await user.dblClick(screen.getByRole("button", { name: "Edit word emile" }));
      await user.type(screen.getByRole("textbox"), "{Enter}"); // unchanged
      expect(sent(send).some((e) => e.type === "TRANSCRIPT_REPLACE_WORD")).toBe(false);
      await user.dblClick(screen.getByRole("button", { name: "Edit word manager." }));
      await user.clear(screen.getByRole("textbox"));
      await user.type(screen.getByRole("textbox"), "{Enter}"); // emptied
      expect(sent(send).some((e) => e.type === "TRANSCRIPT_REPLACE_WORD")).toBe(false);
    });

    it("works from the keyboard: focus a word and press Enter", async () => {
      const user = userEvent.setup();
      setup();
      const word = screen.getByRole("button", { name: "Edit word short" });
      word.focus();
      await user.keyboard("{Enter}");
      expect(screen.getByRole("textbox", { name: "Replace word short" })).toBeInTheDocument();
    });

    it("words are focusable buttons with labels (accessibility)", () => {
      setup();
      const word = screen.getByRole("button", { name: "Edit word Write" });
      expect(word).toHaveAttribute("tabindex", "0");
    });

    it("offers to remember the corrected word, and Yes adds it to the vocabulary", async () => {
      const user = userEvent.setup();
      setup();
      await user.dblClick(screen.getByRole("button", { name: "Edit word emile" }));
      const input = screen.getByRole("textbox");
      await user.clear(input);
      await user.type(input, "email{Enter}");
      expect(screen.getByRole("status")).toHaveTextContent("Remember ‘email’ for next time?");
      await user.click(screen.getByRole("button", { name: "Yes" }));
      expect(getVocabulary()).toEqual(["email"]);
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("No dismisses the offer without remembering", async () => {
      const user = userEvent.setup();
      setup();
      await user.dblClick(screen.getByRole("button", { name: "Edit word emile" }));
      const input = screen.getByRole("textbox");
      await user.clear(input);
      await user.type(input, "email{Enter}");
      await user.click(screen.getByRole("button", { name: "No" }));
      expect(getVocabulary()).toEqual([]);
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });
  });

  describe("whole-transcript editing", () => {
    it("the edit icon opens a text box with the full text and starts editing", async () => {
      const user = userEvent.setup();
      const { send } = setup();
      await user.click(screen.getByRole("button", { name: "Edit transcript" }));
      expect(screen.getByRole("textbox", { name: "Transcript" })).toHaveValue(
        "Write a short emile to my manager. Thanks.",
      );
      expect(sent(send)).toEqual([{ type: "EDIT_START" }]);
    });

    it("the check button saves", async () => {
      const user = userEvent.setup();
      const { send } = setup();
      await user.click(screen.getByRole("button", { name: "Edit transcript" }));
      const box = screen.getByRole("textbox", { name: "Transcript" });
      await user.clear(box);
      await user.type(box, "Brand new text.");
      await user.click(screen.getByRole("button", { name: "Save edits" }));
      expect(sent(send)).toEqual([
        { type: "EDIT_START" },
        { type: "TRANSCRIPT_SET_TEXT", text: "Brand new text." },
        { type: "EDIT_END" },
      ]);
    });

    it("Cmd+Enter and Ctrl+Enter save", async () => {
      for (const mod of ["metaKey", "ctrlKey"]) {
        const user = userEvent.setup();
        const { send, unmount } = setup();
        await user.click(screen.getByRole("button", { name: "Edit transcript" }));
        const box = screen.getByRole("textbox", { name: "Transcript" });
        await user.type(box, " more");
        fireEvent.keyDown(box, { key: "Enter", [mod]: true });
        expect(sent(send)).toContainEqual({
          type: "TRANSCRIPT_SET_TEXT",
          text: "Write a short emile to my manager. Thanks. more",
        });
        unmount();
      }
    });

    it("Esc cancels without saving", async () => {
      const user = userEvent.setup();
      const { send } = setup();
      await user.click(screen.getByRole("button", { name: "Edit transcript" }));
      await user.type(screen.getByRole("textbox", { name: "Transcript" }), "junk{Escape}");
      expect(sent(send)).toEqual([{ type: "EDIT_START" }, { type: "EDIT_END" }]);
      expect(screen.getByTestId("transcript")).toHaveTextContent(
        "Write a short emile to my manager.",
      );
    });

    it("the cancel button cancels", async () => {
      const user = userEvent.setup();
      const { send } = setup();
      await user.click(screen.getByRole("button", { name: "Edit transcript" }));
      await user.click(screen.getByRole("button", { name: "Cancel editing" }));
      expect(sent(send).some((e) => e.type === "TRANSCRIPT_SET_TEXT")).toBe(false);
    });
  });

  describe("editing is blocked outside idle and result", () => {
    it.each(["recording", "processing", "setup", "minimized"] as const)(
      "%s: the edit icon is disabled and double-click does nothing",
      async (state) => {
        const user = userEvent.setup();
        const { send } = setup(state);
        expect(screen.getByRole("button", { name: "Edit transcript" })).toBeDisabled();
        expect(screen.queryByRole("button", { name: "Edit word emile" })).not.toBeInTheDocument();
        await user.dblClick(screen.getByText("emile"));
        expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
        expect(send).not.toHaveBeenCalled();
      },
    );

    it("result: editing is allowed", () => {
      setup("result");
      expect(screen.getByRole("button", { name: "Edit transcript" })).toBeEnabled();
    });

    it("nothing to edit when there are no finished segments", () => {
      setup("idle", { segments: [], partial: "live only" });
      expect(screen.getByRole("button", { name: "Edit transcript" })).toBeDisabled();
    });

    it("an open editor closes if recording starts", async () => {
      const user = userEvent.setup();
      const { rerender, send } = setup();
      await user.click(screen.getByRole("button", { name: "Edit transcript" }));
      rerender(<TranscriptView snapshot={snap()} state="recording" editing={false} send={send} />);
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    });

    it("an editor closes when the app leaves editing by itself", async () => {
      const user = userEvent.setup();
      const send = vi.fn();
      const { rerender } = render(
        <TranscriptView snapshot={snap()} state="idle" editing={false} send={send} />,
      );
      await user.click(screen.getByRole("button", { name: "Edit transcript" }));
      rerender(<TranscriptView snapshot={snap()} state="idle" editing={true} send={send} />); // machine confirms
      rerender(<TranscriptView snapshot={snap()} state="idle" editing={false} send={send} />); // e.g. global Esc
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    });
  });

  describe("Y while editing", () => {
    function WithKeys({ send }: { send: TranscriptSend }) {
      useKeyboardControls(send);
      return <TranscriptView snapshot={snap()} state="idle" editing={true} send={send} />;
    }

    it("typing y into the word editor or the whole-text box never sends KEY_Y", async () => {
      const user = userEvent.setup();
      const send = vi.fn<TranscriptSend>();
      render(<WithKeys send={send} />);
      await user.dblClick(screen.getByRole("button", { name: "Edit word emile" }));
      await user.type(screen.getByRole("textbox"), "yyy");
      expect(sent(send).some((e) => e.type === "KEY_Y")).toBe(false);
    });

    it("Esc inside the editor sends EDIT_END, not KEY_ESC", async () => {
      const user = userEvent.setup();
      const send = vi.fn<TranscriptSend>();
      render(<WithKeys send={send} />);
      await user.click(screen.getByRole("button", { name: "Edit transcript" }));
      await user.type(screen.getByRole("textbox"), "{Escape}");
      expect(sent(send).some((e) => e.type === "KEY_ESC")).toBe(false);
      expect(sent(send).filter((e) => e.type === "EDIT_END").length).toBeGreaterThan(0);
    });
  });
});
