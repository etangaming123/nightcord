// Nightcord client controller: screens, state and protocol flow
// (PROTOCOL.md §3). Rendering lives in ./ui/*.

import { Connection, NightcordError, certTrustUrl, normalizeServerUrl } from "./connection.js";
import { ERR, LIMITS, PROTOCOL_VERSION, T } from "./protocol.js";
import * as store from "./storage.js";
import { $, clear, h } from "./ui/dom.js";
import { closeModal, toast } from "./ui/modals.js";
import { renderChannelSidebar, renderRail } from "./ui/sidebar.js";
import { renderChat, appendMessage, renderComposer, renderChatHeader, scrollToBottom } from "./ui/chat.js";
import { renderMembers } from "./ui/members.js";
import * as dialogs from "./ui/dialogs.js";

// ---------------------------------------------------------------------------
// State

const state = {
  url: null, // canonical ws(s)://…/ws of the connected server
  conn: null,
  info: null, // server.info.result
  user: null,
  guilds: new Map(), // guild_id -> Guild (+ ghost)
  guildId: null,
  channels: [], // of current guild, sorted
  channelId: null,
  members: [], // of current guild (non-ghost)
  online: new Set(),
  messages: [], // of current channel, oldest first
  messageIds: new Set(),
  hasMore: false,
  loadingOlder: false,
  connected: false,
};

export const getState = () => state;

const currentGuild = () => state.guilds.get(state.guildId) || null;
const currentChannel = () => state.channels.find((c) => c.channel_id === state.channelId) || null;
const isGuildOwner = () => {
  const g = currentGuild();
  return !!g && !g.ghost && g.owner_user_id === state.user?.user_id;
};

function req(type, payload) {
  if (!state.conn) return Promise.reject(new NightcordError(ERR.DISCONNECTED, "Not connected"));
  return state.conn.request(type, payload);
}

// ---------------------------------------------------------------------------
// Screens

