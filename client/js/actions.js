// Everything the views can ask for: navigation, loading, messaging, menus,
// settings and moderation. Views get this object as `actions`.

import { req } from "./api.js";
import { ERR, LIMITS, PERMS, T } from "./protocol.js";
import { invalidate } from "./render.js";
import {
  can, channelTree, currentChannel, currentGuild, ensureReadState, isDm, isGuildOwner, isStaff, isUnread, markRead,
  memberById, nameOf, pref, rememberUser, resetMessages, sortChannels, staffLevel, state, userById,
} from "./state.js";
import * as store from "./storage.js";
import { clearPending, readyAttachments } from "./uploads.js";
import { adminModeration } from "./ui/admin.js";
import { channelSettings } from "./ui/channelSettings.js";
import { flashMessage, isNearBottom, renderTyping } from "./ui/chat.js";
import { clearDraft, focusComposer, fromWire, toWire } from "./ui/composer.js";
import * as dialogs from "./ui/dialogs.js";
import { $, displayName, h, idGt } from "./ui/dom.js";
import { openEmojiPicker } from "./ui/emoji.js";
import { guildSettings } from "./ui/guildSettings.js";
import { render as renderMarkdown } from "./ui/markdown.js";
import { closeFullscreen, closeModal, confirmModal, fullscreenOpen, openMenu, openModal, refreshFullscreen, toast } from "./ui/modals.js";
import { inviteDialog, invitePreview } from "./ui/invites.js";
import { openPins } from "./ui/pins.js";
import { copyText, openProfile } from "./ui/profile.js";
import { openSearch } from "./ui/search.js";
import { userSettings } from "./ui/settings.js";
import { openSwitcher } from "./ui/switcher.js";

const fail = (e) => toast(e.message, { error: true });

// --- loading ---------------------------------------------------------------

export async function loadAll() {
  const [g, d, r, n] = await Promise.all([
    req(T.GUILD_LIST), req(T.DM_LIST), req(T.READ_STATE_LIST), req(T.NOTIFY_PREFS_GET),
  ]);
  state.guilds = new Map(g.guilds.map((x) => [x.guild_id, x]));
  state.dms = new Map(d.channels.map((c) => [c.channel_id, c]));
  for (const c of d.channels) c.recipients.forEach(rememberUser);
  state.readStates = new Map(r.read_states.map((s) => [s.channel_id, s]));
  state.notifyPrefs = new Map(n.prefs.map((p) => [p.target_id, p]));
  if (isStaff(1)) {
    req(T.ADMIN_USERS_LIST, { status: "pending" }).then(({ users }) => {
      state.pendingAccounts = users.length;
      invalidate("sidebar");
    }).catch(() => {});
  }
  const partners = [...new Set(d.channels.flatMap((c) => c.recipients.map((u) => u.user_id)))].filter((id) => id !== state.user.user_id);
  if (partners.length) {
    req(T.PRESENCE_LIST, { user_ids: partners.slice(0, 200) }).then(({ presences }) => {
      for (const [id, s] of Object.entries(presences)) state.presences.set(id, s);
      invalidate("sidebar", "header", "members");
    }).catch(() => {});
  }
  invalidate();
}

export async function restoreView() {
  const last = store.getLast(state.url);
  if (last.view === "home") return openHome(last.dmId);
  const target = state.guilds.has(last.guildId) ? last.guildId : state.guilds.keys().next().value;
  if (target) return openGuild(target);
  return openHome();
}

function closeNavDrawer() {
  $("#app").classList.remove("nav-open");
  $("#drawer-scrim").hidden = !$("#app").classList.contains("members-open");
}

export async function openGuild(guildId, channelId = null) {
  if (!state.guilds.has(guildId)) return;
  const sameGuild = state.view === "guild" && state.guildId === guildId && state.channels.length;
  state.view = "guild";
  if (!sameGuild) {
    state.guildId = guildId;
    state.channelId = null;
    state.channels = [];
    state.members = [];
    state.roles = [];
    resetMessages();
    store.setLast(state.url, { view: "guild", guildId });
    invalidate();
    try {
      await reloadGuild(guildId);
    } catch (e) {
      fail(e);
      return;
    }
    if (state.guildId !== guildId || state.view !== "guild") return;
  }
  const remembered = channelId || (store.getLast(state.url).channels || {})[guildId];
  const texts = state.channels.filter((c) => c.kind === "text");
  const target = texts.find((c) => c.channel_id === remembered) || firstText() || texts[0];
  if (target) await openChannel(target.channel_id);
  else invalidate();
}

async function reloadGuild(guildId) {
  const [ch, mem, roles, pres] = await Promise.all([
    req(T.CHANNEL_LIST, { guild_id: guildId }),
    req(T.GUILD_MEMBERS, { guild_id: guildId }),
    req(T.ROLE_LIST, { guild_id: guildId }),
    req(T.PRESENCE_LIST, { guild_id: guildId }),
  ]);
  if (state.guildId !== guildId) return;
  state.channels = sortChannels(ch.channels);
  state.voice = new Map((ch.voice_states || []).map((v) => [v.user_id, v]));
  state.members = mem.members;
  mem.members.forEach((m) => rememberUser(m.user));
  state.roles = roles.roles;
  for (const [id, s] of Object.entries(pres.presences)) state.presences.set(id, s);
  for (const c of ch.channels) ensureReadState(c);
  invalidate();
}

// The first text channel in sidebar order.
function firstText() {
  const tree = channelTree();
  return [...tree.loose, ...tree.categories.flatMap((c) => c.channels)].find((c) => c.kind === "text");
}

