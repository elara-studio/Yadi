import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

let stored: string[] = [];
const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  switch (cmd) {
    case "get_vocabulary":
      return [...stored];
    case "set_vocabulary": {
      const seen = new Set<string>();
      stored = (args!.words as string[])
        .map((w) => w.trim())
        .filter((w) => w && !seen.has(w.toLowerCase()) && seen.add(w.toLowerCase()));
      return [...stored];
    }
    case "vocabulary_import":
      stored = [...stored, "Imported One", "Imported Two"];
      return [...stored];
    case "vocabulary_export":
      return undefined;
    default:
      throw new Error(`unexpected ${cmd}`);
  }
});
const open = vi.fn();
const save = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open, save }));
const { VocabularyEditor } = await import("./VocabularyEditor");

beforeEach(() => {
  stored = [];
  invoke.mockClear();
  open.mockReset();
  save.mockReset();
});

describe("VocabularyEditor", () => {
  it("shows the saved words, or says there are none", async () => {
    const { unmount } = render(<VocabularyEditor />);
    expect(await screen.findByText("No words yet.")).toBeInTheDocument();
    unmount();
    stored = ["Yadi", "Ollama"];
    render(<VocabularyEditor />);
    expect(await screen.findByText("Yadi")).toBeInTheDocument();
    expect(screen.getByText("Ollama")).toBeInTheDocument();
  });

  it("adds a word with the button or Enter, and clears the box", async () => {
    const user = userEvent.setup();
    render(<VocabularyEditor />);
    await screen.findByText("No words yet.");
    await user.type(screen.getByLabelText("New word"), "Kubernetes");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Kubernetes")).toBeInTheDocument();
    expect(screen.getByLabelText("New word")).toHaveValue("");
    await user.type(screen.getByLabelText("New word"), "Postgres{Enter}");
    expect(await screen.findByText("Postgres")).toBeInTheDocument();
    expect(stored).toEqual(["Kubernetes", "Postgres"]);
  });

  it("Add is off for blank input, and a repeat (any case) is not added twice", async () => {
    const user = userEvent.setup();
    stored = ["Yadi"];
    render(<VocabularyEditor />);
    await screen.findByText("Yadi");
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    await user.type(screen.getByLabelText("New word"), "yadi{Enter}");
    await waitFor(() => expect(screen.getByLabelText("New word")).toHaveValue(""));
    expect(stored).toEqual(["Yadi"]);
  });

  it("edits a word: Enter saves, Escape cancels", async () => {
    const user = userEvent.setup();
    stored = ["Yadi", "Ollama"];
    render(<VocabularyEditor />);
    await user.click(await screen.findByRole("button", { name: "Edit Ollama" }));
    const box = screen.getByLabelText("Edit Ollama");
    await user.clear(box);
    await user.type(box, "Ollama Server{Enter}");
    expect(await screen.findByText("Ollama Server")).toBeInTheDocument();
    expect(stored).toEqual(["Yadi", "Ollama Server"]);

    await user.click(screen.getByRole("button", { name: "Edit Yadi" }));
    await user.type(screen.getByLabelText("Edit Yadi"), " nope{Escape}");
    expect(screen.getByText("Yadi")).toBeInTheDocument();
    expect(stored).toEqual(["Yadi", "Ollama Server"]);
  });

  it("deletes a word", async () => {
    const user = userEvent.setup();
    stored = ["Yadi", "Ollama"];
    render(<VocabularyEditor />);
    await user.click(await screen.findByRole("button", { name: "Delete Yadi" }));
    await waitFor(() => expect(screen.queryByText("Yadi")).not.toBeInTheDocument());
    expect(stored).toEqual(["Ollama"]);
  });

  it("imports a .txt chosen in the dialog and shows the merged list", async () => {
    open.mockResolvedValue("/Users/me/words.txt");
    render(<VocabularyEditor />);
    await userEvent.click(await screen.findByRole("button", { name: "Import…" }));
    expect(await screen.findByText("Imported Two")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("vocabulary_import", { path: "/Users/me/words.txt" });
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ filters: [{ name: "Text", extensions: ["txt"] }] }),
    );
  });

  it("cancelling the import dialog does nothing", async () => {
    open.mockResolvedValue(null);
    render(<VocabularyEditor />);
    await userEvent.click(await screen.findByRole("button", { name: "Import…" }));
    expect(invoke).not.toHaveBeenCalledWith("vocabulary_import", expect.anything());
  });

  it("exports to the chosen file, and Export is off when there is nothing to export", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<VocabularyEditor />);
    await screen.findByText("No words yet.");
    expect(screen.getByRole("button", { name: "Export…" })).toBeDisabled();
    unmount();
    stored = ["Yadi"];
    save.mockResolvedValue("/Users/me/out.txt");
    render(<VocabularyEditor />);
    await user.click(await screen.findByRole("button", { name: "Export…" }));
    expect(invoke).toHaveBeenCalledWith("vocabulary_export", { path: "/Users/me/out.txt" });
  });

  it("shows why an import failed", async () => {
    open.mockResolvedValue("/x.txt");
    invoke.mockImplementationOnce(async () => []); // get_vocabulary
    invoke.mockImplementationOnce(async () => {
      throw "That file is too big for a word list (1 MB at most).";
    });
    render(<VocabularyEditor />);
    await userEvent.click(await screen.findByRole("button", { name: "Import…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("too big");
  });
});
