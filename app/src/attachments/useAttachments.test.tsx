import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AttachmentApi, Extracted } from "./api";

type DropPayload =
  | { type: "enter" | "over"; paths: string[] }
  | { type: "leave" }
  | { type: "drop"; paths: string[] };
let dropHandler: ((e: { payload: DropPayload }) => void) | null = null;
const handlers = new Map<string, () => void>();

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (cb: (e: { payload: DropPayload }) => void) => {
      dropHandler = cb;
      return Promise.resolve(() => (dropHandler = null));
    },
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: () => void) => {
    handlers.set(name, cb);
    return Promise.resolve(() => handlers.delete(name));
  },
}));

const { useAttachments } = await import("./useAttachments");
const { AttachmentBar } = await import("../components/AttachmentBar");

const extracted = (over: Partial<Extracted> = {}): Extracted => ({
  name: "notes.txt",
  type_label: "txt",
  size_bytes: 2048,
  text: "hello from the file",
  truncated: false,
  ...over,
});

function setup(enabled = true, api?: Partial<AttachmentApi>) {
  const send = vi.fn();
  const fullApi: AttachmentApi = {
    fromPath: vi.fn(async () => extracted()),
    fromBytes: vi.fn(async (name: string) => extracted({ name })),
    ...api,
  };
  function Harness({ on }: { on: boolean }) {
    const a = useAttachments(on, send, fullApi);
    return (
      <>
        <AttachmentBar {...a} />
        <textarea aria-label="editor" />
      </>
    );
  }
  const view = render(<Harness on={enabled} />);
  return { send, api: fullApi, rerender: (on: boolean) => view.rerender(<Harness on={on} />) };
}

const drop = (paths: string[]) => act(() => dropHandler?.({ payload: { type: "drop", paths } }));
const settle = () => act(async () => {});

function paste(target: Element | Document, data: { text?: string; files?: File[] }) {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: { files: data.files ?? [], getData: () => data.text ?? "" },
  });
  act(() => void target.dispatchEvent(event));
  return event;
}
const file = (name: string, size = 10) => {
  const f = new File(["x".repeat(size)], name);
  return f;
};

beforeEach(() => {
  dropHandler = null;
  handlers.clear();
});

describe("dropping files", () => {
  it("adds a chip with name, type and size, and tells the Controller", async () => {
    const { send, api } = setup();
    await settle();
    drop(["/Users/me/notes.txt"]);
    expect(await screen.findByText("notes.txt")).toBeInTheDocument();
    expect(screen.getByText("txt · 2 KB")).toBeInTheDocument();
    expect(api.fromPath).toHaveBeenCalledWith("/Users/me/notes.txt");
    expect(send).toHaveBeenLastCalledWith({
      type: "ATTACHMENTS_SET",
      items: [{ name: "notes.txt", type: "txt", preview: "hello from the file" }],
    });
  });

  it("shows an overlay while dragging and hides it on leave", async () => {
    setup();
    await settle();
    act(() => dropHandler?.({ payload: { type: "enter", paths: ["/a"] } }));
    expect(screen.getByText("Drop files to attach them")).toBeInTheDocument();
    act(() => dropHandler?.({ payload: { type: "leave" } }));
    expect(screen.queryByText("Drop files to attach them")).not.toBeInTheDocument();
  });

  it("adds several files in order", async () => {
    const names = ["a.txt", "b.txt", "c.txt"];
    const fromPath = vi.fn(async (p: string) => extracted({ name: p.slice(1) }));
    setup(true, { fromPath });
    await settle();
    drop(names.map((n) => `/${n}`));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(3));
    expect(
      screen.getAllByRole("listitem").map((li) => li.querySelector(".chip-name")?.textContent),
    ).toEqual(names);
  });

  it("shows the reason when Rust refuses a file (image, binary, folder...)", async () => {
    const fromPath = vi.fn().mockRejectedValue({
      kind: "unsupported",
      message: "This kind of file (.png) is not supported yet.",
    });
    setup(true, { fromPath });
    await settle();
    drop(["/pic.png"]);
    expect(await screen.findByRole("alert")).toHaveTextContent("not supported yet");
    expect(screen.queryByLabelText("Attachments")).not.toBeInTheDocument();
  });

  it("a failure without a message still says something kind", async () => {
    setup(true, { fromPath: vi.fn().mockRejectedValue(undefined) });
    await settle();
    drop(["/x.txt"]);
    expect(await screen.findByRole("alert")).toHaveTextContent("This file could not be read.");
  });

  it("errors can be dismissed, and only the last three are kept", async () => {
    const fromPath = vi.fn().mockRejectedValue({ kind: "x", message: "nope" });
    setup(true, { fromPath });
    await settle();
    drop(["/1", "/2", "/3", "/4"]);
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(3));
    fireEvent.click(screen.getAllByLabelText("Dismiss")[0]!);
    expect(screen.getAllByRole("alert")).toHaveLength(2);
  });

  it("is refused with a friendly message while the prompt is being made", async () => {
    const { api } = setup(false);
    await settle();
    drop(["/notes.txt"]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Wait until the prompt is ready");
    expect(api.fromPath).not.toHaveBeenCalled();
  });

  it("does not show the overlay when adding is not possible", async () => {
    setup(false);
    await settle();
    act(() => dropHandler?.({ payload: { type: "enter", paths: ["/a"] } }));
    expect(screen.queryByText("Drop files to attach them")).not.toBeInTheDocument();
  });
});

