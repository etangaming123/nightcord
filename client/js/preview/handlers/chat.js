// Channels, read state, notification prefs, DMs, messages, reactions, typing,
// pins, polls, saved messages, search and voice (PROTOCOL.md §5).

import {
  ERR, LIMITS, PERMS, badRequest, fail, forbidden, idCmp, idTime, iso, newId, notFound, optStr, str,
} from "../server.js";

const MAX_CHANNELS = 200;
const OVERWRITE_FLAGS = PERMS.VIEW_CHANNEL | PERMS.SEND_MESSAGES | PERMS.READ_HISTORY | PERMS.ADD_REACTIONS
  | PERMS.MENTION_EVERYONE | PERMS.MANAGE_MESSAGES | PERMS.MANAGE_CHANNELS | PERMS.ATTACH_FILES | PERMS.CONNECT;
const DURATIONS = { "1h": 3600, "4h": 14400, "8h": 28800, "1d": 86400, "3d": 259200, "1w": 604800 };
const EIGHT_BALL = [
  "It is certain.", "It is decidedly so.", "Without a doubt.", "Yes — definitely.", "You may rely on it.",
  "As I see it, yes.", "Most likely.", "Outlook good.", "Yes.", "Signs point to yes.", "Reply hazy, try again.",
  "Ask again later.", "Better not tell you now.", "Cannot predict now.", "Concentrate and ask again.",
  "Don't count on it.", "My reply is no.", "My sources say no.", "Outlook not so good.", "Very doubtful.",
];
const DICE_RE = /^\s*(\d{1,3})?\s*[dD]\s*(\d{1,5})\s*(?:([+-])\s*(\d{1,6}))?\s*$/;
const URL_RE = /(?<!<)\bhttps?:\/\/[^\s<>|]+/g;
const CUSTOM_EMOJI_RE = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{1,20})>$/;
const pick = (list) => list[Math.floor(Math.random() * list.length)];

function runCommand(raw) {
  if (!raw) return null;
  const name = raw.name;
  if (!LIMITS.SERVER_COMMANDS.includes(name)) badRequest(`Unknown command /${name}`);
  const args = String(raw.args || "").trim();
  if (args.length > LIMITS.COMMAND_ARGS_MAX) badRequest("That's too long");
  if (name === "roll") {
    const m = DICE_RE.exec(args || "1d6");
    if (!m) badRequest("Rolls look like 2d6, d20 or 3d10+2");
    const count = Number(m[1] || 1);
    const sides = Number(m[2]);
    const modifier = Number(m[4] || 0) * (m[3] === "-" ? -1 : 1);
    if (count < 1 || count > LIMITS.MAX_DICE) badRequest(`Roll between 1 and ${LIMITS.MAX_DICE} dice`);
    if (sides < 2 || sides > LIMITS.MAX_DIE_SIDES) badRequest(`Dice have 2 to ${LIMITS.MAX_DIE_SIDES} sides`);
    const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
    const notation = `${count}d${sides}${modifier ? (modifier > 0 ? `+${modifier}` : modifier) : ""}`;
    return { name, args, result: { notation, rolls, modifier, total: rolls.reduce((a, b) => a + b, 0) + modifier } };
  }
  if (name === "coinflip") return { name, args: "", result: { side: Math.random() < 0.5 ? "heads" : "tails" } };
  if (name === "8ball") {
    if (!args) badRequest("Ask it something");
    return { name, args, result: { answer: pick(EIGHT_BALL) } };
  }
  const options = args.split("|").map((o) => o.trim()).filter(Boolean);
  if (options.length < 2) badRequest("Give at least two options, separated by |");
  if (options.length > LIMITS.MAX_CHOICES) badRequest(`At most ${LIMITS.MAX_CHOICES} options`);
  return { name, args, result: { options, picked: pick(options) } };
}

function validatePoll(raw) {
  if (!raw) return null;
  const question = str(raw.question, { min: 1, max: LIMITS.POLL_QUESTION_MAX, field: "The question" });
  const answers = raw.answers;
  if (!Array.isArray(answers) || answers.length < LIMITS.POLL_MIN_ANSWERS || answers.length > LIMITS.POLL_MAX_ANSWERS) {
    badRequest(`A poll needs ${LIMITS.POLL_MIN_ANSWERS} to ${LIMITS.POLL_MAX_ANSWERS} answers`);
  }
  const duration = raw.duration || "1d";
  if (!(duration in DURATIONS)) badRequest("Pick a duration from the list.");
  return {
    question, multi: !!raw.multi, expires_at: iso(Date.now() + DURATIONS[duration] * 1000), ended_at: null,
    answers: answers.map((a, i) => ({
      answer_id: i + 1, text: str(a?.text, { min: 1, max: LIMITS.POLL_ANSWER_MAX, field: "Every answer" }), emoji: a?.emoji || null, user_ids: [],
    })),
  };
}

