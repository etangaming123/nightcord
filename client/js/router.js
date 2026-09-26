// Where you are, in the address bar — Nightcord's take on Discord's
// /channels/… URLs:
//
//   /app/home  /app/about  /app/inbox  /app/requests
//   /app/friends[/all|pending|blocked|add]
//   /app/dms/<user>[/<message>]         /app/groups/<group>[/<message>]
//   /app/servers/<guild>[/<channel>[/<message>]]
//   /app/settings/<section>
//   /app/servers/<guild>/settings/<section>
//   /app/servers/<guild>/<channel>/settings/<section>
//   /app/invite/<token>   (the server and code, base64: ui/links.js)
//
// Guilds, channels, DMs and groups go by name where that's unambiguous
// (/app/servers/night-owls/general, /app/dms/luna) and by id otherwise; ids
// always work too. Names are only for the address bar: shareable links
// (message links, invites) keep ids, so a rename doesn't break them.
//
// Moving around pushes history, so Back and Forward walk it (and Back closes
// settings or the long-press sheet first). The server isn't in the path —
// the app remembers which one you were on; shareable links add ?server=.
//
// A static host only has /app/index.html, so a deep link 404s first:
// site/404.html (and tools/localhost.py) bounce it to /app/?route=<path>.
// The standalone build runs from file:// and leaves the address alone.

import { currentChannel, state, userById } from "./state.js";
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
let lastPlace = null; // currentPath(false) as of the last sync

if (ENABLED) {
  // Relative URLs (sounds, language files, the logo) must keep resolving
  // against /app/ after the path moves on to /app/servers/1/2.
  const base = document.createElement("base");
  base.href = APP_BASE;
  document.head.prepend(base);
}

// --- names ------------------------------------------------------------------