describe("pasting", () => {
  it("pasted text becomes a 'Pasted text' attachment", async () => {
    const { send } = setup();
    await settle();
    const event = paste(document.body, { text: "some copied words" });
    expect(await screen.findByText("Pasted text")).toBeInTheDocument();
    expect(event.defaultPrevented).toBe(true);
    expect(send).toHaveBeenLastCalledWith({
      type: "ATTACHMENTS_SET",
      items: [{ name: "Pasted text", type: "pasted text", preview: "some copied words" }],
    });
  });

  it("a pasted file is read as bytes under its own name", async () => {
    const { api } = setup();
    await settle();
    paste(document.body, { files: [file("report.docx", 5)] });
    expect(await screen.findByText("report.docx")).toBeInTheDocument();
    const [name, bytes] = (api.fromBytes as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(name).toBe("report.docx");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toHaveLength(5);
  });

  it("paste into the editor is left alone", async () => {
    const { api } = setup();
    await settle();
    const event = paste(screen.getByLabelText("editor"), { text: "typed text" });
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByText("Pasted text")).not.toBeInTheDocument();
    expect(api.fromBytes).not.toHaveBeenCalled();
  });

  it("empty text and paste while not enabled do nothing", async () => {
    const { rerender } = setup();
    await settle();
    expect(paste(document.body, { text: "   \n" }).defaultPrevented).toBe(false);
    rerender(false);
    expect(paste(document.body, { text: "words" }).defaultPrevented).toBe(false);
    expect(screen.queryByText("Pasted text")).not.toBeInTheDocument();
  });
});

describe("limits", () => {
  it("refuses an 11th attachment", async () => {
    setup();
    await settle();
    for (let i = 0; i < 10; i++) paste(document.body, { text: `text ${i}` });
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(10));
    paste(document.body, { text: "one too many" });
    expect(await screen.findByRole("alert")).toHaveTextContent("up to 10 files");
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
  });

  it("refuses a file over 5 MB without reading it", async () => {
    const { api } = setup();
    await settle();
    const big = file("big.txt", 1);
    Object.defineProperty(big, "size", { value: 5 * 1024 * 1024 + 1 });
    paste(document.body, { files: [big] });
    expect(await screen.findByRole("alert")).toHaveTextContent("limit is 5.0 MB per file");
    expect(api.fromBytes).not.toHaveBeenCalled();
  });

  it("refuses when the total would pass 10 MB", async () => {
    const fromPath = vi.fn(async (p: string) =>
      extracted({ name: p, size_bytes: 4 * 1024 * 1024 }),
    );
    setup(true, { fromPath });
    await settle();
    drop(["/a", "/b", "/c"]);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    expect(await screen.findByRole("alert")).toHaveTextContent("10.0 MB in total");
  });
});

describe("chips", () => {
  it("remove takes the chip away and updates the Controller", async () => {
    const { send } = setup();
    await settle();
    drop(["/notes.txt"]);
    fireEvent.click(await screen.findByLabelText("Remove notes.txt"));
    expect(screen.queryByText("notes.txt")).not.toBeInTheDocument();
    expect(send).toHaveBeenLastCalledWith({ type: "ATTACHMENTS_SET", items: [] });
  });

  it("marks a cut file", async () => {
    setup(true, { fromPath: vi.fn(async () => extracted({ truncated: true })) });
    await settle();
    drop(["/big.txt"]);
    expect(await screen.findByText(/· cut/)).toBeInTheDocument();
  });

  it("a new session (app:attachments-clear) empties everything", async () => {
    setup();
    await settle();
    drop(["/notes.txt"]);
    await screen.findByText("notes.txt");
    act(() => handlers.get("app:attachments-clear")?.());
    expect(screen.queryByText("notes.txt")).not.toBeInTheDocument();
  });

  it("nothing is sent to the Controller until something changes", async () => {
    const { send } = setup();
    await settle();
    expect(send).not.toHaveBeenCalled();
  });
});
