import { useEffect, useRef, useState } from "react";
import type { ResultPayload } from "../windows/mascot/controller";

interface Props {
  result: ResultPayload;
  /** Total time of the cosmetic reveal. 0 shows everything at once. Never longer than 600 ms. */
  revealMs?: number;
  /** Task 20: the attached files' text, appended by "Copy with attachment text". */
  attachmentText?: string;
  /** Makes the prompt again from the (possibly corrected) transcript. */
  onRegenerate?: () => void;
}

const REVEAL_STEP_MS = 30;
const COPIED_MS = 1500;

/** Writes to the clipboard; false when the platform refused. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** A button that copies `text` and says "Copied" for 1.5 seconds. */
function CopyButton({ text, label, primary }: { text: string; label: string; primary?: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const click = async () => {
    const ok = await copyText(text);
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), COPIED_MS);
  };

  return (
    <button type="button" className={primary ? "copy-primary" : "copy-secondary"} onClick={click}>
      {state === "copied" ? "Copied" : state === "failed" ? "Could not copy" : label}
    </button>
  );
}

/** Shows the first `n` characters of `text`, growing to all of it over `ms` (cosmetic only). */
function useReveal(text: string, ms: number): string {
  const [shown, setShown] = useState(ms <= 0 ? text.length : 0);
  useEffect(() => {
    if (ms <= 0) {
      setShown(text.length);
      return;
    }
    setShown(0);
    const steps = Math.max(1, Math.floor(Math.min(ms, 600) / REVEAL_STEP_MS));
    const perStep = Math.max(1, Math.ceil(text.length / steps));
    const id = setInterval(() => {
      setShown((n) => {
        const next = Math.min(text.length, n + perStep);
        if (next >= text.length) clearInterval(id);
        return next;
      });
    }, REVEAL_STEP_MS);
    return () => clearInterval(id);
  }, [text, ms]);
  return text.slice(0, shown);
}

/** The finished prompt in a monospace card, with Copy, the token estimate and recent prompts. */
export function ResultView({ result, revealMs = 450, attachmentText, onRegenerate }: Props) {
  const visible = useReveal(result.prompt, revealMs);
  const older = result.recent.slice(1);

  return (
    <div className="result">
      {result.degraded && (
        <p className="result-degraded" role="status">
          The language model&apos;s answer could not be used, so this is a basic prompt made from
          what you said. You can press Y to try again.
        </p>
      )}
      <pre className="result-card" data-testid="prompt-text" aria-label="Prompt">
        {visible}
      </pre>
      <div className="result-actions">
        <CopyButton text={result.prompt} label="Copy" primary />
        {attachmentText ? (
          <CopyButton
            text={`${result.prompt}\n\n${attachmentText}`}
            label="Copy with attachment text"
          />
        ) : null}
        {onRegenerate ? (
          <button type="button" className="copy-secondary" onClick={onRegenerate}>
            Make it again
          </button>
        ) : null}
        <span className="result-tokens" data-testid="token-line">
          ≈ {result.tokensIn} → ≈ {result.tokensOut} tokens (approximate)
        </span>
      </div>
      {older.length > 0 && (
        <details className="result-recent">
          <summary>Recent ({older.length})</summary>
          <ul>
            {older.map((item) => (
              <li key={item.at + item.prompt}>
                <span className="recent-text">{item.prompt.split("\n")[0].slice(0, 80)}</span>
                <CopyButton text={item.prompt} label="Copy" />
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
