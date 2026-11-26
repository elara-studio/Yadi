import { describe, expect, it } from "vitest";
import {
  NEEDS_MODIFIER_MAC,
  NEEDS_MODIFIER_OTHER,
  UNUSABLE_KEY,
  captureKey,
  formatHeld,
  formatShortcut,
  keyToken,
} from "./shortcut";

const none = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
const press = (code: string, mods: Partial<typeof none> = {}) => ({ ...none, ...mods, code });

describe("captureKey", () => {
  it("Cmd+Shift+Y on a Mac is the default shortcut", () => {
    expect(captureKey(press("KeyY", { metaKey: true, shiftKey: true }), true)).toEqual({
      kind: "shortcut",
      chord: "CommandOrControl+Shift+Y",
    });
  });

  it("Ctrl+Shift+Y elsewhere is the default shortcut too", () => {
    expect(captureKey(press("KeyY", { ctrlKey: true, shiftKey: true }), false)).toEqual({
      kind: "shortcut",
      chord: "CommandOrControl+Shift+Y",
    });
  });

  it("keeps Ctrl on a Mac and Win elsewhere as their own modifiers", () => {
    expect(captureKey(press("Digit1", { ctrlKey: true, altKey: true }), true)).toEqual({
      kind: "shortcut",
      chord: "Control+Alt+1",
    });
    expect(captureKey(press("Space", { metaKey: true }), false)).toEqual({
      kind: "shortcut",
      chord: "Super+Space",
    });
  });

  it("uses the physical key, so Option+Y is Y and not ¥", () => {
    expect(captureKey({ ...press("KeyY", { altKey: true }), key: "¥" } as never, true)).toEqual({
      kind: "shortcut",
      chord: "Alt+Y",
    });
  });

  it("modifier keys alone only update what is held", () => {
    expect(captureKey(press("ShiftLeft", { shiftKey: true, metaKey: true }), true)).toEqual({
      kind: "modifiers",
      held: ["CommandOrControl", "Shift"],
    });
  });

  it("refuses a key without Cmd/Ctrl/Alt, including Shift alone", () => {
    expect(captureKey(press("KeyY"), true)).toEqual({
      kind: "invalid",
      message: NEEDS_MODIFIER_MAC,
    });
    expect(captureKey(press("KeyY", { shiftKey: true }), false)).toEqual({
      kind: "invalid",
      message: NEEDS_MODIFIER_OTHER,
    });
  });

  it("refuses keys the shortcut parser does not know", () => {
    expect(captureKey(press("IntlBackslash", { metaKey: true }), true)).toEqual({
      kind: "invalid",
      message: UNUSABLE_KEY,
    });
  });
});

describe("keyToken", () => {
  it.each([
    ["KeyA", "A"],
    ["Digit7", "7"],
    ["F12", "F12"],
    ["Numpad5", "Numpad5"],
    ["ArrowUp", "ArrowUp"],
    ["Space", "Space"],
    ["Slash", "Slash"],
    ["F25", null],
    ["Escape", null],
    ["MediaPlayPause", null],
  ])("%s -> %s", (code, token) => expect(keyToken(code)).toBe(token));
});

describe("formatShortcut", () => {
  it("shows symbols on a Mac and names elsewhere", () => {
    expect(formatShortcut("CommandOrControl+Shift+Y", true)).toBe("⌘⇧Y");
    expect(formatShortcut("CommandOrControl+Shift+Y", false)).toBe("Ctrl+Shift+Y");
    expect(formatShortcut("Control+Alt+Space", true)).toBe("⌃⌥Space");
    expect(formatShortcut("Super+ArrowUp", false)).toBe("Win+↑");
  });

  it("reads hand-written shortcuts from older settings", () => {
    expect(formatShortcut("cmd+shift+keyk", true)).toBe("⌘⇧K");
    expect(formatShortcut("Alt+y", false)).toBe("Alt+Y");
  });

  it("shows held modifiers while recording", () => {
    expect(formatHeld([], true)).toBe("…");
    expect(formatHeld(["CommandOrControl", "Shift"], true)).toBe("⌘⇧…");
    expect(formatHeld(["CommandOrControl"], false)).toBe("Ctrl+…");
  });
});
