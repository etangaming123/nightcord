// Every keyboard shortcut in one table, used both by the global handler in
// main.js and by the cheat sheet (Ctrl/Cmd+/).
//
// A shortcut names the keys it wants and what to do. Anything with Ctrl, Cmd
// or Alt held keeps working while a text box has focus — it types nothing, so
// there's nothing to get in the way of. Bare keys are ignored there instead.

import { $ } from "./ui/dom.js";

export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// A key description: { key, mod (Ctrl/Cmd), shift, alt }.
const on = (key, opts = {}) => ({ key: key.toLowerCase(), mod: false, shift: false, alt: false, ...opts });

// group: which block of the cheat sheet it belongs in.
// keys: what the sheet shows, as an array of label parts.
export const SHORTCUTS = [
  // --- navigation ---
  { id: "prev_channel", group: "navigation", match: on("ArrowUp", { alt: true }), keys: ["Alt", "↑"], run: (a) => a.stepChannel(-1) },
  { id: "next_channel", group: "navigation", match: on("ArrowDown", { alt: true }), keys: ["Alt", "↓"], run: (a) => a.stepChannel(1) },
  { id: "prev_unread", group: "navigation", match: on("ArrowUp", { alt: true, shift: true }), keys: ["Alt", "Shift", "↑"], run: (a) => a.stepUnread(-1) },
  { id: "next_unread", group: "navigation", match: on("ArrowDown", { alt: true, shift: true }), keys: ["Alt", "Shift", "↓"], run: (a) => a.stepUnread(1) },
  { id: "prev_guild", group: "navigation", match: on("ArrowUp", { alt: true, mod: true }), keys: ["Ctrl", "Alt", "↑"], run: (a) => a.stepGuild(-1) },
  { id: "next_guild", group: "navigation", match: on("ArrowDown", { alt: true, mod: true }), keys: ["Ctrl", "Alt", "↓"], run: (a) => a.stepGuild(1) },
  // Alt+1…9, not Ctrl+1…9: browsers keep those for their own tabs.
  { id: "guild_n", group: "navigation", match: null, keys: ["Alt", "1–9"], run: null },
  { id: "switcher", group: "navigation", match: on("k", { mod: true }), keys: ["Ctrl", "K"], run: (a) => a.showSwitcher() },
  { id: "inbox", group: "navigation", match: on("i", { alt: true }), keys: ["Alt", "I"], run: (a) => a.openFriends("inbox") },

  // --- reading ---
  { id: "mark_read", group: "reading", match: on("Escape"), keys: ["Esc"], run: null }, // handled in main.js: only when nothing else is open
  { id: "mark_guild_read", group: "reading", match: on("Escape", { shift: true }), keys: ["Shift", "Esc"], run: null },
  { id: "search", group: "reading", match: on("f", { mod: true }), keys: ["Ctrl", "F"], run: (a) => a.showSearch() },

  // --- writing ---
  // Rows with no `match` are handled where they belong (the composer's own
  // key handling, ui/format.js) and appear here only so the sheet is complete.
  { id: "focus_composer", group: "writing", match: null, keys: [], run: null },
  { id: "emoji", group: "writing", match: on("e", { mod: true }), keys: ["Ctrl", "E"], run: (a) => a.openComposerEmoji() },
  { id: "upload", group: "writing", match: on("u", { mod: true, shift: true }), keys: ["Ctrl", "Shift", "U"], run: (a) => a.openComposerUpload() },
  { id: "bold", group: "writing", match: null, keys: ["Ctrl", "B"], run: null },
  { id: "italic", group: "writing", match: null, keys: ["Ctrl", "I"], run: null },
  { id: "underline", group: "writing", match: null, keys: ["Ctrl", "U"], run: null },
  { id: "edit_last", group: "writing", match: null, keys: ["↑"], run: null },

  // --- help ---
  { id: "cheat_sheet", group: "help", match: on("/", { mod: true }), keys: ["Ctrl", "/"], run: (a) => a.showShortcuts() },
];

export const GROUPS = ["navigation", "reading", "writing", "help"];

// ⌘ and ⌥ read better than Ctrl and Alt on a Mac.
export function keyLabel(part) {
  if (!isMac()) return part;
  return { Ctrl: "⌘", Alt: "⌥", Shift: "⇧", Esc: "esc" }[part] || part;
}

export const isTyping = (el) => !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

function matches(e, m) {
  if (!m) return false;
  if (e.key.toLowerCase() !== m.key) return false;
  if (!!(e.ctrlKey || e.metaKey) !== m.mod) return false;
  if (!!e.shiftKey !== m.shift) return false;
  if (!!e.altKey !== m.alt) return false;
  return true;
}

// A key combination that can't be mistaken for typing.
const modified = (m) => !!m && (m.mod || m.alt);

// Runs the first shortcut this event matches. Returns true when one fired.
export function handleShortcut(e, actions) {
  const typing = isTyping(document.activeElement);
  for (const s of SHORTCUTS) {
    if (!s.run || !matches(e, s.match)) continue;
    if (typing && !modified(s.match)) continue;
    e.preventDefault();
    s.run(actions);
    return true;
  }
  // Alt+1…9 jumps to a guild by position.
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
    e.preventDefault();
    actions.openGuildAt(Number(e.key) - 1);
    return true;
  }
  return false;
}

// A plain letter typed with nothing else held down goes to the composer.
export function shouldFocusComposer(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || isTyping(document.activeElement)) return false;
  if (e.key.length !== 1) return false;
  return !!$("#composer textarea");
}
