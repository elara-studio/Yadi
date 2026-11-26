import type { SetupStepId } from "@yadi/core";
import type { SetupApi } from "./api";
import { SpeedMeter } from "./format";
import type { HardwareProfile, Progress, TierInfo } from "./types";

/** What a running step reports to the screen. */
export interface StepProgress {
  label: string;
  received: number;
  total: number | null;
  bytesPerSecond: number | null;
  /**
   * The download is complete and the step is doing the rest of its work (checking, unpacking,
   * installing). The bar then shows "busy" instead of a full bar that looks stuck.
   */
  finishing?: boolean;
}

/** What each phase after the last byte is called on screen. */
export const PHASE_LABELS: Record<string, string> = {
  unpacking: "Unpacking",
  verifying: "Checking it is genuine",
  installing: "Installing",
};
export const FINISHING_LABEL = "Finishing up";

export interface StepContext {
  api: SetupApi;
  tier: TierInfo;
  hardware: HardwareProfile;
  /** Repair mode: models are downloaded again even if they look installed. */
  repair: boolean;
  report: (progress: StepProgress) => void;
  /** Wall clock in ms; injected so speed measurement is testable. */
  now: () => number;
}

export interface StepDef {
  id: Exclude<SetupStepId, "welcome">;
  title: string;
  /** Already done? Steps are idempotent: if so the wizard moves on without doing anything. */
  detect(ctx: StepContext): Promise<boolean>;
  run(ctx: StepContext): Promise<void>;
}

const isMac = (c: StepContext) => c.hardware.os === "macos";

/** A progress callback that also measures speed. */
function meter(ctx: StepContext, label: string) {
  const speed = new SpeedMeter();
  return (p: Progress) => {
    const { received, total } = p;
    // A phase from the backend names the work; a full bar without one is still "finishing".
    const finishing = Boolean(p.phase) || (total !== null && total > 0 && received >= total);
    if (finishing) {
      const what = (p.phase && PHASE_LABELS[p.phase]) || FINISHING_LABEL;
      ctx.report({
        label: `${what}: ${label.toLowerCase()}`,
        received,
        total: null,
        bytesPerSecond: null,
        finishing: true,
      });
      return;
    }
    ctx.report({ label, received, total, bytesPerSecond: speed.add(ctx.now(), received) });
  };
}

/**
 * Makes sure Ollama answers before something needs it. If the saved progress says it was set up
 * but it has since been removed or stopped, this installs/starts it again rather than failing.
 */
async function ensureOllamaRunning(ctx: StepContext): Promise<void> {
  if ((await ctx.api.ollamaStatus()).state === "running") return;
  await ollamaStep.run(ctx);
}

export const ollamaStep: StepDef = {
  id: "ollama",
  title: "Ollama (the engine that runs the language model)",
  async detect(ctx) {
    return (await ctx.api.ollamaStatus()).state === "running";
  },
  async run(ctx) {
    let status = await ctx.api.ollamaStatus();
    if (status.state === "missing") {
      const report = meter(ctx, "Downloading Ollama");
      const off = ctx.api.onDownloadProgress("ollama-installer", report);
      try {
        await ctx.api.ollamaInstall();
      } finally {
        off();
      }
      status = await ctx.api.ollamaStatus();
    }
    if (status.state === "installed") {
      ctx.report({ label: "Starting Ollama", received: 0, total: null, bytesPerSecond: null });
      await ctx.api.ollamaStart();
      status = await ctx.api.ollamaStatus();
    }
    if (status.state !== "running") throw new Error("Ollama did not start. Please try again.");
  },
};