export default function register(s) {
  // --- channels ------------------------------------------------------------------------------

  const visibleChannels = (uid, guildId) => {
    const all = s.guildChannels(guildId).filter((c) => c.kind !== "voice" || s.config.voice_enabled);
    const seen = new Set(all.filter((c) => c.kind !== "category" && s.canView(uid, c)).map((c) => c.channel_id));
    return all.filter((c) => (c.kind === "category"
      ? s.canView(uid, c) || all.some((x) => x.parent_id === c.channel_id && seen.has(x.channel_id))
      : seen.has(c.channel_id)));
  };

  const nameFor = (kind, raw) => {
    if (kind === "text") {
      const name = String(raw || "").trim().toLowerCase().replace(/\s+/g, "-");
      if (!LIMITS.CHANNEL_NAME_RE.test(name)) badRequest("Channel names are 1–32 characters: a-z, 0-9, _ and -");
      return name;
    }
    return str(raw, { min: 1, max: LIMITS.CHANNEL_TITLE_MAX, field: "Name" });
  };

  const parseOverwrites = (guildId, raw) => {
    if (!Array.isArray(raw)) badRequest("'overwrites' must be a list");
    return raw.map((o) => {
      if (!s.role(guildId, o.role_id)) badRequest("Unknown role in overwrites");
      const allow = o.allow | 0;
      const deny = o.deny | 0;
      if ((allow | deny) & ~OVERWRITE_FLAGS) badRequest("Overwrites only take channel permissions");
      if (allow & deny) badRequest("An overwrite can't both allow and deny the same permission");
      return { role_id: o.role_id, allow, deny };
    });
  };

  const checkOverwritesAllowed = (uid, guildId, overwrites = []) => {
    const mine = s.guildPerms(uid, guildId);
    if (!(mine & PERMS.MANAGE_ROLES)) forbidden("Editing permissions needs Manage Roles");
    for (const o of overwrites) if (o.allow & ~mine) forbidden("You can't allow permissions you don't have");
  };

  // After a permission change: new channels appear, lost ones disappear.
  const channelsChanged = (changed, before) => {
    if (!s.me) return;
    for (const ch of changed) {
      const now = s.canView(s.me, ch);
      if (now && !before.get(ch.channel_id)) s.emit("channel.created", s.serializeChannel(ch));
      else if (now) s.emit("channel.updated", s.serializeChannel(ch));
      else if (before.get(ch.channel_id)) s.emit("channel.deleted", { guild_id: ch.guild_id, channel_id: ch.channel_id });
    }
  };
  const syncedChildren = (cat) => (cat.kind === "category" ? s.guildChannels(cat.guild_id).filter((c) => c.parent_id === cat.channel_id && c.perms_synced) : []);

  s.on("channel.list", (uid, p) => {
    s.requireMember(p.guild_id, uid);
    return {
      channels: visibleChannels(uid, p.guild_id).map((c) => s.serializeChannel(c, uid)),
      voice_states: s.config.voice_enabled ? [...s.voice.values()].filter((v) => v.guild_id === p.guild_id).map((v) => ({ ...v })) : [],
    };
  });

  s.on("channel.join", (uid, p) => {
    s.requireChannel(uid, p.channel_id);
    if (uid === s.me) s.focus = p.channel_id;
    return {};
  });

  s.on("channel.leave", (uid, p) => {
    if (uid === s.me && s.focus === p.channel_id) s.focus = null;
    return {};
  });

  s.on("channel.history", (uid, p) => {
    const ch = s.requireChannel(uid, p.channel_id);
    s.requireChannelPerm(uid, ch, PERMS.READ_HISTORY);
    const limit = Math.max(1, Math.min(p.limit || LIMITS.HISTORY_PAGE, 100));
    const cursors = [p.before_message_id, p.after_message_id, p.around_message_id].filter(Boolean);
    if (cursors.length > 1) badRequest("Use at most one of before/after/around_message_id");
    const ids = s.channelMessages.get(ch.channel_id) || [];
    const out = (list) => list.map((id) => s.serializeMessage(s.messages.get(id)));
    if (p.around_message_id) {
      let i = ids.findIndex((id) => idCmp(id, p.around_message_id) >= 0);
      if (i < 0) i = ids.length;
      const start = Math.max(0, i - Math.floor(limit / 2));
      const slice = ids.slice(start, start + limit);
      return { messages: out(slice), has_more: start > 0, has_more_after: start + limit < ids.length };
    }
    if (p.after_message_id) {
      const after = ids.filter((id) => idCmp(id, p.after_message_id) > 0);
      return { messages: out(after.slice(0, limit)), has_more: true, has_more_after: after.length > limit };
    }
    const older = p.before_message_id ? ids.filter((id) => idCmp(id, p.before_message_id) < 0) : ids;
    return { messages: out(older.slice(-limit)), has_more: older.length > limit, has_more_after: false };
  });

  s.on("channel.create", (uid, p) => {
    const g = s.requireGuild(p.guild_id);
    s.requireGuildPerm(uid, g.guild_id, PERMS.MANAGE_CHANNELS);
    const kind = p.kind || "text";
    if (!["text", "voice", "category"].includes(kind)) badRequest("Unknown channel kind");
    if (kind === "voice" && !s.config.voice_enabled) fail(ERR.VOICE_DISABLED, "Voice channels are turned off on this server");
    if (s.guildChannels(g.guild_id).length >= MAX_CHANNELS) badRequest(`A guild can have at most ${MAX_CHANNELS} channels`);
    const name = nameFor(kind, p.name);
    const parentId = p.parent_id || null;
    if (kind === "category" && parentId) badRequest("Categories can't be nested");
    if (parentId && s.channels.get(parentId)?.kind !== "category") badRequest("'parent_id' must be a category in this guild");
    let overwrites = [];
    if (p.overwrites?.length) {
      overwrites = parseOverwrites(g.guild_id, p.overwrites);
      checkOverwritesAllowed(uid, g.guild_id, overwrites);
    }
    const ch = s.addChannel(g.guild_id, {
      kind, name, parent_id: parentId, topic: kind === "text" ? optStr(p.topic, { max: LIMITS.TOPIC_MAX, field: "Topic" }) : null,
      overwrites, perms_synced: !!parentId && !overwrites.length,
    });
    s.guildLog(g.guild_id, uid, "channel.create", ch.channel_id, { name, kind });
    s.channelEvent("channel.created", ch);
    return { channel: s.serializeChannel(ch, uid) };
  });

  s.on("channel.update", (uid, p) => {
    const ch = s.requireChannel(uid, p.channel_id);
    if (!ch.guild_id) badRequest("Use dm.update for direct messages");
    s.requireChannelPerm(uid, ch, PERMS.MANAGE_CHANNELS);
    const fields = {};
    if (p.name !== undefined && p.name !== null) fields.name = nameFor(ch.kind, p.name);
    if (Number.isInteger(p.position)) {
      if (p.position < 0) badRequest("'position' must be >= 0");
      fields.position = p.position;
    }
    if ("topic" in p) {
      if (ch.kind !== "text") badRequest("Only text channels have topics");
      fields.topic = optStr(p.topic, { max: LIMITS.TOPIC_MAX, field: "Topic" });
    }
    if (p.slowmode_seconds !== undefined && p.slowmode_seconds !== null) {
      if (ch.kind !== "text" || !LIMITS.SLOWMODE_PRESETS.includes(p.slowmode_seconds)) badRequest("Pick a slowmode from the list.");
      fields.slowmode_seconds = p.slowmode_seconds;
    }
    let overwrites = null;
    if (p.overwrites !== undefined && p.overwrites !== null) {
      overwrites = parseOverwrites(ch.guild_id, p.overwrites);
      checkOverwritesAllowed(uid, ch.guild_id, overwrites);
      if (ch.perms_synced) fields.perms_synced = false;
    }
    if (typeof p.perms_synced === "boolean" && overwrites === null) {
      if (p.perms_synced && !ch.parent_id) badRequest("Only channels in a category can sync with it");
      checkOverwritesAllowed(uid, ch.guild_id);
      fields.perms_synced = p.perms_synced;
    }
    const permsChange = overwrites !== null || "perms_synced" in fields;
    const affected = permsChange ? [ch, ...syncedChildren(ch)] : [ch];
    const before = new Map(affected.map((c) => [c.channel_id, !!s.me && s.canView(s.me, c)]));
    if (overwrites !== null) ch.overwrites = overwrites;
    Object.assign(ch, fields);
    if (Object.keys(fields).length || overwrites) s.guildLog(ch.guild_id, uid, "channel.update", ch.channel_id, { name: ch.name });
    if (permsChange) channelsChanged(affected, before);
    else s.channelEvent("channel.updated", ch);
    return { channel: s.serializeChannel(ch, uid) };
  });

  s.on("channel.reorder", (uid, p) => {
    s.requireGuildPerm(uid, p.guild_id, PERMS.MANAGE_CHANNELS);
    if (!Array.isArray(p.channels) || !p.channels.length) badRequest("'channels' must be a non-empty list");
    const moved = [];
    for (const it of p.channels) {
      const ch = s.channels.get(it.channel_id);
      if (!ch || ch.guild_id !== p.guild_id) badRequest("Unknown channel");
      if (!Number.isInteger(it.position) || it.position < 0) badRequest("'position' must be >= 0");
      const parent = it.parent_id || null;
      if (parent && s.channels.get(parent)?.kind !== "category") badRequest("'parent_id' must be a category in this guild");
      if (ch.kind === "category" && parent) badRequest("Categories can't be nested");
      if (ch.parent_id !== parent || ch.position !== it.position) moved.push([ch, parent, it.position]);
    }
    for (const [ch, parent, position] of moved) {
      if (ch.parent_id !== parent) ch.perms_synced = false;
      ch.parent_id = parent;
      ch.position = position;
      s.channelEvent("channel.updated", ch);
    }
    if (moved.length) s.guildLog(p.guild_id, uid, "channel.reorder");
    return { channels: visibleChannels(uid, p.guild_id).map((c) => s.serializeChannel(c, uid)) };
  });

  s.on("channel.delete", (uid, p) => {
    const ch = s.requireChannel(uid, p.channel_id);
    if (!ch.guild_id) badRequest("Use dm.leave for direct messages");
    s.requireChannelPerm(uid, ch, PERMS.MANAGE_CHANNELS);
    for (const [id, v] of s.voice) if (v.channel_id === ch.channel_id) s.leaveVoice(id);
    for (const id of [...(s.channelMessages.get(ch.channel_id) || [])]) s.removeMessage(id);
    s.channels.delete(ch.channel_id);
    s.channelMessages.delete(ch.channel_id);
    if (s.focus === ch.channel_id) s.focus = null;
    s.guildLog(ch.guild_id, uid, "channel.delete", ch.channel_id, { name: ch.name });
    s.toGuild(ch.guild_id, "channel.deleted", { guild_id: ch.guild_id, channel_id: ch.channel_id });
    const children = s.guildChannels(ch.guild_id).filter((c) => c.parent_id === ch.channel_id);
    for (const c of children) {
      if (c.perms_synced) c.overwrites = (ch.overwrites || []).map((o) => ({ ...o }));
      c.parent_id = null;
      c.perms_synced = false;
      s.channelEvent("channel.updated", c);
    }
    const g = s.guilds.get(ch.guild_id);
    if (g.system_channel_id === ch.channel_id) {
      g.system_channel_id = null;
      s.toGuild(g.guild_id, "guild.updated", () => s.plainGuild(g));
    }
    return {};
  });

  // --- read state and notification prefs ---------------------------------------------------------

  s.on("channel.ack", (uid, p) => {
    const ch = s.requireChannel(uid, p.channel_id);
    if (!p.message_id) badRequest("'message_id' is required");
    if (p.unread) {
      const before = (BigInt(p.message_id) - 1n).toString();
      s.setRead(uid, ch.channel_id, { last_read_id: before });
    } else {
      const cur = s.readStates.get(`${uid}:${ch.channel_id}`)?.last_read_id;
      const next = cur && idCmp(cur, p.message_id) > 0 ? cur : p.message_id;
      s.setRead(uid, ch.channel_id, { last_read_id: next, mention_count: 0 });
    }
    return { read_state: s.readState(uid, ch) };
  });

  s.on("read_state.list", (uid) => {
    const chans = [];
    for (const g of s.guilds.values()) {
      if (!s.member(g.guild_id, uid)) continue;
      chans.push(...s.guildChannels(g.guild_id).filter((c) => c.kind === "text" && s.canView(uid, c)));
    }
    chans.push(...s.userDms(uid));
    return { read_states: chans.map((c) => s.readState(uid, c)) };
  });

  s.on("notify.prefs.get", (uid) => ({
    prefs: [...s.notifyPrefs.entries()].filter(([k]) => k.startsWith(`${uid}:`)).map(([, v]) => ({ ...v })),
  }));

  s.on("notify.prefs.set", (uid, p) => {
    if (!p.target_id) badRequest("'target_id' is required");
    const level = p.level ?? null;
    if (level !== null && !["all", "mentions", "none"].includes(level)) badRequest("Unknown level");
    const pref = { target_id: p.target_id, level, muted: !!p.muted };
    if (!level && !pref.muted) s.notifyPrefs.delete(`${uid}:${p.target_id}`);
    else s.notifyPrefs.set(`${uid}:${p.target_id}`, pref);
    return { pref };
  });

  // --- DMs ----------------------------------------------------------------------------------------

  const other = (ch, uid) => ch.recipients.find((id) => id !== uid) || null;

  // Whether `sender` may message `recipient` (dms.py dm_gate): the request
  // state to move to, or null for no change; throws when they can't.
  const dmGate = (sender, recipient, ch) => {
    if (s.blockedEither(sender, recipient)) fail(ERR.BLOCKED, "You can't message this person");
    const req = ch?.request;
    if (s.relation(sender, recipient) === "friend" || req?.state === "accepted") return null;
    if (req?.state === "pending" && req.from_user_id === recipient) return "accepted";
    const privacy = s.users.get(recipient).dm_privacy;
    if (privacy === "everyone") return null;
    if (privacy === "friends") fail(ERR.DM_NOT_ALLOWED, "They only take messages from friends");
    if (req && req.from_user_id === sender) {
      if (req.state === "declined") fail(ERR.DM_NOT_ALLOWED, "They aren't taking messages from you");
      fail(ERR.REQUEST_PENDING, "Wait for them to accept your message request");
    }
    return "pending";
  };
  s.dmGate = dmGate;

  const requireDm = (uid, id, group = false) => {
    const ch = s.channels.get(id);
    if (!ch || ch.guild_id || !ch.recipients.includes(uid)) notFound("Direct message");
    if (group && ch.kind !== "group_dm") badRequest("Only group DMs can do that");
    return ch;
  };
  const requireFriends = (uid, ids) => {
    for (const id of ids) if (s.relation(uid, id) !== "friend") fail(ERR.NOT_FRIENDS, "You can only add your friends to a group");
  };
  const newDm = (kind, recipients, fields = {}) => {
    const ch = {
      channel_id: newId(), guild_id: null, kind, name: null, owner_user_id: null, recipients: [...recipients],
      request: null, open: new Set(), ...fields,
    };
    s.channels.set(ch.channel_id, ch);
    s.channelMessages.set(ch.channel_id, []);
    return ch;
  };
  s.newDm = newDm;
  const dmToMe = (type, ch) => { if (s.me && ch.recipients.includes(s.me) && ch.open.has(s.me)) s.emit(type, s.serializeChannel(ch)); };

  s.on("dm.list", (uid) => ({
    channels: s.userDms(uid).sort((a, b) => idCmp(s.lastMessageId(b.channel_id) || b.channel_id, s.lastMessageId(a.channel_id) || a.channel_id))
      .map((c) => s.serializeChannel(c, uid)),
  }));

  s.on("dm.open", (uid, p) => {
    if (p.user_id === uid) badRequest("You can't DM yourself");
    const u = s.users.get(p.user_id);
    if (!u || u.deleted || u.status !== "active") notFound("User");
    let ch = s.dmBetween(uid, p.user_id);
    try { dmGate(uid, p.user_id, ch); } catch (e) { if (e.code !== ERR.REQUEST_PENDING) throw e; }
    if (!ch) ch = newDm("dm", [uid, p.user_id]);
    ch.open.add(uid);
    return { channel: s.serializeChannel(ch, uid) };
  });

  s.on("dm.create_group", (uid, p) => {
    const others = [...new Set((p.user_ids || []).filter((id) => id !== uid))];
    if (!others.length) badRequest("Pick at least one person");
    if (others.length + 1 > LIMITS.GROUP_DM_MAX) fail(ERR.DM_LIMIT, `Group DMs can have at most ${LIMITS.GROUP_DM_MAX} people`);
    for (const id of others) s.requireUser(id);
    requireFriends(uid, others);
    const ch = newDm("group_dm", [uid, ...others], { owner_user_id: uid });
    for (const id of ch.recipients) ch.open.add(id);
    if (uid !== s.me) dmToMe("dm.created", ch);
    return { channel: s.serializeChannel(ch, uid) };
  });

  s.on("dm.update", (uid, p) => {
    const ch = requireDm(uid, p.channel_id, true);
    ch.name = optStr(p.name, { max: LIMITS.GROUP_DM_NAME_MAX, field: "Name" });
    if (uid !== s.me) dmToMe("dm.updated", ch);
    return { channel: s.serializeChannel(ch, uid) };
  });

  s.on("dm.add_recipient", (uid, p) => {
    const ch = requireDm(uid, p.channel_id, true);
    s.requireUser(p.user_id);
    if (ch.recipients.includes(p.user_id)) fail(ERR.ALREADY_MEMBER, "They're already in this group");
    if (ch.recipients.length >= LIMITS.GROUP_DM_MAX) fail(ERR.DM_LIMIT, `Group DMs can have at most ${LIMITS.GROUP_DM_MAX} people`);
    requireFriends(uid, [p.user_id]);
    ch.recipients.push(p.user_id);
    ch.open.add(p.user_id);
    if (p.user_id === s.me) dmToMe("dm.created", ch);
    else if (uid !== s.me) dmToMe("dm.updated", ch);
    return { channel: s.serializeChannel(ch, uid) };
  });

  s.on("dm.leave", (uid, p) => {
    const ch = requireDm(uid, p.channel_id);
    if (ch.kind === "dm") ch.open.delete(uid);
    else {
      ch.recipients = ch.recipients.filter((id) => id !== uid);
      ch.open.delete(uid);
      if (uid !== s.me) dmToMe("dm.updated", ch);
    }
    if (uid === s.me && s.focus === ch.channel_id) s.focus = null;
    return {};
  });

  const requireRequest = (uid, id) => {
    const ch = requireDm(uid, id);
    if (ch.request?.state !== "pending" || ch.request.from_user_id === uid) notFound("Message request");
    return ch;
  };

  s.on("dm.request.accept", (uid, p) => {
    const ch = requireRequest(uid, p.channel_id);
    ch.request.state = "accepted";
    if (uid !== s.me) dmToMe("dm.updated", ch);
    return { channel: s.serializeChannel(ch, uid) };
  });

  s.on("dm.request.decline", (uid, p) => {
    const ch = requireRequest(uid, p.channel_id);
    ch.request.state = "declined";
    ch.open.delete(uid);
    return { channel: s.serializeChannel(ch, uid) };
  });

  // --- messages -------------------------------------------------------------------------------------

  const checkSlowmode = (uid, ch) => {
    const secs = ch.slowmode_seconds || 0;
    if (!secs || s.channelPerms(uid, ch) & (PERMS.MANAGE_MESSAGES | PERMS.MANAGE_CHANNELS)) return;
    const ids = s.channelMessages.get(ch.channel_id) || [];
    for (let i = ids.length - 1; i >= 0; i--) {
      const m = s.messages.get(ids[i]);
      if (m.author_id !== uid || m.type !== "default") continue;
      const wait = secs - (Date.now() - idTime(m.message_id)) / 1000;
      if (wait > 0) fail(ERR.SLOWMODE, `Slowmode is on; wait ${Math.ceil(wait)}s`, { retry_after: Math.ceil(wait) });
      return;
    }
  };

  const checkTimeout = (uid, ch) => {
    if (ch.guild_id && s.isTimedOut(s.member(ch.guild_id, uid))) fail(ERR.TIMED_OUT, "You're timed out in this server.");
  };

  const mentionsFor = (uid, ch, content, extra = []) => {
    const audience = new Set(ch.guild_id
      ? s.guildMembers(ch.guild_id).map((m) => m.user_id).filter((id) => s.canView(id, ch))
      : ch.recipients);
    const ids = [];
    for (const id of [...[...content.matchAll(/<@(\d{1,20})>/g)].map((m) => m[1]), ...extra]) {
      if (audience.has(id) && !ids.includes(id)) ids.push(id);
    }
    const everyone = !!ch.guild_id && !!(s.channelPerms(uid, ch) & PERMS.MENTION_EVERYONE) && /(?<![\w`])@everyone\b/.test(content);
    return { mentions: ids, everyone };
  };

  // Moves a 1:1 DM's request state before a message goes in.
  const gateDm = (uid, ch) => {
    if (ch.kind !== "dm") return;
    const to = other(ch, uid);
    const state = dmGate(uid, to, ch);
    if (state === "pending") ch.request = { from_user_id: uid, state: "pending" };
    else if (state === "accepted") {
      ch.request.state = "accepted";
      if (to === s.me) dmToMe("dm.updated", ch);
    }
  };

  // Canned previews for the links the preview knows about (seeded in seed.js);
  // anything else gets none, because the preview never fetches anything.
  const fillEmbeds = (m) => {
    if (!s.config.link_embeds || !s.embedFor) return;
    const urls = [...m.content.replace(/`[^`]*`|\|\|[\s\S]*?\|\|/g, "").matchAll(URL_RE)].map((x) => x[0]).slice(0, LIMITS.MAX_EMBEDS_PER_MESSAGE);
    const embeds = urls.map((u) => s.embedFor(u)).filter(Boolean);
    if (!embeds.length) return;
    setTimeout(() => {
      const fresh = s.messages.get(m.message_id);
      if (!fresh || fresh.content !== m.content || fresh.embeds_suppressed) return;
      fresh.embeds = embeds;
      s.messageEvent("message.updated", fresh);
    }, 350);
  };
  s.fillEmbeds = fillEmbeds;

  s.on("message.send", (uid, p) => {
    const ch = s.requireChannel(uid, p.channel_id);
    if (!["text", "dm", "group_dm"].includes(ch.kind)) badRequest("You can't send messages in that channel");
    checkTimeout(uid, ch);
    s.requireChannelPerm(uid, ch, PERMS.SEND_MESSAGES);
    s.requireNotMuted(uid);
    const attachmentIds = p.attachment_ids || [];
    const stickerIds = p.sticker_ids || [];
    if (attachmentIds.length > LIMITS.MAX_ATTACHMENTS) badRequest(`At most ${LIMITS.MAX_ATTACHMENTS} attachments`);
    if (stickerIds.length > 1) badRequest("One sticker per message");
    const command = runCommand(p.command);
    const poll = validatePoll(p.poll);
    const allowEmpty = !!(attachmentIds.length || stickerIds.length || command || poll);
    const content = typeof p.content === "string" ? p.content.trim() : "";
    if (!content && !allowEmpty) badRequest("Messages can't be empty.");
    if (content.length > LIMITS.CONTENT_MAX_CHARS) fail(ERR.CONTENT_TOO_LONG, `Messages are at most ${LIMITS.CONTENT_MAX_CHARS} characters.`);
    for (const id of stickerIds) {
      const st = s.stickers.get(id);
      if (!st) notFound("Sticker");
      const m = s.member(st.guild_id, uid);
      if (!m || m.ghost) forbidden("Join the guild these stickers are from to use them");
    }
    if (attachmentIds.length) {
      s.requireChannelPerm(uid, ch, PERMS.ATTACH_FILES);
      for (const id of attachmentIds) {
        const a = s.attachments.get(id);
        if (!a || a.claimed || a.user_id !== uid || a.channel_id !== ch.channel_id) badRequest("Unknown or already used attachment");
      }
    }
    checkSlowmode(uid, ch);
    const extra = [];
    if (p.reply_to_id) {
      const target = s.messages.get(p.reply_to_id);
      if (!target || target.channel_id !== ch.channel_id) badRequest("The message you're replying to isn't in this channel");
      if (p.mention_reply !== false && target.author_id !== uid) extra.push(target.author_id);
    }
    gateDm(uid, ch);
    const { mentions, everyone } = mentionsFor(uid, ch, content, extra);
    for (const id of attachmentIds) s.attachments.get(id).claimed = true;
    const m = s.postMessage({
      channel_id: ch.channel_id, author_id: uid, content, reply_to_id: p.reply_to_id || null, mentions,
      mention_everyone: everyone, attachment_ids: attachmentIds, stickers: stickerIds, command, poll,
    });
    fillEmbeds(m);
    s.afterMessage?.(m, uid);
    return { message_id: m.message_id, message: s.serializeMessage(m) };
  });

  s.on("message.forward", (uid, p) => {
    const src = s.requireMessage(uid, p.message_id);
    const source = s.channels.get(src.channel_id);
    const target = s.requireChannel(uid, p.channel_id);
    if (!["text", "dm", "group_dm"].includes(target.kind)) badRequest("You can't send messages in that channel");
    s.requireChannelPerm(uid, target, PERMS.SEND_MESSAGES);
    s.requireNotMuted(uid);
    checkSlowmode(uid, target);
    const note = typeof p.content === "string" ? p.content.trim() : "";
    if (note.length > LIMITS.CONTENT_MAX_CHARS) fail(ERR.CONTENT_TOO_LONG, "That note is too long.");
    gateDm(uid, target);
    const g = source.guild_id ? s.guilds.get(source.guild_id) : null;
    const forward = {
      message_id: src.message_id, channel_id: source.channel_id, guild_id: source.guild_id || null,
      source: source.guild_id ? `#${source.name}${g ? ` · ${g.name}` : ""}` : source.name || "DM",
      author: s.publicUser(src.author_id), sent_at: src.sent_at, content: src.content.slice(0, 2000),
      attachments: (src.attachment_ids || []).map((id) => s.attachments.get(id)).filter(Boolean)
        .map((a) => ({ filename: a.filename, content_type: a.content_type, size: a.size })),
    };
    const { mentions, everyone } = mentionsFor(uid, target, note);
    const m = s.postMessage({ channel_id: target.channel_id, author_id: uid, content: note, mentions, mention_everyone: everyone, forward });
    fillEmbeds(m);
    return { message_id: m.message_id, message: s.serializeMessage(m) };
  });

  s.on("message.edit", (uid, p) => {
    const m = s.requireMessage(uid, p.message_id);
    const ch = s.channels.get(m.channel_id);
    if (m.author_id !== uid || m.type !== "default") forbidden("You can only edit your own messages");
    checkTimeout(uid, ch);
    s.requireNotMuted(uid);
    const content = typeof p.content === "string" ? p.content.trim() : "";
    if (!content && !m.attachment_ids?.length) badRequest("Messages can't be empty.");
    if (content.length > LIMITS.CONTENT_MAX_CHARS) fail(ERR.CONTENT_TOO_LONG, `Messages are at most ${LIMITS.CONTENT_MAX_CHARS} characters.`);
    const { mentions, everyone } = mentionsFor(uid, ch, content);
    const target = m.reply_to_id && s.messages.get(m.reply_to_id);
    if (target && m.mentions.includes(target.author_id) && !mentions.includes(target.author_id)) mentions.push(target.author_id);
    const changed = content !== m.content;
    Object.assign(m, { content, mentions, mention_everyone: everyone, edited_at: iso() });
    if (changed) m.embeds = [];
    s.messageEvent("message.updated", m);
    if (changed) fillEmbeds(m);
    return { message: s.serializeMessage(m) };
  });

  s.on("message.delete", (uid, p) => {
    const m = s.requireMessage(uid, p.message_id);
    const ch = s.channels.get(m.channel_id);
    const own = m.author_id === uid;
    if (!own && !(ch.guild_id && s.channelPerms(uid, ch) & PERMS.MANAGE_MESSAGES)) forbidden("You can only delete your own messages");
    if (!own) s.guildLog(ch.guild_id, uid, "message.delete", m.author_id, { channel_id: ch.channel_id, channel: ch.name });
    const visible = s.me && s.canView(s.me, ch);
    s.removeMessage(m.message_id);
    if (visible) s.emit("message.deleted", { channel_id: ch.channel_id, guild_id: ch.guild_id || null, message_id: m.message_id });
    return {};
  });

  s.on("message.embeds.suppress", (uid, p) => {
    const m = s.requireMessage(uid, p.message_id);
    const ch = s.channels.get(m.channel_id);
    if (m.author_id !== uid && !(ch.guild_id && s.channelPerms(uid, ch) & PERMS.MANAGE_MESSAGES)) {
      forbidden("You can only hide previews on your own messages");
    }
    const suppressed = p.suppressed === undefined ? true : !!p.suppressed;
    if (!!m.embeds_suppressed !== suppressed) {
      m.embeds_suppressed = suppressed;
      s.messageEvent("message.updated", m);
      if (!suppressed && !m.embeds.length) fillEmbeds(m);
    }
    return { message: s.serializeMessage(m) };
  });

  // --- reactions and typing ------------------------------------------------------------------------

  const reactionEvent = (type, m, emoji, uid) => {
    const ch = s.channels.get(m.channel_id);
    if (s.me && s.canView(s.me, ch)) {
      s.emit(type, { channel_id: ch.channel_id, guild_id: ch.guild_id || null, message_id: m.message_id, emoji, user_id: uid });
    }
  };

  const checkEmoji = (emoji) => {
    if (typeof emoji !== "string" || !emoji || (emoji.length > 32 && !CUSTOM_EMOJI_RE.test(emoji))) badRequest("That isn't an emoji.");
    return emoji;
  };

  s.on("reaction.add", (uid, p) => {
    const m = s.requireMessage(uid, p.message_id);
    const ch = s.channels.get(m.channel_id);
    let emoji = checkEmoji(p.emoji);
    if (!(s.channelPerms(uid, ch) & PERMS.ADD_REACTIONS)) { checkTimeout(uid, ch); forbidden("You can't add reactions here"); }
    s.requireNotMuted(uid);
    const custom = CUSTOM_EMOJI_RE.exec(emoji);
    if (custom) {
      const existing = m.reactions.find((r) => r.emoji.endsWith(`:${custom[3]}>`));
      if (existing) emoji = existing.emoji;
      else {
        const e = s.emojis.get(custom[3]);
        if (!e) notFound("That emoji was deleted; it");
        const mem = s.member(e.guild_id, uid);
        if (!mem || mem.ghost) forbidden("Join the guild these emoji are from to use them");
        emoji = `<${e.animated ? "a" : ""}:${e.name}:${e.emoji_id}>`;
      }
    }
    let r = m.reactions.find((x) => x.emoji === emoji);
    if (!r) {
      if (m.reactions.length >= LIMITS.MAX_REACTION_EMOJI) fail(ERR.TOO_MANY_REACTIONS, "This message has too many different reactions");
      r = { emoji, user_ids: [] };
      m.reactions.push(r);
    }
    if (!r.user_ids.includes(uid)) {
      r.user_ids.push(uid);
      reactionEvent("reaction.added", m, emoji, uid);
    }
    return {};
  });

  s.on("reaction.remove", (uid, p) => {
    const m = s.requireMessage(uid, p.message_id);
    const r = m.reactions.find((x) => x.emoji === p.emoji);
    if (r?.user_ids.includes(uid)) {
      r.user_ids = r.user_ids.filter((id) => id !== uid);
      if (!r.user_ids.length) m.reactions = m.reactions.filter((x) => x !== r);
      reactionEvent("reaction.removed", m, p.emoji, uid);
    }
    return {};
  });

  s.on("typing.start", (uid, p) => {
    const ch = s.requireChannel(uid, p.channel_id);
    s.requireChannelPerm(uid, ch, PERMS.SEND_MESSAGES);
    s.requireNotMuted(uid);
    if (uid !== s.me && s.focus === ch.channel_id) {
      s.emit("typing.started", { channel_id: ch.channel_id, guild_id: ch.guild_id || null, user_id: uid });
    }
    return {};
  });

  // --- pins -----------------------------------------------------------------------------------------

  const requirePinPerm = (uid, ch) => {
    if (!ch.guild_id) { s.requireNotMuted(uid); return; }
    if (!(s.channelPerms(uid, ch) & PERMS.MANAGE_MESSAGES)) { checkTimeout(uid, ch); forbidden("Pinning messages needs Manage Messages"); }
  };

  s.on("message.pin", (uid, p) => {
    const m = s.requireMessage(uid, p.message_id);
    const ch = s.channels.get(m.channel_id);
    requirePinPerm(uid, ch);
    if (m.type !== "default") badRequest("System messages can't be pinned");
    if (!m.pinned) {
      const count = (s.channelMessages.get(ch.channel_id) || []).filter((id) => s.messages.get(id).pinned).length;
      if (count >= LIMITS.MAX_PINS) fail(ERR.PIN_LIMIT, `A channel can have at most ${LIMITS.MAX_PINS} pins`);
      m.pinned = true;
      m.pinned_at = Date.now();
      s.messageEvent("message.updated", m);
      if (ch.guild_id) s.guildLog(ch.guild_id, uid, "message.pin", m.author_id, { channel_id: ch.channel_id, channel: ch.name });
      s.postMessage({ channel_id: ch.channel_id, author_id: uid, content: "", type: "pin", reply_to_id: m.message_id });
    }
    return {};
  });

  s.on("message.unpin", (uid, p) => {
    const m = s.requireMessage(uid, p.message_id);
    requirePinPerm(uid, s.channels.get(m.channel_id));
    if (m.pinned) {
      m.pinned = false;
      m.pinned_at = null;
      s.messageEvent("message.updated", m);
    }
    return {};
  });

  s.on("channel.pins", (uid, p) => {
    const ch = s.requireChannel(uid, p.channel_id);
    s.requireChannelPerm(uid, ch, PERMS.READ_HISTORY);
    const pinned = (s.channelMessages.get(ch.channel_id) || []).map((id) => s.messages.get(id)).filter((m) => m.pinned)
      .sort((a, b) => (b.pinned_at || 0) - (a.pinned_at || 0));
    return { messages: pinned.map((m) => s.serializeMessage(m)) };
  });

  // --- polls ----------------------------------------------------------------------------------------

  const requirePoll = (uid, p) => {
    const m = s.requireMessage(uid, p.message_id);
    if (!m.poll) notFound("A poll on that message");
    if (!m.poll.ended_at && new Date(m.poll.expires_at) < new Date()) m.poll.ended_at = m.poll.expires_at;
    return m;
  };
  const pollEvent = (m) => {
    const ch = s.channels.get(m.channel_id);
    if (s.me && s.canView(s.me, ch)) {
      s.emit("poll.updated", { message_id: m.message_id, channel_id: ch.channel_id, guild_id: ch.guild_id || null, poll: s.serializePoll(m.poll) });
    }
  };

  s.on("poll.vote", (uid, p) => {
    const m = requirePoll(uid, p);
    if (m.poll.ended_at) fail(ERR.POLL_ENDED, "This poll has closed");
    if (!Array.isArray(p.answer_ids)) badRequest("'answer_ids' must be a list of answer ids");
    const chosen = [...new Set(p.answer_ids)];
    for (const id of chosen) if (!m.poll.answers.some((a) => a.answer_id === id)) badRequest("Unknown answer");
    if (!m.poll.multi && chosen.length > 1) badRequest("This poll only takes one answer");
    for (const a of m.poll.answers) {
      const has = a.user_ids.includes(uid);
      if (chosen.includes(a.answer_id) && !has) a.user_ids.push(uid);
      if (!chosen.includes(a.answer_id) && has) a.user_ids = a.user_ids.filter((x) => x !== uid);
    }
    pollEvent(m);
    return { poll: s.serializePoll(m.poll) };
  });

  s.on("poll.end", (uid, p) => {
    const m = requirePoll(uid, p);
    const ch = s.channels.get(m.channel_id);
    if (m.author_id !== uid && !(ch.guild_id && s.channelPerms(uid, ch) & PERMS.MANAGE_MESSAGES)) forbidden("Only the author can end this poll");
    if (m.poll.ended_at) fail(ERR.POLL_ENDED, "This poll has already closed");
    m.poll.ended_at = iso();
    pollEvent(m);
    return { poll: s.serializePoll(m.poll) };
  });

  // --- saved messages ------------------------------------------------------------------------------

  const savedOf = (uid) => {
    if (!s.saved.has(uid)) s.saved.set(uid, new Map());
    return s.saved.get(uid);
  };

  s.on("saved.list", (uid, p) => {
    const limit = Math.max(1, Math.min(p.limit || LIMITS.SAVED_PAGE, 50));
    const all = [...savedOf(uid).entries()].map(([id, at]) => ({ m: s.messages.get(id), at, cursor: `${at}:${id}` }))
      .filter((x) => x.m && s.channelPerms(uid, s.channels.get(x.m.channel_id)) & PERMS.READ_HISTORY)
      .sort((a, b) => b.at - a.at || idCmp(b.m.message_id, a.m.message_id));
    let rest = all;
    if (p.before) {
      const i = all.findIndex((x) => x.cursor === p.before);
      rest = i >= 0 ? all.slice(i + 1) : all;
    }
    const page = rest.slice(0, limit);
    return {
      messages: page.map((x) => ({ ...s.serializeMessage(x.m), saved_at: iso(x.at), cursor: x.cursor })),
      has_more: rest.length > limit,
      next: page.length ? page[page.length - 1].cursor : null,
      count: savedOf(uid).size,
    };
  });

  s.on("saved.add", (uid, p) => {
    s.requireMessage(uid, p.message_id);
    const map = savedOf(uid);
    if (!map.has(p.message_id) && map.size >= LIMITS.MAX_SAVED) badRequest(`You can save at most ${LIMITS.MAX_SAVED} messages`);
    if (!map.has(p.message_id)) map.set(p.message_id, Date.now());
    return { message_id: p.message_id, saved: true, count: map.size };
  });

  s.on("saved.remove", (uid, p) => {
    const map = savedOf(uid);
    map.delete(p.message_id);
    return { message_id: p.message_id, saved: false, count: map.size };
  });

  // --- search ----------------------------------------------------------------------------------------

  s.on("message.search", (uid, p) => {
    let chans;
    if (p.channel_id) {
      const ch = s.requireChannel(uid, p.channel_id);
      s.requireChannelPerm(uid, ch, PERMS.READ_HISTORY);
      chans = [ch];
    } else {
      s.requireMember(p.guild_id, uid);
      chans = s.guildChannels(p.guild_id).filter((c) => c.kind === "text" && s.channelPerms(uid, c) & PERMS.READ_HISTORY);
    }
    const words = String(p.query || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length && !p.author_id && !p.has && !p.pinned) badRequest("Search for something");
    const offset = p.offset || 0;
    const hits = [];
    for (const ch of chans) {
      for (const id of s.channelMessages.get(ch.channel_id) || []) {
        const m = s.messages.get(id);
        if (m.type !== "default") continue;
        if (p.author_id && m.author_id !== p.author_id) continue;
        if (p.pinned && !m.pinned) continue;
        if (p.before && idCmp(m.message_id, p.before) >= 0) continue;
        if (p.after && idCmp(m.message_id, p.after) <= 0) continue;
        if (words.length) {
          const tokens = m.content.toLowerCase().split(/[^\p{L}\p{N}_]+/u);
          if (!words.every((w) => tokens.some((tk) => tk.startsWith(w)))) continue;
        }
        if (p.has) {
          const types = (m.attachment_ids || []).map((a) => s.attachments.get(a)?.content_type || "");
          const ok = p.has === "file" ? types.length
            : p.has === "image" ? types.some((x) => x.startsWith("image/"))
              : p.has === "video" ? types.some((x) => x.startsWith("video/"))
                : /https?:\/\//.test(m.content);
          if (!ok) continue;
        }
        hits.push(m);
      }
    }
    hits.sort((a, b) => idCmp(b.message_id, a.message_id));
    return { messages: hits.slice(offset, offset + 25).map((m) => s.serializeMessage(m)), total: hits.length };
  });

  // --- voice (placeholder, like the real server: presence only) --------------------------------------

  s.on("voice.join", (uid, p) => {
    if (!s.config.voice_enabled) fail(ERR.VOICE_DISABLED, "Voice is turned off on this server");
    const ch = s.requireChannel(uid, p.channel_id);
    if (ch.kind !== "voice") badRequest("That isn't a voice channel");
    s.requireChannelPerm(uid, ch, PERMS.CONNECT);
    s.requireNotMuted(uid);
    if (s.voice.has(uid)) s.leaveVoice(uid);
    const v = { guild_id: ch.guild_id, channel_id: ch.channel_id, user_id: uid, self_mute: false, self_deaf: false };
    s.voice.set(uid, v);
    s.toGuild(ch.guild_id, "voice.state_updated", { ...v });
    return { voice_state: { ...v } };
  });

  s.on("voice.leave", (uid) => { s.leaveVoice(uid); return {}; });

  s.on("voice.state.set", (uid, p) => {
    const v = s.voice.get(uid);
    if (!v) badRequest("You're not in a voice channel");
    if (typeof p.self_mute === "boolean") v.self_mute = p.self_mute;
    if (typeof p.self_deaf === "boolean") v.self_deaf = p.self_deaf;
    s.toGuild(v.guild_id, "voice.state_updated", { ...v });
    return { voice_state: { ...v } };
  });
}
