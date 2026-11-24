import { describe, expect, it } from "vitest";
import {
  SETUP_STEPS,
  currentScreen,
  initialSetupState,
  isSetupComplete,
  loadSetupState,
  restartSetup,
  stepNumber,
  withConsent,
  withStep,
  type SetupState,
} from "./setup";

const allDone = (): SetupState => {
  let s = withConsent(initialSetupState(), true);
  for (const id of SETUP_STEPS) s = withStep(s, id, "done");
  return s;
};

describe("setup state", () => {
  it("starts with every step pending at the welcome screen", () => {
    const s = initialSetupState();
    expect(SETUP_STEPS.every((id) => s.steps[id] === "pending")).toBe(true);
    expect(currentScreen(s)).toBe("welcome");
    expect(isSetupComplete(s)).toBe(false);
  });

  it("the current screen is the first step that is not done", () => {
    let s = withConsent(initialSetupState(), true);
    expect(currentScreen(s)).toBe("ollama");
    s = withStep(s, "ollama", "done");
    s = withStep(s, "llm", "error"); // an errored step is where to resume
    expect(currentScreen(s)).toBe("llm");
    s = withStep(s, "llm", "done");
    s = withStep(s, "stt", "running");
    expect(currentScreen(s)).toBe("stt");
  });

  it("is complete only when every step is done", () => {
    expect(isSetupComplete(allDone())).toBe(true);
    expect(currentScreen(allDone())).toBe("done");
    expect(isSetupComplete(withStep(allDone(), "summon", "pending"))).toBe(false);
  });

  it("steps can be completed out of order and the screen is still the first gap", () => {
    let s = withConsent(initialSetupState(), true);
    s = withStep(s, "microphone", "done");
    expect(currentScreen(s)).toBe("ollama");
  });

  it("withStep does not mutate the previous state", () => {
    const before = initialSetupState();
    const after = withStep(before, "ollama", "done");
    expect(before.steps.ollama).toBe("pending");
    expect(after.steps.ollama).toBe("done");
  });

  it("withConsent(true) completes the welcome step; withConsent(false) resets everything", () => {
    const s = withConsent(initialSetupState(), true);
    expect(s.consent).toBe(true);
    expect(s.steps.welcome).toBe("done");
    expect(withConsent(allDone(), false)).toEqual(initialSetupState());
  });

  it("step numbers are 1-based and 'done' is the last", () => {
    expect(stepNumber("welcome")).toBe(1);
    expect(stepNumber("summon")).toBe(6);
    expect(stepNumber("done")).toBe(6);
  });
});

describe("loading a saved state (resume)", () => {
  it("round-trips a partly finished state", () => {
    let s = withConsent(initialSetupState(), true);
    s = withStep(s, "ollama", "done");
    s = withStep(s, "llm", "error");
    expect(loadSetupState(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("a step that was running when the app quit resumes as pending", () => {
    let s = withConsent(initialSetupState(), true);
    s = withStep(s, "ollama", "done");
    s = withStep(s, "llm", "running");
    const loaded = loadSetupState(JSON.parse(JSON.stringify(s)));
    expect(loaded.steps.llm).toBe("pending");
    expect(currentScreen(loaded)).toBe("llm");
  });

  it.each([null, undefined, 42, "x", [], {}, { steps: "no" }, { steps: { ollama: "weird" } }])(
    "garbage input %j gives a fresh state without throwing",
    (raw) => {
      expect(loadSetupState(raw)).toEqual(initialSetupState());
    },
  );

  it("unknown step ids are ignored and missing ones stay pending", () => {
    const loaded = loadSetupState({
      consent: true,
      steps: { welcome: "done", ollama: "done", flying: "done" },
    });
    expect(loaded.steps.ollama).toBe("done");
    expect(loaded.steps.llm).toBe("pending");
    expect(Object.keys(loaded.steps)).toEqual([...SETUP_STEPS]);
  });

  it("progress saved without consent cannot skip the welcome screen", () => {
    const loaded = loadSetupState({ consent: false, steps: { ollama: "done", llm: "done" } });
    expect(currentScreen(loaded)).toBe("welcome");
    expect(loaded.steps.ollama).toBe("pending");
  });

  it("repair is only true when saved as exactly true", () => {
    expect(loadSetupState({ repair: true }).repair).toBe(true);
    expect(loadSetupState({ repair: "yes" }).repair).toBe(false);
  });
});

describe("restartSetup", () => {
  it("resets all steps but keeps consent, and can request repair", () => {
    const r = restartSetup(allDone(), true);
    expect(r.consent).toBe(true);
    expect(r.repair).toBe(true);
    expect(SETUP_STEPS.every((id) => r.steps[id] === "pending")).toBe(true);
    expect(currentScreen(r)).toBe("welcome");
    expect(restartSetup(allDone(), false).repair).toBe(false);
  });
});
