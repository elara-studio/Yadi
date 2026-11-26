import mascotUrl from "../assets/mascot/mascot.png";

/**
 * What the mascot is doing. `asleep` is the hidden-chat state (click to start); `setup` is the
 * first-run wizard; the rest follow one prompt from "ready to record" to "copy it".
 */
export type MascotState = "asleep" | "setup" | "idle" | "listening" | "thinking" | "done";

/**
 * What the thought bubble says: the next thing to do, so nobody has to remember the keys.
 * The artwork is the static app icon animated with CSS; to switch to Lottie/GIF mascots later,
 * replace the <img> below. Nothing else depends on this file's internals.
 */
export const MASCOT_STATUS: Record<MascotState, string> = {
  asleep: "Click me to start",
  setup: "Let's get you set up",
  idle: "Press Y when you're ready to record",
  listening: "Press Y when you're done",
  thinking: "Thinking…",
  done: "Press C to copy, or drag and drop the prompt",
};

export function Mascot({ state }: { state: MascotState }) {
  return (
    <div className={`mascot mascot--${state}`} data-state={state}>
      {/* Keyed by state so the bubble pops in again each time its message changes. */}
      <div key={state} className="bubble" role="status" aria-live="polite">
        {state === "listening" && <span className="bubble-rec" aria-hidden="true" />}
        {MASCOT_STATUS[state]}
      </div>
      <img className="mascot-img" src={mascotUrl} alt="Yadi" draggable={false} />
    </div>
  );
}
