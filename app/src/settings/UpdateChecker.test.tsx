import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UpdateCheck } from "./UpdateChecker";

const handlers = new Map<string, (e: { payload: unknown }) => void>();
const listen = vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
  handlers.set(name, cb);
  return Promise.resolve(() => handlers.delete(name));
});
const backend = {
  check: { status: "no-release", current: "0.1.0" } as UpdateCheck | Error,
  download: (() => Promise.resolve()) as () => Promise<void>,
  installError: null as string | null,
};
const calls: Array<[string, unknown]> = [];
const invoke = vi.fn(async (cmd: string, args?: unknown) => {
  calls.push([cmd, args]);
  switch (cmd) {
    case "check_for_update":
      if (backend.check instanceof Error) throw backend.check.message;
      return backend.check;
    case "download_update":
      return backend.download();
    case "install_update":
      if (backend.installError) throw backend.installError;
      return undefined;
    case "cancel_update_download":
    case "open_release_page":
      return undefined;
    default:
      throw new Error(`unexpected command ${cmd}`);
  }
});
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
const { UpdateChecker } = await import("./UpdateChecker");

const available = (
  over: Partial<Extract<UpdateCheck, { status: "available" }>> = {},
): UpdateCheck => ({
  status: "available",
  current: "0.1.0",
  latest: "0.2.0",
  notes: "Faster start-up",
  page_url: "https://github.com/elara-studio/Yadi/releases/tag/v0.2.0",
  installable: true,
  reason: null,
  size_bytes: 120_000_000,
  ...over,
});

const pressCheck = async () => {
  await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
};

describe("UpdateChecker", () => {
  beforeEach(() => {
    calls.length = 0;
    handlers.clear();
    invoke.mockClear();
    backend.check = { status: "no-release", current: "0.1.0" };
    backend.download = () => Promise.resolve();
    backend.installError = null;
  });

  it("does nothing by itself: no check until the button is pressed", async () => {
    render(<UpdateChecker version="0.1.0" />);
    await act(async () => {});
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.getByText("You have Yadi 0.1.0.")).toBeInTheDocument();
  });

  it("says so when no release has been published yet", async () => {
    render(<UpdateChecker version="0.1.0" />);
    await pressCheck();
    expect(await screen.findByRole("status")).toHaveTextContent("No update has been published yet");
  });

  it("says so when the newest version is already installed", async () => {
    backend.check = { status: "up-to-date", current: "0.1.0", latest: "0.1.0" };
    render(<UpdateChecker version="0.1.0" />);
    await pressCheck();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "You have the newest version (0.1.0)",
    );
  });

  it("offers a newer version with its notes and size", async () => {
    backend.check = available();
    render(<UpdateChecker version="0.1.0" />);
    await pressCheck();
    expect(await screen.findByText("Yadi 0.2.0 is available")).toBeInTheDocument();
    expect(screen.getByText("Faster start-up")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("download 120 MB");
    expect(screen.getByRole("button", { name: "Download and install" })).toBeInTheDocument();
  });

  it("downloads with progress, then asks before closing Yadi to install", async () => {
    let finish: () => void = () => {};
    backend.check = available();
    backend.download = () => new Promise<void>((r) => (finish = r));
    render(<UpdateChecker version="0.1.0" />);
    await pressCheck();
    await userEvent.click(await screen.findByRole("button", { name: "Download and install" }));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-busy", "true");
    await waitFor(() => expect(handlers.has("update:progress")).toBe(true));
    act(() => handlers.get("update:progress")?.({ payload: { received: 60, total: 120 } }));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByTestId("update-progress-text")).toHaveTextContent("50%");
    // Nothing is installed (and Yadi does not close) until the person says so.
    expect(calls.some(([c]) => c === "install_update")).toBe(false);
    await act(async () => finish());
    const install = await screen.findByRole("button", { name: "Install now" });
    expect(screen.getByRole("status")).toHaveTextContent("closes Yadi");
    await userEvent.click(install);
    expect(calls.filter(([c]) => c === "install_update")).toHaveLength(1);
  });

  it("can cancel a download", async () => {
    backend.check = available();
    backend.download = () => new Promise<void>(() => {});
    render(<UpdateChecker version="0.1.0" />);
    await pressCheck();
    await userEvent.click(await screen.findByRole("button", { name: "Download and install" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls).toContainEqual(["cancel_update_download", undefined]);
  });

  it("a failed download shows the reason and lets the person check again", async () => {
    backend.check = available();
    backend.download = () => Promise.reject("The downloaded file did not match its checksum.");
    render(<UpdateChecker version="0.1.0" />);
    await pressCheck();
    await userEvent.click(await screen.findByRole("button", { name: "Download and install" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("did not match its checksum");
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeEnabled();
  });

  it("when Yadi cannot install it, it explains why and opens the release page instead", async () => {
    backend.check = available({
      installable: false,
      reason: "There is no installer for this computer in that release.",
    });
    render(<UpdateChecker version="0.1.0" />);
    await pressCheck();
    expect(await screen.findByText(/no installer for this computer/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download and install" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open the release page" }));
    expect(calls).toContainEqual([
      "open_release_page",
      { url: "https://github.com/elara-studio/Yadi/releases/tag/v0.2.0" },
    ]);
  });

  it("being offline is shown as a plain message", async () => {
    backend.check = new Error(
      "Yadi could not reach GitHub. Check your internet connection and try again.",
    );
    render(<UpdateChecker version="0.1.0" />);
    await pressCheck();
    expect(await screen.findByRole("alert")).toHaveTextContent("could not reach GitHub");
  });

  it("an installer that fails to open is reported", async () => {
    backend.check = available();
    backend.installError = "macOS could not open the installer.";
    render(<UpdateChecker version="0.1.0" />);
    await pressCheck();
    await userEvent.click(await screen.findByRole("button", { name: "Download and install" }));
    await userEvent.click(await screen.findByRole("button", { name: "Install now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not open the installer");
  });
});
