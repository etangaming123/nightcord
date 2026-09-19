// Tiny DOM builder. Strings become text nodes, never HTML, so user content
// can't inject markup.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, val] of Object.entries(attrs || {})) {
    if (val === undefined || val === null || val === false) continue;
    if (key === "class") el.className = val;
    else if (key === "text") el.textContent = val;
    else if (key === "on") for (const [ev, fn] of Object.entries(val)) el.addEventListener(ev, fn);
    else if (key === "dataset") Object.assign(el.dataset, val);
    else if (key in el && typeof val !== "string") el[key] = val;
    else el.setAttribute(key, val === true ? "" : val);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

// Stable pleasant color per username.
const AVATAR_COLORS = ["#7aa2f7", "#bb9af7", "#9ece6a", "#e0af68", "#f7768e", "#7dcfff", "#ff9e64", "#73daca"];
export function colorFor(name) {
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export function avatar(name, { size = "", online = null } = {}) {
  const initial = [...String(name || "?")][0].toUpperCase();
  return h(
    "div",
    { class: `avatar ${size}`, style: `background:${colorFor(name)}`, "aria-hidden": "true" },
    initial,
    online === null ? null : h("span", { class: `dot ${online ? "on" : ""}` }),
  );
}

export function initials(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words.slice(0, 3).map((w) => [...w][0]) : [...(words[0] || "?")].slice(0, 2);
  return letters.join("").toUpperCase();
}

// Renders text with http(s) URLs as links; everything stays text-node safe.
const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;
export function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h("a", { href: m[0], target: "_blank", rel: "noopener noreferrer nofollow" }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
