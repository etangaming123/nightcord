// Nightcord client entry: screens (connect, first-run setup, auth), session
// lifecycle and reconnects (PROTOCOL.md §3). The app itself lives in
// actions.js / events.js / render.js and ./ui/*.

import { ackCurrent, actions, loadAll, openInvite, restoreView, setSessionHooks } from "./actions.js";
import { req } from "./api.js";
import { Connection, NightcordError, certTrustUrl, normalizeServerUrl } from "./connection.js";
import { resync, wireEvents } from "./events.js";
import { applyPrefs, getPrefs, setPrefs } from "./prefs.js";
import { restoreReminders } from "./reminders.js";
import { ERR, LIMITS, PROTOCOL_VERSION, T } from "./protocol.js";
import { checkForUpdate, getUpdateInfo, onUpdateInfo, RELEASES_URL } from "./update-check.js";
import { handleShortcut, shouldFocusComposer } from "./shortcuts.js";
import { flush, invalidate, setActions } from "./render.js";
import { currentChannel, isThisServer, resetServerState, state } from "./state.js";
import * as store from "./storage.js";
import { $, add, clear, h, setAvatarBase, setStampPrefs, setUrlResolver } from "./ui/dom.js";
import { render as renderMarkdown } from "./ui/markdown.js";
import { clearPending } from "./uploads.js";
import { focusComposer, setupDropZone } from "./ui/composer.js";
import { legalLinks, legalUpdateModal, renderLegalTabs, showLegalModal } from "./ui/legal.js";
import { closeSearch, searchOpen } from "./ui/search.js";
import { decodeInvite, parseMessageLink, setInviteLinkHandler, setMessageLinkHandler, setupLinkGuard } from "./ui/links.js";
import { setupGestures } from "./ui/gestures.js";
import * as router from "./router.js";
import { setFaviconBadge } from "./ui/favicon.js";
import { closeFullscreen, closeModal, closePopover, confirmAction, fullscreenOpen, modalOpen, openModal, popoverOpen, toast } from "./ui/modals.js";
import { loadStrings, scopedT } from "./strings.js";
import { icon } from "./ui/icons.js";

const t = scopedT("main");
const tc = scopedT("common");

const IDLE_AFTER_MS = 10 * 60 * 1000;
// Three hours of use with no real break. It's a parody app; it can afford one
// joke that's also good advice.
const GRASS_AFTER_MS = 3 * 60 * 60 * 1000;
const GRASS_SNOOZE_MS = 60 * 60 * 1000;
const BANNED_CLOSE = 4003;

let pendingInvite = null; // ?invite=CODE, opened once logged in
let pendingJump = null; // ?jump=…/…/…, a message link opened once logged in
let pendingRoute = null; // the address the page opened on (router.js), shown once logged in
let addingAccount = false; // on the login screen to add another account (not replace one)

setActions(actions);

// ---------------------------------------------------------------------------
// Screens

let currentScreen = "connect";
let updateFloatDismissed = false; // this session only, like the Inbox card

function showScreen(which) {
  for (const id of ["connect", "setup", "legal", "auth"]) $(`#screen-${id}`).hidden = which !== id;
  $("#app").hidden = which !== "app";
  currentScreen = which;
  renderUpdateFloat();
  if (which !== "app") {
    document.title = t("brand");
    setFaviconBadge(0);
    router.clear();
  }
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
  if (preview && input === PREVIEW_URL) { connectPreview({ addAccount }); return; }
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
  status.textContent = t("connecting_to", { host: new URL(url).host });
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
  await joinServer(conn, url, { addAccount });
}