export async function reloadRoles() {
  if (!state.guildId) return;
  state.roles = (await req(T.ROLE_LIST, { guild_id: state.guildId })).roles;
  invalidate("chat", "members");
}

export async function openHome(dmId = null) {
  const switching = state.view !== "home";
  state.view = "home";
  state.guildId = null;
  state.channels = [];
  state.members = [];
  state.roles = [];
  store.setLast(state.url, { view: "home" });
  const target = dmId && state.dms.has(dmId) ? dmId : switching ? store.getLast(state.url).dmId : state.channelId;
  if (target && state.dms.has(target)) {
    await openChannel(target);
  } else {
    state.channelId = null;
    resetMessages();
    closeNavDrawer();
    invalidate();
  }
}

export const openDm = (channelId) => (state.view === "home" ? openChannel(channelId) : openHome(channelId));

// Open a channel of the current view (guild channel or DM).
export async function openChannel(channelId, { around = null } = {}) {
  const prevId = state.channelId;
  if (prevId !== channelId) clearPending();
  state.channelId = channelId;
  resetMessages();
  const channel = currentChannel();
  if (!channel) return;
  if (channel.kind === "voice") { joinVoice(channel); return; }
  if (channel.kind === "category") return;
  if (state.view === "guild") {
    const last = store.getLast(state.url);
    store.setLast(state.url, { channels: { ...(last.channels || {}), [state.guildId]: channelId } });
  } else {
    store.setLast(state.url, { dmId: channelId });
  }
  const rs = ensureReadState(channel);
  if (isUnread(channelId) && rs.last_read_id) {
    state.unreadMarker = rs.last_read_id;
    state.scrollTo = "unread";
  } else {
    state.scrollTo = "bottom";
  }
  closeNavDrawer();
  invalidate();
  try {
    await req(T.CHANNEL_JOIN, { channel_id: channelId });
    if (can("READ_HISTORY", channel)) {
      const page = await req(T.CHANNEL_HISTORY, around
        ? { channel_id: channelId, around_message_id: around, limit: LIMITS.HISTORY_PAGE }
        : { channel_id: channelId, limit: LIMITS.HISTORY_PAGE });
      if (state.channelId !== channelId) return;
      // Live messages may have arrived between join and history; merge.
      const live = around && page.has_more_after ? [] : state.messages;
      state.messages = [];
      state.messageIds = new Set();
      for (const m of [...page.messages, ...live]) addMessage(m);
      state.hasMore = page.has_more;
      state.hasMoreAfter = !!page.has_more_after;
    }
  } catch (e) {
    if (state.channelId === channelId) fail(e);
  }
  if (state.channelId !== channelId) return;
  if (around) {
    state.unreadMarker = null;
    state.scrollTo = null;
    invalidate("chat", "composer");
    requestAnimationFrame(() => requestAnimationFrame(() => flashMessage(around)));
  } else {
    state.scrollTo = state.unreadMarker ? "unread" : "bottom";
    invalidate("chat");
    ackCurrent(true);
  }
  if (prevId !== channelId) setTimeout(focusComposer);
}

// Newer messages after jumping into the past.
export async function loadNewer() {
  if (state.loadingOlder || !state.hasMoreAfter || !state.messages.length) return;
  const channelId = state.channelId;
  state.loadingOlder = true;
  try {
    const page = await req(T.CHANNEL_HISTORY, {
      channel_id: channelId, after_message_id: state.messages.at(-1).message_id, limit: LIMITS.HISTORY_PAGE,
    });
    if (state.channelId !== channelId) return;
    page.messages.forEach(addMessage);
    state.hasMoreAfter = page.has_more_after;
    invalidate("chat");
  } catch (e) {
    fail(e);
  } finally {
    state.loadingOlder = false;
  }
}

export async function jumpToPresent() {
  const id = state.channelId;
  state.channelId = null;
  if (state.view === "guild") await openGuild(state.guildId, id);
  else await openChannel(id);
}

export async function loadOlder() {
  if (state.loadingOlder || !state.hasMore || !state.messages.length) return;
  const channelId = state.channelId;
  state.loadingOlder = true;
  try {
    const page = await req(T.CHANNEL_HISTORY, {
      channel_id: channelId, before_message_id: state.messages[0].message_id, limit: LIMITS.HISTORY_PAGE,
    });
    if (state.channelId !== channelId) return;
    const older = page.messages.filter((m) => !state.messageIds.has(m.message_id));
    older.forEach((m) => { state.messageIds.add(m.message_id); rememberUser(m.author); });
    state.messages = [...older, ...state.messages];
    state.hasMore = page.has_more;
    state.scrollTo = "prepend";
    invalidate("chat");
  } catch (e) {
    fail(e);
  } finally {
    state.loadingOlder = false;
  }
}

// --- read state ----------------------------------------------------------------

let ackTimer = null;

// Mark the open channel read up to its newest message, if the user can see it.
export function ackCurrent(force = false) {
  const ch = currentChannel();
  if (!ch || !state.connected) return;
  if (!force && (document.hidden || !document.hasFocus() || !isNearBottom())) return;
  const rs = ensureReadState(ch);
  const latest = state.messages.at(-1)?.message_id || rs.last_message_id;
  if (!latest || (!idGt(latest, rs.last_read_id) && !rs.mention_count)) return;
  markRead(ch.channel_id, latest);
  invalidate("rail", "sidebar", "title");
  clearTimeout(ackTimer);
  ackTimer = setTimeout(() => {
    req(T.CHANNEL_ACK, { channel_id: ch.channel_id, message_id: latest }).catch(() => {});
  }, 400);
}

