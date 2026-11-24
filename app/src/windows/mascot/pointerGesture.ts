/** A press that moves less than this many CSS pixels is a click, otherwise a drag. */
export const DRAG_THRESHOLD_PX = 4;

export type GestureResult = "none" | "drag-start" | "click";

/**
 * Tells a click from a drag. Tauri's own drag region starts a native drag on mousedown and
 * swallows the click, so the mascot starts dragging itself once the pointer has moved
 * DRAG_THRESHOLD_PX. Pure: no DOM, no Tauri.
 */
export class PointerGesture {
  private start: { x: number; y: number } | null = null;
  private dragging = false;

  down(x: number, y: number): void {
    this.start = { x, y };
    this.dragging = false;
  }

  /** Returns "drag-start" exactly once, when the movement first reaches the threshold. */
  move(x: number, y: number): GestureResult {
    if (!this.start || this.dragging) return "none";
    if (Math.hypot(x - this.start.x, y - this.start.y) >= DRAG_THRESHOLD_PX) {
      this.dragging = true;
      return "drag-start";
    }
    return "none";
  }

  /** "click" when the press ended without becoming a drag. */
  up(): GestureResult {
    const wasClick = this.start !== null && !this.dragging;
    this.start = null;
    this.dragging = false;
    return wasClick ? "click" : "none";
  }

  cancel(): void {
    this.start = null;
    this.dragging = false;
  }
}
