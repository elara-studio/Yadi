/**
 * Turning key presses into the summon shortcut, and showing it. Shortcuts are stored in the
 * global-shortcut format ("CommandOrControl+Shift+Y"); `CommandOrControl` is Cmd on macOS and
 * Ctrl elsewhere, so the default works on both.
 */

export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

/** The keys that only modify; pressing them alone never finishes a shortcut. */
const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
  "Fn",
  "CapsLock",
]);

/** Physical keys (`KeyboardEvent.code`) a shortcut may end with, as the parser spells them. */
const NAMED_CODES = new Set([
  "Space",
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Minus",
  "Equal",
  "BracketLeft",
  "BracketRight",
  "Backslash",
  "Semicolon",
  "Quote",
  "Comma",
  "Period",
  "Slash",
  "Backquote",
]);

/** The key part of a shortcut for a physical key, or null when it cannot be used. */
export function keyToken(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1]!;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (/^Numpad([0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter)$/.test(code)) return code;
  return NAMED_CODES.has(code) ? code : null;
}

export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code);
}

interface Mods {
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** Modifier names in a fixed order. Cmd on a Mac (or Ctrl elsewhere) becomes CommandOrControl. */
function modifierTokens(e: Mods, mac: boolean): string[] {
  const out: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) out.push("CommandOrControl");
  if (mac && e.ctrlKey) out.push("Control");
  if (!mac && e.metaKey) out.push("Super");
  if (e.altKey) out.push("Alt");
  if (e.shiftKey) out.push("Shift");
  return out;
}

/** The modifiers held right now, as shortcut parts (for the live display while recording). */
export function heldModifiers(e: Mods, mac = IS_MAC): string[] {
  return modifierTokens(e, mac);
}

export type Capture =
  | { kind: "modifiers"; held: string[] }
  | { kind: "shortcut"; chord: string }
  | { kind: "invalid"; message: string };

export const NEEDS_MODIFIER_MAC = "Hold ⌘, ⌃ or ⌥ too (Shift alone is not enough).";
export const NEEDS_MODIFIER_OTHER = "Hold Ctrl, Alt or Win too (Shift alone is not enough).";
export const UNUSABLE_KEY = "That key cannot be used for a shortcut. Try a letter or a number.";

/**
 * What one keydown means while recording. A shortcut needs Cmd/Ctrl/Alt (or Win): with only
 * Shift, every capital letter typed anywhere would summon Yadi.
 */
export function captureKey(e: Mods & { code: string }, mac = IS_MAC): Capture {
  const held = modifierTokens(e, mac);
  if (isModifierCode(e.code)) return { kind: "modifiers", held };
  const key = keyToken(e.code);
  if (!key) return { kind: "invalid", message: UNUSABLE_KEY };
  if (!held.some((m) => m !== "Shift")) {
    return { kind: "invalid", message: mac ? NEEDS_MODIFIER_MAC : NEEDS_MODIFIER_OTHER };
  }
  return { kind: "shortcut", chord: [...held, key].join("+") };
}

const MAC_SYMBOLS: Record<string, string> = {
  commandorcontrol: "⌘",
  cmdorctrl: "⌘",
  commandorctrl: "⌘",
  cmdorcontrol: "⌘",
  command: "⌘",
  cmd: "⌘",
  super: "⌘",
  meta: "⌘",
  control: "⌃",
  ctrl: "⌃",
  alt: "⌥",
  option: "⌥",
  shift: "⇧",
};

const OTHER_NAMES: Record<string, string> = {
  commandorcontrol: "Ctrl",
  cmdorctrl: "Ctrl",
  commandorctrl: "Ctrl",
  cmdorcontrol: "Ctrl",
  control: "Ctrl",
  ctrl: "Ctrl",
  super: "Win",
  command: "Win",
  cmd: "Win",
  meta: "Win",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};

const KEY_NAMES: Record<string, string> = {
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  space: "Space",
  minus: "-",
  equal: "=",
  bracketleft: "[",
  bracketright: "]",
  backslash: "\\",
  semicolon: ";",
  quote: "'",
  comma: ",",
  period: ".",
  slash: "/",
  backquote: "`",
};

function keyName(token: string): string {
  const lower = token.toLowerCase();
  if (KEY_NAMES[lower]) return KEY_NAMES[lower];
  const key = /^key([a-z])$/.exec(lower) ?? /^digit([0-9])$/.exec(lower);
  if (key) return key[1]!.toUpperCase();
  return token.length === 1 ? token.toUpperCase() : token;
}

/** "CommandOrControl+Shift+Y" -> "⌘⇧Y" on a Mac, "Ctrl+Shift+Y" elsewhere. */
export function formatShortcut(chord: string, mac = IS_MAC): string {
  const parts = chord
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const names = parts.map((p) => {
    const lower = p.toLowerCase();
    const mod = mac ? MAC_SYMBOLS[lower] : OTHER_NAMES[lower];
    return mod ?? keyName(p);
  });
  return mac ? names.join("") : names.join("+");
}

/** The held modifiers while recording, e.g. "⌘⇧…" or "Ctrl+Shift+…". */
export function formatHeld(held: string[], mac = IS_MAC): string {
  if (held.length === 0) return "…";
  const shown = formatShortcut(held.join("+"), mac);
  return mac ? `${shown}…` : `${shown}+…`;
}
