// The preview's pretend server: an in-memory copy of what the real one keeps
// (server/nightcord/db.py), answering the same requests with the same shapes
// (docs/PROTOCOL.md). Only one person is ever connected — the one trying the
// preview — so "send this event to everyone who can see it" becomes "does the
// person in the preview see it?". Sample users act through the same handlers
// (handleAs), so everything they do looks exactly like a real server's events.
//
// No DOM here: tests run it in node (client/tests/preview.test.mjs).

import { AUTH_OK_TYPES, ERR, LIMITS, PERMS, PROTOCOL_VERSION } from "../protocol.js";

export class PreviewError extends Error {
  constructor(code, message, data = {}) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export const fail = (code, message, data) => { throw new PreviewError(code, message, data); };
export const notFound = (what = "That") => fail(ERR.NOT_FOUND, `${what} doesn't exist.`);
export const forbidden = (message = "You don't have permission to do that.") => fail(ERR.FORBIDDEN, message);
export const badRequest = (message) => fail(ERR.BAD_REQUEST, message);

const ALL_PERMS = Object.values(PERMS).reduce((a, b) => a | b, 0);
const DM_PERMS = PERMS.VIEW_CHANNEL | PERMS.SEND_MESSAGES | PERMS.READ_HISTORY | PERMS.ADD_REACTIONS | PERMS.ATTACH_FILES;
export const EVERYONE_DEFAULT = 229903;
const STAFF_RANK = { none: 0, moderator: 1, admin: 2, owner: 3 };

// Snowflake-style ids (PROTOCOL.md §4 IDs): ms << 12 | seq, as decimal strings.
// The seed mints ids for past times in between present ones, so the sequence
// just keeps counting rather than restarting per millisecond.
let seq = 0;
export function newId(ms = Date.now()) {
  seq = (seq + 1) & 4095;
  return ((BigInt(Math.floor(ms)) << 12n) | BigInt(seq)).toString();
}
export const idTime = (id) => Number(BigInt(id) >> 12n);
export const idCmp = (a, b) => (a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0);
export const iso = (ms = Date.now()) => new Date(ms).toISOString();

const MENTION_RE = /<@(\d+)>/g;

export class PreviewServer {
  constructor() {
    this.handlers = new Map();
    this.sink = null; // (type, payload) => void — the preview's connection
    this.me = null; // user_id logged in, or null on the login screen
    this.sessionToken = null;
    this.focus = null; // channel_id the client has "joined"
    this.config = {};
    this.legal = { terms: null, privacy: null, version: null };
    this.users = new Map();
    this.presence = new Map(); // sample users' visible status (the viewer's comes from their account)
    this.sessions = new Map(); // session_id -> { session_id, user_id, token, created_at, last_seen, user_agent, device_id, ip }
    this.guilds = new Map();
    this.members = new Map(); // `${guild}:${user}` -> member row
    this.roles = new Map();
    this.channels = new Map();
    this.messages = new Map();
    this.channelMessages = new Map(); // channel_id -> [message_id] oldest first
    this.relations = new Map(); // `${a}:${b}` -> { kind, since } from a's side
    this.readStates = new Map(); // `${user}:${channel}` -> { last_read_id, mention_count }
    this.notifyPrefs = new Map(); // `${user}:${target}` -> NotifyPref
    this.saved = new Map(); // user_id -> Map(message_id -> saved_at ms)
    this.notes = new Map(); // `${user}:${target}` -> note
    this.emojis = new Map();
    this.stickers = new Map();
    this.invites = new Map();
    this.bans = new Map(); // `${guild}:${user}` -> { reason, created_at }
    this.announcements = [];
    this.announcementRead = new Map(); // user_id -> last_read_id
    this.badges = new Map();
    this.serverAudit = [];
    this.guildAudit = [];
    this.ipBans = [];
    this.deviceBans = [];
    this.media = new Map(); // media_id -> Media (+ url)
    this.attachments = new Map(); // attachment_id -> Attachment (+ url, user_id, channel_id, claimed)
    this.voice = new Map(); // user_id -> VoiceState
    this.embedCache = 37; // pretend cached previews, for the Data tab
  }

  // --- plumbing ------------------------------------------------------------------

  on(type, fn) { this.handlers.set(type, fn); }

  emit(type, payload) { this.sink?.(type, payload); }

  // A request from the person in the preview.
  handle(type, payload = {}) {
    const fn = this.handlers.get(type);
    if (!fn) fail(ERR.UNKNOWN_TYPE, `Unknown message type: ${type}`);
    const preAuth = AUTH_OK_TYPES.has(type) || type === "server.info" || type === "legal.get";
    if (!preAuth && !this.me) fail(ERR.NOT_AUTHENTICATED, "Log in first.");
    return fn(this.me, payload || {}, this) ?? {};
  }

