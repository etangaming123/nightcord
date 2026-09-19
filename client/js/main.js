// Nightcord client entry: screens (connect, first-run setup, auth), session
// lifecycle and reconnects (PROTOCOL.md §3). The app itself lives in
// actions.js / events.js / render.js and ./ui/*.

import { ackCurrent, actions, loadAll, openInvite, restoreView, setSessionHooks } from "./actions.js";
import { req } from "./api.js";
import { Connection, NightcordError, certTrustUrl, normalizeServerUrl } from "./connection.js";
import { resync, wireEvents } from "./events.js";
import { applyPrefs } from "./prefs.js";
import { ERR, LIMITS, PROTOCOL_VERSION, T } from "./protocol.js";
import { flush, invalidate, setActions } from "./render.js";
import { currentChannel, resetServerState, state } from "./state.js";
import * as store from "./storage.js";
import { $, add, clear, h, setAvatarBase } from "./ui/dom.js";
import { clearPending } from "./uploads.js";
import { setupDropZone } from "./ui/composer.js";
import { legalLinks, legalUpdateModal, renderLegalTabs, showLegalModal } from "./ui/legal.js";
import { closeSearch, searchOpen } from "./ui/search.js";
import { closeFullscreen, closeModal, closePopover, openModal, toast } from "./ui/modals.js";

const IDLE_AFTER_MS = 10 * 60 * 1000;
const BANNED_CLOSE = 4003;

let pendingInvite = null; // ?invite=CODE, opened once logged in

setActions(actions);

// ---------------------------------------------------------------------------
// Screens

function showScreen(which) {
  for (const id of ["connect", "setup", "legal", "auth"]) $(`#screen-${id}`).hidden = which !== id;
  $("#app").hidden = which !== "app";
  if (which !== "app") document.title = "Nightcord";
}

function showConnect({ error = null, prefill = "" } = {}) {
  showScreen("connect");
  const list = clear($("#saved-servers"));
  for (const s of store.getServers()) {
    const remove = h("button", {
      class: "icon-btn", type: "button", title: "Forget this server", "aria-label": `Forget ${s.label}`,
      on: { click: (e) => { e.stopPropagation(); store.removeServer(s.url); showConnect(); } },
    }, "×");
    add(list, h("li", {
      class: "saved-server", tabindex: "0", role: "button",
      on: {
        click: () => connectTo(s.url),
        keydown: (e) => { if (e.key === "Enter") connectTo(s.url); },
      },
    }, h("div", { class: "meta" }, h("div", { class: "name" }, s.label), h("div", { class: "url" }, s.url)), remove));
  }
  const form = $("#connect-form");
  if (prefill) form.address.value = prefill.replace(/^(https?|wss?):\/\//i, "");
  updateScheme();
  const box = $("#connect-error");
  box.hidden = !error;
  if (error) clear(box, error);
}

function connectError(url, err) {
  const parts = [h("div", {}, err.message || "Could not connect.")];
  if (url.startsWith("wss:")) {
    const trust = certTrustUrl(url);
    parts.push(h("p", { class: "small", style: "margin:8px 0 0" },
      "If this server uses a self-signed certificate, open ",
      h("a", { href: trust, target: "_blank", rel: "noopener" }, trust),
      " once, accept the certificate warning, then try again."));
  }
  return parts;
}

// The address field shows the scheme the client will use: https:// (wss)
// normally, http:// (ws) for a local server while the client itself is on http.
function updateScheme() {
  const value = $("#connect-form").address.value.trim();
  let scheme = "https://";
  try {
    if (value && !/^[a-z]+:\/\//i.test(value) && normalizeServerUrl(value).startsWith("ws:")) scheme = "http://";
  } catch { /* invalid so far; keep the default */ }
  if (/^[a-z]+:\/\//i.test(value)) scheme = "";
  $("#connect-scheme").textContent = scheme;
  $("#connect-scheme").hidden = !scheme;
}

// Connecting reveals your IP address to the server owner, so warn first
// (PROTOCOL.md §8b). Resolves true to go ahead.
function ipWarning(url) {
  const host = new URL(url).host;
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; closeModal(); resolve(ok); } };
    openModal({
      title: "Only join servers you trust",
      subtitle: host,
      content: h("div", { class: "stack warning-body" },
        h("p", {}, "Nightcord servers are run by people, not by Nightcord. The owner of this server and its staff can see your ",
          h("strong", {}, "IP address"), " and everything you send there."),
        h("p", { class: "muted small" }, "Connect only if you know who runs it. You'll see this once per server.")),
      actions: [
        h("button", { class: "btn", type: "button", on: { click: () => finish(false) } }, "Cancel"),
        h("button", { class: "btn primary", type: "button", on: { click: () => finish(true) } }, "I trust this server"),
      ],
      onClose: () => finish(false),
    });
  });
}

