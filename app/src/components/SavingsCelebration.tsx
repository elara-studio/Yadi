import { useEffect, type CSSProperties } from "react";
import mascotUrl from "../assets/mascot/mascot.png";

interface Props {
  /** Approximate tokens saved (always more than 0 when shown). */
  saved: number;
  /** Approximate tokens of the message as it was recorded, and of the prompt. */
  tokensIn: number;
  tokensOut: number;
  /** False when the person turned animations off: no confetti, no bounce. */
  animated: boolean;
  onDone: () => void;
  /** How long it stays on screen. */
  durationMs?: number;
}

export const CELEBRATION_MS = 2800;
const CONFETTI_COLORS = ["#f15f36", "#ffb341", "#3fb37f", "#4f8ff7", "#c75ff1", "#ffd84d"];
const CONFETTI_PIECES = 28;

/** Fixed, spread-out confetti (no randomness, so it looks the same every time and in tests). */
const CONFETTI = Array.from({ length: CONFETTI_PIECES }, (_, i) => {
  const spread = (i * 37) % 100; // 0..99, evenly scattered
  return {
    x: `${spread}%`,
    dx: `${((i * 53) % 80) - 40}px`,
    delay: `${(i % 7) * 70}ms`,
    duration: `${1400 + ((i * 131) % 900)}ms`,
    rotate: `${((i * 97) % 720) - 360}deg`,
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length]!,
    round: i % 3 === 0,
  };
});

/**
 * "You saved ≈ N tokens": confetti and the mascot over the chat for a moment after a prompt that
 * is shorter than what was said. It never takes the keyboard (C still copies) and goes away by
 * itself; clicking it closes it sooner.
 */
export function SavingsCelebration({
  saved,
  tokensIn,
  tokensOut,
  animated,
  onDone,
  durationMs = CELEBRATION_MS,
}: Props) {
  useEffect(() => {
    const id = setTimeout(onDone, durationMs);
    return () => clearTimeout(id);
  }, [onDone, durationMs]);

  return (
    <div
      className={`celebration${animated ? "" : " celebration--still"}`}
      data-testid="celebration"
      role="status"
      aria-live="polite"
    >
      {animated && (
        <div className="confetti" aria-hidden="true">
          {CONFETTI.map((p, i) => (
            <span
              key={i}
              className={`confetti-piece${p.round ? " confetti-piece--round" : ""}`}
              style={
                {
                  left: p.x,
                  background: p.color,
                  "--dx": p.dx,
                  "--rotate": p.rotate,
                  animationDelay: p.delay,
                  animationDuration: p.duration,
                } as CSSProperties
              }
            />
          ))}
        </div>
      )}
      <button type="button" className="celebration-card" onClick={onDone}>
        <img className="celebration-mascot" src={mascotUrl} alt="" draggable={false} />
        <span className="celebration-title">
          You saved ≈ {saved.toLocaleString()} tokens by using Yadi
        </span>
        <span className="celebration-detail">
          ≈ {tokensIn.toLocaleString()} as you said it → ≈ {tokensOut.toLocaleString()} in the
          prompt
        </span>
      </button>
    </div>
  );
}