  // The same request, made by a sample user (simulated activity, seeding).
  handleAs(userId, type, payload = {}) {
    const fn = this.handlers.get(type);
    if (!fn) fail(ERR.UNKNOWN_TYPE, `Unknown message type: ${type}`);
    return fn(userId, payload, this) ?? {};
  }

  // --- users -----------------------------------------------------------------------

  user(id) { return this.users.get(id) || null; }
  requireUser(id) { const u = this.users.get(id); if (!u || u.deleted) notFound("That user"); return u; }
  userByName(name) {
    const low = String(name || "").toLowerCase();
    return [...this.users.values()].find((u) => !u.deleted && u.username.toLowerCase() === low) || null;
  }

  // What everyone else sees (PROTOCOL.md §4 User).
  publicUser(id) {
    const u = this.users.get(id);
    if (!u) return null;
    if (u.deleted) {
      return {
        user_id: u.user_id, username: `deleted_user_${u.user_id.slice(-6)}`, display_name: null, avatar_id: null,
        avatar_color: null, custom_status: null, is_server_owner: false, server_role: "none", deleted: true,
        perks: false, banner_id: null, profile_colors: null, badges: [],
      };
    }
    return {
      user_id: u.user_id,
      username: u.username,
      display_name: u.display_name,
      avatar_id: u.avatar_id,
      avatar_color: u.avatar_color,
      custom_status: this.visibleStatus(id) === "offline" && id !== this.me ? null : u.custom_status,
      is_server_owner: !!u.is_server_owner,
      server_role: this.staffRole(u),
      deleted: false,
      perks: !!u.perks,
      banner_id: u.banner_id,
      profile_colors: u.profile_colors,
      badges: this.badgesOf(u),
    };
  }

  selfUser(id) {
    const u = this.users.get(id);
    return {
      ...this.publicUser(id),
      custom_status: u.custom_status,
      custom_status_expires_at: u.custom_status_expires_at,
      bio: u.bio,
      created_at: u.created_at,
      presence: u.presence,
      muted_until: u.muted_until,
      legal_version: u.legal_version,
      dm_privacy: u.dm_privacy,
    };
  }

  // The view of `id` the person in the preview gets.
  viewUser(id) { return id === this.me ? this.selfUser(id) : this.publicUser(id); }

  adminUser(id) {
    const u = this.users.get(id);
    const sessions = [...this.sessions.values()].filter((s) => s.user_id === id).sort((a, b) => b.last_seen - a.last_seen);
    return {
      ...this.publicUser(id),
      status: u.status,
      created_at: u.created_at,
      note: u.note,
      muted_until: u.muted_until,
      last_ip: sessions[0]?.ip || null,
      last_seen: sessions[0] ? iso(sessions[0].last_seen) : null,
      device_count: new Set(sessions.map((s) => s.device_id)).size,
      online: this.visibleStatus(id) !== "offline" || (id === this.me) || this.presence.get(id) === "invisible",
    };
  }

  staffRole(u) { return u.is_server_owner ? "owner" : u.server_role || "none"; }
  staffRank(id) { const u = this.users.get(id); return u ? STAFF_RANK[this.staffRole(u)] : 0; }
  requireStaff(uid, min) {
    if (this.staffRank(uid) < STAFF_RANK[min]) forbidden("That's for server staff.");
  }

  badgesOf(u) {
    return (u.badges || []).map((id) => this.badges.get(id)).filter(Boolean);
  }

  // online | idle | dnd | offline, as others see them.
  visibleStatus(id) {
    if (id === this.me) {
      const p = this.users.get(id)?.presence || "online";
      return p === "invisible" ? "offline" : p;
    }
    const s = this.presence.get(id) || "offline";
    return s === "invisible" ? "offline" : s;
  }

  isMuted(id) {
    const m = this.users.get(id)?.muted_until;
    return m === "permanent" || (!!m && new Date(m) > new Date());
  }
  requireNotMuted(id) { if (this.isMuted(id)) fail(ERR.MUTED, "You're muted on this server."); }

  // Everyone who hears about `id`: shares a guild (visibly) or a DM, or is a friend.
  seesUser(viewer, id) {
    if (viewer === id) return true;
    if (this.relation(viewer, id) === "friend") return true;
    for (const ch of this.channels.values()) {
      if (!ch.guild_id && ch.recipients.includes(viewer) && ch.recipients.includes(id)) return true;
    }
    for (const g of this.guilds.values()) {
      const a = this.member(g.guild_id, viewer);
      const b = this.member(g.guild_id, id);
      if (a && b && !b.ghost) return true;
    }
    return false;
  }

