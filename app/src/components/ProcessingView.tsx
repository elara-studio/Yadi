import { useEffect, useState } from "react";
import {
  PROCESS_STAGES,
  type ProcessStage,
  type ProgressPayload,
} from "../windows/mascot/controller";

const LABELS: Record<ProcessStage, string> = {
  transcribing: "Transcribing",
  cleaning: "Cleaning",
  analysing: "Analysing",
  writing: "Writing",
};

interface Props {
  /** What the Controller last reported; null before the first report (shown as "Transcribing"). */
  progress: ProgressPayload | null;
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${m}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * The stage list shown while the prompt is being made: finished stages are ticked, the active one
 * pulses, the rest are dim. Also an elapsed timer and, once it exists, the cleaned transcript
 * (dimmed, because it is not the final answer).
 */
export function ProcessingView({ progress }: Props) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(id);
  }, []);

  const active = progress?.stage ?? "transcribing";
  const activeIndex = PROCESS_STAGES.indexOf(active);

  return (
    <div className="processing" aria-live="polite">
      <ul className="stages" aria-label="Progress">
        {PROCESS_STAGES.map((stage, i) => {
          const status = i < activeIndex ? "done" : i === activeIndex ? "active" : "pending";
          const counts =
            stage === "transcribing" && status === "active" && progress && progress.total > 1
              ? ` ${progress.done}/${progress.total}`
              : "";
          return (
            <li
              key={stage}
              className={`stage stage-${status}`}
              aria-current={status === "active" ? "step" : undefined}
              data-status={status}
            >
              <span className="stage-mark" aria-hidden="true">
                {status === "done" ? "✓" : status === "active" ? "●" : "○"}
              </span>
              {LABELS[stage]}
              {status === "active" ? `${counts}…` : ""}
            </li>
          );
        })}
        <li className="stage-elapsed" data-testid="elapsed">
          {formatElapsed(seconds)}
        </li>
      </ul>
      {progress?.clean ? (
        <p className="stage-clean" data-testid="clean-text">
          {progress.clean}
        </p>
      ) : null}
    </div>
  );
}
