// Tiny DOM builder. Strings become text nodes, never HTML, so user content
// can't inject markup.

import { scopedT } from "../strings.js";
import { hasIcon, icon } from "./icons.js";

const t = scopedT("ui/dom");

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
const AVATAR_COLORS = ["#884499", "#bb6688", "#8888cc", "#ccaa88", "#ddaacc", "#6a8fbf", "#9ece6a", "#73daca"];
export function colorFor(name) {
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export function displayName(user) {
  if (user?.deleted) return t("deleted_user");
  return user?.display_name || user?.username || t("unknown_user");
}

// Where avatar images and files live: the server's https origin (same host as /ws).
let avatarBase = null;
let httpBase = null;
// The preview (client/js/preview) has no https origin: it answers server
// paths like /media/123 or /files/… itself, with data: and blob: URLs.
let resolveUrl = null;
export const setUrlResolver = (fn) => { resolveUrl = fn; };
export function setAvatarBase(wsUrl) {
  if (!wsUrl) { avatarBase = null; httpBase = null; return; }
  const u = new URL(wsUrl);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  u.pathname = "/avatars/";
  avatarBase = u.toString();
  httpBase = u.origin;
}
// Image references (PROTOCOL.md §4 User): "123.png" is a small upload under
// /avatars/, "123" a /media upload and "a_123" an animated one.
const MEDIA_REF = /^(a_)?(\d{1,20})$/;
export const mediaUrl = (mediaId) => {
  if (!mediaId) return null;
  if (resolveUrl) return resolveUrl(`/media/${mediaId}`);
  return httpBase ? `${httpBase}/media/${encodeURIComponent(mediaId)}` : null;
};
export const isAnimatedRef = (ref) => typeof ref === "string" && ref.startsWith("a_");
export function avatarUrl(ref) {
  if (!ref) return null;
  const m = MEDIA_REF.exec(ref);
  if (m) return mediaUrl(m[2]);
  if (resolveUrl) return resolveUrl(`/avatars/${ref}`);
  return avatarBase ? avatarBase + encodeURIComponent(ref) : null;
}
export const imageUrl = avatarUrl;

// Whether an animated image may play; set from the server's customisation
// settings (PROTOCOL.md §8d). owner: the PublicUser (or guild) it belongs to.
let animatePolicy = () => true;
export const setAnimatePolicy = (fn) => { animatePolicy = fn; };
export const mayAnimate = (owner) => animatePolicy(owner);

// <img> for an image reference; an animated image that may not play is
// drawn still (its first frame) on a canvas.
export function imageEl(ref, { animate = true, alt = "", cls = "", lazy = true } = {}) {
  const src = avatarUrl(ref);
  if (!src) return null;
  const img = h("img", { src, alt, class: cls || null, loading: lazy ? "lazy" : null, decoding: "async", draggable: "false" });
  if (!isAnimatedRef(ref) || animate) return img;
  const canvas = h("canvas", { class: `still ${cls}`, role: alt ? "img" : null, "aria-label": alt || null });
  img.crossOrigin = "anonymous";
  img.loading = "eager";
  img.onload = () => {
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0);
  };
  return canvas;
}
// An absolute URL for a server path like /files/… or /upload.
export const serverUrl = (path) => (resolveUrl ? resolveUrl(path) : httpBase ? httpBase + path : null);

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

const STATUS_KEY = { online: "status_online", idle: "status_idle", dnd: "status_dnd", offline: "status_offline", invisible: "status_invisible" };
export const statusLabel = (s) => t(STATUS_KEY[s] || "status_offline");

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
  if (url) el.append(imageEl(user.avatar_id, { animate: mayAnimate(user) }));
  else el.append([...displayName(user)][0].toUpperCase());
  if (status) el.append(h("span", { class: `dot ${status}`, title: statusLabel(status) }));
  return el;
}

export function initials(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words.slice(0, 3).map((w) => [...w][0]) : [...(words[0] || "?")].slice(0, 2);
  return letters.join("").toUpperCase();
}

// glyph: an icon name from icons.js, or any node/text (e.g. an emoji).
export function iconBtn(glyph, label, onClick, { cls = "" } = {}) {
  return h("button", {
    class: `icon-btn ${cls}`, type: "button", title: label, "aria-label": label,
    on: { click: (e) => { e.stopPropagation(); onClick(e); } },
  }, hasIcon(glyph) ? icon(glyph) : glyph);
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

// Message times, Discord-style and the same on every browser: "Today at
// 3:18pm", "Yesterday at 3:00am", "13/11/26 at 12:00pm". The date order and
// clock come from Appearance (prefs.dateFormat / prefs.clock), handed in by
// main.js — importing prefs.js here would make an import cycle.
let stampPrefs = () => ({});
export const setStampPrefs = (get) => { stampPrefs = get; };
const pad = (n) => String(n).padStart(2, "0");
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function fmtClock(date, { clock = stampPrefs().clock } = {}) {
  const d = date instanceof Date ? date : new Date(date);
  if (clock === "24h") return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getHours() % 12 || 12}:${pad(d.getMinutes())}${d.getHours() < 12 ? "am" : "pm"}`;
}

export function fmtShortDate(date, { dateFormat = stampPrefs().dateFormat } = {}) {
  const d = date instanceof Date ? date : new Date(date);
  const [dd, mm, yy] = [pad(d.getDate()), pad(d.getMonth() + 1), pad(d.getFullYear() % 100)];
  if (dateFormat === "mdy") return `${mm}/${dd}/${yy}`;
  if (dateFormat === "ymd") return `${yy}/${mm}/${dd}`;
  return `${dd}/${mm}/${yy}`;
}

export function fmtStamp(date, opts = {}) {
  if (!date) return "";
  const d = date instanceof Date ? date : new Date(date);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const day = sameDay(d, now) ? t("today") : sameDay(d, yesterday) ? t("yesterday") : fmtShortDate(d, opts);
  return t("stamp", { day, time: fmtClock(d, opts) });
}

const RELATIVE_UNITS = [
  ["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400],
  ["hour", 3600], ["minute", 60], ["second", 1],
];
let relFmt = null;

// "3 hours ago", "in 2 days": a Date or ISO string relative to now.
export function fmtRelative(date) {
  if (!date) return "";
  const d = date instanceof Date ? date : new Date(date);
  relFmt ??= new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const diff = (d.getTime() - Date.now()) / 1000;
  for (const [unit, secs] of RELATIVE_UNITS) {
    if (Math.abs(diff) >= secs || unit === "second") {
      return relFmt.format(Math.round(diff / secs), unit);
    }
  }
  return "";
}

// A "last seen" time in the viewer's chosen style (prefs.lastSeenFormat):
// datetime | date | relative | both ("3 hours ago (25 Sept 2026, 9:40 am)").
export function fmtSeen(iso, format) {
  if (!iso) return "";
  if (format === "date") return fmtDate(iso);
  if (format === "relative") return fmtRelative(iso);
  if (format === "both") return `${fmtRelative(iso)} (${fmtDateTime(iso)})`;
  return fmtDateTime(iso);
}
