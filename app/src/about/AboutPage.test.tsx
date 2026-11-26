import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AboutPage, PRIVACY_LINE } from "./AboutPage";
import type { LicenseData } from "./types";

const fixture: LicenseData = {
  entries: [
    {
      id: "yadi",
      name: "Yadi",
      kind: "app",
      version: "0.1.0",
      license_spdx: "Apache-2.0",
      attribution: "Copyright Elara Software Services FZ-LLC",
      text_ids: ["t-apache"],
    },
    {
      id: "ollama",
      name: "Ollama",
      kind: "runtime",
      version: "user-installed",
      license_spdx: "MIT",
      license_url: "https://github.com/ollama/ollama/blob/main/LICENSE",
      text_ids: ["t-mit"],
    },
    {
      id: "npm:react@19.3.1",
      name: "react",
      kind: "library",
      ecosystem: "npm",
      version: "19.3.1",
      license_spdx: "MIT",
      text_ids: [],
    },
    {
      id: "cargo:serde@1.0.0",
      name: "serde",
      kind: "library",
      ecosystem: "cargo",
      version: "1.0.0",
      license_spdx: "MIT OR Apache-2.0",
      text_ids: ["t-mit"],
    },
  ],
  texts: { "t-apache": "Apache License Version 2.0 full text", "t-mit": "MIT License full text" },
};

describe("AboutPage", () => {
  it("shows the version, the privacy line and grouped entries", () => {
    render(<AboutPage data={fixture} version="0.1.0" />);
    expect(screen.getByText("Version 0.1.0")).toBeInTheDocument();
    expect(screen.getByText(PRIVACY_LINE)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Application (1)" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Runtimes (1)" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Libraries (2)" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Models/ })).not.toBeInTheDocument();
  });

  it("finds an entry by search (name and SPDX id)", async () => {
    const user = userEvent.setup();
    render(<AboutPage data={fixture} version="0.1.0" />);
    await user.type(screen.getByLabelText("Search licences"), "ollama");
    expect(screen.getByText("Ollama")).toBeInTheDocument();
    expect(screen.queryByText("react")).not.toBeInTheDocument();
    expect(screen.queryByText("serde")).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText("Search licences"));
    await user.type(screen.getByLabelText("Search licences"), "apache");
    expect(screen.getByRole("heading", { name: "Application (1)" })).toBeInTheDocument();
    expect(screen.getByText("serde")).toBeInTheDocument();
    expect(screen.queryByText("Ollama")).not.toBeInTheDocument();
  });

  it("says so when nothing matches", async () => {
    const user = userEvent.setup();
    render(<AboutPage data={fixture} version="0.1.0" />);
    await user.type(screen.getByLabelText("Search licences"), "zzzz");
    expect(screen.getByText(/No licences match/)).toBeInTheDocument();
  });

  it("expands an entry to show its full licence text, only after opening", async () => {
    const user = userEvent.setup();
    render(<AboutPage data={fixture} version="0.1.0" />);
    expect(screen.queryByText("MIT License full text")).not.toBeInTheDocument();
    await user.click(screen.getByText("Ollama"));
    const row = screen.getByText("Ollama").closest("details")!;
    expect(within(row).getByText("MIT License full text")).toBeInTheDocument();
    expect(within(row).getByText(/github.com\/ollama/)).toBeInTheDocument();
  });

  it("explains when an entry has no bundled text", async () => {
    const user = userEvent.setup();
    render(<AboutPage data={fixture} version="0.1.0" />);
    await user.click(screen.getByText("react"));
    expect(screen.getByText(/Full licence text not bundled/)).toBeInTheDocument();
  });

  it("shows a back button only when onBack is given", async () => {
    const user = userEvent.setup();
    let backs = 0;
    const { rerender } = render(<AboutPage data={fixture} version="1" />);
    expect(screen.queryByLabelText("Back to chat")).not.toBeInTheDocument();
    rerender(<AboutPage data={fixture} version="1" onBack={() => backs++} />);
    await user.click(screen.getByLabelText("Back to chat"));
    expect(backs).toBe(1);
  });
});