export function seenBottom() {
  if (state.unreadMarker && !isUnread(state.channelId)) return;
  ackCurrent();
}

export async function markGuildRead(guildId) {
  for (const rs of state.readStates.values()) {
    if (rs.guild_id === guildId && isUnread(rs.channel_id)) {
      markRead(rs.channel_id, rs.last_message_id);
      req(T.CHANNEL_ACK, { channel_id: rs.channel_id, message_id: rs.last_message_id }).catch(() => {});
    }
  }
  invalidate("rail", "sidebar", "title");
}

export function markChannelRead(channelId) {
  const rs = state.readStates.get(channelId);
  if (!rs?.last_message_id) return;
  markRead(channelId, rs.last_message_id);
  req(T.CHANNEL_ACK, { channel_id: channelId, message_id: rs.last_message_id }).catch(() => {});
  invalidate("rail", "sidebar", "title");
}

// --- messages --------------------------------------------------------------------

export function addMessage(m) {
  if (state.messageIds.has(m.message_id)) return false;
  rememberUser(m.author);
  state.messageIds.add(m.message_id);
  state.messages.push(m);
  return true;
}

export function updateMessage(m) {
  const i = state.messages.findIndex((x) => x.message_id === m.message_id);
  if (i < 0) return false;
  state.messages[i] = m;
  return true;
}

export function removeMessage(id) {
  if (!state.messageIds.has(id)) return false;
  state.messageIds.delete(id);
  state.messages = state.messages.filter((m) => m.message_id !== id);
  for (const m of state.messages) if (m.reply_to?.message_id === id) m.reply_to = null;
  if (state.editingId === id) state.editingId = null;
  if (state.replyTo?.message_id === id) { state.replyTo = null; invalidate("composer"); }
  return true;
}

export function applyReaction({ message_id, emoji, user_id }, added) {
  const m = state.messages.find((x) => x.message_id === message_id);
  if (!m) return false;
  const r = m.reactions.find((x) => x.emoji === emoji);
  if (added) {
    if (r) { if (!r.user_ids.includes(user_id)) r.user_ids.push(user_id); } else m.reactions.push({ emoji, user_ids: [user_id] });
  } else if (r) {
    r.user_ids = r.user_ids.filter((u) => u !== user_id);
    if (!r.user_ids.length) m.reactions = m.reactions.filter((x) => x !== r);
  }
  return true;
}

function startSlowmode(channel, seconds) {
  if (!seconds) return;
  state.slowmodeUntil.set(channel.channel_id, Date.now() + seconds * 1000);
  invalidate("composer");
}

export async function sendMessage(content, reply) {
  const channelId = state.channelId;
  const channel = currentChannel();
  const payload = { channel_id: channelId, content };
  if (reply) {
    payload.reply_to_id = reply.message_id;
    payload.mention_reply = state.replyPing;
  }
  if (state.pending.length) payload.attachment_ids = await readyAttachments();
  let res;
  try {
    res = await req(T.MESSAGE_SEND, payload);
  } catch (e) {
    if (e.code === ERR.SLOWMODE) startSlowmode(channel, e.data.retry_after);
    throw e;
  }
  if (state.channelId === channelId) {
    clearPending();
    if (channel.slowmode_seconds && !can("MANAGE_MESSAGES", channel) && !can("MANAGE_CHANNELS", channel)) {
      startSlowmode(channel, channel.slowmode_seconds);
    }
    if (state.hasMoreAfter) { jumpToPresent(); return res.message_id; }
    if (addMessage(res.message)) invalidate("chat");
    state.scrollTo = "bottom";
    state.unreadMarker = null;
    state.replyTo = null;
    clearDraft(channelId);
    invalidate("chat", "composer");
    const rs = state.readStates.get(channelId);
    if (rs) { rs.last_message_id = res.message_id; markRead(channelId, res.message_id); }
  }
  return res.message_id;
}

export const typing = (channelId) => req(T.TYPING_START, { channel_id: channelId }).catch(() => {});

export function reply(m) {
  state.replyTo = m;
  state.replyPing = true;
  invalidate("composer");
  setTimeout(focusComposer);
}

export function cancelReply() {
  state.replyTo = null;
  invalidate("composer");
}

export const rerenderComposer = () => invalidate("composer");

export function startEdit(m) {
  state.editingId = m.message_id;
  state.editDraft = fromWire(m.content);
  invalidate("chat");
}

export function cancelEdit() {
  state.editingId = null;
  state.editDraft = "";
  invalidate("chat");
  setTimeout(focusComposer);
}

export async function saveEdit(m, text) {
  const content = toWire(text.trim());
  if (!content) {
    cancelEdit();
    deleteMessage(m);
    return;
  }
  if (content === m.content) { cancelEdit(); return; }
  try {
    const res = await req(T.MESSAGE_EDIT, { message_id: m.message_id, content });
    updateMessage(res.message);
    cancelEdit();
  } catch (e) {
    fail(e);
  }
}

export function deleteMessage(m, skipConfirm = false) {
  const run = () => req(T.MESSAGE_DELETE, { message_id: m.message_id }).then(() => {
    if (removeMessage(m.message_id)) invalidate("chat");
  });
  if (skipConfirm) { run().catch(fail); return; }
  confirmModal({
    title: "Delete message?",
    message: "This can't be undone. Tip: hold Shift while clicking delete to skip this.",
    confirmLabel: "Delete",
    onConfirm: run,
  });
}

