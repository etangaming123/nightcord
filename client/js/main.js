// Nightcord client entry: screens (connect, first-run setup, auth), session
// lifecycle and reconnects (PROTOCOL.md §3). The app itself lives in
// actions.js / events.js / render.js and ./ui/*.

import { ackCurrent, actions, loadAll, openInvite, restoreView, setSessionHooks } from "./actions.js";
import { req } from "./api.js";
import { Connection, NightcordError, certTrustUrl, normalizeServerUrl } from "./connection.js";
import { resync, wireEvents } from "./events.js";
import { applyPrefs } from "./prefs.js";
import { ERR, LIMITS, PROTOCOL_VERSION, T } from "./protocol.js";
import { checkForUpdate } from "./update-check.js";
import { flush, invalidate, setActions } from "./render.js";
import { currentChannel, resetServerState, state } from "./state.js";
import * as store from "./storage.js";
import { $, add, clear, h, setAvatarBase } from "./ui/dom.js";
import { clearPending } from "./uploads.js";
import { setupDropZone } from "./ui/composer.js";
import { legalLinks, legalUpdateModal, renderLegalTabs, showLegalModal } from "./ui/legal.js";
import { closeSearch, searchOpen } from "./ui/search.js";
import { closeFullscreen, closeModal, closePopover, confirmAction, openModal, toast } from "./ui/modals.js";
import { loadStrings, scopedT } from "./strings.js";

const t = scopedT("main");
const tc = scopedT("common");

const IDLE_AFTER_MS = 10 * 60 * 1000;
const BANNED_CLOSE = 4003;

let pendingInvite = null; // ?invite=CODE, opened once logged in
let addingAccount = false; // on the login screen to add another account (not replace one)

setActions(actions);

// ---------------------------------------------------------------------------
// Screens

function showScreen(which) {
  for (const id of ["connect", "setup", "legal", "auth"]) $(`#screen-${id}`).hidden = which !== id;
  $("#app").hidden = which !== "app";
  if (which !== "app") document.title = t("brand");
}

// prefill: what to put back in the address box (only after a real failure,
// so cancelling never rewrites what the user typed).
// tab: force a tab; left out, whichever tab is showing stays put.
function showConnect({ error = null, prefill = null, tab = null } = {}) {
  showScreen("connect");
  const servers = store.getServers();
  const list = clear($("#saved-servers"));
  servers.forEach((s, i) => {
    const remove = h("button", {
      class: "icon-btn", type: "button", title: t("forget_server"), "aria-label": t("forget_server_aria", { label: s.label }),
      on: {
        click: (e) => {
          e.stopPropagation();
          confirmAction(e, {
            title: t("forget_server_title", { label: s.label }),
            message: t("forget_server_body"),
            confirmLabel: t("forget_server"),
            onConfirm: () => { store.removeServer(s.url); showConnect(); },
          });
        },
      },
    }, "×");
    add(list, h("li", {
      class: "saved-server", tabindex: "0", role: "button",
      on: {
        click: () => connectTo(s.url),
        keydown: (e) => { if (e.key === "Enter") connectTo(s.url); },
      },
    }, h("div", { class: "meta" },
      h("div", { class: "name" }, h("span", {}, s.label), i === 0 && servers.length > 1 ? h("span", { class: "pill" }, t("last_used_badge")) : ""),
      h("div", { class: "url" }, s.url,
        store.getAccounts(s.url).length ? ` · ${t("account_count", { count: store.getAccounts(s.url).length })}` : "")), remove));
  });
  $("#saved-empty").hidden = servers.length > 0;
  const form = $("#connect-form");
  // Keep an explicit ws:// or wss:// — the scheme chip only stands in for https.
  if (prefill) form.address.value = /^wss?:\/\//i.test(prefill) ? prefill : prefill.replace(/^https?:\/\//i, "");
  updateScheme();
  setSavedBusy(false);
  const box = $("#connect-error");
  box.hidden = !error;
  if (error) clear(box, error);
  // Neither panel showing yet: this is the first draw, so pick a sensible tab.
  if (tab) setConnectTab(tab);
  else if ($("#tab-new").hidden && $("#tab-saved").hidden) setConnectTab(servers.length ? "saved" : "new");
}