/** Ollama's status lines ("pulling 3f8e...", "verifying sha256 digest") in plain words. */
export function pullLabel(status: string): string {
  if (status.startsWith("pulling manifest")) return "Contacting the model library";
  if (status.startsWith("pulling")) return "Downloading the language model";
  if (status.startsWith("verifying")) return "Checking it is genuine";
  if (status.startsWith("writing manifest")) return "Finishing up";
  if (status === "success") return "Done";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export const llmStep: StepDef = {
  id: "llm",
  title: "Language model",
  async detect(ctx) {
    if (ctx.repair) return false;
    const running = (await ctx.api.ollamaStatus()).state === "running";
    return running && (await ctx.api.ollamaHas(ctx.tier.llm_tag));
  },
  async run(ctx) {
    await ensureOllamaRunning(ctx);
    const speed = new SpeedMeter();
    const off = ctx.api.onPullProgress((p) => {
      const received = p.completed ?? 0;
      ctx.report({
        label: pullLabel(p.status),
        received,
        total: p.total ?? null,
        bytesPerSecond: p.total ? speed.add(ctx.now(), received) : null,
        // "verifying sha256 digest", "writing manifest": no byte counts, so the bar shows "busy".
        finishing: !p.total,
      });
    });
    try {
      await ctx.api.ollamaPull(ctx.tier.llm_tag);
    } finally {
      off();
    }
  },
};

export const sttStep: StepDef = {
  id: "stt",
  title: "Speech recognition models",
  async detect(ctx) {
    if (ctx.repair) return false;
    const models = await ctx.api.listModels();
    return [ctx.tier.stt_stream_model_id, ctx.tier.stt_final_model_id].every(
      (id) => models.find((m) => m.id === id)?.installed,
    );
  },
  async run(ctx) {
    const models = await ctx.api.listModels();
    const parts: [string, string][] = [
      [ctx.tier.stt_stream_model_id, "Live speech model"],
      [ctx.tier.stt_final_model_id, "Accuracy model"],
    ];
    for (const [id, label] of parts) {
      if (!ctx.repair && models.find((m) => m.id === id)?.installed) continue;
      const report = meter(ctx, label);
      const off = ctx.api.onDownloadProgress(id, report);
      try {
        await ctx.api.downloadModel(id, ctx.repair);
      } finally {
        off();
      }
    }
  },
};

export const MIC_DENIED_MESSAGE =
  "Microphone access is turned off for Yadi. Turn it on in your system's privacy settings (macOS: System Settings > Privacy & Security > Microphone; Windows: Settings > Privacy > Microphone), then press Try again.";

export const microphoneStep: StepDef = {
  id: "microphone",
  title: "Microphone",
  async detect(ctx) {
    return (await ctx.api.micStatus()) === "authorized";
  },
  async run(ctx) {
    const status = await ctx.api.micRequest();
    if (status === "denied" || status === "restricted") throw new Error(MIC_DENIED_MESSAGE);
    if (status === "not-determined") {
      throw new Error("No answer to the microphone question yet. Press Try again.");
    }
    // "authorized", or "unknown" (no system answer is available, e.g. on Windows: Yadi
    // will notice a silent microphone later and say so).
  },
};

export const SUMMON_NOT_GRANTED_MESSAGE =
  "Yadi still needs Accessibility permission to notice when you hold Y. Turn Yadi on in System Settings > Privacy & Security > Accessibility, then press Try again, or skip this and use Cmd+Shift+Y instead.";

export const summonStep: StepDef = {
  id: "summon",
  title: "Summon key",
  async detect(ctx) {
    if (!isMac(ctx)) return false; // Windows: show the explanation screen
    return (await ctx.api.hotkeyStatus()).accessibility;
  },
  async run(ctx) {
    if (!isMac(ctx)) return; // nothing to grant on Windows
    // The only place Yadi asks: never at launch, and never when it is already allowed.
    if (!(await ctx.api.hotkeyStatus()).accessibility) {
      await ctx.api.hotkeyRequest();
      if (!(await ctx.api.hotkeyStatus()).accessibility)
        throw new Error(SUMMON_NOT_GRANTED_MESSAGE);
    }
    // Permission may have arrived after launch, when Hold-Y could not start: start it now.
    await ctx.api.useHoldY();
  },
};

export const STEP_DEFS: Record<Exclude<SetupStepId, "welcome">, StepDef> = {
  ollama: ollamaStep,
  llm: llmStep,
  stt: sttStep,
  microphone: microphoneStep,
  summon: summonStep,
};