export const react = (m, emoji) => req(T.REACTION_ADD, { message_id: m.message_id, emoji }).catch(fail);
export const unreact = (m, emoji) => req(T.REACTION_REMOVE, { message_id: m.message_id, emoji }).catch(fail);

export function pickReaction(m, anchor) {
  openEmojiPicker(anchor, (emoji) => {
    const mine = m.reactions?.find((r) => r.emoji === emoji)?.user_ids.includes(state.user.user_id);
    if (!mine) react(m, emoji);
  }, { placement: "left" });
}

// Scroll to a message, loading the history around it if needed.
export async function jumpTo(messageId, channelId = state.channelId, guildId = undefined) {
  if (channelId === state.channelId && flashMessage(messageId)) return;
  if (guildId && (state.view !== "guild" || state.guildId !== guildId)) await openGuild(guildId, null);
  else if (guildId === null && state.view !== "home") { await openHome(); }
  closeModal();
  await openChannel(channelId, { around: messageId });
}

export const pinMessage = (m) => req(T.MESSAGE_PIN, { message_id: m.message_id }).then(() => toast("Pinned"), fail);
export const unpinMessage = (m) => req(T.MESSAGE_UNPIN, { message_id: m.message_id }).then(() => toast("Unpinned"), fail);
export const showPins = (anchor) => openPins(anchor, actions);
export const showSearch = (initial) => openSearch(actions, initial);
export const showSwitcher = () => openSwitcher(actions);

export function showTopic(channel) {
  openModal({
    title: `#${channel.name}`,
    content: h("div", { class: "topic-full" }, renderMarkdown(channel.topic || "", { user: userById })),
  });
}

export function expireTyping() {
  const now = Date.now();
  let changed = false;
  for (const [uid, until] of state.typing) if (until <= now) { state.typing.delete(uid); changed = true; }
  if (changed) renderTyping(state);
}

// --- navigation chrome -------------------------------------------------------------

export function toggleNav(open) {
  const app = $("#app");
  const next = open ?? !app.classList.contains("nav-open");
  app.classList.toggle("nav-open", next);
  app.classList.remove("members-open");
  $("#drawer-scrim").hidden = !next;
}

export function toggleMembers() {
  const app = $("#app");
  if (matchMedia("(min-width: 1101px)").matches) {
    app.classList.toggle("members-hidden");
    return;
  }
  const next = !app.classList.contains("members-open");
  app.classList.toggle("members-open", next);
  app.classList.remove("nav-open");
  $("#drawer-scrim").hidden = !next;
}

export const refreshChrome = () => invalidate("rail", "sidebar", "title");

// --- users & profiles --------------------------------------------------------------

export { rememberUser, req };

export function setSelf(user) {
  state.user = { ...state.user, ...user };
  rememberUser(user);
  invalidate();
}

export function setServerInfo(config) {
  state.info = { ...state.info, ...config };
  store.saveServer(state.url, state.info.server_name);
  invalidate("rail", "sidebar", "title");
}

export const openProfileAction = (userId, anchor, opts) => openProfile(userId, anchor, actions, opts);

export async function messageUser(userId) {
  try {
    const { channel } = await req(T.DM_OPEN, { user_id: userId });
    state.dms.set(channel.channel_id, channel);
    channel.recipients.forEach(rememberUser);
    ensureReadState(channel);
    closeFullscreen();
    await openHome(channel.channel_id);
  } catch (e) {
    fail(e);
  }
}

export function statusMenu(anchor) {
  const cur = state.user.presence;
  const set = (status) => req(T.PRESENCE_SET, { status }).then(() => {
    state.user.presence = status;
    invalidate("sidebar", "members", "header");
  }).catch(fail);
  openMenu(anchor, [
    { label: "Online", icon: "🟢", checked: cur === "online", onClick: () => set("online") },
    { label: "Idle", icon: "🌙", checked: cur === "idle", onClick: () => set("idle") },
    { label: "Do Not Disturb", icon: "⛔", hint: "Mutes notifications", checked: cur === "dnd", onClick: () => set("dnd") },
    { label: "Invisible", icon: "⚪", hint: "Appear offline", checked: cur === "invisible", onClick: () => set("invisible") },
    "-",
    {
      label: state.user.custom_status ? "Edit custom status" : "Set custom status", icon: "💬",
      onClick: () => dialogs.customStatusDialog(state.user.custom_status, async (text) => {
        setSelf((await req(T.USER_UPDATE, { custom_status: text || null })).user);
      }),
    },
    state.user.custom_status ? {
      label: "Clear custom status", icon: "✕",
      onClick: async () => { try { setSelf((await req(T.USER_UPDATE, { custom_status: null })).user); } catch (e) { fail(e); } },
    } : null,
    { label: "Edit profile", icon: "✎", onClick: () => openUserSettings("profile") },
    { label: "Copy user ID", icon: "🆔", onClick: () => copyText(state.user.user_id, "User ID copied") },
  ], { placement: "top" });
}

export const openUserSettings = (section) => userSettings(actions, section);

// --- guilds ------------------------------------------------------------------------

function joined(guild) {
  state.guilds.set(guild.guild_id, guild);
  return req(T.READ_STATE_LIST).then(({ read_states }) => {
    state.readStates = new Map(read_states.map((s) => [s.channel_id, s]));
  }).catch(() => {}).then(() => openGuild(guild.guild_id));
}