async function connectTo(input) {
  let url;
  try {
    url = normalizeServerUrl(input);
  } catch (e) {
    showConnect({ error: e.message, prefill: input });
    return;
  }
  if (!store.isTrusted(url) && !(await ipWarning(url))) {
    showConnect({ prefill: input });
    return;
  }
  store.setTrusted(url);
  disconnect();
  const button = $("#connect-form button[type=submit]");
  button.disabled = true;
  button.textContent = "Connecting…";
  const conn = new Connection(url);
  let banned = null;
  conn.on(T.ERROR, (p) => { if (p.code === ERR.IP_BANNED) banned = p.message; });
  try {
    await conn.open();
    state.conn = conn;
    state.url = url;
    state.info = await conn.request(T.SERVER_INFO);
  } catch (e) {
    conn.close();
    state.conn = null;
    showConnect({ error: banned ? banned : connectError(url, e), prefill: input });
    return;
  } finally {
    button.disabled = false;
    button.textContent = "Connect";
  }
  if (state.info.protocol_version && state.info.protocol_version !== PROTOCOL_VERSION) {
    toast(`Server speaks protocol ${state.info.protocol_version}; this client expects ${PROTOCOL_VERSION}. Some things may not work.`, { error: true, ms: 8000 });
  }
  setAvatarBase(url);
  wireEvents(conn);
  wireConnection(conn);
  store.saveServer(url, state.info.server_name);
  store.setLastServer(url);

  if (state.info.setup_required) {
    showSetup();
    return;
  }
  const token = store.getToken(url);
  if (token) {
    try {
      await enterApp(await req(T.AUTH_RESUME, { session_token: token, device_id: store.getDeviceId(url) }));
      return;
    } catch (e) {
      if (e.code === ERR.DEVICE_BANNED) { showAuth({ message: e.message }); return; }
      if (e.code !== ERR.SESSION_EXPIRED) toast(e.message, { error: true });
      store.setToken(url, null);
    }
  }
  if (needsLegal()) showLegal();
  else showAuth();
}

// --- server rules (before creating an account) ---

const needsLegal = () => !!state.info?.legal_version && store.getLegalAccepted(state.url) !== state.info.legal_version;

async function showLegal() {
  showScreen("legal");
  $("#legal-server-name").textContent = state.info.server_name;
  const body = clear($("#legal-body"), h("p", { class: "muted" }, "Loading…"));
  try {
    const docs = await req(T.LEGAL_GET);
    state.info.legal_version = docs.legal_version;
    if (!docs.legal_version) { showAuth(); return; }
    renderLegalTabs(docs, $("#legal-tabs"), body);
  } catch (e) {
    clear(body, h("div", { class: "error-box" }, e.message));
  }
}

async function openLegalDoc(which) {
  try { showLegalModal(await req(T.LEGAL_GET), which); } catch (e) { toast(e.message, { error: true }); }
}

function disconnect() {
  if (state.conn) state.conn.close();
  closeSearch();
  clearPending();
  resetServerState();
  setAvatarBase(null);
  closeModal();
  closePopover();
  closeFullscreen();
}

// --- first-run setup ---

let setupStep = 0;

