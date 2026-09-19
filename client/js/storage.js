// localStorage wrapper. Every access is guarded: storage can be unavailable
// (private windows, blocked site data) and the app must still work.

const PREFIX = "nightcord.";

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    if (value === undefined || value === null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable; nothing to do */
  }
}

// Saved servers: [{ url, label }], most recently used first.
export function getServers() {
  const list = read("servers", []);
  return Array.isArray(list) ? list.filter((s) => s && typeof s.url === "string") : [];
}

export function saveServer(url, label) {
  const rest = getServers().filter((s) => s.url !== url);
  write("servers", [{ url, label: label || url }, ...rest]);
}

export function removeServer(url) {
  write("servers", getServers().filter((s) => s.url !== url));
  write(`session.${url}`, null);
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

// Session token, scoped per saved server (PROTOCOL.md §3).
export const getToken = (url) => read(`session.${url}`, null);
export const setToken = (url, token) => write(`session.${url}`, token);

// Last-open guild/channel per server, restored on reconnect.
export const getLast = (url) => read(`last.${url}`, {});
export function setLast(url, patch) {
  write(`last.${url}`, { ...getLast(url), ...patch });
}

export const getLastServer = () => read("lastServer", null);
export const setLastServer = (url) => write("lastServer", url);
