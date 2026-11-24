import { useCallback, useEffect, useRef, useState } from "react";
import {
  SETUP_STEPS,
  currentScreen,
  loadSetupState,
  stepNumber,
  withConsent,
  withStep,
  type SetupScreen,
  type SetupState,
  type SetupStepId,
} from "@yadi/core";
import type { SetupApi } from "./api";
import { formatBytes, formatSpeed, percent, redactPersonalPaths } from "./format";
import { STEP_DEFS, type StepContext, type StepProgress } from "./steps";
import type { HardwareProfile, ModelStatus, Selection, TierInfo } from "./types";

const STEP_TITLES: Record<SetupStepId, string> = {
  welcome: "Welcome",
  ollama: "Language engine",
  llm: "Language model",
  stt: "Speech models",
  microphone: "Microphone",
  summon: "Summon key",
};

/** Steps that start by themselves once the user agreed on the welcome screen. */
const AUTO_RUN: readonly SetupScreen[] = ["ollama", "llm", "stt"];
/** Steps that trigger an operating-system dialog: the user presses a button first. */
const AUTO_DETECT: readonly SetupScreen[] = ["microphone", "summon"];

interface Loaded {
  hardware: HardwareProfile;
  selection: Selection;
  models: ModelStatus[];
  version: string;
}

export const OFFLINE_HINT =
  "If you are offline, connect to the internet and press Try again. Whatever was already downloaded is kept, so it continues where it stopped.";

/** Plain-text details a person can paste into a bug report. No personal data. */
export function buildDetails(input: {
  step: SetupStepId;
  message: string;
  version: string;
  hardware: HardwareProfile | null;
  tier: string | null;
}): string {
  const hw = input.hardware;
  return [
    "Yadi setup details",
    `step: ${input.step}`,
    `error: ${redactPersonalPaths(input.message)}`,
    `app version: ${input.version}`,
    hw
      ? `system: ${hw.os} ${hw.arch}, ${Math.round(hw.ram_bytes / 1024 ** 3)} GB memory`
      : "system: unknown",
    `model tier: ${input.tier ?? "unknown"}`,
  ].join("\n");
}

function ProgressBar({ progress }: { progress: StepProgress | null }) {
  const pct = progress ? percent(progress.received, progress.total) : null;
  return (
    <div>
      <div
        className="setup-bar"
        role="progressbar"
        aria-label="Progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-busy={pct === null}
      >
        <div
          className={pct === null ? "setup-bar-fill setup-bar-indeterminate" : "setup-bar-fill"}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
      {progress && (
        <p className="setup-progress-text" data-testid="progress-text">
          {progress.label}
          {pct !== null && ` · ${pct}%`}
          {progress.total
            ? ` · ${formatBytes(progress.received)} of ${formatBytes(progress.total)}`
            : ""}
          {progress.bytesPerSecond ? ` · ${formatSpeed(progress.bytesPerSecond)}` : ""}
        </p>
      )}
    </div>
  );
}