export const addGuild = () => dialogs.addGuildDialog(state, {
  create: async (name) => joined((await req(T.GUILD_CREATE, { name })).guild),
  joinByCode: async (code) => joined((await req(T.GUILD_JOIN_BY_CODE, { invite_code: code })).guild),
  loadPublic: async () => (await req(T.GUILD_PUBLIC_LIST)).guilds,
  joinById: async (guildId) => joined((await req(T.GUILD_JOIN_BY_ID, { guild_id: guildId })).guild),
});

export async function ghostJoin(guildId) {
  await joined((await req(T.GUILD_OWNER_OVERRIDE_JOIN, { guild_id: guildId })).guild);
  toast("Joined as a ghost. Members can't see you, and you can't post.");
}

export async function updateGuild(patch) {
  const res = await req(T.GUILD_CONFIG_UPDATE, { guild_id: state.guildId, ...patch });
  state.guilds.set(res.guild.guild_id, { ...state.guilds.get(res.guild.guild_id), ...res.guild });
  invalidate();
}

export const createInvite = async (opts = {}) => (await req(T.GUILD_INVITE_CREATE, { guild_id: state.guildId, ...opts })).invite;

// A link that opens this client, connects to this server and shows the invite.
export function inviteLink(code) {
  const server = new URL(state.url).host;
  return `${location.origin}${location.pathname}?server=${encodeURIComponent(server)}&invite=${encodeURIComponent(code)}`;
}

export const openInviteDialog = () => inviteDialog(actions);

export async function openInvite(code) {
  try {
    const preview = await req(T.GUILD_INVITE_RESOLVE, { invite_code: code });
    invitePreview(preview, {
      onJoin: async () => {
        if (preview.is_member) { await openGuild(preview.guild.guild_id); return; }
        await joined((await req(T.GUILD_JOIN_BY_CODE, { invite_code: code })).guild);
      },
    });
  } catch (e) {
    toast(e.code === ERR.INVITE_EXPIRED ? "That invite has expired." : e.message, { error: true });
  }
}

export async function setGuildIcon(dataB64) {
  const res = await req(T.GUILD_ICON_SET, { guild_id: state.guildId, data_b64: dataB64 });
  state.guilds.set(res.guild.guild_id, { ...state.guilds.get(res.guild.guild_id), ...res.guild });
  invalidate("rail", "sidebar");
}

export function forgetGuild(guildId) {
  state.guilds.delete(guildId);
  for (const [id, rs] of state.readStates) if (rs.guild_id === guildId) state.readStates.delete(id);
  if (state.view === "guild" && state.guildId === guildId) {
    closeFullscreen();
    state.guildId = null;
    state.channelId = null;
    resetMessages();
    const next = state.guilds.keys().next().value;
    if (next) openGuild(next);
    else openHome();
  }
  invalidate();
}

export const leaveGuild = (guild = currentGuild()) => dialogs.leaveGuildDialog(guild, async () => {
  await req(T.GUILD_LEAVE, { guild_id: guild.guild_id });
  forgetGuild(guild.guild_id);
});

export const openGuildSettings = (section) => guildSettings(actions, section);

const hasGuildSettings = () => ["MANAGE_GUILD", "MANAGE_ROLES", "KICK_MEMBERS", "BAN_MEMBERS", "MODERATE_MEMBERS", "CREATE_INVITE", "VIEW_AUDIT_LOG"].some((f) => can(f)) || isGuildOwner();

function levelItems(targetId, { inherit }) {
  const p = pref(targetId);
  const set = (patch) => setNotifyPref(targetId, { level: p.level, muted: p.muted, ...patch });
  return [
    { heading: "Notifications" },
    inherit ? { label: inherit, checked: !p.level, onClick: () => set({ level: null }) } : null,
    { label: "All messages", checked: p.level === "all" || (!inherit && !p.level), onClick: () => set({ level: "all" }) },
    { label: "Only @mentions", checked: p.level === "mentions", onClick: () => set({ level: "mentions" }) },
    { label: "Nothing", checked: p.level === "none", onClick: () => set({ level: "none" }) },
  ];
}

export async function setNotifyPref(targetId, { level, muted }) {
  try {
    const res = await req(T.NOTIFY_PREFS_SET, { target_id: targetId, level: level || undefined, muted });
    state.notifyPrefs.set(targetId, res.pref);
    invalidate("rail", "sidebar", "title");
  } catch (e) {
    fail(e);
  }
}

export async function guildMenu(g, anchor) {
  if (state.guildId !== g.guild_id || state.view !== "guild") await openGuild(g.guild_id);
  const p = pref(g.guild_id);
  openMenu(anchor, [
    { label: "Mark as read", icon: "✓", onClick: () => markGuildRead(g.guild_id) },
    can("CREATE_INVITE") ? { label: "Invite people", icon: "✉", onClick: openInviteDialog } : null,
    hasGuildSettings() ? { label: "Guild settings", icon: "⚙", onClick: () => openGuildSettings() } : null,
    can("MANAGE_CHANNELS") ? { label: "Create channel", icon: "＋", onClick: () => createChannel() } : null,
    can("MANAGE_CHANNELS") ? { label: "Create category", icon: "▤", onClick: () => createChannel({ kind: "category" }) } : null,
    !g.ghost && can("CHANGE_NICKNAME") ? { label: "Change nickname", icon: "✎", onClick: () => changeNickname(state.user.user_id) } : null,
    "-",
    { label: p.muted ? "Unmute guild" : "Mute guild", icon: p.muted ? "🔔" : "🔕", onClick: () => setNotifyPref(g.guild_id, { level: p.level, muted: !p.muted }) },
    ...levelItems(g.guild_id, { inherit: null }),
    "-",
    { label: "Copy guild ID", icon: "🆔", onClick: () => copyText(g.guild_id, "Guild ID copied") },
    isGuildOwner(g) ? null : { label: g.ghost ? "Leave (ghost)" : "Leave guild", icon: "⇥", danger: true, onClick: () => leaveGuild(g) },
  ], { placement: anchor instanceof Element ? "bottom" : "right" });
}