// "Night Owls" -> "night-owls". Letters in any script stay; accents go.
export function slug(name) {
  return String(name || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
}

// What each kind of place is called in the address, and among what.
const KINDS = {
  guild: { all: () => [...state.guilds.values()], id: (g) => g.guild_id, name: (g) => g.name },
  // Not categories: nothing opens one, so a "General" category mustn't push
  // a #general channel back to its id. "settings" would read as the page.
  channel: {
    all: () => state.channels.filter((c) => c.kind !== "category"), id: (c) => c.channel_id, name: (c) => c.name,
    reserved: ["settings"],
  },
  dm: {
    all: () => [...state.dms.values()].filter((c) => c.kind === "dm"), id: (c) => c.channel_id,
    name: (c) => {
      const other = c.recipients.find((u) => u.user_id !== state.user?.user_id);
      return other ? (userById(other.user_id) || other).username : "";
    },
  },
  group: { all: () => [...state.dms.values()].filter((c) => c.kind === "group_dm"), id: (c) => c.channel_id, name: (c) => c.name },
};

// The (unencoded) address segment for `item`: its name, unless that's empty,
// all digits, reserved or shared with another of its kind; then its id.
function segment(kind, item, all = KINDS[kind].all()) {
  const k = KINDS[kind];
  const s = slug(k.name(item));
  const clash = !s || ID.test(s) || k.reserved?.includes(s) || all.some((o) => o !== item && slug(k.name(o)) === s);
  return clash ? k.id(item) : s;
}

// And back: the id a segment stands for, or null.
function resolve(kind, seg) {
  if (!seg) return null;
  const k = KINDS[kind];
  const all = k.all();
  const hit = all.find((o) => k.id(o) === seg) || all.find((o) => segment(kind, o, all) === seg);
  return hit ? k.id(hit) : ID.test(seg) ? seg : null;
}


// --- paths ------------------------------------------------------------------

// The path (under APP_BASE) for what's on screen now, or null while the
// view is still settling (a guild with no channel picked yet). named: false
// uses ids throughout, which tells a rename apart from going somewhere.
function currentPath(named = true) {
  if (!state.user) return "";
  const part = (kind, item) => (named ? encodeURIComponent(segment(kind, item)) : KINDS[kind].id(item));
  const guild = (id) => (state.guilds.has(id) ? part("guild", state.guilds.get(id)) : id);
  const channel = (id) => {
    const c = state.channels.find((x) => x.channel_id === id);
    return c ? part("channel", c) : id;
  };
  if (overlay) {
    const section = overlay.section ? `/${encodeURIComponent(overlay.section)}` : "";
    if (overlay.kind === "settings") return `settings${section}`;
    if (overlay.kind === "guild") return `servers/${guild(overlay.guildId)}/settings${section}`;
    return `servers/${guild(overlay.guildId)}/${channel(overlay.channelId)}/settings${section}`;
  }
  if (state.view === "guild") {
    if (!state.guildId) return null;
    if (state.channelId) return `servers/${guild(state.guildId)}/${channel(state.channelId)}`;
    return state.channels.length ? `servers/${guild(state.guildId)}` : null; // still loading, or no text channels
  }
  const ch = currentChannel();
  if (ch) return ch.kind === "group_dm" ? `groups/${part("group", ch)}` : `dms/${part("dm", ch)}`;
  const tab = state.homeTab;
  if (HOME_TABS.includes(tab)) return tab;
  return tab === "online" ? "friends" : `friends/${tab}`;
}

// A path under APP_BASE (or a full pathname) to a route object, or null.
// Places stay as written (a name or an id) until apply() looks them up.
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
  if ((head === "dms" || head === "groups") && a) {
    return { kind: "dm", group: head === "groups", channel: a, messageId: ID.test(b || "") ? b : null };
  }
  if (head === "settings") return { kind: "settings", section: a || null };
  if (head === "invite" && a) return { kind: "invite", code: a };
  if (head === "servers" && a) {
    if (b === "settings") return { kind: "guild-settings", guild: a, section: c || null };
    if (b && c === "settings") return { kind: "channel-settings", guild: a, channel: b, section: d || null };
    return { kind: "guild", guild: a, channel: b || null, messageId: ID.test(c || "") ? c : null };
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
  // skipPop: one of our history.back() calls hasn't landed yet; pushing now
  // would get undone by it. onPop syncs once it has.
  if (!ENABLED || !started || applying || skipPop) return;
  const path = currentPath();
  if (path === null) return;
  const place = currentPath(false);
  const full = APP_BASE + path;
  const renamed = place === lastPlace;
  lastPlace = place;
  if (full === location.pathname) { replaceNext = false; return; }
  // Switching sections inside one settings page replaces; so do redirects
  // and renames (same place, new name).
  const inSettings = (p) => /(^|\/)settings(\/|$)/.test(p);
  const oldPath = location.pathname.slice(APP_BASE.length);
  if (replaceNext || renamed || (overlay && inSettings(oldPath) && inSettings(path))) {
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
  lastPlace = null;
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
  const guildId = route.guild ? resolve("guild", route.guild) : null;
  // Opens the route's guild unless it's already open; false if it isn't one of ours.
  const openItsGuild = async () => {
    if (!guildId || !state.guilds.has(guildId)) return false;
    if (state.view !== "guild" || state.guildId !== guildId) await a.openGuild(guildId);
    return true;
  };
  switch (route.kind) {
    case "home":
      a.openFriends(route.tab);
      return true;
    case "dm": {
      const channelId = resolve(route.group ? "group" : "dm", route.channel);
      if (!state.dms.has(channelId)) return false;
      if (route.messageId) await a.jumpTo(route.messageId, channelId, null);
      else await a.openDm(channelId);
      return true;
    }
    case "guild":
      if (!guildId || !state.guilds.has(guildId)) return false;
      if (route.messageId && ID.test(route.channel || "")) {
        await a.jumpTo(route.messageId, route.channel, guildId);
        return true;
      }
      // The channel's name can only be looked up once the guild's loaded,
      // so openGuild takes a picker for it.
      await a.openGuild(guildId, route.channel ? () => resolve("channel", route.channel) : null);
      if (route.messageId && state.guildId === guildId && state.channelId) await a.jumpTo(route.messageId, state.channelId, guildId);
      return true;
    case "settings":
      a.userSettings(route.section || undefined);
      return true;
    case "guild-settings":
      if (!(await openItsGuild())) return false;
      a.guildSettings(route.section || undefined);
      return true;
    case "channel-settings": {
      if (!(await openItsGuild())) return false;
      const channelId = resolve("channel", route.channel);
      const channel = state.channels.find((c) => c.channel_id === channelId);
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
  if (skipPop) { skipPop--; sync(); return; }
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
