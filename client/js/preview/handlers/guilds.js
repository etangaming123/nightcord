// Guilds, invites, roles, members and moderation, custom emoji and stickers
// (PROTOCOL.md §5 Guilds, Roles, Members, Emoji and stickers; §6, §7).

import {
  ALL_PERMS, ERR, LIMITS, PERMS, badRequest, fail, forbidden, iso, newId, notFound, optStr, str,
} from "../server.js";

const MAX_ROLES = 50;
const HEX = /^#[0-9a-f]{6}$/i;
const INVITE_CHARS = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function inviteCode() {
  let code = "";
  for (let i = 0; i < 8; i++) code += INVITE_CHARS[Math.floor(Math.random() * INVITE_CHARS.length)];
  return code;
}

export default function register(s) {
  const guildFor = (g, uid) => s.serializeGuild(g, uid);

  // --- guilds --------------------------------------------------------------------------

  s.on("guild.list", (uid) => ({
    guilds: [...s.guilds.values()].filter((g) => s.member(g.guild_id, uid)).map((g) => guildFor(g, uid)),
  }));

  s.on("guild.create", (uid, p) => {
    const name = str(p.name, { min: 1, max: LIMITS.GUILD_NAME_MAX, field: "Name" });
    if (s.config.guild_creation !== "on" && !s.users.get(uid).is_server_owner) {
      fail(ERR.GUILD_CREATION_DISABLED, "Guild creation is disabled on this server");
    }
    const g = s.createGuild(name, uid);
    return { guild: guildFor(g, uid), channels: s.guildChannels(g.guild_id).map((c) => s.serializeChannel(c, uid)) };
  });

  s.on("guild.public_list", () => {
    if (!s.config.guild_list_visible) return { guilds: [] };
    return {
      guilds: [...s.guilds.values()].filter((g) => g.listed).map((g) => ({ ...s.plainGuild(g), member_count: s.guildMembers(g.guild_id).length })),
    };
  });

  const join = (uid, g, invite = null, viaVanity = false) => {
    const existing = s.member(g.guild_id, uid);
    if (existing && !existing.ghost) fail(ERR.ALREADY_MEMBER, "You're already in this guild");
    if (s.bans.has(`${g.guild_id}:${uid}`)) fail(ERR.BANNED, "You're banned from this guild");
    if (existing) s.members.delete(`${g.guild_id}:${uid}`);
    if (invite) invite.uses += 1;
    s.addMember(g.guild_id, uid, {
      invited_by: invite ? invite.inviter_id : null,
      invite_code: invite ? invite.code : viaVanity ? g.vanity_code : null,
    });
    s.announceJoin(g.guild_id, uid);
    return { guild: guildFor(g, uid) };
  };

  const checkInvite = (code) => {
    const c = String(code || "").trim();
    const invite = s.invites.get(c) || [...s.invites.values()].find((i) => i.code.toLowerCase() === c.toLowerCase());
    if (!invite) {
      const g = [...s.guilds.values()].find((x) => x.vanity_code && x.vanity_code === c.toLowerCase());
      if (!g) fail(ERR.INVITE_INVALID, "That invite is invalid or has been revoked");
      return { invite: null, guild: g };
    }
    const g = s.guilds.get(invite.guild_id);
    if (invite.revoked || !g) fail(ERR.INVITE_INVALID, "That invite is invalid or has been revoked");
    if ((invite.max_uses && invite.uses >= invite.max_uses) || (invite.expires_at && new Date(invite.expires_at) < new Date())) {
      fail(ERR.INVITE_EXPIRED, "That invite has expired");
    }
    return { invite, guild: g };
  };

  s.on("guild.join_by_code", (uid, p) => {
    const { invite, guild } = checkInvite(p.invite_code);
    return join(uid, guild, invite, !invite);
  });

  s.on("guild.join_by_id", (uid, p) => {
    const g = s.guilds.get(p.guild_id);
    if (!g || !g.listed || !s.config.guild_list_visible) notFound("Guild");
    return join(uid, g);
  });

  s.on("guild.owner_override_join", (uid, p) => {
    s.requireStaff(uid, "admin");
    const g = s.requireGuild(p.guild_id);
    if (s.member(g.guild_id, uid)) fail(ERR.ALREADY_MEMBER, "You're already in this guild");
    s.addMember(g.guild_id, uid, { ghost: true });
    return { guild: guildFor(g, uid) };
  });

  s.on("guild.leave", (uid, p) => {
    const g = s.requireGuild(p.guild_id);
    s.requireMember(g.guild_id, uid);
    if (g.owner_user_id === uid) forbidden("The guild owner can't leave their own guild");
    s.dropMember(g.guild_id, uid, "left");
    return {};
  });

  s.on("guild.delete", (uid, p) => {
    const g = s.requireGuild(p.guild_id);
    if (g.owner_user_id !== uid || s.member(g.guild_id, uid)?.ghost) forbidden("Only the guild owner can delete it.");
    s.removeGuild(g.guild_id);
    return {};
  });

  s.on("guild.members", (uid, p) => {
    s.requireMember(p.guild_id, uid);
    return { members: s.guildMembers(p.guild_id).map((m) => s.serializeMember(m)) };
  });

  const guildUpdated = (g) => s.toGuild(g.guild_id, "guild.updated", () => s.plainGuild(g));

  s.on("guild.config.update", (uid, p) => {
    const g = s.requireGuild(p.guild_id);
    s.requireGuildPerm(uid, g.guild_id, PERMS.MANAGE_GUILD);
    const changes = {};
    if (p.name !== undefined && p.name !== null) changes.name = str(p.name, { min: 1, max: LIMITS.GUILD_NAME_MAX, field: "Name" });
    if (typeof p.listed === "boolean") changes.listed = p.listed;
    if ("system_channel_id" in p) {
      const ch = p.system_channel_id && s.channels.get(p.system_channel_id);
      if (p.system_channel_id && (!ch || ch.guild_id !== g.guild_id || ch.kind !== "text")) {
        badRequest("The system channel must be a text channel in this guild");
      }
      changes.system_channel_id = p.system_channel_id || null;
    }
    if (p.system_flags !== undefined && p.system_flags !== null) {
      if (p.system_flags < 0 || p.system_flags & ~(LIMITS.SYSTEM_JOIN | LIMITS.SYSTEM_LEAVE)) badRequest("Unknown system message flags");
      changes.system_flags = p.system_flags;
    }
    if ("vanity_code" in p) {
      let v = p.vanity_code;
      if (v !== null) {
        v = String(v).trim().toLowerCase();
        if (!LIMITS.VANITY_RE.test(v)) badRequest("Vanity links must be 3-32 characters: a-z, 0-9, -");
        if ([...s.guilds.values()].some((x) => x.guild_id !== g.guild_id && x.vanity_code === v) || s.invites.has(v)) {
          badRequest("That vanity link is taken");
        }
      }
      changes.vanity_code = v;
    }
    if ("banner_media_id" in p) {
      changes.banner_id = p.banner_media_id === null ? null : s.mediaRef(s.claimMedia(p.banner_media_id, "guild_banner"));
    }
    Object.assign(g, changes);
    if (Object.keys(changes).length) {
      s.guildLog(g.guild_id, uid, "guild.update", g.guild_id, Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, k === "banner_id" ? !!v : v])));
    }
    guildUpdated(g);
    return { guild: s.plainGuild(g) };
  });

  s.on("guild.icon.set", (uid, p) => {
    const g = s.requireGuild(p.guild_id);
    s.requireGuildPerm(uid, g.guild_id, PERMS.MANAGE_GUILD);
    if (p.media_id !== undefined && p.media_id !== null) g.icon_id = s.mediaRef(s.claimMedia(p.media_id, "guild_icon"));
    else if (p.data_b64) g.icon_id = s.addMedia("guild_icon", { url: `data:image/png;base64,${p.data_b64}` }).media_id;
    else g.icon_id = null;
    s.guildLog(g.guild_id, uid, "guild.update", g.guild_id, { icon: !!g.icon_id });
    guildUpdated(g);
    return { guild: s.plainGuild(g) };
  });

  // --- invites -----------------------------------------------------------------------------

  const serializeInvite = (i) => ({
    code: i.code, guild_id: i.guild_id, inviter: s.publicUser(i.inviter_id), uses: i.uses, max_uses: i.max_uses,
    expires_at: i.expires_at, created_at: i.created_at,
  });
  const activeInvite = (i) => !i.revoked && !(i.max_uses && i.uses >= i.max_uses) && !(i.expires_at && new Date(i.expires_at) < new Date());

  s.on("guild.invite.create", (uid, p) => {
    s.requireGuild(p.guild_id);
    s.requireGuildPerm(uid, p.guild_id, PERMS.CREATE_INVITE);
    const maxUses = p.max_uses || 0;
    const maxAge = p.max_age_seconds || 0;
    if (!LIMITS.INVITE_MAX_USES.includes(maxUses)) badRequest("Pick a number of uses from the list.");
    if (!LIMITS.INVITE_MAX_AGES.includes(maxAge)) badRequest("Pick an expiry from the list.");
    const invite = {
      code: inviteCode(), guild_id: p.guild_id, inviter_id: uid, uses: 0, max_uses: maxUses,
      expires_at: maxAge ? iso(Date.now() + maxAge * 1000) : null, created_at: iso(), revoked: false,
    };
    s.invites.set(invite.code, invite);
    return { invite_code: invite.code, invite: serializeInvite(invite) };
  });

  s.on("guild.invite.list", (uid, p) => {
    const m = s.requireMember(p.guild_id, uid);
    const all = m.ghost || s.guildPerms(uid, p.guild_id) & PERMS.MANAGE_GUILD;
    const invites = [...s.invites.values()].filter((i) => i.guild_id === p.guild_id && activeInvite(i) && (all || i.inviter_id === uid));
    return { invites: invites.map(serializeInvite) };
  });

  s.on("guild.invite.revoke", (uid, p) => {
    const i = s.invites.get(p.invite_code);
    if (!i || i.revoked) notFound("Invite");
    const m = s.requireMember(i.guild_id, uid);
    if (m.ghost || !(i.inviter_id === uid || s.guildPerms(uid, i.guild_id) & PERMS.MANAGE_GUILD)) forbidden("You can only revoke your own invites");
    i.revoked = true;
    s.guildLog(i.guild_id, uid, "invite.revoke", i.inviter_id, { code: i.code });
    return {};
  });

  s.on("guild.invite.resolve", (uid, p) => {
    const { invite, guild: g } = checkInvite(p.invite_code);
    const members = s.guildMembers(g.guild_id);
    return {
      guild: { guild_id: g.guild_id, name: g.name, icon_id: g.icon_id, banner_id: g.banner_id },
      member_count: members.length,
      online_count: members.filter((m) => s.visibleStatus(m.user_id) !== "offline").length,
      inviter: invite ? s.publicUser(invite.inviter_id) : null,
      expires_at: invite?.expires_at || null,
      is_member: !!s.member(g.guild_id, uid) && !s.member(g.guild_id, uid).ghost,
    };
  });

  // --- bans and audit log ----------------------------------------------------------------------

  s.on("guild.bans.list", (uid, p) => {
    s.requireGuildPerm(uid, p.guild_id, PERMS.BAN_MEMBERS);
    const bans = [...s.bans.entries()].filter(([k]) => k.startsWith(`${p.guild_id}:`))
      .map(([k, b]) => ({ user: s.publicUser(k.split(":")[1]), reason: b.reason, created_at: b.created_at }));
    return { bans };
  });

  s.on("guild.audit_log", (uid, p) => {
    s.requireGuildPerm(uid, p.guild_id, PERMS.VIEW_AUDIT_LOG);
    const limit = Math.max(1, Math.min(p.limit || 50, 100));
    let entries = s.guildAudit.filter((e) => e.guild_id === p.guild_id);
    if (p.before) entries = entries.filter((e) => BigInt(e.entry_id) < BigInt(p.before));
    return { entries: entries.slice(0, limit).map((e) => s.serializeAudit(e)), has_more: entries.length > limit };
  });

  // --- roles ---------------------------------------------------------------------------------

  const permsChanged = (guildId) => s.toGuild(guildId, "guild.permissions_changed", { guild_id: guildId });
  const roleEvent = (type, r) => s.toGuild(r.guild_id, type, () => s.serializeRole(r));

  const permBits = (v) => {
    if (v === undefined || v === null) return null;
    if (!Number.isInteger(v) || v < 0 || v & ~ALL_PERMS) badRequest("Unknown permission bits");
    return v;
  };
  const checkGrantable = (uid, guildId, oldBits, newBits) => {
    if ((newBits & ~oldBits) & ~s.guildPerms(uid, guildId)) forbidden("You can't grant permissions you don't have");
  };
  const requireRole = (uid, p) => {
    const r = s.roles.get(p.role_id);
    if (!r) notFound("Role");
    s.requireGuildPerm(uid, r.guild_id, PERMS.MANAGE_ROLES);
    return r;
  };
  const requireBelow = (uid, r) => {
    if (r.role_id !== r.guild_id && r.position >= s.rank(r.guild_id, uid)) forbidden("That role is not below your highest role");
  };
  const cosmetics = (p, role) => {
    const out = {};
    if ("colors" in p) {
      const c = p.colors;
      if (c !== null && !(Array.isArray(c) && c.length >= 2 && c.length <= LIMITS.MAX_ROLE_COLORS && c.every((x) => HEX.test(x)))) badRequest("Pick 2–3 colours.");
      if (c && role?.role_id === role?.guild_id) badRequest("@everyone has no color");
      if (c) out.color = c[0];
      out.colors = c;
    }
    if ("icon_emoji" in p) { out.icon_emoji = p.icon_emoji || null; if (!("icon_id" in out)) out.icon_id = null; }
    if ("icon_media_id" in p) {
      out.icon_id = p.icon_media_id === null ? null : s.mediaRef(s.claimMedia(p.icon_media_id, "role_icon"));
      if (out.icon_id) out.icon_emoji = null;
    }
    return out;
  };

  s.on("role.list", (uid, p) => {
    s.requireMember(p.guild_id, uid);
    return { roles: s.guildRoles(p.guild_id).map((r) => s.serializeRole(r)) };
  });

  s.on("role.create", (uid, p) => {
    s.requireGuild(p.guild_id);
    s.requireGuildPerm(uid, p.guild_id, PERMS.MANAGE_ROLES);
    if (s.guildRoles(p.guild_id).length >= MAX_ROLES) badRequest(`A guild can have at most ${MAX_ROLES} roles`);
    const name = optStr(p.name, { max: LIMITS.ROLE_NAME_MAX, field: "Name" }) || "new role";
    if (p.color && !HEX.test(p.color)) badRequest("Colours look like #rrggbb.");
    const permissions = permBits(p.permissions) || 0;
    checkGrantable(uid, p.guild_id, 0, permissions);
    const myRank = s.rank(p.guild_id, uid);
    const others = s.guildRoles(p.guild_id).filter((r) => r.role_id !== r.guild_id);
    const position = myRank === Infinity ? others.length + 1 : Math.max(1, myRank);
    for (const r of others) if (r.position >= position) r.position += 1;
    const role = {
      role_id: newId(), guild_id: p.guild_id, name, color: p.color || null, permissions, position,
      hoist: !!p.hoist, colors: null, icon_id: null, icon_emoji: null, ...cosmetics(p, null),
    };
    s.roles.set(role.role_id, role);
    s.guildLog(p.guild_id, uid, "role.create", role.role_id, { name });
    roleEvent("role.created", role);
    if (myRank !== Infinity) for (const r of others) if (r.position > position) roleEvent("role.updated", r);
    permsChanged(p.guild_id);
    return { role: s.serializeRole(role) };
  });

  s.on("role.update", (uid, p) => {
    const role = requireRole(uid, p);
    requireBelow(uid, role);
    const everyone = role.role_id === role.guild_id;
    const fields = {};
    if (p.name !== undefined && p.name !== null) {
      if (everyone) badRequest("@everyone can't be renamed");
      fields.name = str(p.name, { min: 1, max: LIMITS.ROLE_NAME_MAX, field: "Role name" });
    }
    if ("color" in p) {
      if (p.color !== null && !HEX.test(p.color)) badRequest("Colours look like #rrggbb.");
      fields.color = p.color;
      if (!("colors" in p)) fields.colors = null;
    }
    if (typeof p.hoist === "boolean") {
      if (everyone) badRequest("@everyone can't be displayed separately");
      fields.hoist = p.hoist;
    }
    const bits = permBits(p.permissions);
    if (bits !== null) { checkGrantable(uid, role.guild_id, role.permissions, bits); fields.permissions = bits; }
    Object.assign(fields, cosmetics(p, role));
    if (!Object.keys(fields).length) badRequest("Nothing to update");
    Object.assign(role, fields);
    s.guildLog(role.guild_id, uid, "role.update", role.role_id, { name: role.name });
    roleEvent("role.updated", role);
    if ("permissions" in fields) permsChanged(role.guild_id);
    return { role: s.serializeRole(role) };
  });

  s.on("role.reorder", (uid, p) => {
    s.requireGuildPerm(uid, p.guild_id, PERMS.MANAGE_ROLES);
    const current = s.guildRoles(p.guild_id).filter((r) => r.role_id !== r.guild_id);
    const ids = p.role_ids || [];
    if (ids.length !== current.length || new Set(ids).size !== ids.length || !current.every((r) => ids.includes(r.role_id))) {
      badRequest("'role_ids' must list every role except @everyone");
    }
    const myRank = s.rank(p.guild_id, uid);
    const next = Object.fromEntries(ids.map((id, i) => [id, ids.length - i]));
    for (const r of current) {
      if (r.position !== next[r.role_id] && (r.position >= myRank || next[r.role_id] >= myRank)) forbidden("You can only move roles below your highest role");
    }
    for (const r of current) {
      if (r.position !== next[r.role_id]) { r.position = next[r.role_id]; roleEvent("role.updated", r); }
    }
    s.guildLog(p.guild_id, uid, "role.reorder");
    permsChanged(p.guild_id);
    return { roles: s.guildRoles(p.guild_id).map((r) => s.serializeRole(r)) };
  });

  s.on("role.delete", (uid, p) => {
    const role = requireRole(uid, p);
    if (role.role_id === role.guild_id) badRequest("@everyone can't be deleted");
    requireBelow(uid, role);
    s.roles.delete(role.role_id);
    for (const m of s.members.values()) if (m.guild_id === role.guild_id) m.role_ids = m.role_ids.filter((id) => id !== role.role_id);
    for (const ch of s.guildChannels(role.guild_id)) ch.overwrites = (ch.overwrites || []).filter((o) => o.role_id !== role.role_id);
    for (const r of s.guildRoles(role.guild_id)) {
      if (r.role_id !== r.guild_id && r.position > role.position) { r.position -= 1; roleEvent("role.updated", r); }
    }
    s.guildLog(role.guild_id, uid, "role.delete", role.role_id, { name: role.name });
    s.toGuild(role.guild_id, "role.deleted", { guild_id: role.guild_id, role_id: role.role_id });
    permsChanged(role.guild_id);
    return {};
  });

  // --- members and moderation ---------------------------------------------------------------------

  const memberUpdated = (guildId, userId) => {
    const m = s.member(guildId, userId);
    s.toGuild(guildId, "guild.member_updated", () => ({ guild_id: guildId, member: s.serializeMember(m) }));
    if (userId === s.me) s.emit("guild.permissions_changed", { guild_id: guildId });
  };

  s.on("member.roles.set", (uid, p) => {
    s.requireGuildPerm(uid, p.guild_id, PERMS.MANAGE_ROLES);
    const m = p.user_id === uid ? s.requireMember(p.guild_id, uid) : s.requireOutranks(p.guild_id, uid, p.user_id);
    const wanted = [...new Set(p.role_ids || [])];
    for (const id of wanted) if (!s.role(p.guild_id, id) || id === p.guild_id) badRequest("Unknown role");
    const myRank = s.rank(p.guild_id, uid);
    const diff = [...wanted.filter((id) => !m.role_ids.includes(id)), ...m.role_ids.filter((id) => !wanted.includes(id))];
    for (const id of diff) if (s.roles.get(id).position >= myRank) forbidden(`'${s.roles.get(id).name}' is not below your highest role`);
    const added = wanted.filter((id) => !m.role_ids.includes(id)).map((id) => s.roles.get(id).name);
    const removed = m.role_ids.filter((id) => !wanted.includes(id)).map((id) => s.roles.get(id)?.name);
    m.role_ids = wanted;
    s.guildLog(p.guild_id, uid, "member.roles", p.user_id, { added, removed });
    memberUpdated(p.guild_id, p.user_id);
    return { member: s.serializeMember(m) };
  });

  s.on("member.kick", (uid, p) => {
    s.requireGuildPerm(uid, p.guild_id, PERMS.KICK_MEMBERS);
    s.requireOutranks(p.guild_id, uid, p.user_id);
    s.guildLog(p.guild_id, uid, "member.kick", p.user_id, { reason: p.reason || null });
    s.dropMember(p.guild_id, p.user_id, "kicked");
    return {};
  });

  s.on("member.ban", (uid, p) => {
    const g = s.requireGuild(p.guild_id);
    s.requireGuildPerm(uid, g.guild_id, PERMS.BAN_MEMBERS);
    s.requireUser(p.user_id);
    const m = s.member(g.guild_id, p.user_id);
    if (m && !m.ghost) s.requireOutranks(g.guild_id, uid, p.user_id);
    else if (p.user_id === uid || p.user_id === g.owner_user_id) forbidden("You can't ban that user");
    const secs = p.delete_seconds || 0;
    if (secs < 0 || secs > 7 * 86400) badRequest("'delete_seconds' must be between 0 and 7 days");
    s.bans.set(`${g.guild_id}:${p.user_id}`, { reason: p.reason || null, created_at: iso(), by: uid });
    s.guildLog(g.guild_id, uid, "member.ban", p.user_id, { reason: p.reason || null });
    if (m) s.dropMember(g.guild_id, p.user_id, "banned");
    if (secs) {
      const since = Date.now() - secs * 1000;
      for (const ch of s.guildChannels(g.guild_id)) {
        for (const id of [...(s.channelMessages.get(ch.channel_id) || [])]) {
          const msg = s.messages.get(id);
          if (msg.author_id === p.user_id && new Date(msg.sent_at).getTime() >= since) {
            s.removeMessage(id);
            if (s.me && s.canView(s.me, ch)) s.emit("message.deleted", { channel_id: ch.channel_id, guild_id: g.guild_id, message_id: id });
          }
        }
      }
    }
    return {};
  });

  s.on("member.unban", (uid, p) => {
    s.requireGuildPerm(uid, p.guild_id, PERMS.BAN_MEMBERS);
    if (!s.bans.delete(`${p.guild_id}:${p.user_id}`)) notFound("That ban");
    s.guildLog(p.guild_id, uid, "member.unban", p.user_id);
    return {};
  });

  s.on("member.timeout", (uid, p) => {
    s.requireGuildPerm(uid, p.guild_id, PERMS.MODERATE_MEMBERS);
    const m = s.requireOutranks(p.guild_id, uid, p.user_id);
    const secs = p.duration_seconds;
    if (secs !== null && secs !== undefined && !(secs > 0 && secs <= LIMITS.MAX_TIMEOUT_SECONDS)) badRequest("'duration_seconds' must be between 1 second and 28 days");
    m.timed_out_until = secs ? iso(Date.now() + secs * 1000) : null;
    s.guildLog(p.guild_id, uid, "member.timeout", p.user_id, { until: m.timed_out_until, reason: p.reason || null });
    memberUpdated(p.guild_id, p.user_id);
    return { member: s.serializeMember(m) };
  });

  s.on("member.nickname.set", (uid, p) => {
    const self = p.user_id === uid;
    s.requireGuildPerm(uid, p.guild_id, self ? PERMS.CHANGE_NICKNAME : PERMS.MANAGE_NICKNAMES);
    const m = self ? s.requireMember(p.guild_id, uid) : s.requireOutranks(p.guild_id, uid, p.user_id);
    m.nickname = optStr(p.nickname, { max: LIMITS.NICKNAME_MAX, field: "Nickname" });
    if (!self) s.guildLog(p.guild_id, uid, "member.nickname", p.user_id, { nickname: m.nickname });
    s.toGuild(p.guild_id, "guild.member_updated", () => ({ guild_id: p.guild_id, member: s.serializeMember(m) }));
    return { member: s.serializeMember(m) };
  });

  // --- custom emoji and stickers ------------------------------------------------------------------

  const emojisUpdated = (guildId) => s.toGuild(guildId, "guild.emojis_updated", () => ({ guild_id: guildId, emojis: s.guildEmojis(guildId) }));
  const stickersUpdated = (guildId) => s.toGuild(guildId, "guild.stickers_updated", () => ({ guild_id: guildId, stickers: s.guildStickers(guildId) }));
  const emojiName = (name, guildId, except = null) => {
    if (!LIMITS.EMOJI_NAME_RE.test(name || "")) badRequest("Emoji names are 2–32 letters, digits or _.");
    if ([...s.emojis.values()].some((e) => e.guild_id === guildId && e.emoji_id !== except && e.name.toLowerCase() === name.toLowerCase())) {
      badRequest("This server already has an emoji with that name.");
    }
    return name;
  };

  s.on("emoji.create", (uid, p) => {
    s.requireGuild(p.guild_id);
    s.requireGuildPerm(uid, p.guild_id, PERMS.MANAGE_EXPRESSIONS);
    if (s.guildEmojis(p.guild_id).length >= LIMITS.MAX_GUILD_EMOJI) badRequest("This server has no emoji slots left.");
    const name = emojiName(p.name, p.guild_id);
    const media = s.claimMedia(p.media_id, "emoji");
    const emoji = { emoji_id: media.media_id, guild_id: p.guild_id, name, animated: !!media.animated, creator_id: uid, created_at: iso() };
    s.emojis.set(emoji.emoji_id, emoji);
    s.guildLog(p.guild_id, uid, "emoji.create", emoji.emoji_id, { name });
    emojisUpdated(p.guild_id);
    return { emoji: { ...emoji } };
  });

  const requireEmoji = (uid, id) => {
    const e = s.emojis.get(id);
    if (!e) notFound("Emoji");
    s.requireGuildPerm(uid, e.guild_id, PERMS.MANAGE_EXPRESSIONS);
    return e;
  };

  s.on("emoji.update", (uid, p) => {
    const e = requireEmoji(uid, p.emoji_id);
    e.name = emojiName(p.name, e.guild_id, e.emoji_id);
    s.guildLog(e.guild_id, uid, "emoji.update", e.emoji_id, { name: e.name });
    emojisUpdated(e.guild_id);
    return { emoji: { ...e } };
  });

  s.on("emoji.delete", (uid, p) => {
    const e = requireEmoji(uid, p.emoji_id);
    s.emojis.delete(e.emoji_id);
    s.media.delete(e.emoji_id);
    s.guildLog(e.guild_id, uid, "emoji.delete", e.emoji_id, { name: e.name });
    emojisUpdated(e.guild_id);
    return {};
  });

  s.on("emoji.info", (uid, p) => {
    const e = s.emojis.get(p.emoji_id);
    if (!e) notFound("Emoji");
    const g = s.guilds.get(e.guild_id);
    const m = s.member(e.guild_id, uid);
    const show = g && (m || g.listed);
    return { emoji: { ...e }, guild: show ? { guild_id: g.guild_id, name: g.name, icon_id: g.icon_id } : null, is_member: !!m && !m.ghost };
  });

  const stickerFields = (p, out) => {
    if (p.name !== undefined) out.name = str(p.name, { min: 2, max: LIMITS.STICKER_NAME_MAX, field: "Sticker name" });
    if ("description" in p) out.description = optStr(p.description, { max: LIMITS.STICKER_DESCRIPTION_MAX, field: "Description" });
    if ("tag_emoji" in p) out.tag_emoji = p.tag_emoji || null;
    return out;
  };

  s.on("sticker.create", (uid, p) => {
    s.requireGuild(p.guild_id);
    s.requireGuildPerm(uid, p.guild_id, PERMS.MANAGE_EXPRESSIONS);
    if (s.guildStickers(p.guild_id).length >= LIMITS.MAX_GUILD_STICKERS) badRequest("This server has no sticker slots left.");
    const media = s.claimMedia(p.media_id, "sticker");
    const sticker = stickerFields(p, {
      sticker_id: media.media_id, guild_id: p.guild_id, name: "", description: null, tag_emoji: null,
      animated: !!media.animated, creator_id: uid, created_at: iso(),
    });
    s.stickers.set(sticker.sticker_id, sticker);
    s.guildLog(p.guild_id, uid, "sticker.create", sticker.sticker_id, { name: sticker.name });
    stickersUpdated(p.guild_id);
    return { sticker: { ...sticker } };
  });

  const requireSticker = (uid, id) => {
    const x = s.stickers.get(id);
    if (!x) notFound("Sticker");
    s.requireGuildPerm(uid, x.guild_id, PERMS.MANAGE_EXPRESSIONS);
    return x;
  };

  s.on("sticker.update", (uid, p) => {
    const x = requireSticker(uid, p.sticker_id);
    stickerFields(p, x);
    s.guildLog(x.guild_id, uid, "sticker.update", x.sticker_id, { name: x.name });
    stickersUpdated(x.guild_id);
    return { sticker: { ...x } };
  });

  s.on("sticker.delete", (uid, p) => {
    const x = requireSticker(uid, p.sticker_id);
    s.stickers.delete(x.sticker_id);
    s.guildLog(x.guild_id, uid, "sticker.delete", x.sticker_id, { name: x.name });
    stickersUpdated(x.guild_id);
    return {};
  });
}
