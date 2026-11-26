import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { InputDevice, LlmOption, Settings } from "./types";

/** An in-memory stand-in for the Rust side: settings, vocabulary and the lists Settings shows. */
const backend = {
  settings: null as unknown as Settings,
  vocabulary: [] as string[],
  devices: [] as InputDevice[],
  models: [] as LlmOption[],
  installed: new Set<string>(),
  autostart: false,
  failSave: null as string | null,
};
const calls: Array<[string, unknown]> = [];

const defaults = (): Settings => ({
  summon: { mode: "longpress-y", threshold_ms: 400, chord: "CommandOrControl+Shift+Y" },
  finalPass: { enabled: true, timeout_seconds: 20 },
  microphone: { device: null },
  llm: { model_id: null },
  appearance: { animations: true },
});

const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  calls.push([cmd, args]);
  switch (cmd) {
    case "get_settings":
      return structuredClone(backend.settings);
    case "set_settings":
      if (backend.failSave) throw backend.failSave;
      backend.settings = structuredClone(args!.settings as Settings);
      return structuredClone(backend.settings);
    case "reset_everything":
      backend.settings = defaults();
      backend.vocabulary = [];
      return structuredClone(backend.settings);
    case "audio_list_devices":
      return backend.devices;
    case "llm_options_list":
      return backend.models;
    case "ollama_has":
      return backend.installed.has(args!.tag as string);
    case "get_vocabulary":
      return [...backend.vocabulary];
    case "set_vocabulary":
      backend.vocabulary = [...new Set(args!.words as string[])].filter((w) => w.trim());
      return [...backend.vocabulary];
    default:
      throw new Error(`unexpected command ${cmd}`);
  }
});
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-autostart", () => ({
  isEnabled: vi.fn(async () => backend.autostart),
  enable: vi.fn(async () => void (backend.autostart = true)),
  disable: vi.fn(async () => void (backend.autostart = false)),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
const { SettingsView } = await import("./SettingsView");
const autostart = await import("@tauri-apps/plugin-autostart");

const model = (over: Partial<LlmOption> & { id: string }): LlmOption => ({
  tag: `${over.id}:tag`,
  size_bytes: 2 * 1024 ** 3,
  memory_needed_bytes: 3 * 1024 ** 3,
  recommended: false,
  fits: true,
  warning: null,
  tested: false,
  ...over,
});

beforeEach(() => {
  calls.length = 0;
  invoke.mockClear();
  backend.settings = defaults();
  backend.vocabulary = [];
  backend.devices = [
    { name: "MacBook Microphone", is_default: true },
    { name: "USB Mic", is_default: false },
  ];
  backend.models = [
    model({ id: "small", recommended: true }),
    model({
      id: "huge",
      size_bytes: 9 * 1024 ** 3,
      fits: false,
      warning: "This model needs about 10.0 GB of memory and Yadi can use about 4.0 GB.",
    }),
  ];
  backend.installed = new Set(["small:tag"]);
  backend.autostart = false;
  backend.failSave = null;
});

