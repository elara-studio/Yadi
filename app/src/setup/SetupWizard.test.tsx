import { describe, expect, it, vi, type Mock } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { initialSetupState, withConsent, withStep, type SetupState } from "@yadi/core";
import type { SetupApi } from "./api";
import { createMockSetupApi } from "./mockApi";
import { OFFLINE_HINT, SetupWizard, buildDetails } from "./SetupWizard";
import { MIC_DENIED_MESSAGE, SUMMON_NOT_GRANTED_MESSAGE } from "./steps";
import type { HardwareProfile, ModelStatus, Selection } from "./types";

const HW: HardwareProfile = {
  ram_bytes: 18 * 1024 ** 3,
  free_disk_bytes: 40_000_000_000,
  cpu_cores: 11,
  arch: "aarch64",
  os: "macos",
  gpu: { kind: "apple-silicon" },
};
const TIER = {
  result: "tier" as const,
  id: "mid",
  llm_model_id: "llm-q",
  llm_tag: "qwen3:4b-instruct-2507-q4_K_M",
  stt_final_model_id: "stt-final",
  stt_stream_model_id: "stt-stream",
  installed_bytes: 3_286_125_063,
  disk_needed_bytes: 4_929_187_595,
  memory_needed_bytes: 3_571_035_140,
};
const MODELS = (installed: string[] = []): ModelStatus[] => [
  {
    id: "stt-stream",
    kind: "stt-stream",
    size_bytes: 310_414_022,
    installed: installed.includes("stt-stream"),
  },
  {
    id: "stt-final",
    kind: "stt-final",
    size_bytes: 208_576_005,
    installed: installed.includes("stt-final"),
  },
  {
    id: "llm-q",
    kind: "llm",
    size_bytes: 2_497_293_316,
    ollama_tag: TIER.llm_tag,
    installed: false,
  },
];

type FakeApi = {
  [K in keyof SetupApi]: SetupApi[K] extends (...a: never[]) => unknown
    ? Mock<SetupApi[K]>
    : SetupApi[K];
};

function fakeApi(
  over: Partial<SetupApi> = {},
  state: unknown = null,
  selection: Selection = TIER,
  hw = HW,
): FakeApi {
  const pull = new Set<(p: { status: string; completed?: number; total?: number }) => void>();
  const dl = new Map<string, Set<(p: { received: number; total: number | null }) => void>>();
  const api: SetupApi = {
    mock: false,
    getState: vi.fn(async () => state),
    saveState: vi.fn(async () => {}),
    hardware: vi.fn(async () => hw),
    selection: vi.fn(async () => selection),
    listModels: vi.fn(async () => MODELS()),
    ollamaStatus: vi.fn(async () => ({ state: "running" as const, version: "1" })),
    ollamaInstall: vi.fn(async () => {}),
    ollamaStart: vi.fn(async () => {}),
    ollamaHas: vi.fn(async () => false),
    ollamaPull: vi.fn(async () => {}),
    ollamaCancelPull: vi.fn(async () => {}),
    onPullProgress: vi.fn((cb) => {
      pull.add(cb);
      return () => void pull.delete(cb);
    }),
    downloadModel: vi.fn(async () => {}),
    cancelDownload: vi.fn(async () => {}),
    onDownloadProgress: vi.fn((id, cb) => {
      const set = dl.get(id) ?? new Set();
      set.add(cb);
      dl.set(id, set);
      return () => void set.delete(cb);
    }),
    micStatus: vi.fn(async () => "not-determined" as const),
    micRequest: vi.fn(async () => "authorized" as const),
    hotkeyStatus: vi.fn(async () => ({ accessibility: false, input_monitoring: false })),
    hotkeyRequest: vi.fn(async () => {}),
    useChordFallback: vi.fn(async () => {}),
    summonDescription: vi.fn(async () => "Hold the Y key"),
    appVersion: vi.fn(async () => "0.1.0"),
    ...over,
  };
  // test helpers to push progress
  (api as unknown as Record<string, unknown>).__pull = (p: {
    status: string;
    completed?: number;
    total?: number;
  }) => pull.forEach((cb) => cb(p));
  (api as unknown as Record<string, unknown>).__download = (
    id: string,
    p: { received: number; total: number | null },
  ) => dl.get(id)?.forEach((cb) => cb(p));
  return api as unknown as FakeApi;
}
const pushPull = (api: FakeApi, p: { status: string; completed?: number; total?: number }) =>
  act(() => (api as unknown as { __pull: (x: typeof p) => void }).__pull(p));