export function SetupWizard({
  api,
  onFinished,
  onOpenAbout,
  now = Date.now,
}: {
  api: SetupApi;
  onFinished: () => void;
  onOpenAbout?: () => void;
  now?: () => number;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [progress, setProgress] = useState<StepProgress | null>(null);
  const [error, setError] = useState<{ step: SetupStepId; message: string } | null>(null);
  const [busy, setBusy] = useState<SetupStepId | null>(null);
  const [consentTick, setConsentTick] = useState(false);
  const [copied, setCopied] = useState(false);
  const [summon, setSummon] = useState("");
  const setupRef = useRef<SetupState | null>(null);
  const busyRef = useRef<SetupStepId | null>(null);
  const detected = useRef(new Set<string>());

  // ---- load ----
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.getState(),
      api.hardware(),
      api.selection(),
      api.listModels(),
      api.appVersion(),
    ]).then(
      ([raw, hardware, selection, models, version]) => {
        if (cancelled) return;
        const state = loadSetupState(raw);
        setupRef.current = state;
        setSetup(state);
        setConsentTick(state.consent);
        setLoaded({ hardware, selection, models, version });
      },
      (e: unknown) => !cancelled && setLoadError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  const persist = useCallback(
    async (next: SetupState) => {
      setupRef.current = next;
      setSetup(next);
      try {
        await api.saveState(next);
      } catch {
        // Not being able to save only costs a resume point; the wizard carries on.
      }
    },
    [api],
  );

  const tier: TierInfo | null = loaded?.selection.result === "tier" ? loaded.selection : null;

  const runStep = useCallback(
    async (id: Exclude<SetupStepId, "welcome">, opts: { detectOnly?: boolean } = {}) => {
      const current = setupRef.current;
      if (!current || !loaded || !tier || busyRef.current) return;
      busyRef.current = id;
      setBusy(id);
      setError(null);
      setProgress(null);
      const ctx: StepContext = {
        api,
        tier,
        hardware: loaded.hardware,
        repair: current.repair,
        report: setProgress,
        now,
      };
      const def = STEP_DEFS[id];
      try {
        if (opts.detectOnly) {
          if (await def.detect(ctx))
            await persist(withStep(setupRef.current ?? current, id, "done"));
          return;
        }
        await persist(withStep(current, id, "running"));
        if (await def.detect(ctx)) {
          await persist(withStep(setupRef.current ?? current, id, "done"));
        } else {
          await def.run(ctx);
          await persist(withStep(setupRef.current ?? current, id, "done"));
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!opts.detectOnly) {
          await persist(withStep(setupRef.current ?? current, id, "error"));
          setError({ step: id, message });
        }
      } finally {
        busyRef.current = null;
        setBusy(null);
        setProgress(null);
      }
    },
    [api, loaded, tier, now, persist],
  );

  const screen: SetupScreen | null = setup ? currentScreen(setup) : null;

  // Downloads start by themselves; permission steps only check if they are already granted.
  useEffect(() => {
    if (!setup || !screen || screen === "welcome" || screen === "done" || !tier) return;
    if (!setup.consent || busy || error) return;
    if (AUTO_RUN.includes(screen)) {
      void runStep(screen);
    } else if (AUTO_DETECT.includes(screen) && !detected.current.has(screen)) {
      detected.current.add(screen);
      void runStep(screen, { detectOnly: true });
    }
  }, [setup, screen, tier, busy, error, runStep]);

  // The finished screen shows how Yadi is summoned.
  useEffect(() => {
    if (screen === "done") void api.summonDescription().then(setSummon, () => setSummon(""));
  }, [screen, api]);

  const retry = () => {
    if (error && error.step !== "welcome") void runStep(error.step);
  };

  const copyDetails = async () => {
    if (!error) return;
    const text = buildDetails({
      step: error.step,
      message: error.message,
      version: loaded?.version ?? "unknown",
      hardware: loaded?.hardware ?? null,
      tier: tier?.id ?? null,
    });
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable: nothing else to do
    }
  };

  const cancelDownloads = () => {
    if (!tier) return;
    if (screen === "llm") void api.ollamaCancelPull(tier.llm_tag);
    if (screen === "stt") {
      void api.cancelDownload(tier.stt_stream_model_id);
      void api.cancelDownload(tier.stt_final_model_id);
    }
  };

  // ---- rendering ----
  if (loadError) {
    return (
      <div className="setup" role="alert">
        <h1>Set up Yadi</h1>
        <p>Yadi could not read your computer's details: {redactPersonalPaths(loadError)}</p>
      </div>
    );
  }
  if (!setup || !loaded || !screen) return <div className="setup">Loading…</div>;

  const sizeOf = (id: string) => loaded.models.find((m) => m.id === id)?.size_bytes ?? 0;
  const downloadBytes = tier
    ? sizeOf(tier.llm_model_id) + sizeOf(tier.stt_stream_model_id) + sizeOf(tier.stt_final_model_id)
    : 0;
  const hw = loaded.hardware;
  const stepError = error && error.step === screen ? error : null;

  const statusIcon = (id: SetupStepId) => {
    const s = setup.steps[id];
    if (s === "done") return { icon: "✓", label: "done" };
    if (busy === id || s === "running") return { icon: "…", label: "in progress" };
    if (s === "error" || (error && error.step === id))
      return { icon: "!", label: "needs attention" };
    return { icon: "○", label: "not started" };
  };

  const errorBox = stepError && (
    <div className="setup-error" role="alert">
      <p>{stepError.message}</p>
      {(screen === "ollama" || screen === "llm" || screen === "stt") && (
        <p className="setup-hint">{OFFLINE_HINT}</p>
      )}
      <div className="setup-actions">
        <button type="button" onClick={retry}>
          Try again
        </button>
        <button type="button" onClick={() => void copyDetails()}>
          {copied ? "Copied" : "Copy details"}
        </button>
      </div>
    </div>
  );

  let panel: React.ReactNode;
  if (screen === "welcome") {
    panel = (
      <section aria-label="Welcome">
        <h2>Welcome to Yadi</h2>
        <p>
          Yadi turns what you say into a clean, short prompt. Everything runs on this computer, and
          your voice and prompts never leave it.
        </p>
        <p>
          <strong>The internet is needed only for this setup.</strong> Afterwards Yadi works
          offline.
        </p>
        <h3>Your computer</h3>
        <ul className="setup-facts" data-testid="hardware-summary">
          <li>{Math.round(hw.ram_bytes / 1024 ** 3)} GB memory</li>
          <li>{hw.cpu_cores} processor cores</li>
          <li>
            {hw.gpu.kind === "apple-silicon"
              ? "Apple Silicon"
              : hw.gpu.kind === "nvidia"
                ? `NVIDIA graphics (${formatBytes(hw.gpu.vram_bytes)})`
                : "No dedicated graphics card"}
          </li>
          <li>{formatBytes(hw.free_disk_bytes)} free disk space</li>
        </ul>
        {tier ? (
          <>
            <h3>What will be installed</h3>
            <ul className="setup-facts" data-testid="plan-summary">
              <li>Language model: {tier.llm_tag}</li>
              <li>Speech models: live recognition and an accuracy pass</li>
              <li>
                About {formatBytes(downloadBytes)} to download, {formatBytes(tier.installed_bytes)}{" "}
                on disk (you need at least {formatBytes(tier.disk_needed_bytes)} free)
              </li>
            </ul>
            <label className="setup-consent">
              <input
                type="checkbox"
                checked={consentTick}
                onChange={(e) => setConsentTick(e.target.checked)}
              />{" "}
              I agree to download these (and install Ollama if it is missing).
            </label>
            <div className="setup-actions">
              <button
                type="button"
                disabled={!consentTick}
                onClick={() => void persist(withConsent(setup, true))}
              >
                Continue
              </button>
            </div>
          </>
        ) : (
          <div className="setup-error" role="alert" data-testid="unsupported">
            <p>
              {loaded.selection.result === "unsupported"
                ? loaded.selection.reason
                : "This computer is not supported."}
            </p>
            <p className="setup-hint">Yadi cannot run on this computer.</p>
          </div>
        )}
      </section>
    );
  } else if (screen === "ollama" || screen === "llm" || screen === "stt") {
    const text: Record<string, [string, string]> = {
      ollama: [
        "Setting up the language engine",
        "Yadi uses Ollama to run the language model on your computer. It is installed if it is missing, then started.",
      ],
      llm: [
        "Downloading the language model",
        "This is the biggest download. You can close Yadi and come back; it continues where it stopped.",
      ],
      stt: [
        "Downloading the speech models",
        "One model listens while you speak, another polishes the text afterwards.",
      ],
    };
    const [title, body] = text[screen] as [string, string];
    panel = (
      <section aria-label={STEP_TITLES[screen]}>
        <h2>{title}</h2>
        <p>{body}</p>
        {stepError ? (
          errorBox
        ) : (
          <>
            <ProgressBar progress={busy === screen ? progress : null} />
            {(screen === "llm" || screen === "stt") && busy === screen && (
              <div className="setup-actions">
                <button type="button" onClick={cancelDownloads}>
                  Cancel
                </button>
              </div>
            )}
          </>
        )}
      </section>
    );
  } else if (screen === "microphone") {
    panel = (
      <section aria-label="Microphone">
        <h2>Allow the microphone</h2>
        <p>
          Yadi listens only while you are recording, on this computer. Your computer will ask for
          permission.
        </p>
        {stepError ? (
          errorBox
        ) : (
          <div className="setup-actions">
            <button
              type="button"
              disabled={busy === "microphone"}
              onClick={() => void runStep("microphone")}
            >
              {busy === "microphone" ? "Waiting for your answer…" : "Allow microphone"}
            </button>
          </div>
        )}
      </section>
    );
  } else if (screen === "summon") {
    const mac = hw.os === "macos";
    panel = (
      <section aria-label="Summon key">
        <h2>How you call Yadi</h2>
        {mac ? (
          <p>
            Hold the <kbd>Y</kbd> key anywhere to summon Yadi. macOS needs your permission for this
            (Accessibility and Input Monitoring). If you prefer, use <kbd>Cmd</kbd>+<kbd>Shift</kbd>
            +<kbd>Y</kbd> instead.
          </p>
        ) : (
          <p>
            Hold the <kbd>Y</kbd> key anywhere to summon Yadi. If it does not work in some programs
            (for example ones running as administrator), or if your security software objects, use{" "}
            <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Y</kbd> instead; you can change this later in
            Settings.
          </p>
        )}
        {stepError ? errorBox : null}
        <div className="setup-actions">
          <button type="button" disabled={busy === "summon"} onClick={() => void runStep("summon")}>
            {mac ? (busy === "summon" ? "Waiting…" : "Turn on hold-Y") : "Continue"}
          </button>
          {mac && (
            <button
              type="button"
              onClick={async () => {
                await api.useChordFallback();
                setError(null);
                await persist(withStep(setupRef.current ?? setup, "summon", "done"));
              }}
            >
              Skip and use Cmd+Shift+Y instead
            </button>
          )}
        </div>
      </section>
    );
  } else {
    panel = (
      <section aria-label="Done">
        <h2>Yadi is ready</h2>
        <p data-testid="summon-key">
          Summon Yadi with: <strong>{summon || "…"}</strong>
        </p>
        <ol className="setup-how">
          <li>Press Y and speak your thoughts, however messy.</li>
          <li>Press Y again: Yadi cleans them up into a short prompt.</li>
          <li>Press Copy and paste it into your AI tool.</li>
        </ol>
        <div className="setup-actions">
          <button type="button" onClick={onFinished}>
            Start using Yadi
          </button>
          {onOpenAbout && (
            <button type="button" onClick={onOpenAbout}>
              About and licences
            </button>
          )}
        </div>
      </section>
    );
  }

  return (
    <div className="setup" data-testid="setup-wizard">
      {api.mock && (
        <p className="setup-mock">
          Simulated setup (development): nothing is downloaded or installed.
        </p>
      )}
      <header>
        <h1>Set up Yadi</h1>
        <p className="setup-count">
          Step {stepNumber(screen)} of {SETUP_STEPS.length}
        </p>
      </header>
      <ol className="setup-steps" aria-label="Steps">
        {SETUP_STEPS.map((id) => {
          const s = statusIcon(id);
          return (
            <li
              key={id}
              className={id === screen ? "setup-step-current" : ""}
              aria-current={id === screen ? "step" : undefined}
            >
              <span aria-label={s.label}>{s.icon}</span> {STEP_TITLES[id]}
            </li>
          );
        })}
      </ol>
      {panel}
    </div>
  );
}
