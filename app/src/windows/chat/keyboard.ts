import type { AppEvent } from "@yadi/core";

/** True when the event target is somewhere the user types text. */
export function isEditorTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  // jsdom has no isContentEditable, so look at the attribute on the element or an ancestor.
  const editable = target.closest("[contenteditable]");
  return editable !== null && editable.getAttribute("contenteditable") !== "false";
}

/**
 * Maps a keydown to the event the Controller should get, or null to do nothing.
 *  - plain Y (no Ctrl/Alt/Meta/Shift, not auto-repeat) -> KEY_Y, never while typing in an editor
 *  - Escape (not auto-repeat) -> KEY_ESC, except inside an editor where it only cancels the edit
 */
export function classifyKey(e: KeyboardEvent): AppEvent | null {
  if (e.repeat) return null;
  const inEditor = isEditorTarget(e.target);
  if (e.key === "Escape") return inEditor ? { type: "EDIT_END" } : { type: "KEY_ESC" };
  if (inEditor) return null;
  if (e.key.toLowerCase() === "y" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
    return { type: "KEY_Y" };
  }
  return null;
}