const pushDownload = (api: FakeApi, id: string, p: { received: number; total: number | null }) =>
  act(() => (api as unknown as { __download: (i: string, x: typeof p) => void }).__download(id, p));

const consented = (...done: Parameters<typeof withStep>[1][]): SetupState => {
  let s = withConsent(initialSetupState(), true);
  for (const id of done) s = withStep(s, id, "done");
  return s;
};

function renderWizard(
  api: FakeApi | SetupApi,
  props: { onFinished?: () => void; onOpenAbout?: () => void; now?: () => number } = {},
) {
  const onFinished = props.onFinished ?? vi.fn();
  return {
    onFinished,
    ...render(
      <SetupWizard
        api={api as SetupApi}
        onFinished={onFinished}
        onOpenAbout={props.onOpenAbout}
        now={props.now}
      />,
    ),
  };
}
const stepCount = () => screen.getByText(/^Step \d of 6$/).textContent;

describe("SetupWizard", () => {
  describe("welcome", () => {
    it("shows the hardware, what will be installed, sizes and the offline promise", async () => {
      renderWizard(fakeApi());
      expect(await screen.findByText("Welcome to Yadi")).toBeInTheDocument();
      const hw = screen.getByTestId("hardware-summary");
      expect(hw).toHaveTextContent("18 GB memory");
      expect(hw).toHaveTextContent("11 processor cores");
      expect(hw).toHaveTextContent("Apple Silicon");
      expect(hw).toHaveTextContent("40.0 GB free disk space");
      const plan = screen.getByTestId("plan-summary");
      expect(plan).toHaveTextContent("qwen3:4b-instruct-2507-q4_K_M");
      expect(plan).toHaveTextContent("About 3.0 GB to download"); // 2.50 + 0.31 + 0.21 GB
      expect(plan).toHaveTextContent("3.3 GB on disk");
      expect(plan).toHaveTextContent("at least 4.9 GB free");
      expect(screen.getByText(/internet is needed only for this setup/i)).toBeInTheDocument();
      expect(screen.getByText(/Afterwards Yadi works offline/)).toBeInTheDocument();
    });

    it("Continue needs the consent checkbox, then saves consent and moves on", async () => {
      const user = userEvent.setup();
      const api = fakeApi({ ollamaStatus: vi.fn(async () => ({ state: "missing" as const })) });
      renderWizard(api);
      const button = await screen.findByRole("button", { name: "Continue" });
      expect(button).toBeDisabled();
      await user.click(screen.getByRole("checkbox"));
      expect(button).toBeEnabled();
      await user.click(button);
      await waitFor(() => expect(api.saveState).toHaveBeenCalled());
      const saved = (api.saveState as Mock).mock.calls[0]?.[0] as SetupState;
      expect(saved.consent).toBe(true);
      expect(saved.steps.welcome).toBe("done");
    });

    it("unsupported hardware shows the reason and offers no way forward", async () => {
      renderWizard(
        fakeApi({}, null, {
          result: "unsupported",
          why: {},
          reason: "This computer has 4 GB of memory; Yadi needs at least 6 GB.",
        }),
      );
      expect(await screen.findByTestId("unsupported")).toHaveTextContent("needs at least 6 GB");
      expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    });

    it("a computer whose details cannot be read gets a clear message", async () => {
      renderWizard(
        fakeApi({
          hardware: vi.fn(async () =>
            Promise.reject(new Error("no app data directory: /Users/jane/x")),
          ),
        }),
      );
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("could not read your computer's details");
      expect(alert).not.toHaveTextContent("jane");
    });
  });

  describe("Ollama step", () => {
    it("already running: done without installing anything (idempotent)", async () => {
      const api = fakeApi({}, consented());
      renderWizard(api);
      await waitFor(() => expect(stepCount()).not.toBe("Step 2 of 6"));
      expect(api.ollamaInstall).not.toHaveBeenCalled();
      expect(api.ollamaStart).not.toHaveBeenCalled();
    });

    it("missing: installs, shows download progress with speed, then starts it", async () => {
      let status: "missing" | "installed" | "running" = "missing";
      let finishInstall: () => void = () => {};
      const api = fakeApi(
        {
          ollamaStatus: vi.fn(async () =>
            status === "running"
              ? { state: "running" as const, version: "1" }
              : status === "installed"
                ? { state: "installed" as const, path: "/Applications/Ollama.app" }
                : { state: "missing" as const },
          ),
          ollamaInstall: vi.fn(
            () =>
              new Promise<void>(
                (r) =>
                  (finishInstall = () => {
                    status = "installed";
                    r();
                  }),
              ),
          ),
          ollamaStart: vi.fn(async () => void (status = "running")),
        },
        consented(),
      );
      let t = 0;
      renderWizard(api, { now: () => (t += 1000) });
      await waitFor(() => expect(api.ollamaInstall).toHaveBeenCalled());
      expect(stepCount()).toBe("Step 2 of 6");
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-busy", "true"); // size unknown yet
      pushDownload(api, "ollama-installer", { received: 10_000_000, total: 100_000_000 });
      pushDownload(api, "ollama-installer", { received: 60_000_000, total: 100_000_000 });
      const text = screen.getByTestId("progress-text");
      expect(text).toHaveTextContent("Downloading Ollama");
      expect(text).toHaveTextContent("60%");
      expect(text).toHaveTextContent("60 MB of 100 MB");
      expect(text).toHaveTextContent("50.0 MB/s");
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "60");
      await act(async () => finishInstall());
      await waitFor(() => expect(api.ollamaStart).toHaveBeenCalled());
      await waitFor(() => expect(stepCount()).not.toBe("Step 2 of 6"));
    });

    it("installed but not running: starts it without reinstalling", async () => {
      let running = false;
      const api = fakeApi(
        {
          ollamaStatus: vi.fn(async () =>
            running
              ? { state: "running" as const, version: "1" }
              : { state: "installed" as const, path: "/x" },
          ),
          ollamaStart: vi.fn(async () => void (running = true)),
        },
        consented(),
      );
      renderWizard(api);
      await waitFor(() => expect(api.ollamaStart).toHaveBeenCalledTimes(1));
      expect(api.ollamaInstall).not.toHaveBeenCalled();
    });

    it("error: shows the message, the offline hint, Try again and Copy details", async () => {
      const user = userEvent.setup();
      let fail = true;
      const api = fakeApi(
        {
          ollamaStatus: vi.fn(async () => ({ state: "missing" as const })),
          ollamaInstall: vi.fn(async () => {
            if (fail)
              throw new Error(
                "Download failed: error sending request for url (https://ollama.com/...)",
              );
          }),
        },
        consented(),
      );
      renderWizard(api);
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Download failed");
      expect(alert).toHaveTextContent(OFFLINE_HINT);
      expect(within(alert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
      expect(screen.getByText("Language engine").closest("li")).toHaveAttribute(
        "aria-current",
        "step",
      );
      // the step is saved as an error so a restart resumes here
      const states = (api.saveState as Mock).mock.calls.map(
        (c) => (c[0] as SetupState).steps.ollama,
      );
      expect(states).toContain("error");
      fail = false;
      await user.click(within(alert).getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(api.ollamaInstall).toHaveBeenCalledTimes(2));
    });

    it("Copy details copies step, version and system but no personal paths", async () => {
      const user = userEvent.setup();
      const api = fakeApi(
        {
          ollamaStatus: vi.fn(async () => ({ state: "missing" as const })),
          ollamaInstall: vi.fn(async () => {
            throw new Error("cannot write /Users/jane.doe/Library/Application Support/x");
          }),
        },
        consented(),
      );
      renderWizard(api);
      await user.click(await screen.findByRole("button", { name: "Copy details" }));
      const text = await navigator.clipboard.readText();
      expect(text).toContain("step: ollama");
      expect(text).toContain("app version: 0.1.0");
      expect(text).toContain("macos aarch64");
      expect(text).toContain("model tier: mid");
      expect(text).toContain("~/Library/Application Support/x");
      expect(text).not.toContain("jane");
      expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    });
  });

  describe("language model step", () => {
    it("already pulled: skipped (idempotent)", async () => {
      const api = fakeApi({ ollamaHas: vi.fn(async () => true) }, consented("ollama"));
      renderWizard(api);
      await waitFor(() => expect(stepCount()).not.toBe("Step 3 of 6"));
      expect(api.ollamaPull).not.toHaveBeenCalled();
    });

    it("shows progress, speed and a Cancel button while pulling", async () => {
      const user = userEvent.setup();
      let finish: () => void = () => {};
      const api = fakeApi(
        { ollamaPull: vi.fn(() => new Promise<void>((r) => (finish = r))) },
        consented("ollama"),
      );
      let t = 0;
      renderWizard(api, { now: () => (t += 1000) });
      await waitFor(() => expect(api.ollamaPull).toHaveBeenCalledWith(TIER.llm_tag));
      expect(stepCount()).toBe("Step 3 of 6");
      pushPull(api, { status: "pulling manifest" });
      expect(screen.getByTestId("progress-text")).toHaveTextContent("pulling manifest");
      pushPull(api, { status: "pulling abc123", completed: 500_000_000, total: 2_000_000_000 });
      pushPull(api, { status: "pulling abc123", completed: 1_000_000_000, total: 2_000_000_000 });
      const text = screen.getByTestId("progress-text");
      expect(text).toHaveTextContent("50%");
      expect(text).toHaveTextContent("1.0 GB of 2.0 GB");
      expect(text).toHaveTextContent("500.0 MB/s");
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(api.ollamaCancelPull).toHaveBeenCalledWith(TIER.llm_tag);
      await act(async () => finish());
    });

    it("a cancelled or failed pull offers Try again, and resuming works", async () => {
      const user = userEvent.setup();
      let attempt = 0;
      const api = fakeApi(
        {
          ollamaPull: vi.fn(async () => {
            if (++attempt === 1) throw new Error("The download was cancelled.");
          }),
        },
        consented("ollama"),
      );
      renderWizard(api);
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("The download was cancelled.");
      await user.click(within(alert).getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(api.ollamaPull).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(stepCount()).not.toBe("Step 3 of 6"));
    });

    it("if Ollama was removed since the saved progress, it is installed again before pulling", async () => {
      let status: "missing" | "running" = "missing";
      const api = fakeApi(
        {
          ollamaStatus: vi.fn(async () =>
            status === "running"
              ? { state: "running" as const, version: "1" }
              : { state: "missing" as const },
          ),
          ollamaInstall: vi.fn(async () => void (status = "running")),
        },
        consented("ollama"),
      );
      renderWizard(api);
      await waitFor(() => expect(api.ollamaPull).toHaveBeenCalled());
      expect(api.ollamaInstall).toHaveBeenCalledTimes(1);
    });

    it("if Ollama stopped running it is started before pulling", async () => {
      let running = false;
      const api = fakeApi(
        {
          ollamaStatus: vi.fn(async () =>
            running
              ? { state: "running" as const, version: "1" }
              : { state: "installed" as const, path: "/x" },
          ),
          ollamaStart: vi.fn(async () => void (running = true)),
        },
        consented("ollama"),
      );
      renderWizard(api);
      await waitFor(() => expect(api.ollamaPull).toHaveBeenCalled());
      expect(api.ollamaStart).toHaveBeenCalled();
    });
  });

  describe("speech models step", () => {
    it("downloads the live model then the accuracy model, with progress", async () => {
      const order: string[] = [];
      let finish: () => void = () => {};
      const api = fakeApi(
        {
          downloadModel: vi.fn(async (id: string) => {
            order.push(id);
            if (id === "stt-stream") await new Promise<void>((r) => (finish = r));
          }),
        },
        consented("ollama", "llm"),
      );
      renderWizard(api);
      await waitFor(() => expect(order).toEqual(["stt-stream"]));
      expect(stepCount()).toBe("Step 4 of 6");
      pushDownload(api, "stt-stream", { received: 155_207_011, total: 310_414_022 });
      expect(screen.getByTestId("progress-text")).toHaveTextContent("Live speech model");
      expect(screen.getByTestId("progress-text")).toHaveTextContent("50%");
      await act(async () => finish());
      await waitFor(() => expect(order).toEqual(["stt-stream", "stt-final"]));
      expect(api.downloadModel).toHaveBeenCalledWith("stt-stream", false);
    });

    it("skips what is installed already, and everything when both are (idempotent)", async () => {
      const partial = fakeApi(
        { listModels: vi.fn(async () => MODELS(["stt-stream"])) },
        consented("ollama", "llm"),
      );
      renderWizard(partial);
      await waitFor(() => expect(partial.downloadModel).toHaveBeenCalledTimes(1));
      expect(partial.downloadModel).toHaveBeenCalledWith("stt-final", false);
    });

    it("nothing to do when both are installed", async () => {
      const api = fakeApi(
        { listModels: vi.fn(async () => MODELS(["stt-stream", "stt-final"])) },
        consented("ollama", "llm"),
      );
      renderWizard(api);
      await waitFor(() => expect(stepCount()).not.toBe("Step 4 of 6"));
      expect(api.downloadModel).not.toHaveBeenCalled();
    });

    it("repair mode downloads both again even if they look installed", async () => {
      const state = { ...consented("ollama", "llm"), repair: true };
      const api = fakeApi(
        { listModels: vi.fn(async () => MODELS(["stt-stream", "stt-final"])) },
        state,
      );
      renderWizard(api);
      await waitFor(() => expect(api.downloadModel).toHaveBeenCalledTimes(2));
      expect(api.downloadModel).toHaveBeenCalledWith("stt-stream", true);
      expect(api.downloadModel).toHaveBeenCalledWith("stt-final", true);
    });

    it("an error keeps progress and offers to retry", async () => {
      const user = userEvent.setup();
      let first = true;
      const api = fakeApi(
        {
          downloadModel: vi.fn(async () => {
            if (first) {
              first = false;
              throw new Error("Not enough free disk space: 400 MB needed, 100 MB available.");
            }
          }),
        },
        consented("ollama", "llm"),
      );
      renderWizard(api);
      expect(await screen.findByRole("alert")).toHaveTextContent("Not enough free disk space");
      await user.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(stepCount()).not.toBe("Step 4 of 6"));
    });
  });

  describe("microphone step", () => {
    const atMic = () => consented("ollama", "llm", "stt");

    it("pending: explains and waits for a click before the system asks", async () => {
      const api = fakeApi({}, atMic());
      renderWizard(api);
      await screen.findByRole("button", { name: "Allow microphone" });
      expect(stepCount()).toBe("Step 5 of 6");
      expect(api.micRequest).not.toHaveBeenCalled();
    });

    it("running: shows that it is waiting for the user's answer", async () => {
      const user = userEvent.setup();
      let answer: (s: "authorized") => void = () => {};
      const api = fakeApi(
        { micRequest: vi.fn(() => new Promise<"authorized">((r) => (answer = r))) },
        atMic(),
      );
      renderWizard(api);
      await user.click(await screen.findByRole("button", { name: "Allow microphone" }));
      expect(screen.getByRole("button", { name: "Waiting for your answer…" })).toBeDisabled();
      await act(async () => answer("authorized"));
      await waitFor(() => expect(stepCount()).toBe("Step 6 of 6"));
    });

    it("done: already allowed is detected without asking", async () => {
      const api = fakeApi({ micStatus: vi.fn(async () => "authorized" as const) }, atMic());
      renderWizard(api);
      await waitFor(() => expect(stepCount()).toBe("Step 6 of 6"));
      expect(api.micRequest).not.toHaveBeenCalled();
    });

    it("error: denied access explains how to turn it on", async () => {
      const user = userEvent.setup();
      const api = fakeApi({ micRequest: vi.fn(async () => "denied" as const) }, atMic());
      renderWizard(api);
      await user.click(await screen.findByRole("button", { name: "Allow microphone" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(MIC_DENIED_MESSAGE);
    });

    it("an unknown answer (no system API) does not block setup", async () => {
      const user = userEvent.setup();
      const api = fakeApi({ micRequest: vi.fn(async () => "unknown" as const) }, atMic());
      renderWizard(api);
      await user.click(await screen.findByRole("button", { name: "Allow microphone" }));
      await waitFor(() => expect(stepCount()).toBe("Step 6 of 6"));
    });

    it("no answer yet is an error that can be retried", async () => {
      const user = userEvent.setup();
      const api = fakeApi({ micRequest: vi.fn(async () => "not-determined" as const) }, atMic());
      renderWizard(api);
      await user.click(await screen.findByRole("button", { name: "Allow microphone" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "No answer to the microphone question",
      );
    });
  });

  describe("summon key step", () => {
    const atSummon = () => consented("ollama", "llm", "stt", "microphone");

    it("macOS pending: offers to turn on hold-Y or to skip to the shortcut", async () => {
      renderWizard(fakeApi({}, atSummon()));
      expect(await screen.findByRole("button", { name: "Turn on hold-Y" })).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Skip and use Cmd+Shift+Y instead" }),
      ).toBeInTheDocument();
      expect(stepCount()).toBe("Step 6 of 6");
    });

    it("already granted: detected and finished without a click", async () => {
      const api = fakeApi(
        { hotkeyStatus: vi.fn(async () => ({ accessibility: true, input_monitoring: true })) },
        atSummon(),
      );
      renderWizard(api);
      expect(await screen.findByText("Yadi is ready")).toBeInTheDocument();
      expect(api.hotkeyRequest).not.toHaveBeenCalled();
    });

    it("asks for permission and finishes when it is granted", async () => {
      const user = userEvent.setup();
      let granted = false;
      const api = fakeApi(
        {
          hotkeyStatus: vi.fn(async () => ({ accessibility: granted, input_monitoring: granted })),
          hotkeyRequest: vi.fn(async () => void (granted = true)),
        },
        atSummon(),
      );
      renderWizard(api);
      await user.click(await screen.findByRole("button", { name: "Turn on hold-Y" }));
      expect(await screen.findByText("Yadi is ready")).toBeInTheDocument();
      expect(api.hotkeyRequest).toHaveBeenCalledTimes(1);
    });

    it("error: not granted yet explains what to do", async () => {
      const user = userEvent.setup();
      renderWizard(fakeApi({}, atSummon()));
      await user.click(await screen.findByRole("button", { name: "Turn on hold-Y" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(SUMMON_NOT_GRANTED_MESSAGE);
    });

    it("Skip switches to the chord and completes the step", async () => {
      const user = userEvent.setup();
      const api = fakeApi(
        { summonDescription: vi.fn(async () => "CommandOrControl+Shift+Y") },
        atSummon(),
      );
      renderWizard(api);
      await user.click(
        await screen.findByRole("button", { name: "Skip and use Cmd+Shift+Y instead" }),
      );
      expect(api.useChordFallback).toHaveBeenCalledTimes(1);
      expect(await screen.findByText("Yadi is ready")).toBeInTheDocument();
      expect(await screen.findByTestId("summon-key")).toHaveTextContent("CommandOrControl+Shift+Y");
    });

    it("Windows: shows an explanation and a Continue button (nothing to grant)", async () => {
      const user = userEvent.setup();
      const api = fakeApi({}, atSummon(), TIER, {
        ...HW,
        os: "windows",
        arch: "x86_64",
        gpu: { kind: "none" },
      });
      renderWizard(api);
      expect(await screen.findByText(/administrator/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Skip and use/ })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Continue" }));
      expect(await screen.findByText("Yadi is ready")).toBeInTheDocument();
      expect(api.hotkeyRequest).not.toHaveBeenCalled();
    });
  });

  describe("done", () => {
    const allDone = () => consented("ollama", "llm", "stt", "microphone", "summon");

    it("shows the summon key, three lines of how it works and the licences link", async () => {
      const user = userEvent.setup();
      const onOpenAbout = vi.fn();
      const { onFinished } = renderWizard(fakeApi({}, allDone()), { onOpenAbout });
      expect(await screen.findByText("Yadi is ready")).toBeInTheDocument();
      expect(await screen.findByTestId("summon-key")).toHaveTextContent("Hold the Y key");
      expect(
        screen.getAllByRole("listitem").filter((li) => li.closest("ol.setup-how")),
      ).toHaveLength(3);
      await user.click(screen.getByRole("button", { name: "About and licences" }));
      expect(onOpenAbout).toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Start using Yadi" }));
      expect(onFinished).toHaveBeenCalledTimes(1);
    });
  });

  describe("resume", () => {
    it("begins at the first step that is not done, not at the start", async () => {
      let release: () => void = () => {};
      const api = fakeApi(
        { downloadModel: vi.fn(() => new Promise<void>((r) => (release = r))) },
        consented("ollama", "llm"),
      );
      renderWizard(api);
      await waitFor(() => expect(api.downloadModel).toHaveBeenCalled());
      expect(stepCount()).toBe("Step 4 of 6");
      expect(api.ollamaInstall).not.toHaveBeenCalled();
      expect(api.ollamaPull).not.toHaveBeenCalled();
      const steps = within(screen.getByRole("list", { name: "Steps" }));
      expect(steps.getByText("Language model").closest("li")).toHaveTextContent("✓");
      expect(steps.getByText("Speech models").closest("li")).toHaveAttribute(
        "aria-current",
        "step",
      );
      await act(async () => release());
    });

    it("a step that was 'running' when the app quit starts again", async () => {
      const state = {
        ...consented("ollama"),
        steps: { ...consented("ollama").steps, llm: "running" as const },
      };
      const api = fakeApi({}, state);
      renderWizard(api);
      await waitFor(() => expect(api.ollamaPull).toHaveBeenCalledWith(TIER.llm_tag));
    });

    it("a step saved as 'error' resumes by trying again", async () => {
      const state = {
        ...consented("ollama"),
        steps: { ...consented("ollama").steps, llm: "error" as const },
      };
      const api = fakeApi({}, state);
      renderWizard(api);
      await waitFor(() => expect(api.ollamaPull).toHaveBeenCalled());
    });

    it("garbage in setup.json starts at the welcome screen", async () => {
      renderWizard(fakeApi({}, { steps: "???", consent: 42 }));
      expect(await screen.findByText("Welcome to Yadi")).toBeInTheDocument();
      expect(stepCount()).toBe("Step 1 of 6");
    });

    it("a finished setup shows the done screen straight away", async () => {
      renderWizard(fakeApi({}, consented("ollama", "llm", "stt", "microphone", "summon")));
      expect(await screen.findByText("Yadi is ready")).toBeInTheDocument();
    });

    it("every progress change is saved", async () => {
      const api = fakeApi({}, consented("ollama"));
      renderWizard(api);
      await waitFor(() => expect(stepCount()).toBe("Step 5 of 6"));
      const llm = (api.saveState as Mock).mock.calls.map((c) => (c[0] as SetupState).steps.llm);
      expect(llm).toContain("running");
      expect(llm).toContain("done");
    });

    it("a failing save does not stop the wizard", async () => {
      const api = fakeApi(
        { saveState: vi.fn(async () => Promise.reject(new Error("disk full"))) },
        consented("ollama", "llm", "stt"),
      );
      renderWizard(api);
      expect(await screen.findByRole("button", { name: "Allow microphone" })).toBeInTheDocument();
    });
  });

  describe("buildDetails", () => {
    it("never contains the home folder", () => {
      const d = buildDetails({
        step: "llm",
        message: "x /Users/sam/y and C:\\Users\\Sam Doe\\z",
        version: "1",
        hardware: HW,
        tier: "low",
      });
      expect(d).not.toMatch(/sam|doe/i);
      expect(d).toContain("step: llm");
    });
    it("copes with missing hardware and tier", () => {
      const d = buildDetails({
        step: "ollama",
        message: "m",
        version: "1",
        hardware: null,
        tier: null,
      });
      expect(d).toContain("system: unknown");
      expect(d).toContain("model tier: unknown");
    });
  });

  describe("simulated setup (YADI_MOCK_SETUP) end to end", () => {
    it("completes the whole wizard with the mock API", async () => {
      const user = userEvent.setup();
      const api = createMockSetupApi({ delayMs: 0 });
      const { onFinished } = renderWizard(api);
      expect(await screen.findByText(/Simulated setup/)).toBeInTheDocument();
      await user.click(await screen.findByRole("checkbox"));
      await user.click(screen.getByRole("button", { name: "Continue" }));
      await user.click(await screen.findByRole("button", { name: "Allow microphone" }));
      await user.click(await screen.findByRole("button", { name: "Turn on hold-Y" }));
      expect(await screen.findByText("Yadi is ready")).toBeInTheDocument();
      expect(await screen.findByTestId("summon-key")).toHaveTextContent("Hold the Y key");
      await user.click(screen.getByRole("button", { name: "Start using Yadi" }));
      expect(onFinished).toHaveBeenCalled();
      // everything was recorded as done in the saved state
      const saved = (await api.getState()) as SetupState;
      expect(Object.values(saved.steps).every((s) => s === "done")).toBe(true);
    });

    it("the mock can fail once to show the error screen, and then recovers", async () => {
      const user = userEvent.setup();
      const api = createMockSetupApi({
        delayMs: 0,
        failOnce: "ollamaPull",
        state: consented("ollama"),
      });
      renderWizard(api);
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Simulated network failure");
      await user.click(within(alert).getByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("button", { name: "Allow microphone" })).toBeInTheDocument();
    });

    it("the mock resumes from a saved partial state", async () => {
      const api = createMockSetupApi({
        delayMs: 0,
        state: consented("ollama", "llm", "stt", "microphone"),
      });
      renderWizard(api);
      expect(await screen.findByRole("button", { name: "Turn on hold-Y" })).toBeInTheDocument();
    });

    it("the mock on Windows uses the Ctrl chord wording after a skip", async () => {
      const api = createMockSetupApi({ delayMs: 0, os: "windows" });
      await api.useChordFallback();
      expect(await api.summonDescription()).toBe("Ctrl+Shift+Y");
    });
  });
});
