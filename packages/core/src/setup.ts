/**
 * Pure logic of the first-run setup wizard: which steps exist, their status, how progress is
 * saved and resumed. No I/O here; the wizard persists `SetupState` through the app (`setup.json`).
 */

/** The steps that need doing, in order. A final "done" screen follows them. */
export const SETUP_STEPS = ["welcome", "ollama", "llm", "stt", "microphone", "summon"] as const;
export type SetupStepId = (typeof SETUP_STEPS)[number];
export type StepStatus = "pending" | "running" | "error" | "done";
/** The screen shown: a step, or the finished screen. */
export type SetupScreen = SetupStepId | "done";

export interface SetupState {
  version: 1;
  /** The user agreed to the downloads on the welcome screen. */
  consent: boolean;
  steps: Record<SetupStepId, StepStatus>;
  /** Re-run in repair mode: models are downloaded again even if they look installed. */
  repair: boolean;
}

export function initialSetupState(): SetupState {
  return {
    version: 1,
    consent: false,
    steps: Object.fromEntries(SETUP_STEPS.map((s) => [s, "pending"])) as Record<
      SetupStepId,
      StepStatus
    >,
    repair: false,
  };
}

const STATUSES: readonly StepStatus[] = ["pending", "running", "error", "done"];

/**
 * Reads a saved state defensively (the file may be missing, old, edited or half-written).
 * Anything unknown becomes "pending". A step that was "running" when the app quit is not running
 * any more, so it becomes "pending" and the wizard resumes there.
 */
export function loadSetupState(raw: unknown): SetupState {
  const state = initialSetupState();
  if (typeof raw !== "object" || raw === null) return state;
  const r = raw as { consent?: unknown; repair?: unknown; steps?: unknown };
  state.consent = r.consent === true;
  state.repair = r.repair === true;
  if (typeof r.steps === "object" && r.steps !== null) {
    const saved = r.steps as Record<string, unknown>;
    for (const id of SETUP_STEPS) {
      const v = saved[id];
      if (typeof v === "string" && (STATUSES as readonly string[]).includes(v)) {
        state.steps[id] = v === "running" ? "pending" : (v as StepStatus);
      }
    }
  }
  // Without consent nothing after the welcome screen can have been done.
  if (!state.consent) {
    for (const id of SETUP_STEPS) if (id !== "welcome") state.steps[id] = "pending";
    state.steps.welcome = "pending";
  }
  return state;
}

/** The first step that is not done, or "done" when everything is. */
export function currentScreen(state: SetupState): SetupScreen {
  return SETUP_STEPS.find((s) => state.steps[s] !== "done") ?? "done";
}

export function isSetupComplete(state: SetupState): boolean {
  return currentScreen(state) === "done";
}

export function withStep(state: SetupState, id: SetupStepId, status: StepStatus): SetupState {
  return { ...state, steps: { ...state.steps, [id]: status } };
}

export function withConsent(state: SetupState, consent: boolean): SetupState {
  return consent
    ? { ...state, consent: true, steps: { ...state.steps, welcome: "done" } }
    : initialSetupState();
}

/** Starts a re-run: everything pending again; `repair` also forces model re-downloads. */
export function restartSetup(previous: SetupState, repair: boolean): SetupState {
  return { ...initialSetupState(), consent: previous.consent, repair };
}

/** 1-based position of the current screen among the steps, for "Step 2 of 6". */
export function stepNumber(screen: SetupScreen): number {
  return screen === "done" ? SETUP_STEPS.length : SETUP_STEPS.indexOf(screen) + 1;
}
