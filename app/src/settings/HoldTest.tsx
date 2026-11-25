import { useEffect, useRef, useState } from "react";

/** Would a press of `ms` milliseconds summon Yadi, with a hold time of `thresholdMs`? */
export function classifyHold(ms: number, thresholdMs: number): "long" | "tap" {
  return ms >= thresholdMs ? "long" : "tap";
}

/**
 * "Test it": while switched on, the Y key is timed in this window so the person can feel what
 * the hold time is like. (The real summon works anywhere; this only measures.)
 */
export function HoldTest({ thresholdMs }: { thresholdMs: number }) {
  const [on, setOn] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const downAt = useRef<number | null>(null);

  useEffect(() => {
    if (!on) return;
    const isY = (e: KeyboardEvent) => e.key.toLowerCase() === "y" && !e.metaKey && !e.ctrlKey;
    const down = (e: KeyboardEvent) => {
      if (!isY(e)) return;
      e.preventDefault();
      if (!e.repeat) downAt.current = performance.now();
    };
    const up = (e: KeyboardEvent) => {
      if (!isY(e) || downAt.current === null) return;
      e.preventDefault();
      const ms = Math.round(performance.now() - downAt.current);
      downAt.current = null;
      setResult(
        classifyHold(ms, thresholdMs) === "long"
          ? `Held for ${ms} ms: that summons Yadi.`
          : `Held for ${ms} ms: too short, Yadi would just type the letter.`,
      );
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      downAt.current = null;
    };
  }, [on, thresholdMs]);

  return (
    <div className="settings-row">
      <button
        type="button"
        onClick={() => {
          setOn((v) => !v);
          setResult(null);
        }}
      >
        {on ? "Stop testing" : "Test the hold time"}
      </button>
      {on && (
        <span role="status">
          {result ?? `Press and hold Y for ${thresholdMs} ms or longer, then let go.`}
        </span>
      )}
    </div>
  );
}
