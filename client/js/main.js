// Nightcord client entry: screens (connect, first-run setup, auth), session
// lifecycle and reconnects (PROTOCOL.md §3). The app itself lives in
// actions.js / events.js / render.js and ./ui/*.

import { ackCurrent, actions, loadAll, restoreView, setSessionHooks } from "./actions.js";
import { req } from "./api.js";
import { Connection, NightcordError, certTrustUrl, normalizeServerUrl } from "./connection.js";
import { resync, wireEvents } from "./events.js";
import { applyPrefs } from "./prefs.js";
import { ERR, LIMITS, PROTOCOL_VERSION, T } from "./protocol.js";
import { flush, invalidate, setActions } from "./render.js";
import { resetServerState, state } from "./state.js";
import * as store from "./storage.js";
import { $, add, clear, h, setAvatarBase } from "./ui/dom.js";
import { closeFullscreen, closeModal, closePopover, toast } from "./ui/modals.js";

const IDLE_AFTER_MS = 10 * 60 * 1000;

setActions(actions);

// ---------------------------------------------------------------------------
// Screens

function showScreen(which) {
  for (const id of ["connect", "setup", "auth"]) $(`#screen-${id}`).hidden = which !== id;
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
  if (prefill) form.address.value = prefill;
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

async function connectTo(input) {
  let url;
  try {
    url = normalizeServerUrl(input);
  } catch (e) {
    showConnect({ error: e.message, prefill: input });
    return;
  }
  disconnect();
  const button = $("#connect-form button");
  button.disabled = true;
  button.textContent = "Connecting…";
  const conn = new Connection(url);
  try {
    await conn.open();
    state.conn = conn;
    state.url = url;
    state.info = await conn.request(T.SERVER_INFO);
  } catch (e) {
    conn.close();
    state.conn = null;
    showConnect({ error: connectError(url, e), prefill: input });
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
      await enterApp(await req(T.AUTH_RESUME, { session_token: token }));
      return;
    } catch (e) {
      if (e.code !== ERR.SESSION_EXPIRED) toast(e.message, { error: true });
      store.setToken(url, null);
    }
  }
  showAuth();
}

function disconnect() {
  if (state.conn) state.conn.close();
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
    if (authMode === "request") {
      await req(T.AUTH_REQUEST_ACCOUNT, { username, password, note: form.note.value.trim() || undefined });
      form.reset();
      authMode = "login";
      showAuth({ message: "Request sent. You can log in once the server owner approves it.", info: true });
      return;
    }
    const type = authMode === "register" ? T.AUTH_REGISTER : T.AUTH_LOGIN;
    const ok = await req(type, { username, password });
    form.password.value = "";
    await enterApp(ok);
  } catch (err) {
    showAuth({ message: err.message });
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// App

async function enterApp({ session_token, user }) {
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
}

// Back to the login screen on the same connection.
function toLogin(message) {
  const { conn, url, info } = state;
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

setSessionHooks({ logout, switchServer });

function setBanner(text) {
  const el = $("#status-banner");
  el.hidden = !text;
  el.textContent = text || "";
}

function wireConnection(conn) {
  conn.addEventListener("disconnected", () => {
    if (conn !== state.conn) return;
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
      const ok = await req(T.AUTH_RESUME, { session_token: token });
      state.user = ok.user;
      state.connected = true;
      setBanner(null);
      if (state.afk) req(T.PRESENCE_SET, { afk: true }).catch(() => {});
      await resync();
    } catch (e) {
      setBanner(null);
      if (e.code === ERR.SESSION_EXPIRED) {
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
  $("#auth-form").addEventListener("submit", submitAuth);
  $("#setup-form").addEventListener("submit", submitSetup);
  $("#setup-back").addEventListener("click", () => { setupStep = Math.max(0, setupStep - 1); showSetup(); });
  for (const id of ["#auth-back", "#setup-cancel"]) {
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
  // Escape closes the reply bar / inline edit even when focus is elsewhere.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !state.user || e.defaultPrevented) return;
    if (state.editingId) actions.cancelEdit();
    else if (state.replyTo) actions.cancelReply();
  });

  // ?server=host:port lets a server operator share a direct link.
  const param = new URLSearchParams(location.search).get("server");
  if (param) history.replaceState(null, "", location.pathname);
  const last = store.getLastServer();
  showConnect();
  if (param) connectTo(param);
  else if (last) connectTo(last);
}

boot();
