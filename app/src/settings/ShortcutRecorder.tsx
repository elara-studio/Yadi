import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { captureKey, formatHeld, formatShortcut, heldModifiers, IS_MAC } from "./shortcut";

/**
 * Shows the summon shortcut; "Change" starts recording and the next key combination pressed
 * becomes the new shortcut. Esc cancels. While recording, every key is kept from the rest of
 * the window (so Y and Esc do not drive the chat) and the current global chord is paused in
 * Rust, so pressing it is recorded instead of summoning Yadi.
 */
export function ShortcutRecorder({
  chord,
  onChange,
  mac = IS_MAC,
}: {
  chord: string;
  onChange: (chord: string) => void;
  mac?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [held, setHeld] = useState<string[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!recording) return;
    void invoke("summon_capture_start").catch(() => {});
    const stop = () => setRecording(false);

    const onKeyDown = (e: KeyboardEvent) => {
      // Capture phase on window: nothing else in the chat sees this key.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      if (e.code === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        stop();
        return;
      }
      const result = captureKey(e, mac);
      if (result.kind === "modifiers") {
        setHeld(result.held);
        setHint(null);
      } else if (result.kind === "invalid") {
        setHint(result.message);
      } else {
        onChangeRef.current(result.chord);
        stop();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      setHeld(heldModifiers(e, mac));
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", stop);
      setHeld([]);
      setHint(null);
      void invoke("summon_capture_end").catch(() => {});
    };
  }, [recording, mac]);

  return (
    <div className="shortcut-recorder">
      <div className="settings-row">
        <span>Shortcut</span>
        <kbd
          className={recording ? "shortcut-keys shortcut-keys--recording" : "shortcut-keys"}
          aria-label="Shortcut"
          aria-live="polite"
          data-testid="shortcut-keys"
        >
          {recording ? formatHeld(held, mac) : formatShortcut(chord, mac)}
        </kbd>
        {recording ? (
          <button type="button" onClick={() => setRecording(false)}>
            Cancel
          </button>
        ) : (
          <button type="button" onClick={() => setRecording(true)}>
            Change
          </button>
        )}
      </div>
      {recording && (
        <p className="settings-help" role="status">
          {hint ?? "Press the keys you want to use, together. Esc cancels."}
        </p>
      )}
    </div>
  );
}
