// Server staff tools, badges and announcements (PROTOCOL.md §5 Admin, Badges,
// Announcements; §8c). Staff checks follow the real server: mod < admin < owner,
// and every action on a person needs them ranked strictly below you.

import { ERR, LIMITS, badRequest, fail, forbidden, iso, newId, notFound, optStr, str } from "../server.js";

const DAY = 86400e3;
const SORTS = ["joined", "seen", "name", "devices"];

// A small, believable database for the Data tab: sizes follow what's stored.
function storageUsage(s) {
  const messages = [...s.messages.values()];
  const text = messages.reduce((n, m) => n + m.content.length * 2 + 260 + (m.reactions?.length || 0) * 40, 0);
  const attachments = [...s.attachments.values()];
  const media = [...s.media.values()];
  const mediaOf = (kinds) => media.filter((m) => kinds.includes(m.kind));
  const bytes = (list) => list.reduce((n, x) => n + (x.size || 0), 0);
  const pageSize = 4096;
  const cat = (key, db, files = 0, count = 0) => ({ key, bytes: db + files, db_bytes: db, file_bytes: files, files: count });
  const emoji = mediaOf(["emoji", "sticker"]);
  const images = mediaOf(["avatar", "banner", "guild_icon", "guild_banner", "role_icon", "badge"]);
  const categories = [
    cat("messages", Math.round(text * 1.9)),
    cat("attachments", attachments.length * 180, bytes(attachments), attachments.length),
    cat("emoji", emoji.length * 120, bytes(emoji), emoji.length),
    cat("images", images.length * 90, bytes(images), images.length),
    cat("previews", s.embedCache * 1400, s.embedCache * 2600, s.embedCache),
    cat("users", s.users.size * 900 + s.sessions.size * 300),
    cat("servers", s.guilds.size * 2200 + s.channels.size * 400 + s.roles.size * 200),
    cat("logs", (s.serverAudit.length + s.guildAudit.length) * 220 + s.announcements.length * 600),
    cat("other", 24576, 12288, 2),
    cat("free", s.freeBytes),
  ];
  const dbBytes = categories.reduce((n, c) => n + c.db_bytes, 0);
  const pageCount = Math.ceil(dbBytes / pageSize);
  const unclaimed = media.filter((m) => !m.claimed);
  return {
    total_bytes: categories.reduce((n, c) => n + c.bytes, 0),
    database: { file_bytes: pageCount * pageSize, wal_bytes: 12288, page_size: pageSize, page_count: pageCount, free_bytes: s.freeBytes, exact: false },
    categories,
    unclaimed_media: { count: unclaimed.length, bytes: bytes(unclaimed) },
    cached_previews: s.embedCache,
  };
}