  // Tell the preview's person that `id` changed, if they'd hear about it.
  userUpdated(id) {
    if (this.me && this.seesUser(this.me, id)) this.emit("user.updated", this.viewUser(id));
  }

  setPresence(id, status) {
    const before = this.visibleStatus(id);
    this.presence.set(id, status);
    const after = this.visibleStatus(id);
    if (before !== after && this.me && id !== this.me && this.hearsPresence(this.me, id)) {
      this.emit("presence.update", { user_id: id, status: after });
    }
  }

  hearsPresence(viewer, id) {
    if (this.relation(viewer, id) === "friend") return true;
    for (const ch of this.channels.values()) {
      if (!ch.guild_id && ch.recipients.includes(viewer) && ch.recipients.includes(id)) return true;
    }
    for (const g of this.guilds.values()) {
      const a = this.member(g.guild_id, viewer);
      const b = this.member(g.guild_id, id);
      if (a && b && !b.ghost) return true;
    }
    return false;
  }

  // --- relationships ---------------------------------------------------------------

  relation(a, b) { return this.relations.get(`${a}:${b}`)?.kind || null; }
  setRelation(a, b, kind) {
    if (!kind) this.relations.delete(`${a}:${b}`);
    else this.relations.set(`${a}:${b}`, { kind, since: iso() });
  }
  relationship(a, b) {
    const r = this.relations.get(`${a}:${b}`);
    return r ? { user: this.publicUser(b), kind: r.kind, since: r.since } : null;
  }
  blockedEither(a, b) { return this.relation(a, b) === "blocked" || this.relation(b, a) === "blocked"; }

  // --- guilds, roles, members, permissions -----------------------------------------------

  guild(id) { return this.guilds.get(id) || null; }
  requireGuild(id) { const g = this.guilds.get(id); if (!g) notFound("That server"); return g; }
  member(guildId, userId) { return this.members.get(`${guildId}:${userId}`) || null; }
  requireMember(guildId, userId) {
    const m = this.member(guildId, userId);
    if (!m) notFound("That server");
    return m;
  }
  guildMembers(guildId, { ghosts = false } = {}) {
    return [...this.members.values()].filter((m) => m.guild_id === guildId && (ghosts || !m.ghost) && !this.users.get(m.user_id)?.deleted);
  }
  guildRoles(guildId) {
    return [...this.roles.values()].filter((r) => r.guild_id === guildId).sort((a, b) => b.position - a.position);
  }
  guildChannels(guildId) {
    return [...this.channels.values()].filter((c) => c.guild_id === guildId).sort((a, b) => a.position - b.position || idCmp(a.channel_id, b.channel_id));
  }

  serializeMember(m) {
    return {
      user: this.publicUser(m.user_id),
      role_ids: [...m.role_ids],
      joined_at: m.joined_at,
      timed_out_until: m.timed_out_until && new Date(m.timed_out_until) > new Date() ? m.timed_out_until : null,
      is_owner: this.guilds.get(m.guild_id)?.owner_user_id === m.user_id,
      nickname: m.nickname,
      invited_by: m.invited_by,
      invite_code: m.invite_code,
    };
  }

  role(guildId, roleId) { const r = this.roles.get(roleId); return r && r.guild_id === guildId ? r : null; }
  serializeRole(r) {
    return {
      role_id: r.role_id, guild_id: r.guild_id, name: r.name, color: r.color, permissions: r.permissions,
      position: r.position, is_everyone: r.role_id === r.guild_id, hoist: !!r.hoist, colors: r.colors || null,
      icon_id: r.icon_id || null, icon_emoji: r.icon_emoji || null,
    };
  }

  isTimedOut(m) { return !!m?.timed_out_until && new Date(m.timed_out_until) > new Date(); }

  // Guild-wide permissions (PROTOCOL.md §5a, steps 1–2).
  guildPerms(userId, guildId) {
    const g = this.guilds.get(guildId);
    const m = this.member(guildId, userId);
    if (!g || !m) return 0;
    if (m.ghost) return PERMS.VIEW_CHANNEL | PERMS.READ_HISTORY;
    if (g.owner_user_id === userId) return ALL_PERMS;
    let perms = this.roles.get(guildId)?.permissions || 0;
    for (const id of m.role_ids) perms |= this.roles.get(id)?.permissions || 0;
    if (perms & PERMS.ADMINISTRATOR) return ALL_PERMS;
    if (this.isTimedOut(m)) return perms & (PERMS.VIEW_CHANNEL | PERMS.READ_HISTORY);
    return perms;
  }

