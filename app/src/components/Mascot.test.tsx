import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MASCOT_STATUS, Mascot, type MascotState } from "./Mascot";

describe("Mascot", () => {
  it.each(Object.keys(MASCOT_STATUS) as MascotState[])("shows the %s status bubble", (state) => {
    const { container } = render(<Mascot state={state} />);
    expect(screen.getByRole("status")).toHaveTextContent(MASCOT_STATUS[state]);
    expect(container.querySelector(`.mascot--${state}`)).not.toBeNull();
    expect(screen.getByAltText("Yadi")).toBeInTheDocument();
  });

  it("stands still when animations are turned off, and still says what to do", () => {
    const { container, rerender } = render(<Mascot state="idle" />);
    expect(container.querySelector(".mascot--still")).toBeNull();
    rerender(<Mascot state="done" still />);
    expect(container.querySelector(".mascot--still")).not.toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(MASCOT_STATUS.done);
  });
});