export default function register(s) {
  const requireTarget = (uid, targetId) => {
    const u = s.users.get(targetId);
    if (!u || u.deleted) notFound("User");
    if (targetId === uid || s.staffRank(targetId) >= s.staffRank(uid)) forbidden("They rank at or above you on this server.");
    return u;
  };
  const userChanged = (id) => s.userUpdated(id);

  // --- accounts --------------------------------------------------------------------------------

  s.on("admin.users.list", (uid, p) => {
    s.requireStaff(uid, "moderator");
    let users = [...s.users.values()].filter((u) => !u.deleted);
    if (p.status) users = users.filter((u) => u.status === p.status);
    const q = String(p.query || "").toLowerCase();
    if (q) users = users.filter((u) => u.username.toLowerCase().includes(q) || (u.display_name || "").toLowerCase().includes(q));
    let list = users.map((u) => s.adminUser(u.user_id));
    for (const flag of p.flags || []) {
      if (flag === "staff") list = list.filter((u) => u.server_role !== "none");
      if (flag === "muted") list = list.filter((u) => u.muted_until);
      if (flag === "perks") list = list.filter((u) => u.perks);
      if (flag === "badges") list = list.filter((u) => u.badges.length);
      if (flag === "online") list = list.filter((u) => u.online);
    }
    const ago = (iso8601) => (iso8601 ? Date.now() - new Date(iso8601).getTime() : Infinity);
    if (p.seen === "7d") list = list.filter((u) => ago(u.last_seen) <= 7 * DAY);
    if (p.seen === "30d") list = list.filter((u) => ago(u.last_seen) <= 30 * DAY);
    if (p.seen === "inactive30") list = list.filter((u) => ago(u.last_seen) > 30 * DAY);
    if (p.seen === "never") list = list.filter((u) => !u.last_seen);
    if (p.joined === "7d") list = list.filter((u) => ago(u.created_at) <= 7 * DAY);
    if (p.joined === "30d") list = list.filter((u) => ago(u.created_at) <= 30 * DAY);
    const sort = SORTS.includes(p.sort) ? p.sort : "joined";
    const dir = p.order === "desc" ? -1 : 1;
    const key = {
      joined: (u) => u.created_at,
      seen: (u) => u.last_seen,
      name: (u) => (u.display_name || u.username).toLowerCase(),
      devices: (u) => u.device_count,
    }[sort];
    list.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      if (ka === null || ka === undefined) return kb === null || kb === undefined ? 0 : 1;
      if (kb === null || kb === undefined) return -1;
      return (ka < kb ? -1 : ka > kb ? 1 : 0) * dir;
    });
    return { users: list.slice(0, 200) };
  });

  s.on("admin.users.set_status", (uid, p) => {
    s.requireStaff(uid, "moderator");
    const u = requireTarget(uid, p.user_id);
    if (!["active", "rejected", "disabled"].includes(p.status)) badRequest("Unknown status");
    u.status = p.status;
    if (p.status !== "active") s.setPresence(u.user_id, "offline");
    s.audit(uid, "user.status", u.user_id, { status: p.status });
    return { user: s.adminUser(u.user_id) };
  });

  s.on("admin.users.reset_password", (uid, p) => {
    s.requireStaff(uid, "admin");
    const u = requireTarget(uid, p.user_id);
    u.password = Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 8);
    for (const [id, x] of s.sessions) if (x.user_id === u.user_id) s.sessions.delete(id);
    s.audit(uid, "user.reset_password", u.user_id);
    return { password: u.password };
  });

  s.on("admin.users.mute", (uid, p) => {
    s.requireStaff(uid, "moderator");
    const u = requireTarget(uid, p.user_id);
    if (p.permanent) u.muted_until = "permanent";
    else if (p.duration_seconds) {
      if (p.duration_seconds < 1 || p.duration_seconds > LIMITS.MAX_MUTE_SECONDS) badRequest("Mutes last 1 second to 365 days");
      u.muted_until = iso(Date.now() + p.duration_seconds * 1000);
    } else u.muted_until = null;
    s.audit(uid, "user.mute", u.user_id, { until: u.muted_until, reason: p.reason || null });
    return { user: s.adminUser(u.user_id) };
  });

  s.on("admin.users.delete", (uid, p) => {
    s.requireStaff(uid, "admin");
    const u = requireTarget(uid, p.user_id);
    s.audit(uid, "user.delete", u.user_id, { username: u.username });
    s.deleteUser(u.user_id);
    return {};
  });

  s.on("admin.staff.set", (uid, p) => {
    s.requireStaff(uid, "admin");
    const u = requireTarget(uid, p.user_id);
    if (!["admin", "moderator", "none"].includes(p.role)) badRequest("Unknown role");
    if (p.role === "admin" && !s.users.get(uid).is_server_owner) forbidden("Only the owner can make admins.");
    u.server_role = p.role;
    s.audit(uid, "staff.set", u.user_id, { role: p.role });
    userChanged(u.user_id);
    return { user: s.adminUser(u.user_id) };
  });

  s.on("admin.users.set_perks", (uid, p) => {
    s.requireStaff(uid, "admin");
    const u = s.requireUser(p.user_id);
    u.perks = !!p.perks;
    s.audit(uid, "user.perks", u.user_id, { perks: u.perks });
    userChanged(u.user_id);
    return { user: s.adminUser(u.user_id) };
  });

  s.on("admin.users.set_badges", (uid, p) => {
    if (!s.users.get(uid).is_server_owner) forbidden("Only the server owner hands out badges.");
    const u = s.requireUser(p.user_id);
    const ids = [...new Set(p.badge_ids || [])];
    if (ids.length > LIMITS.MAX_USER_BADGES) badRequest(`At most ${LIMITS.MAX_USER_BADGES} badges each`);
    for (const id of ids) if (!s.badges.has(id)) notFound("Badge");
    u.badges = ids;
    s.audit(uid, "user.badges", u.user_id, { badges: ids });
    userChanged(u.user_id);
    return { user: s.adminUser(u.user_id) };
  });

  // --- bans ----------------------------------------------------------------------------------------

  const ipBans = () => s.ipBans.map((b) => ({ cidr: b.cidr, reason: b.reason, banned_by: s.publicUser(b.by), created_at: b.created_at }));
  const deviceBans = () => s.deviceBans.map((b) => ({
    device_id: b.device_id, user: b.user_id ? s.publicUser(b.user_id) : null, reason: b.reason, banned_by: s.publicUser(b.by), created_at: b.created_at,
  }));

  s.on("admin.ip_bans.list", (uid) => { s.requireStaff(uid, "moderator"); return { bans: ipBans() }; });
  s.on("admin.ip_bans.add", (uid, p) => {
    s.requireStaff(uid, "moderator");
    const cidr = str(p.cidr, { min: 2, max: 64, field: "Address" });
    if (!/^[0-9a-f.:]+(\/\d{1,3})?$/i.test(cidr)) badRequest("That isn't an address or range.");
    if (cidr === "127.0.0.1" || cidr.startsWith("127.")) forbidden("That range includes your own address.");
    if (!s.ipBans.some((b) => b.cidr === cidr)) s.ipBans.push({ cidr, reason: p.reason || null, by: uid, created_at: iso() });
    s.audit(uid, "ip_ban.add", null, { cidr });
    return { bans: ipBans() };
  });
  s.on("admin.ip_bans.remove", (uid, p) => {
    s.requireStaff(uid, "moderator");
    s.ipBans = s.ipBans.filter((b) => b.cidr !== p.cidr);
    s.audit(uid, "ip_ban.remove", null, { cidr: p.cidr });
    return { bans: ipBans() };
  });

  s.on("admin.device_bans.list", (uid) => { s.requireStaff(uid, "moderator"); return { bans: deviceBans() }; });
  s.on("admin.device_bans.add", (uid, p) => {
    s.requireStaff(uid, "moderator");
    const u = requireTarget(uid, p.user_id);
    const devices = new Set([...s.sessions.values()].filter((x) => x.user_id === u.user_id).map((x) => x.device_id));
    if (!devices.size) devices.add(`device-${u.user_id.slice(-8)}`);
    for (const d of devices) {
      if (!s.deviceBans.some((b) => b.device_id === d)) s.deviceBans.push({ device_id: d, user_id: u.user_id, reason: p.reason || null, by: uid, created_at: iso() });
    }
    for (const [id, x] of s.sessions) if (x.user_id === u.user_id) s.sessions.delete(id);
    s.setPresence(u.user_id, "offline");
    s.audit(uid, "device_ban.add", u.user_id, { devices: devices.size });
    return { bans: deviceBans() };
  });
  s.on("admin.device_bans.remove", (uid, p) => {
    s.requireStaff(uid, "moderator");
    s.deviceBans = s.deviceBans.filter((b) => b.device_id !== p.device_id);
    s.audit(uid, "device_ban.remove", null, { device_id: p.device_id });
    return { bans: deviceBans() };
  });

  // --- logs, stats, storage ---------------------------------------------------------------------------

  s.on("admin.audit_log", (uid, p) => {
    s.requireStaff(uid, "moderator");
    const limit = Math.max(1, Math.min(p.limit || 50, 100));
    let entries = s.serverAudit;
    if (p.before) entries = entries.filter((e) => BigInt(e.entry_id) < BigInt(p.before));
    return { entries: entries.slice(0, limit).map((e) => s.serializeAudit(e)), has_more: entries.length > limit };
  });

  s.on("admin.stats", (uid) => {
    s.requireStaff(uid, "admin");
    const att = [...s.attachments.values()].filter((a) => a.claimed);
    const media = [...s.media.values()];
    return {
      users: [...s.users.values()].filter((u) => !u.deleted).length,
      guilds: s.guilds.size,
      messages: s.messages.size,
      attachments: { count: att.length, bytes: att.reduce((n, a) => n + a.size, 0) },
      media: { count: media.length, bytes: media.reduce((n, m) => n + m.size, 0) },
    };
  });

  s.on("admin.storage", (uid) => {
    if (!s.users.get(uid).is_server_owner) forbidden("That's for the server owner.");
    return storageUsage(s);
  });

  s.on("admin.storage.action", (uid, p) => {
    if (!s.users.get(uid).is_server_owner) forbidden("That's for the server owner.");
    if (p.action === "clear_previews") s.embedCache = 0;
    else if (p.action === "vacuum") s.freeBytes = 0;
    else if (p.action === "purge_unclaimed") {
      for (const [id, m] of s.media) if (!m.claimed && Date.now() - m.created_at > 5 * 60e3) s.media.delete(id);
      for (const [id, a] of s.attachments) if (!a.claimed) s.attachments.delete(id);
    } else badRequest("Unknown action");
    s.audit(uid, `storage.${p.action}`);
    return storageUsage(s);
  });

  // --- rules pages ----------------------------------------------------------------------------------

  s.on("admin.legal.set", (uid, p) => {
    if (!s.users.get(uid).is_server_owner) forbidden("That's for the server owner.");
    for (const key of ["terms", "privacy"]) {
      if (key in p) s.legal[key] = p[key] ? str(p[key], { max: LIMITS.LEGAL_MAX_CHARS, field: "That document" }) : null;
    }
    s.legal.version = s.legal.terms || s.legal.privacy ? newId().slice(-12) : null;
    s.users.get(uid).legal_version = s.legal.version;
    s.audit(uid, "legal.update");
    if (s.legal.version) postAnnouncement(null, "legal", "The server's rules were updated.");
    s.emit("server.config.updated", s.serverInfo());
    return { legal_version: s.legal.version, has_terms: !!s.legal.terms, has_privacy: !!s.legal.privacy };
  });

  // --- guilds ------------------------------------------------------------------------------------------

  s.on("admin.guilds.list", (uid) => {
    s.requireStaff(uid, "admin");
    return {
      guilds: [...s.guilds.values()].map((g) => ({
        ...s.plainGuild(g), member_count: s.guildMembers(g.guild_id).length, owner: s.publicUser(g.owner_user_id),
      })),
    };
  });

  s.on("admin.guilds.delete", (uid, p) => {
    s.requireStaff(uid, "admin");
    const g = s.requireGuild(p.guild_id);
    s.audit(uid, "guild.delete", g.guild_id, { name: g.name });
    s.removeGuild(g.guild_id);
    return {};
  });

  // --- badges --------------------------------------------------------------------------------------------

  const requireOwner = (uid) => { if (!s.users.get(uid).is_server_owner) forbidden("Only the server owner manages badges."); };
  const badgeList = () => [...s.badges.values()].sort((a, b) => (a.id === LIMITS.BADGE_VERIFIED ? -1 : b.id === LIMITS.BADGE_VERIFIED ? 1 : 0));
  const everyoneWith = (id) => [...s.users.values()].filter((u) => u.badges?.includes(id));

  s.on("badge.list", (uid) => { requireOwner(uid); return { badges: badgeList().map((b) => ({ ...b })) }; });

  s.on("badge.create", (uid, p) => {
    requireOwner(uid);
    if (s.badges.size - 1 >= LIMITS.MAX_BADGES) badRequest(`At most ${LIMITS.MAX_BADGES} badges`);
    const media = s.claimMedia(p.media_id, "badge");
    const badge = {
      id: media.media_id,
      name: str(p.name, { min: 1, max: LIMITS.BADGE_NAME_MAX, field: "Badge name" }),
      description: optStr(p.description, { max: LIMITS.BADGE_DESCRIPTION_MAX, field: "Description" }),
      image: s.mediaRef(media),
      inline: p.inline !== false,
    };
    s.badges.set(badge.id, badge);
    s.audit(uid, "badge.create", badge.id, { name: badge.name });
    return { badge: { ...badge } };
  });

  s.on("badge.update", (uid, p) => {
    requireOwner(uid);
    const b = s.badges.get(p.badge_id);
    if (!b) notFound("Badge");
    if (b.id === LIMITS.BADGE_VERIFIED) forbidden("The built-in badge can't be changed.");
    if (p.name !== undefined) b.name = str(p.name, { min: 1, max: LIMITS.BADGE_NAME_MAX, field: "Badge name" });
    if ("description" in p) b.description = optStr(p.description, { max: LIMITS.BADGE_DESCRIPTION_MAX, field: "Description" });
    if (typeof p.inline === "boolean") b.inline = p.inline;
    s.audit(uid, "badge.update", b.id, { name: b.name });
    for (const u of everyoneWith(b.id)) userChanged(u.user_id);
    return { badge: { ...b } };
  });

  s.on("badge.delete", (uid, p) => {
    requireOwner(uid);
    const b = s.badges.get(p.badge_id);
    if (!b) notFound("Badge");
    if (b.id === LIMITS.BADGE_VERIFIED) forbidden("The built-in badge can't be deleted.");
    const holders = everyoneWith(b.id);
    s.badges.delete(b.id);
    for (const u of holders) { u.badges = u.badges.filter((x) => x !== b.id); userChanged(u.user_id); }
    s.audit(uid, "badge.delete", b.id, { name: b.name });
    return {};
  });

  // --- announcements --------------------------------------------------------------------------------------

  const canAnnounce = (uid) => s.users.get(uid).is_server_owner || (s.config.announcements_admins && s.staffRank(uid) >= 2);
  const unreadFor = (uid) => {
    const last = s.announcementRead.get(uid) || "0";
    return s.announcements.filter((a) => BigInt(a.announcement_id) > BigInt(last)).length;
  };
  const postAnnouncement = (authorId, kind, content) => {
    const a = { announcement_id: newId(), author_id: authorId, kind, content, created_at: iso(), edited_at: null };
    s.announcements.unshift(a);
    if (s.me) s.emit("announcement.created", { ...a });
    return a;
  };
  s.postAnnouncement = postAnnouncement;

  s.on("announcement.list", (uid, p) => {
    let list = s.announcements;
    if (p.before) list = list.filter((a) => BigInt(a.announcement_id) < BigInt(p.before));
    return { announcements: list.slice(0, 50).map((a) => ({ ...a })), last_read_id: s.announcementRead.get(uid) || "0", unread: unreadFor(uid) };
  });

  s.on("announcement.create", (uid, p) => {
    if (!canAnnounce(uid)) forbidden("Only the owner can post announcements.");
    const content = str(p.content, { min: 1, max: LIMITS.ANNOUNCEMENT_MAX_CHARS, field: "Announcement" });
    return { announcement: { ...postAnnouncement(uid, "post", content) } };
  });

  const requireAnnouncement = (uid, id) => {
    if (!canAnnounce(uid)) forbidden("Only the owner can change announcements.");
    const a = s.announcements.find((x) => x.announcement_id === id);
    if (!a) notFound("Announcement");
    return a;
  };

  s.on("announcement.update", (uid, p) => {
    const a = requireAnnouncement(uid, p.announcement_id);
    if (!a.author_id) forbidden("Automatic entries can't be edited.");
    a.content = str(p.content, { min: 1, max: LIMITS.ANNOUNCEMENT_MAX_CHARS, field: "Announcement" });
    a.edited_at = iso();
    return { announcement: { ...a } };
  });

  s.on("announcement.delete", (uid, p) => {
    requireAnnouncement(uid, p.announcement_id);
    s.announcements = s.announcements.filter((x) => x.announcement_id !== p.announcement_id);
    return {};
  });

  s.on("announcement.ack", (uid, p) => {
    if (!s.announcements.some((a) => a.announcement_id === p.announcement_id)) fail(ERR.NOT_FOUND, "Announcement not found");
    const cur = s.announcementRead.get(uid) || "0";
    if (BigInt(p.announcement_id) > BigInt(cur)) s.announcementRead.set(uid, p.announcement_id);
    return { last_read_id: s.announcementRead.get(uid), unread: unreadFor(uid) };
  });
}