  overwritesOf(ch) {
    if (ch.perms_synced && ch.parent_id) return this.channels.get(ch.parent_id)?.overwrites || [];
    return ch.overwrites || [];
  }

  channelPerms(userId, ch) {
    if (!ch) return 0;
    if (!ch.guild_id) return ch.recipients.includes(userId) ? DM_PERMS : 0;
    const g = this.guilds.get(ch.guild_id);
    const m = this.member(ch.guild_id, userId);
    if (!g || !m) return 0;
    if (m.ghost) return PERMS.VIEW_CHANNEL | PERMS.READ_HISTORY;
    if (g.owner_user_id === userId) return ALL_PERMS;
    let perms = this.roles.get(ch.guild_id)?.permissions || 0;
    for (const id of m.role_ids) perms |= this.roles.get(id)?.permissions || 0;
    if (perms & PERMS.ADMINISTRATOR) return ALL_PERMS;
    const ows = this.overwritesOf(ch);
    const e = ows.find((o) => o.role_id === ch.guild_id);
    if (e) perms = (perms & ~e.deny) | e.allow;
    let allow = 0;
    let deny = 0;
    for (const o of ows) if (m.role_ids.includes(o.role_id)) { allow |= o.allow; deny |= o.deny; }
    perms = (perms & ~deny) | allow;
    if (!(perms & PERMS.VIEW_CHANNEL)) return 0;
    if (this.isTimedOut(m)) perms &= PERMS.VIEW_CHANNEL | PERMS.READ_HISTORY;
    return perms;
  }

  canView(userId, ch) { return !!(this.channelPerms(userId, ch) & PERMS.VIEW_CHANNEL); }

  requireGuildPerm(userId, guildId, flag) {
    this.requireMember(guildId, userId);
    if (!(this.guildPerms(userId, guildId) & flag)) forbidden();
  }
  requireChannelPerm(userId, ch, flag) {
    if (!(this.channelPerms(userId, ch) & flag)) forbidden();
  }

  // A member's rank: the highest position among their roles; the owner outranks all.
  rank(guildId, userId) {
    const g = this.guilds.get(guildId);
    if (g?.owner_user_id === userId) return Infinity;
    const m = this.member(guildId, userId);
    if (!m) return -1;
    return Math.max(0, ...m.role_ids.map((id) => this.roles.get(id)?.position || 0));
  }

  // Moderation targets must be visible members ranked strictly below the actor.
  requireOutranks(guildId, actor, target) {
    if (actor === target) forbidden("You can't do that to yourself.");
    const m = this.member(guildId, target);
    if (!m || m.ghost) notFound("That member");
    if (this.guilds.get(guildId).owner_user_id === target) forbidden("You can't do that to the server owner.");
    if (this.rank(guildId, actor) <= this.rank(guildId, target)) forbidden("They rank at or above you.");
    return m;
  }

  serializeGuild(g, viewer = this.me) {
    const m = this.member(g.guild_id, viewer);
    return {
      guild_id: g.guild_id, name: g.name, owner_user_id: g.owner_user_id, listed: !!g.listed,
      created_at: g.created_at, icon_id: g.icon_id, system_channel_id: g.system_channel_id,
      system_flags: g.system_flags, vanity_code: g.vanity_code, banner_id: g.banner_id,
      ghost: !!m?.ghost,
      my_permissions: this.guildPerms(viewer, g.guild_id),
      emojis: this.guildEmojis(g.guild_id),
      stickers: this.guildStickers(g.guild_id),
    };
  }
  plainGuild(g) {
    const { ghost: _g, my_permissions: _p, emojis: _e, stickers: _s, ...rest } = this.serializeGuild(g, null);
    return rest;
  }

  guildEmojis(guildId) {
    return [...this.emojis.values()].filter((e) => e.guild_id === guildId).map((e) => ({ ...e }));
  }
  guildStickers(guildId) {
    return [...this.stickers.values()].filter((s) => s.guild_id === guildId).map((s) => ({ ...s }));
  }

  // --- channels ----------------------------------------------------------------------

  channel(id) { return this.channels.get(id) || null; }
  requireChannel(userId, id) {
    const ch = this.channels.get(id);
    if (!ch || !this.canView(userId, ch)) notFound("That channel");
    return ch;
  }

  lastMessageId(channelId) {
    const ids = this.channelMessages.get(channelId);
    return ids?.length ? ids[ids.length - 1] : null;
  }

