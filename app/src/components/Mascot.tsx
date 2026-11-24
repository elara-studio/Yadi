import mascotUrl from "../assets/mascot/mascot.png";

export type MascotState = "idle" | "listening" | "thinking" | "done";

/**
 * Status text shown in the thought bubble. This is the stop-gap for animated mascots:
 * the artwork is the static app icon, and a bubble carries the status. To switch to
 * Lottie/GIF mascots later, replace the <img> below and drop the bubble; nothing else
 * depends on this file's internals.
 */
export const MASCOT_STATUS: Record<MascotState, string> = {
  idle: "Ready",
  listening: "Listening…",
  thinking: "Thinking…",
  done: "Done!",
};

export function Mascot({ state }: { state: MascotState }) {
  return (
    <div className={`mascot mascot--${state}`} data-state={state}>
      <div className="bubble" role="status" aria-live="polite">
        {MASCOT_STATUS[state]}
      </div>
      <img className="mascot-img" src={mascotUrl} alt="Yadi" draggable={false} />
    </div>
  );
}
