// Where you are, in the address bar — Nightcord's take on Discord's
// /channels/… URLs:
//
//   /app/home  /app/about  /app/inbox  /app/requests
//   /app/friends[/all|pending|blocked|add]
//   /app/dms/<channel>[/<message>]      /app/groups/<channel>[/<message>]
//   /app/servers/<guild>[/<channel>[/<message>]]
//   /app/settings/<section>
//   /app/servers/<guild>/settings/<section>
//   /app/servers/<guild>/<channel>/settings/<section>
//   /app/invite/<token>   (the server and code, base64: ui/links.js)
//
// Moving around pushes history, so Back and Forward walk it (and Back closes
// settings or the long-press sheet first). The server isn't in the path —
// the app remembers which one you were on; shareable links add ?server=.
//
// A static host only has /app/index.html, so a deep link 404s first:
// site/404.html (and tools/localhost.py) bounce it to /app/?route=<path>.
// The standalone build runs from file:// and leaves the address alone.

import { currentChannel, state } from "./state.js";
import { closeFullscreen, closeSheet, setOverlayListener, sheetOpen } from "./ui/modals.js";

const here = import.meta.url; // undefined in the standalone (bundled) build
export const ENABLED = /^https?:$/.test(location.protocol) && /^https?:/.test(here || "");
// The client's own folder ("/app/"), whatever path the page is showing.
export const APP_BASE = ENABLED ? new URL("../", here).pathname : location.pathname;

const ID = /^\d{1,20}$/;
const FRIEND_TABS = ["online", "all", "pending", "blocked", "add"];
const HOME_TABS = ["home", "about", "inbox", "requests"];

let actions = null;
let invalidate = () => {};
let started = false; // false until logged in and the first view is up
let replaceNext = true; // the next address change replaces instead of pushing
let overlay = null; // { kind: "settings" | "guild" | "channel", section, guildId?, channelId? }
let skipPop = 0; // our own history.back() calls, whose popstate needs no work
// Following Back/Forward: the address has already moved but the view hasn't,
// so renders in between mustn't write the old place back.
let applying = false;

if (ENABLED) {
  // Relative URLs (sounds, language files, the logo) must keep resolving
  // against /app/ after the path moves on to /app/servers/1/2.
  const base = document.createElement("base");
  base.href = APP_BASE;
  document.head.prepend(base);
}

// --- paths ------------------------------------------------------------------

// The path (under APP_BASE) for what's on screen now, or null while the
// view is still settling (a guild with no channel picked yet).
function currentPath() {
  if (!state.user) return "";
  if (overlay) {
    const section = overlay.section ? `/${encodeURIComponent(overlay.section)}` : "";
    if (overlay.kind === "settings") return `settings${section}`;
    if (overlay.kind === "guild") return `servers/${overlay.guildId}/settings${section}`;
    return `servers/${overlay.guildId}/${overlay.channelId}/settings${section}`;
  }
  if (state.view === "guild") {
    if (!state.guildId) return null;
    if (state.channelId) return `servers/${state.guildId}/${state.channelId}`;
    return state.channels.length ? `servers/${state.guildId}` : null; // still loading, or no text channels
  }
  const ch = currentChannel();
  if (ch) return `${ch.kind === "group_dm" ? "groups" : "dms"}/${ch.channel_id}`;
  const tab = state.homeTab;
  if (HOME_TABS.includes(tab)) return tab;
  return tab === "online" ? "friends" : `friends/${tab}`;
}

