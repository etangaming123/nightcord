// A little toolbar that appears over the composer while text is selected, and
// the Ctrl/Cmd shortcuts that do the same thing without it. Pure text
// wrangling — everything here just edits the textarea's value.

import { h } from "./dom.js";
import { scopedT } from "../strings.js";

const t = scopedT("ui/format");

// label key -> [prefix, suffix]. Link is special-cased below.
export const WRAPS = {
  bold: ["**", "**"],
  italic: ["*", "*"],
  underline: ["__", "__"],
  strike: ["~~", "~~"],
  spoiler: ["||", "||"],
  code: ["`", "`"],
};

const BUTTONS = [
  ["bold", "B"], ["italic", "I"], ["strike", "S"], ["spoiler", "▓"], ["code", "‹›"], ["link", "🔗"],
];

// Wrapping an already-wrapped selection unwraps it, so the same key is a toggle.
export function applyFormat(input, kind) {
  const start = input.selectionStart ?? 0;
  const end = input.selectionEnd ?? start;
  const value = input.value;
  const selected = value.slice(start, end);
  if (kind === "link") {
    const label = selected || t("link_text");
    const url = selected && /^https?:\/\/\S+$/.test(selected) ? selected : "https://";
    const text = `[${selected && url !== selected ? label : t("link_text")}](${url})`;
    input.value = value.slice(0, start) + text + value.slice(end);
    // Leave the cursor on the part worth replacing.
    const at = start + text.indexOf(url === "https://" ? "https://" : url);
    input.setSelectionRange(at, at + url.length);
    fire(input);
    return;
  }
  const [open, close] = WRAPS[kind] || [];
  if (!open) return;
  const before = value.slice(Math.max(0, start - open.length), start);
  const after = value.slice(end, end + close.length);
  if (before === open && after === close) {
    input.value = value.slice(0, start - open.length) + selected + value.slice(end + close.length);
    input.setSelectionRange(start - open.length, end - open.length);
  } else if (selected.startsWith(open) && selected.endsWith(close) && selected.length > open.length + close.length) {
    const inner = selected.slice(open.length, -close.length);
    input.value = value.slice(0, start) + inner + value.slice(end);
    input.setSelectionRange(start, start + inner.length);
  } else {
    input.value = value.slice(0, start) + open + selected + close + value.slice(end);
    input.setSelectionRange(start + open.length, start + open.length + selected.length);
  }
  fire(input);
}

function fire(input) {
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
}

// Ctrl/Cmd+B, +I, +U. Returns true when it handled the key.
export function formatShortcut(e, input) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
  const kind = { b: "bold", i: "italic", u: "underline" }[e.key.toLowerCase()];
  if (!kind) return false;
  e.preventDefault();
  applyFormat(input, kind);
  return true;
}

// The floating bar. Shows itself whenever the composer has a selection.
export function attachFormatBar(form, input) {
  const bar = h("div", { class: "format-bar", role: "toolbar", "aria-label": t("toolbar_label"), hidden: true },
    BUTTONS.map(([kind, glyph]) => h("button", {
      class: `format-btn ${kind}`, type: "button", title: t(`${kind}_title`), "aria-label": t(`${kind}_title`),
      // mousedown, not click: clicking mustn't take the selection away first.
      on: { mousedown: (e) => { e.preventDefault(); applyFormat(input, kind); } },
    }, glyph)));
  const update = () => {
    const has = document.activeElement === input && input.selectionStart !== input.selectionEnd;
    bar.hidden = !has;
  };
  for (const ev of ["select", "keyup", "mouseup", "input", "focus"]) input.addEventListener(ev, update);
  input.addEventListener("blur", () => setTimeout(update, 0));
  document.addEventListener("selectionchange", update);
  form.prepend(bar);
  return bar;
}
