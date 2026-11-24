import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Settings } from "./types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const { SettingsView } = await import("./SettingsView");

const base: Settings = {
  summon: { mode: "longpress-y", threshold_ms: 400, chord: "CommandOrControl+Shift+Y" },
  finalPass: { enabled: true, timeout_seconds: 20 },
};

describe("SettingsView", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation((cmd: string, args?: { settings: Settings }) =>
      cmd === "get_settings" ? Promise.resolve(base) : Promise.resolve(args?.settings),
    );
  });

  it("loads and shows the current settings", async () => {
    render(<SettingsView onBack={() => {}} />);
    expect(await screen.findByText("Hold time: 400 ms")).toBeInTheDocument();
    expect(screen.getByLabelText("Hold the Y key")).toBeChecked();
    expect(screen.getByLabelText("Hold time in milliseconds")).toHaveValue("400");
  });

  it("switching to a shortcut shows the chord field, and Save sends the new settings", async () => {
    const user = userEvent.setup();
    render(<SettingsView onBack={() => {}} />);
    await user.click(await screen.findByLabelText("A keyboard shortcut"));
    const field = screen.getByLabelText("Shortcut");
    await user.clear(field);
    await user.type(field, "Alt+Space");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("set_settings", {
        settings: {
          summon: { mode: "chord", threshold_ms: 400, chord: "Alt+Space" },
          finalPass: { enabled: true, timeout_seconds: 20 },
        },
      }),
    );
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
  });

  it("shows the backend's error and does not claim success", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((cmd: string) =>
      cmd === "get_settings"
        ? Promise.resolve(base)
        : Promise.reject("'Y' needs at least one modifier key"),
    );
    render(<SettingsView onBack={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("needs at least one modifier");
    expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
  });

  it("back button calls onBack", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(<SettingsView onBack={onBack} />);
    await user.click(await screen.findByLabelText("Back to chat"));
    expect(onBack).toHaveBeenCalled();
  });

  it("the final-pass checkbox is on by default and can be switched off and saved", async () => {
    const user = userEvent.setup();
    render(<SettingsView onBack={() => {}} />);
    const box = await screen.findByLabelText(/Polish the transcript after recording/);
    expect(box).toBeChecked();
    await user.click(box);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("set_settings", {
        settings: expect.objectContaining({ finalPass: { enabled: false, timeout_seconds: 20 } }),
      }),
    );
  });

  it("offers Re-run setup and Repair models when the app provides a handler", async () => {
    const user = userEvent.setup();
    const onRerunSetup = vi.fn();
    render(<SettingsView onBack={() => {}} onRerunSetup={onRerunSetup} />);
    await user.click(await screen.findByRole("button", { name: "Re-run setup" }));
    expect(onRerunSetup).toHaveBeenLastCalledWith(false);
    await user.click(screen.getByRole("button", { name: "Repair models" }));
    expect(onRerunSetup).toHaveBeenLastCalledWith(true);
  });

  it("does not show the setup buttons without a handler", async () => {
    render(<SettingsView onBack={() => {}} />);
    await screen.findByText(/Hold time/);
    expect(screen.queryByRole("button", { name: "Re-run setup" })).not.toBeInTheDocument();
  });
});