// --- channels ---------------------------------------------------------------------

export const createChannel = ({ kind = "text", parentId = null } = {}) => dialogs.createChannelDialog({
  roles: state.roles,
  canSetPerms: can("MANAGE_ROLES"),
  kind,
  parentId,
  categories: state.channels.filter((c) => c.kind === "category"),
  voiceEnabled: !!state.info?.voice_enabled,
  onSubmit: async (payload) => {
    const res = await req(T.CHANNEL_CREATE, { guild_id: state.guildId, ...payload });
    if (!state.channels.some((c) => c.channel_id === res.channel.channel_id)) {
      state.channels = sortChannels([...state.channels, res.channel]);
    }
    if (res.channel.kind === "text") {
      ensureReadState(res.channel);
      await openChannel(res.channel.channel_id);
    } else {
      invalidate("sidebar");
    }
  },
});

// Persist a new sidebar order: [{ channel_id, parent_id }] in display order.
export async function reorderChannels(order) {
  const items = order.map((it, position) => ({ ...it, position }));
  const before = state.channels;
  // Optimistic: show the new order right away.
  const byId = new Map(state.channels.map((c) => [c.channel_id, c]));
  state.channels = items.map((it) => ({ ...byId.get(it.channel_id), parent_id: it.parent_id, position: it.position }));
  invalidate("sidebar");
  try {
    const res = await req(T.CHANNEL_REORDER, { guild_id: state.guildId, channels: items });
    state.channels = sortChannels(res.channels);
  } catch (e) {
    state.channels = before;
    fail(e);
  }
  invalidate("sidebar");
}

export function toggleCategory(id) {
  const collapsed = new Set(store.getLast(state.url).collapsed || []);
  if (collapsed.has(id)) collapsed.delete(id);
  else collapsed.add(id);
  store.setLast(state.url, { collapsed: [...collapsed] });
  invalidate("sidebar");
}

export const isCollapsed = (id) => (store.getLast(state.url).collapsed || []).includes(id);

export const openChannelSettings = (channel) => channelSettings(channel, actions);

// Sidebar order as a flat list (top-level channels, then categories with their channels).
export function sidebarOrder() {
  const tree = channelTree();
  return [
    ...tree.loose.map((c) => ({ channel_id: c.channel_id, parent_id: null })),
    ...tree.categories.flatMap(({ cat, channels }) => [
      { channel_id: cat.channel_id, parent_id: null },
      ...channels.map((c) => ({ channel_id: c.channel_id, parent_id: cat.channel_id })),
    ]),
  ];
}

// Move a channel up/down among its siblings (keyboard/menu alternative to dragging).
export function moveChannel(channel, delta) {
  const order = sidebarOrder();
  const siblings = order.filter((o) => {
    const c = state.channels.find((x) => x.channel_id === o.channel_id);
    return channel.kind === "category" ? c.kind === "category" : c.kind !== "category" && o.parent_id === (channel.parent_id || null);
  });
  const i = siblings.findIndex((o) => o.channel_id === channel.channel_id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= siblings.length) return;
  // Swap the two entries (and, for categories, their channels) in the flat order.
  const tree = channelTree();
  if (channel.kind === "category") {
    const cats = tree.categories.map((c) => c.cat.channel_id);
    [cats[i], cats[j]] = [cats[j], cats[i]];
    reorderChannels([
      ...tree.loose.map((c) => ({ channel_id: c.channel_id, parent_id: null })),
      ...cats.flatMap((id) => [{ channel_id: id, parent_id: null },
        ...tree.categories.find((c) => c.cat.channel_id === id).channels.map((c) => ({ channel_id: c.channel_id, parent_id: id }))]),
    ]);
    return;
  }
  const a = order.findIndex((o) => o.channel_id === siblings[i].channel_id);
  const b = order.findIndex((o) => o.channel_id === siblings[j].channel_id);
  [order[a], order[b]] = [order[b], order[a]];
  reorderChannels(order);
}

export function channelMenu(c, anchor) {
  const p = pref(c.channel_id);
  const manage = can("MANAGE_CHANNELS", c);
  const isCat = c.kind === "category";
  const noun = isCat ? "category" : "channel";
  openMenu(anchor, [
    isCat || c.kind === "voice" ? null : { label: "Mark as read", icon: "✓", disabled: !isUnread(c.channel_id), onClick: () => markChannelRead(c.channel_id) },
    c.kind === "text" ? { label: p.muted ? "Unmute channel" : "Mute channel", icon: p.muted ? "🔔" : "🔕", onClick: () => setNotifyPref(c.channel_id, { level: p.level, muted: !p.muted }) } : null,
    ...(c.kind === "text" ? levelItems(c.channel_id, { inherit: "Use guild default" }) : []),
    isCat && can("MANAGE_CHANNELS") ? { label: "Create channel here", icon: "＋", onClick: () => createChannel({ parentId: c.channel_id }) } : null,
    manage ? "-" : null,
    manage ? { label: `Edit ${noun}`, icon: "⚙", onClick: () => openChannelSettings(c) } : null,
    manage ? { label: "Move up", icon: "↑", onClick: () => moveChannel(c, -1) } : null,
    manage ? { label: "Move down", icon: "↓", onClick: () => moveChannel(c, 1) } : null,
    manage ? { label: `Delete ${noun}`, icon: "🗑", danger: true, onClick: () => dialogs.deleteChannelDialog(c, () => req(T.CHANNEL_DELETE, { channel_id: c.channel_id })) } : null,
    "-",
    { label: "Copy channel ID", icon: "🆔", onClick: () => copyText(c.channel_id, "Channel ID copied") },
  ], { placement: "right" });
}

