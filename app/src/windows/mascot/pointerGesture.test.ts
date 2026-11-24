import { describe, expect, it } from "vitest";
import { DRAG_THRESHOLD_PX, PointerGesture } from "./pointerGesture";

describe("PointerGesture", () => {
  it("a press with no movement is a click", () => {
    const g = new PointerGesture();
    g.down(10, 10);
    expect(g.up()).toBe("click");
  });

  it("movement under 4px is still a click", () => {
    const g = new PointerGesture();
    g.down(10, 10);
    expect(g.move(12, 12)).toBe("none"); // hypot ~2.8
    expect(g.move(10, 13)).toBe("none"); // 3
    expect(g.up()).toBe("click");
  });

  it("reaching 4px starts a drag exactly once and is not a click", () => {
    const g = new PointerGesture();
    g.down(0, 0);
    expect(g.move(DRAG_THRESHOLD_PX, 0)).toBe("drag-start");
    expect(g.move(50, 50)).toBe("none");
    expect(g.up()).toBe("none");
  });

  it("diagonal movement uses real distance (3,3 = 4.24 >= 4)", () => {
    const g = new PointerGesture();
    g.down(0, 0);
    expect(g.move(3, 3)).toBe("drag-start");
  });

  it("move without a press does nothing", () => {
    const g = new PointerGesture();
    expect(g.move(100, 100)).toBe("none");
    expect(g.up()).toBe("none");
  });

  it("cancel discards the press", () => {
    const g = new PointerGesture();
    g.down(0, 0);
    g.cancel();
    expect(g.up()).toBe("none");
  });

  it("a new press after a drag can be a click again", () => {
    const g = new PointerGesture();
    g.down(0, 0);
    g.move(20, 0);
    g.up();
    g.down(5, 5);
    expect(g.up()).toBe("click");
  });
});
