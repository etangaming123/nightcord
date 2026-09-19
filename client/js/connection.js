// WebSocket wrapper implementing the envelope rules in PROTOCOL.md §2:
// requests carry an `id`, responses echo it; frames without an id are events.

import { AUTH_OK_TYPES, ERR, T } from "./protocol.js";

const REQUEST_TIMEOUT_MS = 15000;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30000;

export class NightcordError extends Error {
  constructor(code, message, data = {}) {
    super(message || code);
    this.code = code;
    this.data = data; // extra error fields, e.g. retry_after for slowmode
  }
}

// Accepts "host:port", "wss://host:port", "ws://host:port/ws", etc.
// Returns the canonical ws(s)://host[:port]/ws URL, or throws.
export function normalizeServerUrl(input) {
  let s = String(input || "").trim();
  if (!s) throw new Error("Enter a server address");
  if (/^https?:\/\//i.test(s)) s = s.replace(/^http/i, "ws");
  if (!/^wss?:\/\//i.test(s)) {
    const host = s.split("/")[0].split(":")[0];
    const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    // Plain ws:// only for local dev served over http; everything else is wss.
    const secure = !(local && location.protocol === "http:");
    s = `${secure ? "wss" : "ws"}://${s}`;
  }
  const url = new URL(s);
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

// The https:// page a user opens to accept a self-signed certificate.
export function certTrustUrl(wsUrl) {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/";
  return url.toString();
}

export class Connection extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closedByUser = false;
    this.backoff = BACKOFF_START_MS;
    this.reconnectTimer = null;
    this.everOpened = false;
  }

  // Resolves once the socket is open; rejects if it fails before opening.
  open() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        reject(new NightcordError(ERR.DISCONNECTED, e.message));
        return;
      }
      this.ws = ws;
      ws.addEventListener("open", () => {
        settled = true;
        this.everOpened = true;
        this.backoff = BACKOFF_START_MS;
        resolve();
      });
      ws.addEventListener("message", (e) => this.#onFrame(e.data));
      ws.addEventListener("close", (e) => {
        if (this.ws !== ws) return;
        this.#failPending();
        if (!settled) {
          settled = true;
          reject(new NightcordError(ERR.DISCONNECTED, "Could not connect to the server"));
          return;
        }
        this.#emit("disconnected", { code: e.code, reason: e.reason });
        if (!this.closedByUser) this.#scheduleReconnect();
      });
    });
  }

  close() {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
    this.#failPending();
  }

  get isOpen() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  // Sends a request and resolves with the response payload, or rejects with
  // a NightcordError carrying the server's error code.
  request(type, payload = {}) {
    if (!this.isOpen) {
      return Promise.reject(new NightcordError(ERR.DISCONNECTED, "Not connected"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new NightcordError(ERR.TIMEOUT, "The server didn't respond"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { type, resolve, reject, timer });
      this.ws.send(JSON.stringify({ type, payload, id }));
    });
  }

  // Subscribe to an unsolicited event type, e.g. on(T.MESSAGE_NEW, fn).
  on(type, fn) {
    const handler = (e) => fn(e.detail);
    this.addEventListener(type, handler);
    return () => this.removeEventListener(type, handler);
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #onFrame(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;
    const payload = msg.payload || {};
    const waiter = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
    if (waiter) {
      this.pending.delete(msg.id);
      clearTimeout(waiter.timer);
      const okType = AUTH_OK_TYPES.has(waiter.type) ? T.AUTH_OK : `${waiter.type}.result`;
      if (msg.type === okType) waiter.resolve(payload);
      else waiter.reject(new NightcordError(payload.code || ERR.BAD_REQUEST, payload.message, payload));
      return;
    }
    this.#emit(msg.type, payload);
  }

  #failPending() {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new NightcordError(ERR.DISCONNECTED, "Connection lost"));
    }
    this.pending.clear();
  }

  #scheduleReconnect() {
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.#emit("reconnecting", { delay });
    this.reconnectTimer = setTimeout(async () => {
      if (this.closedByUser) return;
      try {
        await this.open();
        this.#emit("reconnected", {});
      } catch {
        if (!this.closedByUser) this.#scheduleReconnect();
      }
    }, delay);
  }
}
