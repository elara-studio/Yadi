import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ResultPayload } from "../windows/mascot/controller";
import { ResultView } from "./ResultView";

const PROMPT = "Role: Plumber\nTask: Fix the sink.\nIf anything is missing, ask me.";

function result(extra: Partial<ResultPayload> = {}): ResultPayload {
  return {
    prompt: PROMPT,
    degraded: false,
    tokensIn: 30,
    tokensOut: 120,
    recent: [{ prompt: PROMPT, at: 1 }],
    ...extra,
  };
}

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => vi.useRealTimers());

describe("ResultView", () => {
  it("shows the prompt in a monospace card", () => {
    render(<ResultView result={result()} revealMs={0} />);
    expect(screen.getByTestId("prompt-text")).toHaveTextContent("Task: Fix the sink.");
    expect(screen.getByTestId("prompt-text").tagName).toBe("PRE");
  });

  it("Copy writes the exact prompt, then says Copied for 1.5 s", async () => {
    vi.useFakeTimers();
    render(<ResultView result={result()} revealMs={0} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy" })));
    expect(writeText).toHaveBeenCalledWith(PROMPT);
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(1499));
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(2));
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("copies the whole prompt even while it is still being revealed", async () => {
    vi.useFakeTimers();
    render(<ResultView result={result()} revealMs={600} />);
    expect(screen.getByTestId("prompt-text").textContent?.length).toBeLessThan(PROMPT.length);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy" })));
    expect(writeText).toHaveBeenCalledWith(PROMPT);
  });

  it("reveals the whole prompt within 600 ms", () => {
    vi.useFakeTimers();
    render(<ResultView result={result()} revealMs={900} />);
    act(() => void vi.advanceTimersByTime(600));
    expect(screen.getByTestId("prompt-text").textContent).toBe(PROMPT);
  });

  it("says so when the clipboard refuses", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    render(<ResultView result={result()} revealMs={0} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy" })));
    expect(screen.getByRole("button", { name: "Could not copy" })).toBeInTheDocument();
  });

  it("shows the approximate token line", () => {
    render(<ResultView result={result()} revealMs={0} />);
    expect(screen.getByTestId("token-line")).toHaveTextContent("≈ 30 → ≈ 120 tokens (approximate)");
  });

  it("shows a notice for a degraded prompt, and none otherwise", () => {
    const { rerender } = render(<ResultView result={result({ degraded: true })} revealMs={0} />);
    expect(screen.getByRole("status")).toHaveTextContent(/basic prompt/);
    rerender(<ResultView result={result()} revealMs={0} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("offers 'Copy with attachment text' only when there are attachments", async () => {
    const { rerender } = render(<ResultView result={result()} revealMs={0} />);
    expect(screen.queryByText("Copy with attachment text")).not.toBeInTheDocument();
    rerender(<ResultView result={result()} revealMs={0} attachmentText="FILE TEXT" />);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Copy with attachment text" })),
    );
    expect(writeText).toHaveBeenCalledWith(`${PROMPT}\n\nFILE TEXT`);
  });

  it("lists older prompts under Recent, each with its own Copy", async () => {
    const recent = [
      { prompt: "Task: newest", at: 3 },
      { prompt: "Task: older one\nmore", at: 2 },
      { prompt: "Task: oldest", at: 1 },
    ];
    render(<ResultView result={result({ prompt: "Task: newest", recent })} revealMs={0} />);
    expect(screen.getByText("Recent (2)")).toBeInTheDocument();
    expect(screen.getByText("Task: older one")).toBeInTheDocument();
    const copies = screen.getAllByRole("button", { name: "Copy" });
    await act(async () => fireEvent.click(copies[1])); // first recent item
    expect(writeText).toHaveBeenCalledWith("Task: older one\nmore");
  });

  it("has no Recent section for the first prompt", () => {
    render(<ResultView result={result()} revealMs={0} />);
    expect(screen.queryByText(/Recent/)).not.toBeInTheDocument();
  });

  it("'Make it again' calls back", () => {
    const onRegenerate = vi.fn();
    render(<ResultView result={result()} revealMs={0} onRegenerate={onRegenerate} />);
    fireEvent.click(screen.getByRole("button", { name: "Make it again" }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });
});
