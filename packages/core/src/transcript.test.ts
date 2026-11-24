import { describe, expect, it } from "vitest";
import { Transcript } from "./transcript";

describe("Transcript", () => {
  it("starts empty", () => {
    const t = new Transcript();
    expect(t.hasContent()).toBe(false);
    expect(t.text()).toBe("");
    expect(t.snapshot()).toEqual({ segments: [], partial: "" });
  });

  it("a partial replaces the previous partial", () => {
    const t = new Transcript();
    t.applyPartial("Write");
    t.applyPartial("Write a short");
    expect(t.snapshot().partial).toBe("Write a short");
    expect(t.hasContent()).toBe(true);
  });

  it("a final replaces the partial and is kept in order", () => {
    const t = new Transcript();
    t.applyPartial("Write a short email");
    t.applyFinal(0, "Write a short email.");
    t.applyPartial("Thanks");
    t.applyFinal(1, "Thanks.");
    expect(t.snapshot()).toEqual({
      segments: [
        { id: 0, text: "Write a short email." },
        { id: 1, text: "Thanks." },
      ],
      partial: "",
    });
    expect(t.text()).toBe("Write a short email. Thanks.");
  });

  it("text() appends the pending partial", () => {
    const t = new Transcript();
    t.applyFinal(0, "First.");
    t.applyPartial("Second");
    expect(t.text()).toBe("First. Second");
  });

  it("a final with an existing id replaces that segment", () => {
    const t = new Transcript();
    t.applyFinal(0, "Helo.");
    t.applyFinal(0, "Hello.");
    expect(t.snapshot().segments).toEqual([{ id: 0, text: "Hello." }]);
  });

  it("whitespace-only text is not content", () => {
    const t = new Transcript();
    t.applyPartial("   ");
    t.applyFinal(0, " ");
    expect(t.hasContent()).toBe(false);
    expect(t.text()).toBe("");
  });

  it("clear empties everything", () => {
    const t = new Transcript();
    t.applyFinal(0, "Hello.");
    t.applyPartial("more");
    t.clear();
    expect(t.hasContent()).toBe(false);
    expect(t.snapshot()).toEqual({ segments: [], partial: "" });
  });

  it("snapshots are copies", () => {
    const t = new Transcript();
    t.applyFinal(0, "A.");
    const snap = t.snapshot();
    snap.segments[0]!.text = "changed";
    expect(t.snapshot().segments[0]!.text).toBe("A.");
  });
});