  serializeChannel(ch, viewer = this.me) {
    if (!ch.guild_id) {
      return {
        channel_id: ch.channel_id, guild_id: null, kind: ch.kind, name: ch.name || null,
        owner_user_id: ch.owner_user_id || null,
        recipients: ch.recipients.map((id) => this.publicUser(id)),
        request: ch.request ? { ...ch.request } : null,
        last_message_id: this.lastMessageId(ch.channel_id),
        my_permissions: this.channelPerms(viewer, ch),
      };
    }
    return {
      channel_id: ch.channel_id, guild_id: ch.guild_id, kind: ch.kind, name: ch.name, position: ch.position,
      parent_id: ch.parent_id, topic: ch.topic, slowmode_seconds: ch.slowmode_seconds || 0,
      perms_synced: !!ch.perms_synced, overwrites: (ch.overwrites || []).map((o) => ({ ...o })),
      last_message_id: this.lastMessageId(ch.channel_id),
      my_permissions: this.channelPerms(viewer, ch),
    };
  }

  // Tell the viewer about a guild channel change, as the real server's fan-out would.
  channelEvent(type, ch) {
    if (this.me && this.canView(this.me, ch)) this.emit(type, this.serializeChannel(ch));
  }

  // --- messages ------------------------------------------------------------------------

  message(id) { return this.messages.get(id) || null; }
  requireMessage(userId, id) {
    const m = this.messages.get(id);
    if (!m) notFound("That message");
    const ch = this.channels.get(m.channel_id);
    if (!ch || !this.canView(userId, ch)) notFound("That message");
    return m;
  }

  addMessage(m) {
    this.messages.set(m.message_id, m);
    const list = this.channelMessages.get(m.channel_id) || [];
    if (!list.length || idCmp(list[list.length - 1], m.message_id) < 0) list.push(m.message_id);
    else { list.push(m.message_id); list.sort(idCmp); }
    this.channelMessages.set(m.channel_id, list);
  }

  removeMessage(id) {
    const m = this.messages.get(id);
    if (!m) return;
    this.messages.delete(id);
    const list = this.channelMessages.get(m.channel_id) || [];
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1);
    for (const map of this.saved.values()) map.delete(id);
    for (const aid of m.attachment_ids || []) this.attachments.delete(aid);
  }

  serializePoll(p) {
    if (!p) return null;
    const answers = p.answers.map((a) => ({ answer_id: a.answer_id, text: a.text, emoji: a.emoji || null, count: a.user_ids.length, user_ids: [...a.user_ids] }));
    const voters = new Set(p.answers.flatMap((a) => a.user_ids));
    return { question: p.question, multi: !!p.multi, expires_at: p.expires_at, ended_at: p.ended_at, total_votes: voters.size, answers };
  }

  serializeAttachment(a) {
    const { user_id: _u, channel_id: _c, claimed: _k, blobUrl: _b, ...rest } = a;
    return rest;
  }

  serializeMessage(m) {
    const ch = this.channels.get(m.channel_id);
    const reply = m.reply_to_id ? this.messages.get(m.reply_to_id) : null;
    return {
      message_id: m.message_id,
      channel_id: m.channel_id,
      guild_id: ch?.guild_id ?? null,
      author: this.publicUser(m.author_id),
      content: m.content,
      sent_at: m.sent_at,
      edited_at: m.edited_at || null,
      reply_to_id: m.reply_to_id || null,
      reply_to: reply ? { message_id: reply.message_id, author: this.publicUser(reply.author_id), content: reply.content.slice(0, 120) } : null,
      mentions: [...(m.mentions || [])],
      mention_everyone: !!m.mention_everyone,
      reactions: (m.reactions || []).map((r) => ({ emoji: r.emoji, user_ids: [...r.user_ids] })),
      type: m.type || "default",
      pinned: !!m.pinned,
      embeds: m.embeds_suppressed ? [] : (m.embeds || []).map((e) => ({ ...e })),
      embeds_suppressed: !!m.embeds_suppressed,
      command: m.command || null,
      poll: this.serializePoll(m.poll),
      forward: m.forward || null,
      attachments: (m.attachment_ids || []).map((id) => this.attachments.get(id)).filter(Boolean).map((a) => this.serializeAttachment(a)),
      stickers: (m.stickers || []).map((id) => {
        const s = this.stickers.get(id);
        return s ? { sticker_id: s.sticker_id, name: s.name, animated: !!s.animated, guild_id: s.guild_id } : { sticker_id: id, deleted: true };
      }),
    };
  }

  // Send a message event to the viewer if they can see the channel.
  messageEvent(type, m) {
    const ch = this.channels.get(m.channel_id);
    if (this.me && ch && this.canView(this.me, ch)) this.emit(type, this.serializeMessage(m));
  }

