import { useEffect } from "react";
import type { AppEvent } from "@yadi/core";
import { classifyKey, isEditorTarget } from "./keyboard";

/**
 * Y / Esc handling for the chat window (PLAN Task 05). `send` delivers the event to the
 * Controller (`app:event`). Keys typed into an editor are never prevented or swallowed.
 * `yEnabled` false (Settings is open): Y is an ordinary key; Esc still works.
 */
export function useKeyboardControls(send: (event: AppEvent) => void, yEnabled = true): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const event = classifyKey(e);
      if (!event) return;
      if (event.type === "KEY_Y" && !yEnabled) return;
      if (!isEditorTarget(e.target)) e.preventDefault();
      send(event);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [send, yEnabled]);
}