function showSetup({ message = null } = {}) {
  showScreen("setup");
  $("#setup-server-url").textContent = state.url;
  const form = $("#setup-form");
  if (!form.server_name.value) form.server_name.value = state.info.server_name || "";
  for (const [i, step] of [...form.querySelectorAll(".setup-step")].entries()) step.hidden = i !== setupStep;
  for (const [i, dot] of [...document.querySelectorAll("#setup-steps li")].entries()) {
    dot.classList.toggle("done", i < setupStep);
    dot.setAttribute("aria-current", i === setupStep ? "step" : "false");
  }
  $("#setup-back").hidden = setupStep === 0;
  $("#setup-next").textContent = setupStep === 2 ? "Finish setup" : "Continue";
  const box = $("#setup-message");
  box.hidden = !message;
  box.textContent = message || "";
  form.querySelector(".setup-step:not([hidden]) input, .setup-step:not([hidden]) select")?.focus();
}

async function submitSetup(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const step = form.querySelectorAll(".setup-step")[setupStep];
  for (const input of step.querySelectorAll("input, select")) {
    if (!input.reportValidity()) return;
  }
  if (setupStep === 1) {
    if (!LIMITS.USERNAME_RE.test(form.username.value.trim())) { showSetup({ message: "Username must be 3–32 characters: letters, digits, _ . -" }); return; }
    if (form.password.value !== form.confirm.value) { showSetup({ message: "The passwords don't match." }); return; }
  }
  if (setupStep < 2) {
    setupStep += 1;
    showSetup();
    return;
  }
  const button = $("#setup-next");
  button.disabled = true;
  try {
    const ok = await req(T.SETUP_CLAIM, {
      device_id: store.getDeviceId(state.url),
      setup_code: form.code.value.trim(),
      username: form.username.value.trim(),
      password: form.password.value,
      server_name: form.server_name.value.trim(),
      account_creation: form.account_creation.value,
      guild_creation: form.guild_creation.value,
      guild_list_visible: form.guild_list_visible.checked,
    });
    state.info = await req(T.SERVER_INFO);
    store.saveServer(state.url, state.info.server_name);
    form.reset();
    setupStep = 0;
    await enterApp(ok);
    toast("Your server is ready. Create a guild to get started!");
  } catch (err) {
    if (err.code === ERR.INVALID_SETUP_CODE) setupStep = 0;
    if (err.code === ERR.SETUP_ALREADY_DONE) { state.info.setup_required = false; showAuth({ message: err.message }); return; }
    showSetup({ message: err.message });
  } finally {
    button.disabled = false;
  }
}

// --- auth screen ---

let authMode = "login";

function showAuth({ message = null, info = false } = {}) {
  showScreen("auth");
  $("#auth-server-name").textContent = state.info.server_name;
  $("#auth-server-url").textContent = state.url;
  const policy = state.info.account_creation;
  const modes = [["login", "Log in"]];
  if (policy === "on") modes.push(["register", "Register"]);
  if (policy === "request") modes.push(["request", "Request account"]);
  if (!modes.some(([m]) => m === authMode)) authMode = "login";

  const tabs = clear($("#auth-tabs"));
  tabs.hidden = modes.length < 2;
  for (const [mode, label] of modes) {
    add(tabs, h("button", {
      class: "tab", type: "button", role: "tab", "aria-selected": String(mode === authMode),
      on: { click: () => { authMode = mode; showAuth(); } },
    }, label));
  }
  const form = $("#auth-form");
  form.password.autocomplete = authMode === "login" ? "current-password" : "new-password";
  form.password.maxLength = LIMITS.PASSWORD_MAX_BYTES;
  $("#auth-note-field").hidden = authMode !== "request";
  $("#auth-submit").textContent = { login: "Log in", register: "Create account", request: "Send request" }[authMode];

  const links = legalLinks(state.info, openLegalDoc);
  $("#auth-legal")?.remove();
  if (links) { links.id = "auth-legal"; form.after(links); }

  const box = $("#auth-message");
  if (!message && policy === "off" && authMode === "login") {
    message = "This server isn't accepting new accounts.";
    info = true;
  }
  box.hidden = !message;
  box.classList.toggle("info", !!info);
  box.textContent = message || "";
  (form.username.value ? form.password : form.username).focus();
}