  parseMentions(content, ch) {
    const ids = new Set();
    for (const [, id] of content.matchAll(MENTION_RE)) if (this.users.has(id)) ids.add(id);
    const everyone = /(^|[^\\\w])@everyone\b/.test(content) && !!ch.guild_id;
    return { mentions: [...ids], everyone };
  }

  // --- read state ------------------------------------------------------------------------

  readState(userId, ch) {
    const key = `${userId}:${ch.channel_id}`;
    const rs = this.readStates.get(key) || { last_read_id: null, mention_count: 0 };
    return {
      channel_id: ch.channel_id, guild_id: ch.guild_id || null,
      last_message_id: this.lastMessageId(ch.channel_id),
      last_read_id: rs.last_read_id, mention_count: rs.mention_count,
    };
  }
  setRead(userId, channelId, patch) {
    const key = `${userId}:${channelId}`;
    const rs = this.readStates.get(key) || { last_read_id: null, mention_count: 0 };
    this.readStates.set(key, { ...rs, ...patch });
  }

  // --- DMs ---------------------------------------------------------------------------------

  dmBetween(a, b) {
    for (const ch of this.channels.values()) {
      if (ch.kind === "dm" && ch.recipients.includes(a) && ch.recipients.includes(b)) return ch;
    }
    return null;
  }

  // DMs listed for a user. A 1:1 DM is listed for whoever opened it, and for
  // everyone in it once it has a message (ch.open); closing it drops it until
  // the next message. A declined request stays hidden from the one who declined.
  userDms(userId) {
    return [...this.channels.values()].filter((ch) => {
      if (ch.guild_id || !ch.recipients.includes(userId) || !ch.open.has(userId)) return false;
      if (ch.request && ch.request.from_user_id !== userId && ch.request.state === "declined") return false;
      return true;
    });
  }

  // --- media ---------------------------------------------------------------------------------

  // Media ids are digits; the browser URL lives in media.url (data: or blob:).
  addMedia(kind, { url, content_type = "image/svg+xml", size = 1024, width = 128, height = 128, animated = false, id = newId() }) {
    const media = { media_id: id, kind, content_type, size, width, height, animated, url, claimed: false, created_at: Date.now() };
    this.media.set(id, media);
    return media;
  }
  claimMedia(id, kind) {
    const m = this.media.get(String(id || ""));
    if (!m || (kind && m.kind !== kind)) fail(ERR.MEDIA_INVALID, "Upload the image again.");
    m.claimed = true;
    return m;
  }
  mediaRef(m) { return m.animated ? `a_${m.media_id}` : m.media_id; }

  // --- audit logs ------------------------------------------------------------------------------

  audit(actor, action, targetId = null, details = null) {
    this.serverAudit.unshift({ entry_id: newId(), actor_id: actor, action, target_id: targetId, details, created_at: iso() });
  }
  guildLog(guildId, actor, action, targetId = null, details = null) {
    this.guildAudit.unshift({ entry_id: newId(), guild_id: guildId, actor_id: actor, action, target_id: targetId, details, created_at: iso() });
  }
  serializeAudit(e) {
    return { entry_id: e.entry_id, actor: this.publicUser(e.actor_id), action: e.action, target_id: e.target_id, details: e.details, created_at: e.created_at };
  }

  // --- shared operations (used by handlers, seeding and simulated activity) ----------------------

  // Event to the viewer if they're in the guild (ghosts included: they get guild events).
  toGuild(guildId, type, payload) {
    if (this.me && this.member(guildId, this.me)) this.emit(type, typeof payload === "function" ? payload() : payload);
  }

  addUser(fields) {
    const user = {
      user_id: newId(), username: "user", password: "preview-password", display_name: null, avatar_id: null,
      avatar_color: null, custom_status: null, custom_status_expires_at: null, is_server_owner: false,
      server_role: "none", deleted: false, perks: false, banner_id: null, profile_colors: null, badges: [],
      bio: null, created_at: iso(), presence: "online", muted_until: null, legal_version: null,
      dm_privacy: "requests", status: "active", note: null, afk: false,
      ...fields,
    };
    this.users.set(user.user_id, user);
    return user;
  }