describe("summon", () => {
  it("loads and shows the current settings", async () => {
    render(<SettingsView onBack={() => {}} />);
    expect(await screen.findByText("Hold time: 400 ms")).toBeInTheDocument();
    expect(screen.getByLabelText("Hold the Y key")).toBeChecked();
    expect(screen.getByLabelText("Hold time in milliseconds")).toHaveValue("400");
  });

  it("the slider covers 250 to 900 ms and Save sends the new hold time", async () => {
    render(<SettingsView onBack={() => {}} />);
    const slider = await screen.findByLabelText("Hold time in milliseconds");
    expect(slider).toHaveAttribute("min", "250");
    expect(slider).toHaveAttribute("max", "900");
    fireEvent.change(slider, { target: { value: "650" } });
    expect(screen.getByText("Hold time: 650 ms")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(backend.settings.summon.threshold_ms).toBe(650));
  });

  it("switching to a shortcut shows the chord field, and Save sends it", async () => {
    const user = userEvent.setup();
    render(<SettingsView onBack={() => {}} />);
    await user.click(await screen.findByLabelText("A keyboard shortcut"));
    expect(screen.queryByLabelText("Hold time in milliseconds")).not.toBeInTheDocument();
    const field = screen.getByLabelText("Shortcut");
    await user.clear(field);
    await user.type(field, "Alt+Space");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(backend.settings.summon).toEqual({
        mode: "chord",
        threshold_ms: 400,
        chord: "Alt+Space",
      }),
    );
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
  });

  it("shows the backend's error and does not claim success", async () => {
    backend.failSave = "'Y' needs at least one modifier key";
    render(<SettingsView onBack={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("needs at least one modifier");
    expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
  });
});

describe("the hold-time test", () => {
  const key = (type: "keydown" | "keyup", repeat = false) =>
    act(() => void window.dispatchEvent(new KeyboardEvent(type, { key: "y", repeat })));

  it("times a press of Y and says whether it would summon", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    render(<SettingsView onBack={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Test the hold time" }));
    expect(screen.getByRole("status")).toHaveTextContent("Press and hold Y for 400 ms");

    key("keydown");
    now += 150;
    key("keyup");
    expect(screen.getByRole("status")).toHaveTextContent("Held for 150 ms: too short");

    key("keydown");
    now += 100;
    key("keydown", true); // auto-repeat does not restart the timer
    now += 420;
    key("keyup");
    expect(screen.getByRole("status")).toHaveTextContent("Held for 520 ms: that summons Yadi");
    vi.restoreAllMocks();
  });

  it("uses the slider's value, and stops listening when switched off", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    render(<SettingsView onBack={() => {}} />);
    fireEvent.change(await screen.findByLabelText("Hold time in milliseconds"), {
      target: { value: "250" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Test the hold time" }));
    key("keydown");
    now = 300;
    key("keyup");
    expect(screen.getByRole("status")).toHaveTextContent("that summons Yadi");
    await userEvent.click(screen.getByRole("button", { name: "Stop testing" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });
});

describe("microphone", () => {
  it("lists the connected microphones with the default marked, and Save keeps the choice", async () => {
    render(<SettingsView onBack={() => {}} />);
    const select = await screen.findByLabelText("Microphone");
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(3));
    expect(
      screen.getByRole("option", { name: "MacBook Microphone (default)" }),
    ).toBeInTheDocument();
    await userEvent.selectOptions(select, "USB Mic");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(backend.settings.microphone.device).toBe("USB Mic"));
  });

  it("choosing 'System default' stores no device", async () => {
    backend.settings.microphone.device = "USB Mic";
    render(<SettingsView onBack={() => {}} />);
    const select = await screen.findByLabelText("Microphone");
    await waitFor(() => expect(select).toHaveValue("USB Mic"));
    await userEvent.selectOptions(select, "");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(backend.settings.microphone.device).toBeNull());
  });

  it("a saved microphone that is unplugged is shown and explained", async () => {
    backend.settings.microphone.device = "Studio Mic";
    render(<SettingsView onBack={() => {}} />);
    expect(
      await screen.findByRole("option", { name: "Studio Mic (not connected)" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("system default is used");
  });

  it("still works when the device list cannot be read", async () => {
    invoke.mockImplementationOnce(async () => backend.settings); // get_settings
    invoke.mockImplementationOnce(async () => {
      throw new Error("no audio");
    });
    render(<SettingsView onBack={() => {}} />);
    expect(await screen.findByLabelText("Microphone")).toBeInTheDocument();
  });
});

describe("language model", () => {
  it("offers Automatic plus every model, marking the recommended and the ones that may not fit", async () => {
    render(<SettingsView onBack={() => {}} />);
    await screen.findByLabelText("Language model");
    expect(
      await screen.findByRole("option", { name: /small:tag .* recommended/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /huge:tag .* may not fit/ })).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Automatic (best for this computer)" }),
    ).toBeInTheDocument();
  });

  it("choosing a model that does not fit shows the warning", async () => {
    render(<SettingsView onBack={() => {}} />);
    await screen.findByRole("option", { name: /huge:tag/ });
    await userEvent.selectOptions(screen.getByLabelText("Language model"), "huge");
    expect(screen.getByRole("alert")).toHaveTextContent("needs about 10.0 GB of memory");
    expect(screen.getByText(/has not been tested/)).toBeInTheDocument();
  });

  it("a model that is not downloaded yet offers to download it through setup", async () => {
    const onRerunSetup = vi.fn();
    render(<SettingsView onBack={() => {}} onRerunSetup={onRerunSetup} />);
    await screen.findByRole("option", { name: /huge:tag/ });
    await userEvent.selectOptions(screen.getByLabelText("Language model"), "huge");
    await userEvent.click(await screen.findByRole("button", { name: "Download it" }));
    expect(onRerunSetup).toHaveBeenCalledWith(false);
  });

  it("an installed model has no download prompt, and Save stores the choice", async () => {
    render(<SettingsView onBack={() => {}} />);
    await screen.findByRole("option", { name: /small:tag/ });
    await userEvent.selectOptions(screen.getByLabelText("Language model"), "small");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("ollama_has", { tag: "small:tag" }));
    expect(screen.queryByRole("button", { name: "Download it" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(backend.settings.llm.model_id).toBe("small"));
  });
});

describe("general", () => {
  it("the final-pass checkbox is on by default and can be switched off and saved", async () => {
    const user = userEvent.setup();
    render(<SettingsView onBack={() => {}} />);
    const box = await screen.findByLabelText(/Polish the transcript after recording/);
    expect(box).toBeChecked();
    await user.click(box);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(backend.settings.finalPass).toEqual({ enabled: false, timeout_seconds: 20 }),
    );
  });

  it("mascot animations are on by default and can be turned off and saved", async () => {
    const user = userEvent.setup();
    render(<SettingsView onBack={() => {}} />);
    const box = await screen.findByLabelText("Animate the mascot");
    expect(box).toBeChecked();
    await user.click(box);
    expect(box).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(backend.settings.appearance).toEqual({ animations: false }));
  });

  it("settings saved before the animation option existed count as animated", async () => {
    const old = defaults();
    delete old.appearance;
    backend.settings = old;
    render(<SettingsView onBack={() => {}} />);
    expect(await screen.findByLabelText("Animate the mascot")).toBeChecked();
  });

  it("launch at login is off by default and switches on and off at once", async () => {
    const user = userEvent.setup();
    render(<SettingsView onBack={() => {}} />);
    const box = await screen.findByLabelText("Start Yadi when I log in");
    await waitFor(() => expect(box).not.toBeChecked());
    await user.click(box);
    expect(autostart.enable).toHaveBeenCalled();
    await waitFor(() => expect(box).toBeChecked());
    await user.click(box);
    expect(autostart.disable).toHaveBeenCalled();
    await waitFor(() => expect(box).not.toBeChecked());
  });

  it("hides launch-at-login when the platform cannot say", async () => {
    vi.mocked(autostart.isEnabled).mockRejectedValueOnce(new Error("unsupported"));
    render(<SettingsView onBack={() => {}} />);
    await screen.findByText(/Hold time/);
    expect(screen.queryByLabelText("Start Yadi when I log in")).not.toBeInTheDocument();
  });

  it("a failing autostart change is shown", async () => {
    vi.mocked(autostart.enable).mockRejectedValueOnce("Not allowed");
    render(<SettingsView onBack={() => {}} />);
    await userEvent.click(await screen.findByLabelText("Start Yadi when I log in"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Not allowed");
  });

  it("back button calls onBack", async () => {
    const onBack = vi.fn();
    render(<SettingsView onBack={onBack} />);
    await userEvent.click(await screen.findByLabelText("Back to chat"));
    expect(onBack).toHaveBeenCalled();
  });
});

describe("setup, about and reset", () => {
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
    expect(screen.queryByRole("button", { name: "About and licences" })).not.toBeInTheDocument();
  });

  it("About and licences opens the About page", async () => {
    const onOpenAbout = vi.fn();
    render(<SettingsView onBack={() => {}} onOpenAbout={onOpenAbout} />);
    await userEvent.click(await screen.findByRole("button", { name: "About and licences" }));
    expect(onOpenAbout).toHaveBeenCalledTimes(1);
  });

  it("Reset everything asks first, then restores defaults, clears words and turns autostart off", async () => {
    backend.settings = {
      ...defaults(),
      summon: { mode: "chord", threshold_ms: 800, chord: "Alt+Y" },
    };
    backend.vocabulary = ["Yadi", "Ollama"];
    backend.autostart = true;
    const user = userEvent.setup();
    render(<SettingsView onBack={() => {}} />);
    expect(await screen.findByText("Ollama")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reset everything" }));
    expect(invoke).not.toHaveBeenCalledWith("reset_everything", undefined);
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Downloaded models are kept");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(backend.vocabulary).toEqual(["Yadi", "Ollama"]);

    await user.click(screen.getByRole("button", { name: "Reset everything" }));
    await user.click(screen.getByRole("button", { name: "Yes, reset everything" }));
    await waitFor(() => expect(backend.settings).toEqual(defaults()));
    expect(backend.vocabulary).toEqual([]);
    expect(autostart.disable).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("Ollama")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Hold the Y key")).toBeChecked();
  });
});

describe("persistence round trip", () => {
  it("everything saved comes back when Settings is opened again", async () => {
    const user = userEvent.setup();
    const first = render(<SettingsView onBack={() => {}} />);
    await screen.findByRole("option", { name: /small:tag/ });
    fireEvent.change(screen.getByLabelText("Hold time in milliseconds"), {
      target: { value: "700" },
    });
    await user.selectOptions(screen.getByLabelText("Microphone"), "USB Mic");
    await user.selectOptions(screen.getByLabelText("Language model"), "small");
    await user.click(screen.getByLabelText(/Polish the transcript/));
    await user.type(screen.getByLabelText("New word"), "Yadi{Enter}");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    first.unmount();

    render(<SettingsView onBack={() => {}} />);
    expect(await screen.findByText("Hold time: 700 ms")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Microphone")).toHaveValue("USB Mic"));
    await waitFor(() => expect(screen.getByLabelText("Language model")).toHaveValue("small"));
    expect(screen.getByLabelText(/Polish the transcript/)).not.toBeChecked();
    expect(await screen.findByText("Yadi")).toBeInTheDocument();
  });
});