// --- voice (placeholder: presence only, no audio yet) ------------------------------

export async function joinVoice(channel) {
  if (state.myVoice?.channel_id === channel.channel_id) return;
  try {
    const { voice_state } = await req(T.VOICE_JOIN, { channel_id: channel.channel_id });
    state.myVoice = voice_state;
    state.voice.set(voice_state.user_id, voice_state);
    invalidate("sidebar");
  } catch (e) {
    fail(e);
  }
}

export async function leaveVoice() {
  try { await req(T.VOICE_LEAVE); } catch (e) { fail(e); }
  if (state.myVoice) state.voice.delete(state.user.user_id);
  state.myVoice = null;
  invalidate("sidebar");
}

export async function setVoiceFlags(flags) {
  try {
    const { voice_state } = await req(T.VOICE_STATE_SET, flags);
    state.myVoice = voice_state;
    if (voice_state.guild_id === state.guildId) state.voice.set(voice_state.user_id, voice_state);
    invalidate("sidebar");
  } catch (e) {
    fail(e);
  }
}

// --- DMs ---------------------------------------------------------------------------

const searchUsers = async (query) => {
  const { users } = await req(T.USER_SEARCH, { query });
  users.forEach(rememberUser);
  return users;
};

function addDm(channel) {
  state.dms.set(channel.channel_id, channel);
  channel.recipients.forEach(rememberUser);
  ensureReadState(channel);
}

export const newDm = () => dialogs.newDmDialog({
  search: searchUsers,
  onCreate: async (ids) => {
    const res = ids.length === 1
      ? await req(T.DM_OPEN, { user_id: ids[0] })
      : await req(T.DM_CREATE_GROUP, { user_ids: ids });
    addDm(res.channel);
    await openHome(res.channel.channel_id);
  },
});

export const renameGroup = (channel) => dialogs.renameGroupDialog({
  channel,
  onRename: async (name) => {
    addDm((await req(T.DM_UPDATE, { channel_id: channel.channel_id, name })).channel);
    invalidate();
  },
});

export const addToGroup = (channel) => dialogs.addToGroupDialog({
  channel,
  search: searchUsers,
  onAdd: async (userId) => { addDm((await req(T.DM_ADD_RECIPIENT, { channel_id: channel.channel_id, user_id: userId })).channel); invalidate(); },
});

export function leaveDm(ch) {
  const run = async () => {
    await req(T.DM_LEAVE, { channel_id: ch.channel_id });
    state.dms.delete(ch.channel_id);
    state.readStates.delete(ch.channel_id);
    if (state.channelId === ch.channel_id) {
      state.channelId = null;
      resetMessages();
    }
    invalidate();
  };
  if (ch.kind === "dm") { run().catch(fail); return; }
  confirmModal({ title: "Leave group?", message: "You won't get its messages unless someone adds you back.", confirmLabel: "Leave group", onConfirm: run });
}

export function dmMenu(ch, anchor) {
  const p = pref(ch.channel_id);
  openMenu(anchor, [
    { label: "Mark as read", icon: "✓", disabled: !isUnread(ch.channel_id), onClick: () => markChannelRead(ch.channel_id) },
    { label: p.muted ? "Unmute conversation" : "Mute conversation", icon: p.muted ? "🔔" : "🔕", onClick: () => setNotifyPref(ch.channel_id, { level: p.level, muted: !p.muted }) },
    ch.kind === "group_dm" ? { label: "Rename group", icon: "✎", onClick: () => renameGroup(ch) } : null,
    ch.kind === "group_dm" ? { label: "Add people", icon: "＋", onClick: () => addToGroup(ch) } : null,
    "-",
    { label: ch.kind === "dm" ? "Close conversation" : "Leave group", icon: "✕", danger: ch.kind !== "dm", onClick: () => leaveDm(ch) },
  ], { placement: "right" });
}

// --- roles & moderation ----------------------------------------------------------

export function myRank() {
  const g = currentGuild();
  if (!g) return -1;
  if (isGuildOwner(g)) return Infinity;
  const me = memberById(state.user.user_id);
  const ids = new Set(me?.role_ids || []);
  return Math.max(0, ...state.roles.filter((r) => ids.has(r.role_id)).map((r) => r.position));
}

function rankOf(userId) {
  const m = memberById(userId);
  if (!m) return -1;
  if (m.is_owner) return Infinity;
  const ids = new Set(m.role_ids);
  return Math.max(0, ...state.roles.filter((r) => ids.has(r.role_id)).map((r) => r.position));
}

export const outranks = (userId) => userId !== state.user.user_id && myRank() > rankOf(userId);

export function assignableRoles() {
  if (!can("MANAGE_ROLES")) return [];
  const rank = myRank();
  return state.roles.filter((r) => !r.is_everyone && r.position < rank);
}