async function submitAuth(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const username = form.username.value.trim();
  const password = form.password.value;
  const button = $("#auth-submit");
  button.disabled = true;
  try {
    if (authMode !== "login" && !LIMITS.USERNAME_RE.test(username)) {
      throw new Error("Username must be 3–32 characters: letters, digits, _ . -");
    }
    const device_id = store.getDeviceId(state.url);
    const accept_legal_version = store.getLegalAccepted(state.url) || undefined;
    if (authMode === "request") {
      await req(T.AUTH_REQUEST_ACCOUNT, { username, password, note: form.note.value.trim() || undefined, device_id, accept_legal_version });
      form.reset();
      authMode = "login";
      showAuth({ message: "Request sent. You can log in once the server owner approves it.", info: true });
      return;
    }
    const ok = authMode === "register"
      ? await req(T.AUTH_REGISTER, { username, password, device_id, accept_legal_version })
      : await req(T.AUTH_LOGIN, { username, password, device_id });
    form.password.value = "";
    await enterApp(ok);
  } catch (err) {
    if (err.code === ERR.LEGAL_REQUIRED) {
      // The documents changed since this device accepted them.
      store.setLegalAccepted(state.url, null);
      state.info = { ...state.info, ...(await req(T.SERVER_INFO).catch(() => ({}))) };
      showLegal();
      return;
    }
    showAuth({ message: err.message });
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// App

async function enterApp({ session_token, user, legal_update_required }) {
  store.setToken(state.url, session_token);
  state.user = user;
  state.users.set(user.user_id, user);
  state.connected = true;
  showScreen("app");
  invalidate();
  flush();
  try {
    await loadAll();
    await restoreView();
  } catch (e) {
    toast(e.message, { error: true });
  }
  if (legal_update_required) await promptLegalUpdate();
  if (pendingInvite) {
    const code = pendingInvite;
    pendingInvite = null;
    openInvite(code);
  }
}

async function promptLegalUpdate() {
  try {
    const docs = await req(T.LEGAL_GET);
    if (!docs.legal_version) return;
    legalUpdateModal(docs, {
      onAccept: async () => {
        const res = await req(T.LEGAL_ACCEPT, { legal_version: docs.legal_version });
        state.user = { ...state.user, ...res.user };
        store.setLegalAccepted(state.url, docs.legal_version);
        closeModal();
      },
      onLogout: () => { closeModal(); logout(); },
    });
  } catch (e) {
    toast(e.message, { error: true });
  }
}

// Back to the login screen on the same connection.
function toLogin(message) {
  const { conn, url, info } = state;
  closeSearch();
  clearPending();
  resetServerState();
  Object.assign(state, { conn, url, info });
  closeModal();
  closePopover();
  closeFullscreen();
  showAuth(message ? { message } : {});
}

async function logout() {
  try { await req(T.AUTH_LOGOUT); } catch { /* the token dies with the session anyway */ }
  store.setToken(state.url, null);
  toLogin();
}

function switchServer() {
  disconnect();
  store.setLastServer(null);
  showConnect();
}

setSessionHooks({
  logout,
  switchServer,
  accountDeleted: () => { store.setToken(state.url, null); toLogin("Your account was deleted."); },
  legalChanged: () => { if (state.user && !state.user.is_server_owner && state.user.legal_version !== state.info.legal_version) promptLegalUpdate(); },
});

function setBanner(text) {
  const el = $("#status-banner");
  el.hidden = !text;
  el.textContent = text || "";
}

function wireConnection(conn) {
  conn.addEventListener("disconnected", (e) => {
    if (conn !== state.conn) return;
    if (e.detail?.code === BANNED_CLOSE) {
      // IP or device ban: don't keep reconnecting.
      conn.close();
      disconnect();
      store.setLastServer(null);
      showConnect({ error: e.detail.reason ? `${e.detail.reason}.` : "You've been banned from this server." });
      return;
    }
    state.connected = false;
    setBanner("Connection lost. Reconnecting…");
    invalidate("composer", "sidebar", "chat");
  });

  conn.addEventListener("reconnecting", (e) => {
    if (conn !== state.conn) return;
    setBanner(`Connection lost. Reconnecting in ${Math.round(e.detail.delay / 1000)}s…`);
  });

  conn.addEventListener("reconnected", async () => {
    if (conn !== state.conn) return;
    try {
      state.info = { ...state.info, ...(await req(T.SERVER_INFO)) };
      if (!state.user) { setBanner(null); return; } // was on the auth screen
      const token = store.getToken(state.url);
      if (!token) throw new NightcordError(ERR.SESSION_EXPIRED, "Please log in again");
      const ok = await req(T.AUTH_RESUME, { session_token: token, device_id: store.getDeviceId(state.url) });
      state.user = ok.user;
      state.connected = true;
      setBanner(null);
      if (state.afk) req(T.PRESENCE_SET, { afk: true }).catch(() => {});
      await resync();
    } catch (e) {
      setBanner(null);
      if (e.code === ERR.SESSION_EXPIRED || e.code === ERR.DEVICE_BANNED) {
        store.setToken(state.url, null);
        toLogin("You were logged out. Please log in again.");
      }
    }
  });
}

// --- auto-idle ---

let lastInput = Date.now();

function markActive() {
  lastInput = Date.now();
  if (state.afk && state.connected) {
    state.afk = false;
    req(T.PRESENCE_SET, { afk: false }).catch(() => {});
    invalidate("sidebar");
  }
}

function checkIdle() {
  if (!state.afk && state.connected && Date.now() - lastInput > IDLE_AFTER_MS) {
    state.afk = true;
    req(T.PRESENCE_SET, { afk: true }).catch(() => {});
    invalidate("sidebar");
  }
}

// ---------------------------------------------------------------------------
// Boot

function boot() {
  applyPrefs();
  matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", applyPrefs);
  $("#connect-form").addEventListener("submit", (e) => {
    e.preventDefault();
    connectTo(e.currentTarget.address.value);
  });
  $("#connect-form").address.addEventListener("input", updateScheme);
  $("#connect-localhost").addEventListener("click", () => {
    const input = $("#connect-form").address;
    input.value = "localhost:8765";
    updateScheme();
    input.focus();
  });
  $("#legal-accept").addEventListener("click", () => {
    store.setLegalAccepted(state.url, state.info.legal_version);
    authMode = state.info.account_creation === "on" ? "register" : state.info.account_creation === "request" ? "request" : "login";
    showAuth();
  });
  $("#legal-decline").addEventListener("click", () => {
    disconnect();
    store.setLastServer(null);
    showConnect({ error: "You need to accept a server's rules to join it." });
  });
  $("#auth-form").addEventListener("submit", submitAuth);
  $("#setup-form").addEventListener("submit", submitSetup);
  $("#setup-back").addEventListener("click", () => { setupStep = Math.max(0, setupStep - 1); showSetup(); });
  for (const id of ["#auth-back", "#setup-cancel", "#legal-back"]) {
    $(id).addEventListener("click", () => {
      disconnect();
      store.setLastServer(null);
      showConnect();
    });
  }
  $("#drawer-scrim").addEventListener("click", () => {
    $("#app").classList.remove("nav-open", "members-open");
    $("#drawer-scrim").hidden = true;
  });
  for (const ev of ["mousemove", "keydown", "mousedown", "touchstart", "wheel"]) {
    window.addEventListener(ev, markActive, { passive: true });
  }
  setInterval(checkIdle, 30 * 1000);
  window.addEventListener("focus", () => { markActive(); ackCurrent(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) ackCurrent(); });
  // Escape closes the search panel / reply bar / inline edit even when focus is elsewhere.
  document.addEventListener("keydown", (e) => {
    if (!state.user || $("#app").hidden) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); actions.showSwitcher(); return; }
    if (mod && e.key.toLowerCase() === "f" && !e.shiftKey && currentChannel()) { e.preventDefault(); actions.showSearch(); return; }
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (searchOpen()) closeSearch();
    else if (state.editingId) actions.cancelEdit();
    else if (state.replyTo) actions.cancelReply();
  });
  setupDropZone();

  // ?server=host:port lets a server operator share a direct link;
  // &invite=CODE opens that guild invite once logged in.
  const params = new URLSearchParams(location.search);
  const param = params.get("server");
  pendingInvite = params.get("invite");
  if (param || pendingInvite) history.replaceState(null, "", location.pathname);
  const last = store.getLastServer();
  showConnect();
  if (param) connectTo(param);
  else if (last) connectTo(last);
}

boot();