// Saved-server cards can't be clicked while a connection is being set up.
function setSavedBusy(busy) {
  $("#tab-saved").classList.toggle("busy", busy);
  for (const card of $("#saved-servers").querySelectorAll(".saved-server")) {
    card.setAttribute("aria-disabled", String(busy));
    card.tabIndex = busy ? -1 : 0;
  }
}

function setConnectTab(which) {
  const isNew = which === "new";
  $("#tab-btn-new").setAttribute("aria-selected", String(isNew));
  $("#tab-btn-saved").setAttribute("aria-selected", String(!isNew));
  $("#tab-new").hidden = !isNew;
  $("#tab-saved").hidden = isNew;
  $("#connect-submit").hidden = !isNew;
  if (isNew) $("#connect-address").focus();
  else $("#saved-servers").querySelector(".saved-server")?.focus();
}

function connectError(url, err) {
  const parts = [h("div", {}, err.message || t("could_not_connect"))];
  if (url.startsWith("wss:")) {
    const trust = certTrustUrl(url);
    parts.push(h("p", { class: "small", style: "margin:8px 0 0" },
      t("self_signed_before"),
      h("a", { href: trust, target: "_blank", rel: "noopener" }, trust),
      t("self_signed_after")));
  }
  return parts;
}

// The address field shows the scheme the client will use: https:// (wss) by
// default, including for localhost, unless the user types a scheme explicitly.
function updateScheme() {
  const value = $("#connect-form").address.value.trim();
  const scheme = /^[a-z]+:\/\//i.test(value) ? "" : "https://";
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
      title: t("trust_title"),
      subtitle: host,
      content: h("div", { class: "stack warning-body" },
        h("p", {}, t("trust_body_before"),
          h("strong", {}, t("trust_body_ip")), t("trust_body_after")),
        h("p", { class: "muted small" }, t("trust_body_note"))),
      actions: [
        h("button", { class: "btn", type: "button", on: { click: () => finish(false) } }, tc("cancel")),
        h("button", { class: "btn primary", type: "button", on: { click: () => finish(true) } }, t("trust_confirm")),
      ],
      onClose: () => finish(false),
    });
  });
}

// One connection attempt at a time: a second click (or a saved card while the
// form is still trying) would leave the first socket dangling.
let connecting = false;

// addAccount: go to the login screen even if this server has saved accounts.
// fromForm: the address came from the New server box, so a failure is worth
// putting back there; a saved card or a boot-time reconnect never rewrites it.
async function connectTo(input, { addAccount = false, fromForm = false } = {}) {
  if (connecting) return;
  let url;
  try {
    url = normalizeServerUrl(input);
  } catch (e) {
    showConnect({ error: e.message, prefill: fromForm ? input : null, tab: "new" });
    return;
  }
  if (!store.isTrusted(url) && !(await ipWarning(url))) {
    showConnect();
    return;
  }
  store.setTrusted(url);
  disconnect();
  const button = $("#connect-submit");
  const status = $("#connect-status");
  const cancelBtn = $("#connect-cancel");
  const hint = $("#connect-hint");
  const conn = new Connection(url);
  let banned = null;
  let cancelled = false;
  const onCancel = () => { cancelled = true; conn.close(); };
  conn.on(T.ERROR, (p) => { if (p.code === ERR.IP_BANNED) banned = p.message; });
  connecting = true;
  setSavedBusy(true);
  button.disabled = true;
  button.textContent = t("connecting");
  status.hidden = !button.hidden; // only show the status text when the Connect button itself is on the other tab
  status.textContent = t("connecting");
  cancelBtn.hidden = false;
  cancelBtn.onclick = onCancel; // assigned, not added: never stacks up
  const hintTimer = setTimeout(() => { hint.hidden = false; }, 6000);
  try {
    await conn.open();
    state.conn = conn;
    state.url = url;
    state.info = await conn.request(T.SERVER_INFO);
  } catch (e) {
    conn.close();
    state.conn = null;
    // Cancelling is not a failure: leave the box and the tab exactly as they were.
    if (cancelled) showConnect();
    else showConnect({ error: banned ? banned : connectError(url, e), prefill: fromForm ? input : null });
    return;
  } finally {
    connecting = false;
    setSavedBusy(false);
    button.disabled = false;
    button.textContent = t("connect");
    status.hidden = true;
    cancelBtn.hidden = true;
    cancelBtn.onclick = null;
    clearTimeout(hintTimer);
    hint.hidden = true;
  }
  if (state.info.protocol_version && state.info.protocol_version !== PROTOCOL_VERSION) {
    toast(t("protocol_mismatch", { server: state.info.protocol_version, client: PROTOCOL_VERSION }), { error: true, ms: 8000 });
  }
  setAvatarBase(url);
  wireEvents(conn);
  wireConnection(conn);
  store.saveServer(url, state.info.server_name, state.info.max_accounts_per_client);
  store.setLastServer(url);

  if (state.info.setup_required) {
    showSetup();
    return;
  }
  // Resume the active account; if its session died, try the others.
  while (!addAccount && store.getToken(url)) {
    try {
      await enterApp(await req(T.AUTH_RESUME, { session_token: store.getToken(url), device_id: store.getDeviceId(url) }));
      return;
    } catch (e) {
      if (e.code === ERR.DEVICE_BANNED) { showAuth({ message: e.message }); return; }
      if (e.code !== ERR.SESSION_EXPIRED) { toast(e.message, { error: true }); break; }
      store.removeAccount(url);
    }
  }
  addingAccount = addAccount;
  if (needsLegal()) showLegal();
  else showAuth();
}