export async function setMemberRoles(userId, roleIds) {
  try {
    const res = await req(T.MEMBER_ROLES_SET, { guild_id: state.guildId, user_id: userId, role_ids: roleIds });
    upsertMember(res.member);
  } catch (e) {
    fail(e);
  }
}

export function upsertMember(member) {
  rememberUser(member.user);
  const i = state.members.findIndex((m) => m.user.user_id === member.user.user_id);
  if (i >= 0) state.members[i] = member;
  else state.members.push(member);
  invalidate("members", "chat", "composer");
  if (fullscreenOpen()) refreshFullscreen();
}

export function changeNickname(userId) {
  const m = memberById(userId);
  if (!m) return;
  dialogs.nicknameDialog(userById(userId) || m.user, m.nickname, async (nickname) => {
    upsertMember((await req(T.MEMBER_NICKNAME_SET, { guild_id: state.guildId, user_id: userId, nickname: nickname || null })).member);
  });
}

export function moderationItems(userId) {
  const m = memberById(userId);
  const nick = m && state.view === "guild" && userId !== state.user.user_id && can("MANAGE_NICKNAMES") && outranks(userId)
    ? [{ label: "Change nickname", icon: "✎", onClick: () => changeNickname(userId) }] : [];
  if (!m || state.view !== "guild" || !outranks(userId)) return nick;
  const user = userById(userId) || m.user;
  const gid = state.guildId;
  const timedOut = m.timed_out_until && new Date(m.timed_out_until) > new Date();
  return [
    can("MODERATE_MEMBERS") ? (timedOut
      ? { label: "Remove timeout", icon: "⏳", onClick: () => req(T.MEMBER_TIMEOUT, { guild_id: gid, user_id: userId, duration_seconds: null }).then((r) => upsertMember(r.member), fail) }
      : { label: `Time out ${displayName(user)}`, icon: "⏳", onClick: () => dialogs.timeoutDialog(user, async (seconds, reason) => upsertMember((await req(T.MEMBER_TIMEOUT, { guild_id: gid, user_id: userId, duration_seconds: seconds, reason })).member)) })
      : null,
    can("KICK_MEMBERS") ? { label: `Kick ${displayName(user)}`, icon: "👢", danger: true, onClick: () => dialogs.kickDialog(user, (reason) => req(T.MEMBER_KICK, { guild_id: gid, user_id: userId, reason })) } : null,
    can("BAN_MEMBERS") ? { label: `Ban ${displayName(user)}`, icon: "🔨", danger: true, onClick: () => dialogs.banDialog(user, (reason, deleteSeconds) => req(T.MEMBER_BAN, { guild_id: gid, user_id: userId, reason, delete_seconds: deleteSeconds })) } : null,
    ...nick,
  ].filter(Boolean);
}

// Server-staff actions for a user (mute, disable, delete, bans), if any apply.
export function staffItems(userId) {
  const u = userById(userId);
  if (!u || userId === state.user.user_id || !isStaff(1) || staffLevel(u) >= staffLevel()) return [];
  return adminModeration(u, actions);
}

export function memberMenu(userId, anchor) {
  const me = userId === state.user.user_id;
  openMenu(anchor, [
    { label: "Profile", icon: "👤", onClick: () => openProfileAction(userId, anchor instanceof Element ? anchor : { ...anchor }) },
    me ? null : { label: "Message", icon: "💬", onClick: () => messageUser(userId) },
    ...(moderationItems(userId).length ? ["-", ...moderationItems(userId)] : []),
    ...(staffItems(userId).length ? ["-", { heading: "Server staff" }, ...staffItems(userId)] : []),
    "-",
    { label: "Copy user ID", icon: "🆔", onClick: () => copyText(userId, "User ID copied") },
  ], { placement: "left" });
}

// --- session -----------------------------------------------------------------------

let hooks = {};
export const setSessionHooks = (h) => { hooks = h; };
export const switchServer = () => hooks.switchServer();
export const logout = () => hooks.logout();
export const accountDeleted = () => hooks.accountDeleted();
export const legalChanged = () => hooks.legalChanged();

export const actions = {
  openGuild, openHome, openDm, openChannel, loadOlder, loadNewer, jumpToPresent, seenBottom,
  sendMessage, typing, reply, cancelReply, rerenderComposer, startEdit, cancelEdit, saveEdit, deleteMessage,
  react, unreact, pickReaction, jumpTo, showTopic, pinMessage, unpinMessage, showPins, showSearch, showSwitcher,
  inviteLink, openInviteDialog, openInvite, createInvite, setGuildIcon,
  reorderChannels, sidebarOrder, toggleCategory, isCollapsed, joinVoice, leaveVoice, setVoiceFlags,
  changeNickname, staffItems, nameOf,
  toggleNav, toggleMembers, refreshChrome,
  req, rememberUser, setSelf, setServerInfo, messageUser, statusMenu,
  openProfile: openProfileAction,
  userSettings: openUserSettings,
  addGuild, ghostJoin, updateGuild, leaveGuild, guildMenu, guildSettings: openGuildSettings,
  createChannel, channelSettings: openChannelSettings, channelMenu, moveChannel,
  newDm, renameGroup, addToGroup, leaveDm, dmMenu,
  myRank, outranks, assignableRoles, setMemberRoles, moderationItems, memberMenu, reloadRoles,
  switchServer, logout, accountDeleted,
  isGuildOwner: () => isGuildOwner(),
  isDm: () => isDm(currentChannel()),
  close: () => { closeModal(); closeFullscreen(); },
  PERMS,
};
