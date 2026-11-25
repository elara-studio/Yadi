import type { ProcessErrorPayload } from "../windows/mascot/controller";

interface Props {
  error: ProcessErrorPayload;
  onRetry: () => void;
  /** Opens setup in repair mode (reinstall the missing model). */
  onRepair: () => void;
}

/** Why the prompt could not be made, with the one action that helps. The transcript is kept. */
export function ProcessErrorView({ error, onRetry, onRepair }: Props) {
  return (
    <div className="process-error" role="alert">
      <p>{error.message}</p>
      <div className="process-error-actions">
        {error.kind === "model-missing" ? (
          <button type="button" className="copy-primary" onClick={onRepair}>
            Open setup to install it
          </button>
        ) : null}
        {error.kind !== "empty" ? (
          <button
            type="button"
            className={error.kind === "model-missing" ? "copy-secondary" : "copy-primary"}
            onClick={onRetry}
          >
            Retry
          </button>
        ) : null}
      </div>
      <p className="process-error-note">Your transcript is still here.</p>
    </div>
  );
}