// After the socket is up and server.info is in: log in (or show the screens
// that come first). Shared by real servers and the preview.
async function joinServer(conn, url, { addAccount = false } = {}) {
  wireEvents(conn);
  wireConnection(conn);
  store.saveServer(url, state.info.server_name, state.info.max_accounts_per_client);
  if (!preview) store.setLastServer(url);

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

// --- preview (client/js/preview): the app against a pretend server in this tab ---

// The standalone build leaves the preview out (scripts/build-standalone.mjs).
const PREVIEW_AVAILABLE = !globalThis.__NIGHTCORD_LANG__;
const PREVIEW_URL = "wss://preview.nightcord.invalid/ws";
let preview = null; // { server, activity, resolveUrl, sessionFor, connect } while it runs

function choosePreview() {
  const tp = scopedT("ui/preview");
  const option = (role, iconName) => h("button", {
    class: "preview-role", type: "button",
    on: { click: () => { closeModal(); startPreview(role); } },
  }, icon(iconName), h("span", { class: "preview-role-text" },
    h("strong", {}, tp(`role_${role}`)), h("span", { class: "muted small" }, tp(`role_${role}_hint`))));
  openModal({
    title: tp("picker_title"),
    subtitle: tp("picker_subtitle"),
    content: h("div", { class: "preview-roles" }, option("owner", "crown"), option("member", "user")),
    actions: [h("button", { class: "btn", type: "button", on: { click: closeModal } }, tc("cancel"))],
  });
}

async function startPreview(role) {
  if (preview || connecting) return;
  disconnect();
  store.setVolatile(true);
  const mod = await import("./preview/index.js");
  preview = mod.createPreview();
  // Both sample accounts are signed in, so the account switcher can hop
  // between the owner's view and a member's. The chosen one goes last: it's
  // the active account.
  for (const r of role === "owner" ? ["member", "owner"] : ["owner", "member"]) {
    const { token, user } = preview.sessionFor(r);
    store.saveAccount(PREVIEW_URL, user, token);
  }
  store.setLegalAccepted(PREVIEW_URL, "preview1");
  store.setLast(PREVIEW_URL, { view: "home" }); // open on the Home page
  store.setTrusted(PREVIEW_URL);
  preview.activity.start();
  await connectPreview();
}

async function connectPreview({ addAccount = false } = {}) {
  disconnect();
  const conn = preview.connect();
  await conn.open();
  state.conn = conn;
  state.url = PREVIEW_URL;
  state.info = await conn.request(T.SERVER_INFO);
  setUrlResolver(preview.resolveUrl);
  renderPreviewBar();
  await joinServer(conn, PREVIEW_URL, { addAccount });
}

// Leaving throws everything away: a reload without ?preview.
function exitPreview() {
  location.href = router.APP_BASE;
}

function renderPreviewBar() {
  const bar = $("#preview-bar");
  bar.hidden = !preview;
  document.body.classList.toggle("has-preview-bar", !!preview);
  if (!preview) return;
  const tp = scopedT("ui/preview");
  const activity = h("input", {
    type: "checkbox", class: "switch", checked: preview.activity.on,
    on: { change: (e) => (e.target.checked ? preview.activity.start() : preview.activity.stop()) },
  });
  const roleBtn = (role, iconName) => {
    const account = store.getAccounts(PREVIEW_URL).find((a) => a.username === (role === "owner" ? "you" : "guest"));
    const current = !!account && account.user_id === state.user?.user_id;
    return h("button", {
      class: `preview-seg ${current ? "on" : ""}`, type: "button", "aria-pressed": String(current),
      title: tp(`view_as_${role}`),
      on: { click: () => { if (account && !current) switchAccount(PREVIEW_URL, account.user_id); } },
    }, icon(iconName), h("span", { class: "preview-bar-label" }, tp(`role_${role}`)));
  };
  clear(bar);
  add(bar,
    h("span", { class: "preview-tag" }, icon("eye"), tp("tag")),
    h("span", { class: "preview-note" }, tp("note")),
    h("span", { class: "preview-spacer" }),
    h("span", { class: "preview-segs", role: "group", "aria-label": tp("view_as") }, roleBtn("owner", "crown"), roleBtn("member", "user")),
    h("label", { class: "preview-toggle", title: tp("activity_hint") }, activity, h("span", { class: "preview-bar-label" }, tp("activity"))),
    h("button", {
      class: "btn small", type: "button", title: tp("reset_hint"),
      on: {
        click: (e) => confirmAction(e, {
          title: tp("reset_title"), message: tp("reset_body"), confirmLabel: tp("reset"),
          onConfirm: () => { location.href = `${router.APP_BASE}?preview=${state.user?.is_server_owner ? "owner" : "member"}`; },
        }),
      },
    }, icon("refresh-cw"), h("span", { class: "preview-bar-label" }, tp("reset"))),
    h("button", { class: "btn small primary", type: "button", on: { click: exitPreview } }, icon("log-out"), h("span", { class: "preview-bar-label" }, tp("exit"))));
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
  setUrlResolver(null);
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
  const desc = state.info.server_description || "";
  clear($("#auth-server-desc"), desc ? renderMarkdown(desc, { plainLinks: true }) : null);
  $("#auth-server-desc").hidden = !desc;
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
  const notice = clear($("#auth-notice"));
  add(notice, t({ login: "auth_notice_login", register: "auth_notice_register", request: "auth_notice_request" }[authMode], { server: state.info.server_name }));
  const other = modes.find(([m]) => m !== authMode);
  if (other) {
    add(notice, " ", h("button", {
      class: "btn link", type: "button",
      on: { click: () => { authMode = other[0]; showAuth(); } },
    }, t({ login: "auth_switch_login", register: "auth_switch_register", request: "auth_switch_request" }[other[0]])));
  }
  const form = $("#auth-form");
  form.password.autocomplete = authMode === "login" ? "current-password" : "new-password";
  form.password.maxLength = LIMITS.PASSWORD_MAX_BYTES;
  $("#auth-note-field").hidden = authMode !== "request";
  const confirmField = $("#auth-confirm-field");
  confirmField.hidden = authMode !== "register";
  form.password2.required = authMode === "register";
  form.password2.maxLength = LIMITS.PASSWORD_MAX_BYTES;
  if (confirmField.hidden) form.password2.value = "";
  form.dispatchEvent(new Event("nightcord:authmode"));
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

// Show/hide eyes on the password fields, plus live hints so mistakes show up
// as you type rather than after Submit.
function setupAuthFields(form) {
  for (const input of form.querySelectorAll('input[type="password"]')) {
    const eye = h("button", { class: "icon-btn pw-toggle", type: "button", title: t("show_password"), "aria-label": t("show_password"), "aria-pressed": "false" }, icon("eye"));
    eye.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      const label = t(show ? "hide_password" : "show_password");
      eye.title = label;
      eye.setAttribute("aria-label", label);
      eye.setAttribute("aria-pressed", String(show));
    });
    const wrap = h("span", { class: "pw-field" });
    input.replaceWith(wrap);
    add(wrap, input, eye);
  }
  const usernameHint = $("#auth-username-hint");
  const confirmHint = $("#auth-confirm-hint");
  const check = () => {
    const name = form.username.value.trim();
    usernameHint.hidden = authMode === "login";
    usernameHint.classList.toggle("bad", !!name && !LIMITS.USERNAME_RE.test(name));
    confirmHint.hidden = authMode !== "register" || !form.password2.value || form.password2.value === form.password.value;
  };
  for (const field of [form.username, form.password, form.password2]) field.addEventListener("input", check);
  form.addEventListener("nightcord:authmode", check);
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
    if (authMode === "register" && password !== form.password2.value) {
      form.password2.focus();
      throw new Error(t("passwords_dont_match"));
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
    form.password2.value = "";
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
  if (preview) renderPreviewBar();
  applyPrefs(); // themes depend on this server's customisation settings
  restoreReminders(); // /remind survives a reload (client/js/reminders.js)
  showScreen("app");
  invalidate();
  flush();
  try {
    await loadAll();
    const route = pendingRoute;
    pendingRoute = null;
    // User settings open over wherever you were last.
    if (route?.kind === "settings") await restoreView();
    if (!(await router.apply(route))) await restoreView();
  } catch (e) {
    toast(e.message, { error: true });
  }
  router.start();
  if (legal_update_required) await promptLegalUpdate();
  if (pendingInvite) {
    const code = pendingInvite;
    pendingInvite = null;
    openInvite(code);
  }
  if (pendingJump) {
    const jump = pendingJump;
    pendingJump = null;
    actions.jumpTo(jump.messageId, jump.channelId, jump.guildId);
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
  else if (preview) exitPreview();
  else toLogin();
}

function switchServer() {
  if (preview) { exitPreview(); return; }
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
// When the current unbroken stretch started. Going idle counts as a break.
let activeSince = Date.now();
let grassDue = Date.now() + GRASS_AFTER_MS;
let grassOpen = false;

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
    // A real break: the clock starts again when they come back.
    activeSince = Date.now();
    grassDue = Date.now() + GRASS_AFTER_MS;
  }
  checkGrass();
}

function checkGrass() {
  if (grassOpen || state.afk || !state.user || !getPrefs().touchGrass) return;
  if (Date.now() < grassDue || modalOpen()) return;
  grassOpen = true;
  const hours = Math.max(1, Math.round((Date.now() - activeSince) / 3600000));
  const close = (snooze) => {
    grassOpen = false;
    closeModal();
    grassDue = Date.now() + snooze;
    activeSince = Date.now();
  };
  openModal({
    title: t("grass_title"),
    content: h("div", { class: "stack" },
      h("p", {}, t("grass_body", { hours })),
      h("p", { class: "muted small" }, t("grass_note"))),
    actions: [
      h("button", { class: "btn", type: "button", on: { click: () => close(GRASS_SNOOZE_MS) } }, t("grass_snooze")),
      h("button", { class: "btn primary", type: "button", on: { click: () => close(GRASS_AFTER_MS) } }, t("grass_done")),
    ],
    onClose: () => close(GRASS_SNOOZE_MS),
  });
}

// ---------------------------------------------------------------------------
// Boot

// Connect and login already carry the big banner; everywhere else (chat,
// setup, rules) gets this small floating reminder.
function renderUpdateFloat() {
  const box = $("#update-float");
  const info = getUpdateInfo();
  box.hidden = !info || updateFloatDismissed || currentScreen === "connect" || currentScreen === "auth";
  document.body.classList.toggle("has-update-float", !box.hidden);
  if (box.hidden) return;
  const tn = scopedT("notify");
  clear(box);
  add(box,
    h("span", {}, tn("update_float_text", { latest: info.latest })),
    h("a", { class: "btn small primary", href: RELEASES_URL, target: "_blank", rel: "noopener" }, tn("update_banner_cta")),
    h("button", { class: "icon-btn", type: "button", title: tn("update_float_dismiss"), "aria-label": tn("update_float_dismiss"),
      on: { click: () => { updateFloatDismissed = true; renderUpdateFloat(); } } }, icon("x")));
}

function renderUpdateBanner() {
  renderUpdateFloat();
  const tn = scopedT("notify");
  const info = getUpdateInfo();
  for (const box of document.querySelectorAll(".update-banner")) {
    box.hidden = !info;
    if (!info) continue;
    clear(box);
    add(box,
      h("strong", {}, tn("update_banner_title", { latest: info.latest })),
      h("p", {}, tn("update_banner_body", { current: info.current })),
      h("a", { class: "btn primary", href: RELEASES_URL, target: "_blank", rel: "noopener" }, tn("update_banner_cta")));
  }
}

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
  setStampPrefs(getPrefs);
  applyPrefs();
  onUpdateInfo(renderUpdateBanner);
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
  const reconnect = $("#auto-reconnect");
  reconnect.checked = getPrefs().autoReconnect;
  reconnect.addEventListener("change", () => setPrefs({ autoReconnect: reconnect.checked }));
  $("#whats-this").addEventListener("click", () => {
    const ts = scopedT("shell");
    openModal({
      title: t("whats_this_title"),
      content: h("div", { class: "whats-this-body" },
        h("p", {}, ts("whats_this_body")),
        h("ul", {}, ["servers", "accounts", "data", "start"].map((k) => h("li", {}, ts(`whats_this_point_${k}`)))),
        h("p", {}, h("a", { href: "https://github.com/etangaming123/nightcord#readme", target: "_blank", rel: "noopener" }, ts("whats_this_more")))),
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
  setupAuthFields($("#auth-form"));
  $("#setup-form").addEventListener("submit", submitSetup);
  $("#setup-back").addEventListener("click", () => { setupStep = Math.max(0, setupStep - 1); showSetup(); });
  for (const id of ["#auth-back", "#setup-cancel", "#legal-back"]) {
    $(id).addEventListener("click", () => {
      // Backing out of "add account": return to the account you were using.
      if (addingAccount && store.getToken(state.url)) { connectTo(state.url); return; }
      if (preview) { exitPreview(); return; }
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
  // One handler for the whole shortcut table (client/js/shortcuts.js), plus
  // the Escape ladder, which has to know what else is open.
  document.addEventListener("keydown", (e) => {
    if (!state.user || $("#app").hidden || e.defaultPrevented) return;
    if (e.key === "Escape") {
      if (modalOpen() || popoverOpen() || fullscreenOpen()) return; // they close themselves
      if (searchOpen()) { closeSearch(); return; }
      if (state.editingId) { actions.cancelEdit(); return; }
      if (state.replyTo) { actions.cancelReply(); return; }
      // Nothing left to close: Esc marks read, Shift+Esc the whole guild.
      if (actions.markCurrentRead({ guild: e.shiftKey })) e.preventDefault();
      return;
    }
    if (handleShortcut(e, actions)) return;
    // Start typing anywhere and the message box takes it.
    if (shouldFocusComposer(e) && currentChannel()) focusComposer();
  });
  setupDropZone();
  setupLinkGuard();
  setupGestures(actions);
  router.setupRouter(actions, { invalidate });
  // Message and invite links pasted into a message open in place, if they're
  // for this server.
  setMessageLinkHandler((jump) => {
    if (!state.user || !isThisServer(jump.server)) return false;
    actions.jumpTo(jump.messageId, jump.channelId, jump.guildId);
    return true;
  });
  setInviteLinkHandler((invite) => {
    if (!state.user || !isThisServer(invite.server)) return false;
    actions.openInvite(invite.code);
    return true;
  });

  // ?server=host:port lets a server operator share a direct link;
  // &invite=CODE (or /app/invite/…) opens that guild invite once logged in;
  // &jump=<guild|@me>/<channel>/<message> opens a message link.
  // ?preview opens the preview (the homepage links here); ?preview=owner or
  // ?preview=member skips the question.
  const params = new URLSearchParams(location.search);
  let param = params.get("server");
  const previewParam = PREVIEW_AVAILABLE && params.has("preview") ? params.get("preview") : null;
  pendingInvite = params.get("invite");
  pendingJump = parseMessageLink(location.href);
  // /app/servers/…, /app/invite/CODE and friends (router.js).
  pendingRoute = router.initialRoute();
  if (pendingRoute?.kind === "invite") {
    // /app/invite/<token> carries the server too (ui/links.js encodeInvite).
    const token = param ? null : decodeInvite(pendingRoute.code);
    pendingInvite = token ? token.code : pendingRoute.code;
    if (token) param = token.server;
    pendingRoute = null;
  }
  if (pendingJump) pendingRoute = null;
  if (param || pendingInvite || pendingJump || previewParam !== null || location.pathname !== router.APP_BASE) {
    history.replaceState(null, "", router.ENABLED ? router.APP_BASE : location.pathname);
  }
  $("#connect-preview-box").hidden = !PREVIEW_AVAILABLE;
  $("#connect-preview").addEventListener("click", () => choosePreview());
  const last = store.getLastServer();
  showConnect();
  if (previewParam !== null) {
    if (previewParam === "owner" || previewParam === "member") startPreview(previewParam);
    else choosePreview();
  } else if (param) connectTo(param);
  else if (last && getPrefs().autoReconnect) connectTo(last);
}

boot();
