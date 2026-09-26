// Client state and pure selectors. Mutated by main.js / events.js; read by
// the views in ./ui.

import { PERMS } from "./protocol.js";
import { idGt } from "./ui/dom.js";
import { scopedT } from "./strings.js";

const t = scopedT("state");

// When this page was opened, for the Home page's "Nightcord uptime".
export const APP_OPENED = Date.now();

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
  relationships: new Map(), // user_id -> { user, kind: friend|outgoing|incoming|blocked, since }
  announcements: { items: [], lastReadId: "0", unread: 0, hasMore: false },
  saved: new Set(), // message ids this account bookmarked (PROTOCOL.md §4 Saved message)
  notes: new Map(), // user_id -> your private note about them

  view: "guild", // guild | home
  homeTab: "home", // Home page, or a Friends page tab: online | all | pending | blocked | requests | inbox | add
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

  pendingAccounts: 0, // server staff: account requests waiting
  voice: new Map(), // user_id -> VoiceState in the current guild
  myVoice: null, // my VoiceState (any guild) or null
  collapsed: new Set(), // collapsed category ids (per device, see prefs)
  hasMoreAfter: false, // jumped into the past: newer messages not loaded
  pending: [], // composer uploads: { id, file, name, progress, attachment, error }
  slowmodeUntil: new Map(), // channel_id -> ms timestamp
};

export function resetServerState() {
  Object.assign(state, {
    conn: null, url: null, info: null, user: null, connected: false,
    users: new Map(), presences: new Map(), guilds: new Map(), dms: new Map(),
    saved: new Set(), notes: new Map(),
    readStates: new Map(), notifyPrefs: new Map(), relationships: new Map(),
    announcements: { items: [], lastReadId: "0", unread: 0, hasMore: false },
    view: "guild", guildId: null, channels: [], roles: [], members: [], channelId: null,
    pendingAccounts: 0, voice: new Map(), myVoice: null, pending: [], slowmodeUntil: new Map(),
  });
  resetMessages();
}