  deleteUser(id) {
    const u = this.users.get(id);
    for (const g of [...this.guilds.values()]) {
      if (!this.member(g.guild_id, id)) continue;
      if (g.owner_user_id === id) {
        const heir = this.guildMembers(g.guild_id).filter((m) => m.user_id !== id)
          .sort((a, b) => this.rank(g.guild_id, b.user_id) - this.rank(g.guild_id, a.user_id))[0];
        if (!heir) { this.removeGuild(g.guild_id); continue; }
        g.owner_user_id = heir.user_id;
        this.guildLog(g.guild_id, heir.user_id, "guild.transfer", heir.user_id);
        this.toGuild(g.guild_id, "guild.updated", () => this.plainGuild(g));
      }
      this.dropMember(g.guild_id, id, "left");
    }
    for (const ch of this.channels.values()) {
      if (ch.kind === "group_dm" && ch.recipients.includes(id)) ch.recipients = ch.recipients.filter((x) => x !== id);
    }
    for (const key of [...this.relations.keys()]) if (key.split(":").includes(id)) this.relations.delete(key);
    for (const [sid, x] of this.sessions) if (x.user_id === id) this.sessions.delete(sid);
    Object.assign(u, { deleted: true, display_name: null, avatar_id: null, bio: null, custom_status: null, banner_id: null, badges: [] });
    u.username = `deleted_user_${id.slice(-6)}`;
    this.presence.delete(id);
  }

  // A new guild with @everyone and #general (PROTOCOL.md §5 guild.create).
  createGuild(name, ownerId, extra = {}) {
    const guildId = newId();
    const g = {
      guild_id: guildId, name, owner_user_id: ownerId, listed: false, created_at: iso(idTime(guildId)), icon_id: null,
      system_channel_id: null, system_flags: 0, vanity_code: null, banner_id: null, ...extra,
    };
    this.guilds.set(guildId, g);
    this.roles.set(guildId, { role_id: guildId, guild_id: guildId, name: "@everyone", color: null, permissions: EVERYONE_DEFAULT, position: 0, hoist: false, colors: null, icon_id: null, icon_emoji: null });
    const general = this.addChannel(guildId, { name: "general" });
    g.system_channel_id = general.channel_id;
    this.addMember(guildId, ownerId);
    return g;
  }

  addChannel(guildId, fields) {
    const siblings = this.guildChannels(guildId);
    const ch = {
      channel_id: newId(), guild_id: guildId, kind: "text", name: "channel", position: siblings.length,
      parent_id: null, topic: null, slowmode_seconds: 0, perms_synced: false, overwrites: [], ...fields,
    };
    this.channels.set(ch.channel_id, ch);
    this.channelMessages.set(ch.channel_id, []);
    return ch;
  }

  addMember(guildId, userId, fields = {}) {
    const m = { guild_id: guildId, user_id: userId, role_ids: [], joined_at: iso(), timed_out_until: null, nickname: null, invited_by: null, invite_code: null, ghost: false, ...fields };
    this.members.set(`${guildId}:${userId}`, m);
    // Joining marks the existing history read.
    for (const ch of this.guildChannels(guildId)) {
      const last = this.lastMessageId(ch.channel_id);
      if (last) this.setRead(userId, ch.channel_id, { last_read_id: last, mention_count: 0 });
    }
    return m;
  }

  // A visible join: events plus the system message (guilds.py announce_join).
  announceJoin(guildId, userId) {
    const m = this.member(guildId, userId);
    if (userId !== this.me) {
      this.toGuild(guildId, "guild.member_joined", () => ({ guild_id: guildId, member: this.serializeMember(m) }));
      const status = this.visibleStatus(userId);
      if (status !== "offline") this.toGuild(guildId, "presence.update", { user_id: userId, status });
    }
    this.systemMessage(guildId, userId, LIMITS.SYSTEM_JOIN, "member_join");
  }

  systemMessage(guildId, userId, flag, type) {
    const g = this.guilds.get(guildId);
    const ch = g && this.channels.get(g.system_channel_id);
    if (!ch || ch.kind !== "text" || !(g.system_flags & flag)) return;
    this.postMessage({ channel_id: ch.channel_id, author_id: userId, content: "", type });
  }

  // Remove a membership and send the events for `reason` (left | kicked | banned).
  dropMember(guildId, userId, reason) {
    const m = this.member(guildId, userId);
    if (!m) return;
    const v = this.voice.get(userId);
    if (v?.guild_id === guildId) this.leaveVoice(userId);
    this.members.delete(`${guildId}:${userId}`);
    if (userId === this.me) {
      if (reason !== "left") this.emit("guild.removed", { guild_id: guildId, reason });
      if (this.channels.get(this.focus)?.guild_id === guildId) this.focus = null;
      return;
    }
    if (!m.ghost) {
      this.toGuild(guildId, "guild.member_left", { guild_id: guildId, user_id: userId, reason });
      this.systemMessage(guildId, userId, LIMITS.SYSTEM_LEAVE, "member_leave");
    }
  }