// A path under APP_BASE (or a full pathname) to a route object, or null.
export function parseRoute(path) {
  let rest = path || "";
  if (rest.startsWith(APP_BASE)) rest = rest.slice(APP_BASE.length);
  let parts;
  try {
    parts = rest.split(/[?#]/)[0].split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  const [head, a, b, c, d] = parts;
  if (!head) return null;
  if (HOME_TABS.includes(head)) return { kind: "home", tab: head };
  if (head === "friends") return { kind: "home", tab: FRIEND_TABS.includes(a) ? a : "online" };
  if ((head === "dms" || head === "groups") && ID.test(a || "")) {
    return { kind: "dm", channelId: a, messageId: ID.test(b || "") ? b : null };
  }
  if (head === "settings") return { kind: "settings", section: a || null };
  if (head === "invite" && a) return { kind: "invite", code: a };
  if (head === "servers" && ID.test(a || "")) {
    if (b === "settings") return { kind: "guild-settings", guildId: a, section: c || null };
    if (ID.test(b || "") && c === "settings") return { kind: "channel-settings", guildId: a, channelId: b, section: d || null };
    return { kind: "guild", guildId: a, channelId: ID.test(b || "") ? b : null, messageId: ID.test(c || "") ? c : null };
  }
  return null;
}

// Where the page was opened: ?route= from the 404 bounce, else the path.
export function initialRoute() {
  if (!ENABLED) return null;
  const bounced = new URLSearchParams(location.search).get("route");
  return parseRoute(bounced ?? location.pathname);
}

// Shareable links. Off the web (the standalone build runs from file://) they
// point at the hosted client instead.
const HOSTED = "https://nightcord.etangaming.xyz/app/";

export const appUrl = (path) => `${ENABLED ? `${location.origin}${APP_BASE}` : HOSTED}${path}`;

// --- keeping the address in step ------------------------------------------------

// Called after every render (render.js flush) and when an overlay changes.
export function sync() {
  if (!ENABLED || !started || applying) return;
  const path = currentPath();
  if (path === null) return;
  const full = APP_BASE + path;
  if (full === location.pathname) { replaceNext = false; return; }
  // Switching sections inside one settings page replaces; so do redirects.
  const inSettings = (p) => /(^|\/)settings(\/|$)/.test(p);
  const oldPath = location.pathname.slice(APP_BASE.length);
  if (replaceNext || (overlay && inSettings(oldPath) && inSettings(path))) {
    history.replaceState(history.state, "", full);
  } else {
    history.pushState(overlay ? { overlay: true } : null, "", full);
  }
  replaceNext = false;
}

// Logged out: plain /app/.
export function clear() {
  started = false;
  overlay = null;
  if (ENABLED && location.pathname !== APP_BASE) history.replaceState(null, "", APP_BASE + location.search);
}

// Start tracking once the app is on screen. The first change replaces the
// /app/ the page loaded on.
export function start() {
  started = true;
  replaceNext = true;
  sync();
}

// Settings pages and the sheet tell us when they open and close.
function onOverlay(kind, info) {
  if (kind === "sheet") {
    if (!ENABLED || !started) return;
    // An entry of its own, so Back closes the sheet instead of leaving.
    if (info) history.pushState({ sheet: true }, "", location.href);
    else if (history.state?.sheet) { skipPop++; history.back(); }
    return;
  }
  overlay = info;
  if (!ENABLED || !started) return;
  // Closed with X or Escape after we pushed it: step back rather than push
  // the page underneath again, so Back doesn't reopen it.
  if (!info && history.state?.overlay) { skipPop++; history.back(); return; }
  if (!info) replaceNext = true;
  sync();
}

// --- following the address -------------------------------------------------------

// Opens a route. Returns false if it points nowhere we can go.
export async function apply(route) {
  if (!route || !actions) return false;
  const a = actions;
  switch (route.kind) {
    case "home":
      a.openFriends(route.tab);
      return true;
    case "dm":
      if (!state.dms.has(route.channelId)) return false;
      if (route.messageId) await a.jumpTo(route.messageId, route.channelId, null);
      else await a.openDm(route.channelId);
      return true;
    case "guild":
      if (!state.guilds.has(route.guildId)) return false;
      if (route.messageId && route.channelId) await a.jumpTo(route.messageId, route.channelId, route.guildId);
      else await a.openGuild(route.guildId, route.channelId);
      return true;
    case "settings":
      a.userSettings(route.section || undefined);
      return true;
    case "guild-settings":
      if (!state.guilds.has(route.guildId)) return false;
      if (state.view !== "guild" || state.guildId !== route.guildId) await a.openGuild(route.guildId);
      a.guildSettings(route.section || undefined);
      return true;
    case "channel-settings": {
      if (!state.guilds.has(route.guildId)) return false;
      if (state.view !== "guild" || state.guildId !== route.guildId) await a.openGuild(route.guildId);
      const channel = state.channels.find((c) => c.channel_id === route.channelId);
      if (!channel) return true; // the guild opened; the channel's gone
      a.channelSettings(channel, route.section || undefined);
      return true;
    }
    case "invite":
      a.openInvite(route.code);
      return true;
    default:
      return false;
  }
}

async function onPop() {
  if (skipPop) { skipPop--; return; }
  if (!started) return;
  if (sheetOpen()) { closeSheet(); return; }
  const route = parseRoute(location.pathname);
  applying = true;
  try {
    if (overlay && !/settings$/.test(route?.kind || "")) closeFullscreen();
    // Already showing it (e.g. Back from settings landed where we were).
    if (currentPath() === location.pathname.slice(APP_BASE.length)) return;
    if (!(await apply(route))) actions.openFriends("home");
  } finally {
    applying = false;
    replaceNext = true; // a redirect (a guild to its channel) replaces
    sync();
    invalidate();
  }
}

export function setupRouter(appActions, { invalidate: inv }) {
  actions = appActions;
  invalidate = inv;
  setOverlayListener(onOverlay);
  if (ENABLED) window.addEventListener("popstate", onPop);
}
