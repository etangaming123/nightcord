// localStorage wrapper. Every access is guarded: storage can be unavailable
// (private windows, blocked site data) and the app must still work.
//
// While the preview runs (client/js/preview), storage is volatile: writes go
// to memory and reads look there first, so trying things out never changes
// what this browser remembers.

const PREFIX = "nightcord.";

let volatile = null; // Map of full key -> string while the preview runs

export function setVolatile(on) {
  volatile = on ? new Map() : null;
}

// Raw string access by full key, for modules that keep their own keys
// (prefs.js, reminders.js, update-check.js).
export function rawGet(key) {
  if (volatile?.has(key)) return volatile.get(key);
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function rawSet(key, value) {
  if (volatile) {
    volatile.set(key, value);
    return;
  }
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable; nothing to do */
  }
}

function read(key, fallback) {
  try {
    const raw = rawGet(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  rawSet(PREFIX + key, value === undefined || value === null ? null : JSON.stringify(value));
}

// Saved servers: [{ url, label, maxAccounts }], most recently used first.
// maxAccounts is the server's advisory max_accounts_per_client (0 = no limit).
export function getServers() {
  const list = read("servers", []);
  return Array.isArray(list) ? list.filter((s) => s && typeof s.url === "string") : [];
}

export function saveServer(url, label, maxAccounts) {
  const list = getServers();
  const prev = list.find((s) => s.url === url);
  const rest = list.filter((s) => s.url !== url);
  const limit = Number.isInteger(maxAccounts) ? maxAccounts : prev?.maxAccounts || 0;
  write("servers", [{ url, label: label || url, maxAccounts: limit }, ...rest]);
}

export function removeServer(url) {
  write("servers", getServers().filter((s) => s.url !== url));
  write(`session.${url}`, null);
  write(`accounts.${url}`, null);
  write(`last.${url}`, null);
  write(`trusted.${url}`, null);
  write(`legal.${url}`, null);
}

// The user saw the "server owners can see your IP" warning for this server.
export const isTrusted = (url) => read(`trusted.${url}`, false) === true || getServers().some((s) => s.url === url);
export const setTrusted = (url) => write(`trusted.${url}`, true);

// Legal documents version accepted on this device before creating an account.
export const getLegalAccepted = (url) => read(`legal.${url}`, null);
export const setLegalAccepted = (url, version) => write(`legal.${url}`, version);

// A random id per server, sent with auth requests (PROTOCOL.md §3, §8c). It
// is kept even when the server is forgotten, like a cookie would be.
export function getDeviceId(url) {
  let id = read(`device.${url}`, null);
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    write(`device.${url}`, id);
  }
  return id;
}

// Accounts per server for the account switcher: [{ user_id, username,
// display_name, avatar_color, token }], plus which one is active. Each holds
// its own session token (PROTOCOL.md §3).
export function getAccounts(url) {
  const list = read(`accounts.${url}`, null);
  if (Array.isArray(list)) return list.filter((a) => a && typeof a.token === "string");
  // Before the switcher there was one token per server; carry it over.
  const legacy = read(`session.${url}`, null);
  return typeof legacy === "string" ? [{ user_id: null, username: null, token: legacy }] : [];
}

const setAccounts = (url, list) => {
  write(`accounts.${url}`, list.length ? list : null);
  write(`session.${url}`, null);
};

export const getActiveId = (url) => read(`active.${url}`, null);

function activeAccount(url) {
  const list = getAccounts(url);
  const id = getActiveId(url);
  return list.find((a) => a.user_id === id) || list[0] || null;
}

export const getToken = (url) => activeAccount(url)?.token || null;

// After logging in: remember (or refresh) this account and make it active.
export function saveAccount(url, user, token) {
  const entry = {
    user_id: user.user_id, username: user.username, display_name: user.display_name || null,
    avatar_color: user.avatar_color || null, token,
  };
  const rest = getAccounts(url).filter((a) => a.user_id !== user.user_id && a.token !== token && a.user_id !== null);
  setAccounts(url, [entry, ...rest]);
  write(`active.${url}`, user.user_id);
}

// Profile changes (name, colour) shown in the switcher.
export function refreshAccount(url, user) {
  const list = getAccounts(url);
  const a = list.find((x) => x.user_id === user.user_id);
  if (!a) return;
  Object.assign(a, { username: user.username, display_name: user.display_name || null, avatar_color: user.avatar_color || null });
  setAccounts(url, list);
}

export const setActiveAccount = (url, userId) => write(`active.${url}`, userId);

// Forget one account (logged out or its session expired). null = the active one.
export function removeAccount(url, userId = null) {
  const target = userId ?? activeAccount(url)?.user_id ?? null;
  const list = getAccounts(url).filter((a) => a.user_id !== target);
  setAccounts(url, list);
  if (getActiveId(url) === target) write(`active.${url}`, list[0]?.user_id ?? null);
}

// Last-open guild/channel per server and account, restored on reconnect.
const lastKey = (url) => `last.${url}${getActiveId(url) ? `#${getActiveId(url)}` : ""}`;
export const getLast = (url) => read(lastKey(url), {});
export function setLast(url, patch) {
  write(lastKey(url), { ...getLast(url), ...patch });
}

export const getLastServer = () => read("lastServer", null);
export const setLastServer = (url) => write("lastServer", url);
