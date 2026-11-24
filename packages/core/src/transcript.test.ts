import { describe, expect, it } from "vitest";
import { Transcript, splitWords } from "./transcript";

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

  describe("recording boundaries", () => {
    it("a second recording does not overwrite the first one's segments", () => {
      const t = new Transcript();
      t.beginRecording();
      t.applyFinal(0, "First.");
      t.beginRecording(); // Rust restarts its ids at 0
      t.applyFinal(0, "Second.");
      expect(t.snapshot().segments.map((s) => s.text)).toEqual(["First.", "Second."]);
    });

    it("beginRecording drops a stale partial", () => {
      const t = new Transcript();
      t.applyPartial("left over");
      t.beginRecording();
      expect(t.snapshot().partial).toBe("");
    });

    it("the final pass replaces everything recorded since the session started", () => {
      const t = new Transcript();
      t.beginRecording();
      t.applyFinal(0, "Right a short emile.");
      t.applyPartial("tail");
      t.replaceRecordedAudio("Write a short email.");
      expect(t.snapshot()).toEqual({
        segments: [{ id: 1, text: "Write a short email." }],
        partial: "",
      });
    });

    it("after the audio is freed, a later final pass only replaces newer text", () => {
      const t = new Transcript();
      t.beginRecording();
      t.applyFinal(0, "Polished first part.");
      t.markAudioFreed(); // buffer emptied after the first pass
      t.beginRecording();
      t.applyFinal(0, "live second part");
      t.replaceRecordedAudio("Polished second part.");
      expect(t.snapshot().segments.map((s) => s.text)).toEqual([
        "Polished first part.",
        "Polished second part.",
      ]);
    });

    it("a final pass that found nothing removes the live text it covered", () => {
      const t = new Transcript();
      t.beginRecording();
      t.applyFinal(0, "noise");
      t.replaceRecordedAudio("   ");
      expect(t.hasContent()).toBe(false);
    });

    it("clear resets offsets and boundaries", () => {
      const t = new Transcript();
      t.beginRecording();
      t.applyFinal(0, "A.");
      t.markAudioFreed();
      t.clear();
      t.beginRecording();
      t.applyFinal(0, "B.");
      expect(t.snapshot().segments).toEqual([{ id: 0, text: "B." }]);
      t.replaceRecordedAudio("B polished.");
      expect(t.snapshot().segments.map((s) => s.text)).toEqual(["B polished."]);
    });
  });

  describe("editing", () => {
    const base = () => {
      const t = new Transcript();
      t.beginRecording();
      t.applyFinal(0, "Write a short emile to my manager.");
      t.applyFinal(1, "Thanks.");
      return t;
    };

    it("splitWords splits on any whitespace and ignores empty pieces", () => {
      expect(splitWords("  a  b\tc\nd ")).toEqual(["a", "b", "c", "d"]);
      expect(splitWords("")).toEqual([]);
    });

    it("replaceWord changes only that word", () => {
      const t = base();
      expect(t.replaceWord(0, 3, "email")).toBe(true);
      expect(t.snapshot().segments).toEqual([
        { id: 0, text: "Write a short email to my manager." },
        { id: 1, text: "Thanks." },
      ]);
    });

    it("replaceWord accepts multi-word replacement text", () => {
      const t = base();
      t.replaceWord(1, 0, "Many thanks");
      expect(t.snapshot().segments[1]?.text).toBe("Many thanks");
      t.replaceWord(0, 3, "e mail");
      expect(t.snapshot().segments[0]?.text).toBe("Write a short e mail to my manager.");
    });

    it("replaceWord ignores unknown segments, bad indexes, empty or unchanged text", () => {
      const t = base();
      const before = JSON.stringify(t.snapshot());
      expect(t.replaceWord(9, 0, "x")).toBe(false);
      expect(t.replaceWord(0, 99, "x")).toBe(false);
      expect(t.replaceWord(0, -1, "x")).toBe(false);
      expect(t.replaceWord(0, 3, "   ")).toBe(false);
      expect(t.replaceWord(0, 3, "emile")).toBe(false);
      expect(JSON.stringify(t.snapshot())).toBe(before);
    });

    it("setText replaces everything with one segment", () => {
      const t = base();
      expect(t.setText("  Totally new text.  ")).toBe(true);
      expect(t.snapshot().segments).toEqual([{ id: 2, text: "Totally new text." }]);
      expect(t.text()).toBe("Totally new text.");
    });

    it("setText with the same text changes nothing, and empty text clears", () => {
      const t = base();
      expect(t.setText(t.text())).toBe(false);
      expect(t.setText("   ")).toBe(true);
      expect(t.hasContent()).toBe(false);
    });
  });
});