  removeGuild(guildId) {
    const wasMember = this.me && this.member(guildId, this.me);
    for (const ch of this.guildChannels(guildId)) {
      for (const id of [...(this.channelMessages.get(ch.channel_id) || [])]) this.removeMessage(id);
      this.channels.delete(ch.channel_id);
      this.channelMessages.delete(ch.channel_id);
    }
    for (const key of [...this.members.keys()]) if (key.startsWith(`${guildId}:`)) this.members.delete(key);
    for (const [id, r] of this.roles) if (r.guild_id === guildId) this.roles.delete(id);
    for (const [id, e] of this.emojis) if (e.guild_id === guildId) this.emojis.delete(id);
    for (const [id, x] of this.stickers) if (x.guild_id === guildId) this.stickers.delete(id);
    for (const [code, i] of this.invites) if (i.guild_id === guildId) this.invites.delete(code);
    for (const [id, v] of this.voice) if (v.guild_id === guildId) this.voice.delete(id);
    this.guilds.delete(guildId);
    if (wasMember) this.emit("guild.removed", { guild_id: guildId, reason: "deleted" });
  }

  leaveVoice(userId) {
    const v = this.voice.get(userId);
    if (!v) return;
    this.voice.delete(userId);
    this.toGuild(v.guild_id, "voice.state_updated", { ...v, channel_id: null });
  }

  // Store a message and send message.new, bumping read state and mentions
  // the way the real server does. Returns the stored message.
  postMessage(fields) {
    const ch = this.channels.get(fields.channel_id);
    const m = {
      message_id: newId(), content: "", sent_at: iso(), edited_at: null, reply_to_id: null, mentions: [],
      mention_everyone: false, reactions: [], type: "default", pinned: false, embeds: [], embeds_suppressed: false,
      command: null, poll: null, forward: null, attachment_ids: [], stickers: [],
      ...fields,
    };
    m.sent_at = fields.sent_at || iso(idTime(m.message_id));
    this.addMessage(m);
    // Your own messages mark the channel read up to them.
    this.setRead(m.author_id, ch.channel_id, { last_read_id: m.message_id, mention_count: 0 });
    if (ch.guild_id) {
      const viewers = this.guildMembers(ch.guild_id).map((x) => x.user_id);
      for (const uid of viewers) {
        if (uid === m.author_id || !this.canView(uid, ch)) continue;
        if (m.mentions.includes(uid) || (m.mention_everyone)) {
          const rs = this.readStates.get(`${uid}:${ch.channel_id}`) || { last_read_id: null, mention_count: 0 };
          this.setRead(uid, ch.channel_id, { mention_count: rs.mention_count + 1 });
        }
      }
    } else {
      // A DM appears for everyone in it with its first message (or reopens).
      const appears = this.me && ch.recipients.includes(this.me) && !ch.open.has(this.me);
      for (const uid of ch.recipients) ch.open.add(uid);
      if (appears && this.userDms(this.me).includes(ch)) this.emit("dm.created", this.serializeChannel(ch));
      if (m.author_id !== this.me && this.me && ch.recipients.includes(this.me) && m.mentions.includes(this.me)) {
        const rs = this.readStates.get(`${this.me}:${ch.channel_id}`) || { last_read_id: null, mention_count: 0 };
        this.setRead(this.me, ch.channel_id, { mention_count: rs.mention_count + 1 });
      }
    }
    this.messageEvent("message.new", m);
    return m;
  }

  // --- server info ------------------------------------------------------------------------------

  serverInfo() {
    return {
      ...structuredClone(this.config),
      protocol_version: PROTOCOL_VERSION,
      setup_required: false,
      legal_version: this.legal.version,
      has_terms: !!this.legal.terms,
      has_privacy: !!this.legal.privacy,
    };
  }
}

// Small checks shared by the handlers.
export function str(v, { max = Infinity, min = 0, field = "text", trim = true } = {}) {
  if (typeof v !== "string") badRequest(`${field} must be text.`);
  const s = trim ? v.trim() : v;
  if (s.length < min) badRequest(`${field} is too short.`);
  if (s.length > max) fail(ERR.CONTENT_TOO_LONG, `${field} is too long (at most ${max} characters).`);
  return s;
}
export const optStr = (v, opts) => (v === undefined || v === null || v === "" ? null : str(v, opts));
export const oneOf = (v, list, field = "value") => { if (!list.includes(v)) badRequest(`Unknown ${field}.`); return v; };
export { ALL_PERMS, DM_PERMS, LIMITS, PERMS, ERR };