function showScreen(which) {
  $("#screen-connect").hidden = which !== "connect";
  $("#screen-auth").hidden = which !== "auth";
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
    list.append(h("li", {
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
  if (state.info.protocol_version && state.info.protocol_version.split(".")[0] !== PROTOCOL_VERSION.split(".")[0]) {
    toast(`Server speaks protocol ${state.info.protocol_version}; this client expects ${PROTOCOL_VERSION}.`, { error: true, ms: 8000 });
  }
  wireEvents(conn);
  store.saveServer(url, state.info.server_name);
  store.setLastServer(url);

  const token = store.getToken(url);
  if (token) {
    try {
      const ok = await req(T.AUTH_RESUME, { session_token: token });
      await enterApp(ok);
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
  Object.assign(state, {
    conn: null, url: null, info: null, user: null, guilds: new Map(), guildId: null,
    channels: [], channelId: null, members: [], online: new Set(), messages: [],
    messageIds: new Set(), hasMore: false, connected: false,
  });
  closeModal();
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
    tabs.append(h("button", {
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
  state.connected = true;
  showScreen("app");
  renderAll();
  await loadGuilds();
  const last = store.getLast(state.url);
  const target = state.guilds.has(last.guildId) ? last.guildId : state.guilds.keys().next().value;
  if (target) await openGuild(target);
  else renderAll();
}

async function loadGuilds() {
  const { guilds } = await req(T.GUILD_LIST);
  state.guilds = new Map(guilds.map((g) => [g.guild_id, g]));
  renderRail(state, actions);
}

async function openGuild(guildId) {
  if (!state.guilds.has(guildId)) return;
  if (state.channelId && state.conn?.isOpen) req(T.CHANNEL_LEAVE, { channel_id: state.channelId }).catch(() => {});
  state.guildId = guildId;
  state.channelId = null;
  state.channels = [];
  state.members = [];
  state.online = new Set();
  resetMessages();
  store.setLast(state.url, { guildId });
  renderAll();
  try {
    const [ch, mem, pres] = await Promise.all([
      req(T.CHANNEL_LIST, { guild_id: guildId }),
      req(T.GUILD_MEMBERS, { guild_id: guildId }),
      req(T.PRESENCE_LIST, { guild_id: guildId }),
    ]);
    if (state.guildId !== guildId) return;
    state.channels = sortChannels(ch.channels);
    state.members = mem.members;
    state.online = new Set(pres.online_user_ids);
  } catch (e) {
    toast(e.message, { error: true });
    return;
  }
  renderAll();
  const remembered = (store.getLast(state.url).channels || {})[guildId];
  const target = state.channels.find((c) => c.channel_id === remembered) || state.channels[0];
  if (target) await openChannel(target.channel_id);
}

function sortChannels(list) {
  return [...list].sort((a, b) => a.position - b.position || (a.channel_id.length - b.channel_id.length) || (a.channel_id < b.channel_id ? -1 : 1));
}

function resetMessages() {
  state.messages = [];
  state.messageIds = new Set();
  state.hasMore = false;
  state.loadingOlder = false;
}

async function openChannel(channelId) {
  state.channelId = channelId;
  resetMessages();
  const last = store.getLast(state.url);
  store.setLast(state.url, { channels: { ...(last.channels || {}), [state.guildId]: channelId } });
  document.body.querySelector("#app").classList.remove("nav-open");
  $("#drawer-scrim").hidden = true;
  renderAll();
  try {
    await req(T.CHANNEL_JOIN, { channel_id: channelId });
    const page = await req(T.CHANNEL_HISTORY, { channel_id: channelId, limit: LIMITS.HISTORY_PAGE });
    if (state.channelId !== channelId) return;
    // Live messages may have arrived between join and history; merge.
    const live = state.messages;
    resetMessages();
    for (const m of [...page.messages, ...live]) addMessage(m);
    state.hasMore = page.has_more;
  } catch (e) {
    toast(e.message, { error: true });
  }
  renderChat(state, actions);
  scrollToBottom();
}

function addMessage(m) {
  if (state.messageIds.has(m.message_id)) return false;
  state.messageIds.add(m.message_id);
  state.messages.push(m);
  return true;
}

async function loadOlder() {
  if (state.loadingOlder || !state.hasMore || !state.messages.length) return;
  const channelId = state.channelId;
  state.loadingOlder = true;
  try {
    const page = await req(T.CHANNEL_HISTORY, {
      channel_id: channelId,
      before_message_id: state.messages[0].message_id,
      limit: LIMITS.HISTORY_PAGE,
    });
    if (state.channelId !== channelId) return;
    const older = page.messages.filter((m) => !state.messageIds.has(m.message_id));
    older.forEach((m) => state.messageIds.add(m.message_id));
    state.messages = [...older, ...state.messages];
    state.hasMore = page.has_more;
    renderChat(state, actions);
  } catch (e) {
    toast(e.message, { error: true });
  } finally {
    state.loadingOlder = false;
  }
}

async function sendMessage(content) {
  const channelId = state.channelId;
  const res = await req(T.MESSAGE_SEND, { channel_id: channelId, content });
  return res.message_id;
}

function renderAll() {
  renderRail(state, actions);
  renderChannelSidebar(state, actions, { isOwner: isGuildOwner() });
  renderChatHeader(state, actions);
  renderChat(state, actions);
  renderComposer(state, actions);
  renderMembers(state);
  const g = currentGuild();
  const c = currentChannel();
  document.title = c && g ? `#${c.name} · ${g.name} — Nightcord` : g ? `${g.name} — Nightcord` : "Nightcord";
}

// ---------------------------------------------------------------------------
// Live events

function wireEvents(conn) {
  conn.on(T.MESSAGE_NEW, (m) => {
    if (m.channel_id !== state.channelId) return;
    if (addMessage(m)) appendMessage(state, m);
  });

  conn.on(T.PRESENCE_UPDATE, ({ guild_id, user_id, status }) => {
    if (guild_id !== state.guildId) return;
    if (status === "online") state.online.add(user_id);
    else state.online.delete(user_id);
    renderMembers(state);
  });

  conn.on(T.GUILD_MEMBER_JOINED, ({ guild_id, member }) => {
    if (guild_id !== state.guildId) return;
    if (!state.members.some((m) => m.user_id === member.user_id)) state.members.push(member);
    renderMembers(state);
  });

  conn.on(T.GUILD_MEMBER_LEFT, ({ guild_id, user_id }) => {
    if (guild_id !== state.guildId) return;
    state.members = state.members.filter((m) => m.user_id !== user_id);
    state.online.delete(user_id);
    renderMembers(state);
  });

  conn.on(T.GUILD_UPDATED, (guild) => {
    const existing = state.guilds.get(guild.guild_id);
    if (!existing) return;
    state.guilds.set(guild.guild_id, { ...existing, ...guild });
    renderAll();
  });

  conn.on(T.CHANNEL_CREATED, (ch) => {
    if (ch.guild_id !== state.guildId || state.channels.some((c) => c.channel_id === ch.channel_id)) return;
    state.channels = sortChannels([...state.channels, ch]);
    renderChannelSidebar(state, actions, { isOwner: isGuildOwner() });
  });

  conn.on(T.CHANNEL_UPDATED, (ch) => {
    if (ch.guild_id !== state.guildId) return;
    state.channels = sortChannels(state.channels.map((c) => (c.channel_id === ch.channel_id ? ch : c)));
    renderAll();
  });

  conn.on(T.CHANNEL_DELETED, ({ guild_id, channel_id }) => {
    if (guild_id !== state.guildId) return;
    state.channels = state.channels.filter((c) => c.channel_id !== channel_id);
    if (state.channelId === channel_id) {
      toast("This channel was deleted.");
      if (state.channels[0]) openChannel(state.channels[0].channel_id);
      else { state.channelId = null; resetMessages(); renderAll(); }
    } else {
      renderChannelSidebar(state, actions, { isOwner: isGuildOwner() });
    }
  });

  conn.addEventListener("disconnected", () => {
    if (conn !== state.conn) return;
    state.connected = false;
    setBanner("Connection lost. Reconnecting…");
    renderComposer(state, actions);
  });

  conn.addEventListener("reconnecting", (e) => {
    if (conn !== state.conn) return;
    setBanner(`Connection lost. Reconnecting in ${Math.round(e.detail.delay / 1000)}s…`);
  });

  conn.addEventListener("reconnected", async () => {
    if (conn !== state.conn) return;
    const token = store.getToken(state.url);
    try {
      if (!token) throw new NightcordError(ERR.SESSION_EXPIRED, "Please log in again");
      const ok = await req(T.AUTH_RESUME, { session_token: token });
      state.user = ok.user;
      state.connected = true;
      setBanner(null);
      await loadGuilds();
      const guildId = state.guilds.has(state.guildId) ? state.guildId : state.guilds.keys().next().value;
      if (guildId) await openGuild(guildId);
      else renderAll();
    } catch (e) {
      setBanner(null);
      if (e.code === ERR.SESSION_EXPIRED) {
        store.setToken(state.url, null);
        showAuth({ message: "Your session expired. Please log in again." });
      }
    }
  });
}

function setBanner(text) {
  const el = $("#status-banner");
  el.hidden = !text;
  el.textContent = text || "";
}

// ---------------------------------------------------------------------------
// Actions exposed to views

const actions = {
  openGuild,
  openChannel,
  loadOlder,
  sendMessage,
  isGuildOwner,

  switchServer() {
    const url = state.url;
    disconnect();
    showConnect({ prefill: "" });
    if (url) store.setLastServer(null);
  },

  async logout() {
    try { await req(T.AUTH_LOGOUT); } catch { /* token dies with the session anyway */ }
    store.setToken(state.url, null);
    state.user = null;
    state.guilds = new Map();
    state.guildId = null;
    showAuth();
  },

  toggleNav(open) {
    const app = $("#app");
    const next = open ?? !app.classList.contains("nav-open");
    app.classList.toggle("nav-open", next);
    app.classList.remove("members-open");
    $("#drawer-scrim").hidden = !next;
  },

  toggleMembers() {
    const app = $("#app");
    const next = !app.classList.contains("members-open");
    app.classList.toggle("members-open", next);
    app.classList.remove("nav-open");
    $("#drawer-scrim").hidden = !next;
  },

  // --- dialogs ---
  addGuild: () => dialogs.addGuildDialog(state, {
    create: async (name) => {
      const res = await req(T.GUILD_CREATE, { name });
      state.guilds.set(res.guild.guild_id, res.guild);
      await openGuild(res.guild.guild_id);
    },
    joinByCode: async (code) => {
      const res = await req(T.GUILD_JOIN_BY_CODE, { invite_code: code });
      state.guilds.set(res.guild.guild_id, res.guild);
      await openGuild(res.guild.guild_id);
    },
    loadPublic: async () => (await req(T.GUILD_PUBLIC_LIST)).guilds,
    joinById: async (guildId) => {
      const res = await req(T.GUILD_JOIN_BY_ID, { guild_id: guildId });
      state.guilds.set(res.guild.guild_id, res.guild);
      await openGuild(res.guild.guild_id);
    },
  }),

  guildSettings: () => dialogs.guildSettingsDialog(currentGuild(), state.info, {
    save: async (patch) => {
      const res = await req(T.GUILD_CONFIG_UPDATE, { guild_id: state.guildId, ...patch });
      state.guilds.set(res.guild.guild_id, { ...currentGuild(), ...res.guild });
      renderAll();
    },
    createInvite: async () => (await req(T.GUILD_INVITE_CREATE, { guild_id: state.guildId })).invite_code,
  }),

  leaveGuild: () => dialogs.leaveGuildDialog(currentGuild(), async () => {
    const guildId = state.guildId;
    await req(T.GUILD_LEAVE, { guild_id: guildId });
    state.guilds.delete(guildId);
    state.guildId = null;
    state.channelId = null;
    resetMessages();
    const next = state.guilds.keys().next().value;
    if (next) await openGuild(next);
    else renderAll();
  }),

  createChannel: () => dialogs.channelNameDialog({
    title: "Create channel",
    submitLabel: "Create",
    onSubmit: async (name) => {
      const res = await req(T.CHANNEL_CREATE, { guild_id: state.guildId, name });
      if (!state.channels.some((c) => c.channel_id === res.channel.channel_id)) {
        state.channels = sortChannels([...state.channels, res.channel]);
      }
      await openChannel(res.channel.channel_id);
    },
  }),

  renameChannel: (channel) => dialogs.channelNameDialog({
    title: "Rename channel",
    submitLabel: "Save",
    initial: channel.name,
    onSubmit: async (name) => {
      const res = await req(T.CHANNEL_UPDATE, { channel_id: channel.channel_id, name });
      state.channels = sortChannels(state.channels.map((c) => (c.channel_id === res.channel.channel_id ? res.channel : c)));
      renderAll();
    },
  }),

  moveChannel: async (channel, delta) => {
    // Swap positions with the neighbour; renumber so positions are unique.
    const list = [...state.channels];
    const i = list.findIndex((c) => c.channel_id === channel.channel_id);
    const j = i + delta;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    try {
      for (const [pos, c] of list.entries()) {
        if (c.position !== pos) await req(T.CHANNEL_UPDATE, { channel_id: c.channel_id, position: pos });
      }
    } catch (e) {
      toast(e.message, { error: true });
    }
  },

  deleteChannel: (channel) => dialogs.deleteChannelDialog(channel, async () => {
    await req(T.CHANNEL_DELETE, { channel_id: channel.channel_id });
  }),

  serverSettings: () => dialogs.serverSettingsDialog(state.info, {
    save: async (patch) => {
      const res = await req(T.SERVER_CONFIG_UPDATE, patch);
      state.info = { ...state.info, ...res.config };
    },
    overrideJoin: async (guildId) => {
      const res = await req(T.GUILD_OWNER_OVERRIDE_JOIN, { guild_id: guildId });
      state.guilds.set(res.guild.guild_id, res.guild);
      await openGuild(res.guild.guild_id);
    },
  }),
};

// ---------------------------------------------------------------------------
// Boot

function boot() {
  $("#connect-form").addEventListener("submit", (e) => {
    e.preventDefault();
    connectTo(e.currentTarget.address.value);
  });
  $("#auth-form").addEventListener("submit", submitAuth);
  $("#auth-back").addEventListener("click", () => {
    disconnect();
    store.setLastServer(null);
    showConnect();
  });
  $("#drawer-scrim").addEventListener("click", () => {
    $("#app").classList.remove("nav-open", "members-open");
    $("#drawer-scrim").hidden = true;
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
