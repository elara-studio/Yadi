import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { ProcessingView } from "./ProcessingView";

afterEach(() => vi.useRealTimers());

const statuses = () =>
  screen.getAllByRole("listitem").flatMap((li) => (li.dataset.status ? [li.dataset.status] : []));

describe("ProcessingView", () => {
  it("starts at Transcribing when nothing was reported yet", () => {
    render(<ProcessingView progress={null} />);
    expect(statuses()).toEqual(["active", "pending", "pending", "pending"]);
    expect(screen.getByText(/Transcribing/)).toHaveAttribute("aria-current", "step");
  });

  it.each([
    ["transcribing", ["active", "pending", "pending", "pending"]],
    ["cleaning", ["done", "active", "pending", "pending"]],
    ["analysing", ["done", "done", "active", "pending"]],
    ["writing", ["done", "done", "done", "active"]],
  ] as const)("stage %s ticks the finished stages and marks one active", (stage, expected) => {
    render(<ProcessingView progress={{ stage, done: 0, total: 0 }} />);
    expect(statuses()).toEqual(expected);
  });

  it("shows chunk counts while transcribing a long recording", () => {
    render(<ProcessingView progress={{ stage: "transcribing", done: 2, total: 3 }} />);
    expect(screen.getByText(/Transcribing 2\/3…/)).toBeInTheDocument();
  });

  it("shows the cleaned text dimmed once it exists", () => {
    render(
      <ProcessingView
        progress={{ stage: "analysing", done: 0, total: 0, clean: "Hello there." }}
      />,
    );
    expect(screen.getByTestId("clean-text")).toHaveTextContent("Hello there.");
  });

  it("counts elapsed time", () => {
    vi.useFakeTimers();
    render(<ProcessingView progress={null} />);
    expect(screen.getByTestId("elapsed")).toHaveTextContent("0:00");
    act(() => void vi.advanceTimersByTime(65_000));
    expect(screen.getByTestId("elapsed")).toHaveTextContent("1:05");
  });
});
