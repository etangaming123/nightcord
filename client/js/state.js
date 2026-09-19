// Client state and pure selectors. Mutated by main.js / events.js; read by
// the views in ./ui.

import { PERMS } from "./protocol.js";
import { idGt } from "./ui/dom.js";

export const state = {
  url: null, // canonical ws(s)://…/ws of the connected server
  conn: null,
  info: null, // server.info.result
  user: null, // self view (PROTOCOL.md §4 User)
  connected: false,
  afk: false, // no input for a while (auto-idle)

  users: new Map(), // user_id -> PublicUser, kept fresh by user.updated
  presences: new Map(), // user_id -> online | idle | dnd (absent = offline)
  guilds: new Map(), // guild_id -> Guild (+ ghost, my_permissions)
  dms: new Map(), // channel_id -> DM channel
  readStates: new Map(), // channel_id -> ReadState
  notifyPrefs: new Map(), // target_id -> NotifyPref

  view: "guild", // guild | home
  guildId: null,
  channels: [], // current guild's visible channels, sorted
  roles: [], // current guild's roles, highest first
  members: [], // current guild's members
  channelId: null,

  messages: [], // current channel, oldest first
  messageIds: new Set(),
  hasMore: false,
  loadingOlder: false,
  unreadMarker: null, // message id after which the "NEW" divider goes
  typing: new Map(), // user_id -> expiry (ms) in the current channel
  replyTo: null, // Message being replied to
  editingId: null, // message id being edited inline
  editDraft: "",

  pendingAccounts: 0, // server owner: account requests waiting
};

export function resetServerState() {
  Object.assign(state, {
    conn: null, url: null, info: null, user: null, connected: false,
    users: new Map(), presences: new Map(), guilds: new Map(), dms: new Map(),
    readStates: new Map(), notifyPrefs: new Map(),
    view: "guild", guildId: null, channels: [], roles: [], members: [], channelId: null,
    pendingAccounts: 0,
  });
  resetMessages();
}

export function resetMessages() {
  Object.assign(state, {
    messages: [], messageIds: new Set(), hasMore: false, loadingOlder: false,
    unreadMarker: null, typing: new Map(), replyTo: null, editingId: null, editDraft: "",
  });
}

// --- users -----------------------------------------------------------------

export function rememberUser(u) {
  if (!u?.user_id) return u;
  const prev = state.users.get(u.user_id);
  const merged = prev ? { ...prev, ...u } : u;
  state.users.set(u.user_id, merged);
  return merged;
}

export const userById = (id) => state.users.get(id) || (state.user?.user_id === id ? state.user : undefined);

export function statusOf(userId) {
  if (userId === state.user?.user_id) {
    if (!state.connected) return "offline";
    const pref = state.user.presence;
    if (pref === "invisible") return "offline";
    return pref === "online" && state.afk ? "idle" : pref;
  }
  return state.presences.get(userId) || "offline";
}

// --- guild / channel -------------------------------------------------------

export const currentGuild = () => (state.view === "guild" ? state.guilds.get(state.guildId) || null : null);

export function currentChannel() {
  if (state.view === "home") return state.dms.get(state.channelId) || null;
  return state.channels.find((c) => c.channel_id === state.channelId) || null;
}

export const isDm = (ch) => !!ch && ch.guild_id === null;

export function can(flag, channel = undefined) {
  const perms = channel ? channel.my_permissions : currentGuild()?.my_permissions;
  return !!(perms & (PERMS[flag] ?? flag));
}

export const isGuildOwner = (g = currentGuild()) => !!g && !g.ghost && g.owner_user_id === state.user?.user_id;

export function isPrivate(channel) {
  const everyone = channel.overwrites?.find((o) => o.role_id === channel.guild_id);
  return !!(everyone && everyone.deny & PERMS.VIEW_CHANNEL);
}

export function dmTitle(ch) {
  if (ch.name) return ch.name;
  const others = ch.recipients.filter((u) => u.user_id !== state.user?.user_id);
  if (!others.length) return "Just you";
  return others.map((u) => userById(u.user_id)?.display_name || userById(u.user_id)?.username || u.username).join(", ");
}

export function channelTitle(ch) {
  if (!ch) return "";
  return isDm(ch) ? dmTitle(ch) : `#${ch.name}`;
}

export const memberById = (id) => state.members.find((m) => m.user.user_id === id);

// Roles for a member, highest first.
export function memberRoles(member) {
  if (!member) return [];
  const ids = new Set(member.role_ids);
  return state.roles.filter((r) => ids.has(r.role_id));
}

export function roleColor(userId) {
  if (state.view !== "guild") return null;
  return memberRoles(memberById(userId)).find((r) => r.color)?.color || null;
}

// --- unread / notification prefs -------------------------------------------

export function pref(targetId) {
  return state.notifyPrefs.get(targetId) || { target_id: targetId, level: null, muted: false };
}

export function isMuted(channelId, guildId = state.readStates.get(channelId)?.guild_id) {
  return pref(channelId).muted || (!!guildId && pref(guildId).muted);
}

export function notifyLevel(channelId, guildId) {
  return pref(channelId).level || (guildId && pref(guildId).level) || "all";
}

export function isUnread(channelId) {
  const rs = state.readStates.get(channelId);
  return !!rs && idGt(rs.last_message_id, rs.last_read_id);
}

export const mentionCount = (channelId) => state.readStates.get(channelId)?.mention_count || 0;

// { unread, mentions } for a guild, ignoring muted channels for `unread`.
export function guildBadge(guildId) {
  let unread = false;
  let mentions = 0;
  const guildMuted = pref(guildId).muted;
  for (const rs of state.readStates.values()) {
    if (rs.guild_id !== guildId) continue;
    mentions += rs.mention_count || 0;
    if (!guildMuted && !pref(rs.channel_id).muted && idGt(rs.last_message_id, rs.last_read_id)) unread = true;
  }
  return { unread, mentions };
}

// DMs: every unread message counts like a mention (as in Discord).
export function homeBadge() {
  let count = 0;
  for (const ch of state.dms.values()) {
    if (pref(ch.channel_id).muted) continue;
    if (isUnread(ch.channel_id)) count += Math.max(1, mentionCount(ch.channel_id));
  }
  return count;
}

export function markRead(channelId, messageId) {
  const rs = state.readStates.get(channelId);
  if (!rs) return;
  if (idGt(messageId, rs.last_read_id)) rs.last_read_id = messageId;
  rs.mention_count = 0;
}

export function ensureReadState(channel) {
  if (!state.readStates.has(channel.channel_id)) {
    state.readStates.set(channel.channel_id, {
      channel_id: channel.channel_id, guild_id: channel.guild_id,
      last_message_id: channel.last_message_id || null, last_read_id: null, mention_count: 0,
    });
  }
  return state.readStates.get(channel.channel_id);
}

export function sortChannels(list) {
  return [...list].sort((a, b) => a.position - b.position || (idGt(a.channel_id, b.channel_id) ? 1 : -1));
}

export function sortDms(list) {
  return [...list].sort((a, b) => {
    const la = state.readStates.get(a.channel_id)?.last_message_id || a.last_message_id || a.channel_id;
    const lb = state.readStates.get(b.channel_id)?.last_message_id || b.last_message_id || b.channel_id;
    return idGt(la, lb) ? -1 : 1;
  });
}

export function mentionsMe(m) {
  const me = state.user?.user_id;
  return !!me && m.author?.user_id !== me && (m.mention_everyone || m.mentions?.includes(me));
}