// --- server rules (before creating an account) ---

const needsLegal = () => !!state.info?.legal_version && store.getLegalAccepted(state.url) !== state.info.legal_version;

async function showLegal() {
  showScreen("legal");
  $("#legal-server-name").textContent = state.info.server_name;
  const body = clear($("#legal-body"), h("p", { class: "muted" }, tc("loading")));
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
  $("#setup-next").textContent = setupStep === 2 ? t("setup_finish") : t("setup_continue");
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
    if (!LIMITS.USERNAME_RE.test(form.username.value.trim())) { showSetup({ message: t("username_requirements") }); return; }
    if (form.password.value !== form.confirm.value) { showSetup({ message: t("passwords_dont_match") }); return; }
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
    store.saveServer(state.url, state.info.server_name, state.info.max_accounts_per_client);
    form.reset();
    setupStep = 0;
    await enterApp(ok);
    toast(t("setup_ready"));
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
  const modes = [["login", t("auth_login_tab")]];
  if (policy === "on") modes.push(["register", t("auth_register_tab")]);
  if (policy === "request") modes.push(["request", t("auth_request_tab")]);
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
  $("#auth-submit").textContent = { login: t("auth_submit_login"), register: t("auth_submit_register"), request: t("auth_submit_request") }[authMode];

  const links = legalLinks(state.info, openLegalDoc);
  $("#auth-legal")?.remove();
  if (links) { links.id = "auth-legal"; form.after(links); }

  const box = $("#auth-message");
  if (!message && addingAccount) {
    message = t("adding_account");
    info = true;
  } else if (!message && policy === "off" && authMode === "login") {
    message = t("accounts_closed");
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
      throw new Error(t("username_requirements"));
    }
    const device_id = store.getDeviceId(state.url);
    const accept_legal_version = store.getLegalAccepted(state.url) || undefined;
    if (authMode === "request") {
      await req(T.AUTH_REQUEST_ACCOUNT, { username, password, note: form.note.value.trim() || undefined, device_id, accept_legal_version });
      form.reset();
      authMode = "login";
      showAuth({ message: t("request_sent"), info: true });
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
  store.saveAccount(state.url, user, session_token);
  addingAccount = false;
  state.user = user;
  state.users.set(user.user_id, user);
  state.connected = true;
  applyPrefs(); // themes depend on this server's customisation settings
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

// Logs the current account out. Another saved account on this server takes
// over if there is one; otherwise it's back to the login screen.
async function logout() {
  try { await req(T.AUTH_LOGOUT); } catch { /* the token dies with the session anyway */ }
  store.removeAccount(state.url, state.user?.user_id);
  if (store.getToken(state.url)) connectTo(state.url);
  else toLogin();
}

function switchServer() {
  disconnect();
  store.setLastServer(null);
  showConnect();
}

// Account switcher (ui/accounts.js). One connection at a time: switching
// reconnects as the other account.
function switchAccount(url, userId) {
  if (url === state.url && userId === state.user?.user_id) return;
  store.setActiveAccount(url, userId);
  connectTo(url);
}

function addAccount(url) {
  connectTo(url, { addAccount: true });
}

// Forget a saved account on this device without switching to it.
function forgetAccount(url, userId) {
  if (url === state.url && userId === state.user?.user_id) { logout(); return; }
  store.removeAccount(url, userId);
  if (url === state.url) store.setActiveAccount(url, state.user?.user_id ?? null);
}

setSessionHooks({
  logout,
  switchServer,
  switchAccount,
  addAccount,
  forgetAccount,
  accountDeleted: () => { store.removeAccount(state.url, state.user?.user_id); toLogin(t("account_deleted")); },
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
      showConnect({ error: e.detail.reason ? t("ban_reason", { reason: e.detail.reason }) : t("banned_generic") });
      return;
    }
    state.connected = false;
    setBanner(t("reconnecting"));
    invalidate("composer", "sidebar", "chat");
  });

  conn.addEventListener("reconnecting", (e) => {
    if (conn !== state.conn) return;
    setBanner(t("reconnecting_in", { seconds: Math.round(e.detail.delay / 1000) }));
  });

  conn.addEventListener("reconnected", async () => {
    if (conn !== state.conn) return;
    try {
      state.info = { ...state.info, ...(await req(T.SERVER_INFO)) };
      if (!state.user) { setBanner(null); return; } // was on the auth screen
      const token = store.getToken(state.url);
      if (!token) throw new NightcordError(ERR.SESSION_EXPIRED, t("please_log_in_again"));
      const ok = await req(T.AUTH_RESUME, { session_token: token, device_id: store.getDeviceId(state.url) });
      state.user = ok.user;
      state.connected = true;
      applyPrefs();
      setBanner(null);
      if (state.afk) req(T.PRESENCE_SET, { afk: true }).catch(() => {});
      await resync();
    } catch (e) {
      setBanner(null);
      if (e.code === ERR.SESSION_EXPIRED || e.code === ERR.DEVICE_BANNED) {
        store.removeAccount(state.url, state.user?.user_id);
        toLogin(t("logged_out"));
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

function hydrateStatic() {
  const ts = scopedT("shell");
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = ts(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = ts(el.dataset.i18nPlaceholder);
  for (const el of document.querySelectorAll("[data-i18n-aria-label]")) el.setAttribute("aria-label", ts(el.dataset.i18nAriaLabel));
  for (const el of document.querySelectorAll("[data-i18n-title]")) el.title = ts(el.dataset.i18nTitle);
}

async function boot() {
  await loadStrings();
  hydrateStatic();
  applyPrefs();
  checkForUpdate(); // standalone-only, local pref-gated; see update-check.js
  matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", applyPrefs);
  $("#connect-form").addEventListener("submit", (e) => {
    e.preventDefault();
    connectTo(e.currentTarget.address.value, { fromForm: true });
  });
  $("#connect-form").address.addEventListener("input", updateScheme);
  $("#tab-btn-new").addEventListener("click", () => setConnectTab("new"));
  $("#tab-btn-saved").addEventListener("click", () => setConnectTab("saved"));
  $("#saved-empty-cta").addEventListener("click", () => setConnectTab("new"));
  $("#whats-this").addEventListener("click", () => {
    const ts = scopedT("shell");
    openModal({
      title: t("whats_this_title"),
      content: h("p", {}, ts("whats_this_body")),
      actions: [h("button", { class: "btn primary", type: "button", on: { click: closeModal } }, tc("close"))],
    });
  });
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
    showConnect({ error: t("must_accept_rules"), tab: "saved" });
  });
  $("#auth-form").addEventListener("submit", submitAuth);
  $("#setup-form").addEventListener("submit", submitSetup);
  $("#setup-back").addEventListener("click", () => { setupStep = Math.max(0, setupStep - 1); showSetup(); });
  for (const id of ["#auth-back", "#setup-cancel", "#legal-back"]) {
    $(id).addEventListener("click", () => {
      // Backing out of "add account": return to the account you were using.
      if (addingAccount && store.getToken(state.url)) { connectTo(state.url); return; }
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
