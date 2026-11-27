import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { CELEBRATION_MS, SavingsCelebration } from "./SavingsCelebration";

afterEach(() => vi.useRealTimers());

const props = { saved: 1234, tokensIn: 1300, tokensOut: 66 };

describe("SavingsCelebration", () => {
  it("says how many tokens were saved, with both counts", () => {
    render(<SavingsCelebration {...props} animated onDone={() => {}} />);
    expect(screen.getByTestId("celebration")).toHaveTextContent(
      "You saved ≈ 1,234 tokens by using Yadi",
    );
    expect(screen.getByTestId("celebration")).toHaveTextContent(
      "≈ 1,300 as you said it → ≈ 66 in the prompt",
    );
  });

  it("goes away by itself", () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    render(<SavingsCelebration {...props} animated onDone={onDone} />);
    act(() => void vi.advanceTimersByTime(CELEBRATION_MS - 1));
    expect(onDone).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("closes sooner when clicked", () => {
    const onDone = vi.fn();
    render(<SavingsCelebration {...props} animated onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: /You saved/ }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("throws confetti only when animations are on", () => {
    const { container, rerender } = render(
      <SavingsCelebration {...props} animated onDone={() => {}} />,
    );
    expect(container.querySelectorAll(".confetti-piece").length).toBeGreaterThan(10);
    rerender(<SavingsCelebration {...props} animated={false} onDone={() => {}} />);
    expect(container.querySelectorAll(".confetti-piece")).toHaveLength(0);
    expect(screen.getByTestId("celebration")).toHaveClass("celebration--still");
  });
});