export function resetMessages() {
  Object.assign(state, {
    messages: [], messageIds: new Set(), hasMore: false, hasMoreAfter: false, loadingOlder: false,
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

// Name shown for a user in the current guild: nickname > display name > username.
export function nameOf(user, guildId = state.view === "guild" ? state.guildId : null) {
  if (!user) return t("unknown_user");
  if (user.deleted) return t("deleted_user");
  if (guildId && guildId === state.guildId) {
    const nick = state.members.find((m) => m.user.user_id === user.user_id)?.nickname;
    if (nick) return nick;
  }
  return user.display_name || user.username || t("unknown_user");
}

// --- friends, blocks and message requests (PROTOCOL.md §5 Friends and blocking) ----

export const relationKind = (userId) => state.relationships.get(userId)?.kind || null;
export const isFriend = (userId) => relationKind(userId) === "friend";
export const isBlocked = (userId) => relationKind(userId) === "blocked";
export const relationsOf = (kind) => [...state.relationships.values()].filter((r) => r.kind === kind);

// A 1:1 DM someone who isn't a friend sent us, waiting for a yes or no.
export const isIncomingRequest = (ch) =>
  ch?.request?.state === "pending" && ch.request.from_user_id !== state.user?.user_id;
export const messageRequests = () => [...state.dms.values()].filter(isIncomingRequest);

// Things waiting on the Friends page: friend requests, message requests, announcements.
export const friendsBadge = () =>
  relationsOf("incoming").length + messageRequests().length + (state.announcements.unread || 0);

// --- server staff (PROTOCOL.md §8c) -------------------------------------------

const STAFF = { none: 0, moderator: 1, admin: 2, owner: 3 };
export const staffLevel = (u = state.user) => STAFF[u?.server_role || (u?.is_server_owner ? "owner" : "none")] || 0;
export const isStaff = (min = 1) => staffLevel() >= min;

// A lazy-lookup object: consumers do STAFF_LABEL[role] and get the
// translated string on access, never at module load.
const STAFF_LABEL_KEYS = { owner: "staff_owner", admin: "staff_admin", moderator: "staff_moderator" };
export const STAFF_LABEL = new Proxy({}, {
  get: (_, prop) => (STAFF_LABEL_KEYS[prop] ? t(STAFF_LABEL_KEYS[prop]) : undefined),
});

export function mutedUntil() {
  const until = state.user?.muted_until;
  if (!until) return null;
  if (until === "permanent") return "permanent";
  return new Date(until) > new Date() ? until : null;
}

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

// Any channel this client knows: the open guild's, or a DM.
export function channelById(id) {
  return state.channels.find((c) => c.channel_id === id) || state.dms.get(id) || null;
}

// A custom status is only shown while someone is around. The server already
// strips it from what it sends about an offline or invisible user; this stops
// a copy we cached while they were online from lingering.
export function customStatusOf(user) {
  if (!user?.custom_status) return null;
  if (user.user_id === state.user?.user_id) return user.custom_status;
  return statusOf(user.user_id) === "offline" ? null : user.custom_status;
}

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

// Overwrites that apply to a channel (its category's when synced).
export function effectiveOverwrites(channel) {
  if (channel?.perms_synced && channel.parent_id) {
    const parent = state.channels.find((c) => c.channel_id === channel.parent_id);
    if (parent) return parent.overwrites || [];
  }
  return channel?.overwrites || [];
}

export function isPrivate(channel) {
  const everyone = effectiveOverwrites(channel).find((o) => o.role_id === channel.guild_id);
  return !!(everyone && everyone.deny & PERMS.VIEW_CHANNEL);
}

// Mirrors the server's permission computation (PROTOCOL.md §5a) for another
// member, to list who can see a channel. The server remains the authority.
export function memberChannelPerms(member, channel) {
  if (!member || !channel) return 0;
  if (member.is_owner) return ~0;
  const everyone = state.roles.find((r) => r.is_everyone);
  const ids = new Set(member.role_ids);
  let perms = everyone?.permissions || 0;
  for (const r of state.roles) if (ids.has(r.role_id)) perms |= r.permissions;
  if (perms & PERMS.ADMINISTRATOR) return ~0;
  const ows = effectiveOverwrites(channel);
  const e = ows.find((o) => o.role_id === channel.guild_id);
  if (e) perms = (perms & ~e.deny) | e.allow;
  let allow = 0;
  let deny = 0;
  for (const o of ows) if (ids.has(o.role_id)) { allow |= o.allow; deny |= o.deny; }
  return (perms & ~deny) | allow;
}

export const memberCanView = (member, channel) => !!(memberChannelPerms(member, channel) & PERMS.VIEW_CHANNEL);

// Channels in sidebar order: top-level channels, then each category with its channels.
export function channelTree() {
  const cats = state.channels.filter((c) => c.kind === "category");
  const inCat = (id) => state.channels.filter((c) => c.kind !== "category" && c.parent_id === id);
  const loose = state.channels.filter((c) => c.kind !== "category" && (!c.parent_id || !cats.some((k) => k.channel_id === c.parent_id)));
  return { loose, categories: cats.map((cat) => ({ cat, channels: inCat(cat.channel_id) })) };
}

export const textChannels = () => state.channels.filter((c) => c.kind === "text");
export const voiceEnabled = () => !!state.info?.voice_enabled;
export const voiceIn = (channelId) => [...state.voice.values()].filter((v) => v.channel_id === channelId);

export function dmTitle(ch) {
  if (ch.name) return ch.name;
  const others = ch.recipients.filter((u) => u.user_id !== state.user?.user_id);
  if (!others.length) return t("just_you");
  return others.map((u) => nameOf(userById(u.user_id) || u, null)).join(", ");
}

export function channelTitle(ch) {
  if (!ch) return "";
  return isDm(ch) ? dmTitle(ch) : `#${ch.name}`;
}

export const memberById = (id) => state.members.find((m) => m.user.user_id === id);

// Whether a shared link's ?server= (host:port, or ws://host:port for plain
// ws) is the server we're on. No server in the link means this one.
export function isThisServer(server) {
  if (!server || !state.url) return true;
  return server.replace(/^wss?:\/\//i, "").toLowerCase() === new URL(state.url).host.toLowerCase();
}

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

// The highest role that's displayed separately in the member list, if any.
export const hoistedRole = (member) => memberRoles(member).find((r) => r.hoist) || null;

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

// DMs: every unread message counts like a mention (as in Discord). Message
// requests count once each (in friendsBadge), not per message.
export function homeBadge() {
  let count = friendsBadge();
  for (const ch of state.dms.values()) {
    if (pref(ch.channel_id).muted || isIncomingRequest(ch)) continue;
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
