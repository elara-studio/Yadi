import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PROCESS_MESSAGES, type ProcessErrorKind } from "../windows/mascot/controller";
import { ProcessErrorView } from "./ProcessErrorView";

function show(kind: ProcessErrorKind) {
  const onRetry = vi.fn();
  const onRepair = vi.fn();
  render(
    <ProcessErrorView
      error={{ kind, message: PROCESS_MESSAGES[kind] }}
      onRetry={onRetry}
      onRepair={onRepair}
    />,
  );
  return { onRetry, onRepair };
}

describe("ProcessErrorView", () => {
  it.each(["unreachable", "timeout", "failed"] as const)("%s: message and Retry", (kind) => {
    const { onRetry, onRepair } = show(kind);
    expect(screen.getByRole("alert")).toHaveTextContent(PROCESS_MESSAGES[kind]);
    expect(screen.getByText("Your transcript is still here.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRepair).not.toHaveBeenCalled();
    expect(screen.queryByText(/Open setup/)).not.toBeInTheDocument();
  });

  it("a missing model offers setup (repair) as well as Retry", () => {
    const { onRetry, onRepair } = show("model-missing");
    fireEvent.click(screen.getByRole("button", { name: "Open setup to install it" }));
    expect(onRepair).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("an empty transcript has nothing to retry", () => {
    show("empty");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });
});
