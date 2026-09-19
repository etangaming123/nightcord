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
    else if (key === "style" && typeof val === "object") Object.assign(el.style, val);
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

// Like el.append(), but skips null/false children (native append would print "null").
export function add(el, ...children) {
  append(el, children);
  return el;
}

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

export function displayName(user) {
  return user?.display_name || user?.username || "Unknown user";
}

// Where avatar images live: the server's https origin (same host as /ws).
let avatarBase = null;
export function setAvatarBase(wsUrl) {
  if (!wsUrl) { avatarBase = null; return; }
  const u = new URL(wsUrl);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  u.pathname = "/avatars/";
  avatarBase = u.toString();
}
export const avatarUrl = (avatarId) => (avatarBase && avatarId ? avatarBase + encodeURIComponent(avatarId) : null);

const STATUS_LABEL = { online: "Online", idle: "Idle", dnd: "Do Not Disturb", offline: "Offline", invisible: "Invisible" };
export const statusLabel = (s) => STATUS_LABEL[s] || "Offline";

// user: PublicUser (or anything with username/avatar_id/avatar_color).
// status: null (no dot) or online | idle | dnd | offline.
export function avatar(user, { size = "", status = null } = {}) {
  const name = user?.username || "?";
  const url = avatarUrl(user?.avatar_id);
  const el = h("div", {
    class: `avatar ${size}`,
    style: url ? null : `background:${user?.avatar_color || colorFor(name)}`,
    "aria-hidden": "true",
  });
  if (url) el.append(h("img", { src: url, alt: "", loading: "lazy", decoding: "async", draggable: "false" }));
  else el.append([...displayName(user)][0].toUpperCase());
  if (status) el.append(h("span", { class: `dot ${status}`, title: statusLabel(status) }));
  return el;
}

export function initials(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words.slice(0, 3).map((w) => [...w][0]) : [...(words[0] || "?")].slice(0, 2);
  return letters.join("").toUpperCase();
}

export function iconBtn(glyph, label, onClick, { cls = "" } = {}) {
  return h("button", {
    class: `icon-btn ${cls}`, type: "button", title: label, "aria-label": label,
    on: { click: (e) => { e.stopPropagation(); onClick(e); } },
  }, glyph);
}

// Compare snowflake id strings numerically.
export function idGt(a, b) {
  if (!a) return false;
  if (!b) return true;
  return a.length !== b.length ? a.length > b.length : a > b;
}

const shortFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
export const fmtDate = (iso) => (iso ? shortFmt.format(new Date(iso)) : "");
export const fmtDateTime = (iso) => (iso ? fullFmt.format(new Date(iso)) : "");
