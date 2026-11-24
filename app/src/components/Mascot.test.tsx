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
});
