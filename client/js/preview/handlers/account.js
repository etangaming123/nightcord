// Server info, rules, logging in, your own account, presence, friends and blocking
// (PROTOCOL.md §5 Server info, Legal documents, Auth, Users, Friends, Presence).

import { ERR, LIMITS, badRequest, fail, forbidden, iso, newId, notFound, oneOf, optStr, str } from "../server.js";

const CLEAR_AFTER = { "30m": 1800e3, "1h": 3600e3, "4h": 4 * 3600e3 };
const HEX = /^#[0-9a-f]{6}$/i;

function statusExpiry(option) {
  if (!option || option === "never") return null;
  if (option === "today") {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
  }
  return iso(Date.now() + CLEAR_AFTER[option]);
}

export default function register(s) {
  // --- server info and rules -----------------------------------------------------

  s.on("server.info", () => s.serverInfo());

  s.on("legal.get", () => ({ terms: s.legal.terms, privacy: s.legal.privacy, legal_version: s.legal.version }));

  s.on("legal.accept", (uid, p) => {
    if (p.legal_version !== s.legal.version) fail(ERR.LEGAL_REQUIRED, "The rules changed again; have another look.");
    s.users.get(uid).legal_version = s.legal.version;
    return { user: s.selfUser(uid) };
  });

  s.on("server.config.update", (uid, p) => {
    if (!s.users.get(uid)?.is_server_owner) forbidden("Only the server owner can change server settings.");
    const next = structuredClone(s.config);
    for (const [key, value] of Object.entries(p)) {
      if (!(key in next)) badRequest(`Unknown setting: ${key}`);
      if (key === "server_name") next[key] = str(value, { min: 1, max: LIMITS.SERVER_NAME_MAX, field: "Server name" });
      else if (key === "server_description") next[key] = str(value, { max: LIMITS.SERVER_DESCRIPTION_MAX, field: "Description" });
      else if (key === "customization_features") next[key] = { ...next[key], ...value };
      else next[key] = value;
    }
    const voiceOff = s.config.voice_enabled && !next.voice_enabled;
    s.config = next;
    s.audit(uid, "config.update", null, { keys: Object.keys(p) });
    if (voiceOff) {
      for (const [id, v] of s.voice) {
        s.voice.delete(id);
        s.emit("voice.state_updated", { ...v, channel_id: null });
      }
    }
    s.emit("server.config.updated", s.serverInfo());
    return { config: structuredClone(s.config) };
  });

  // --- auth -----------------------------------------------------------------------------

  const login = (user, deviceId) => {
    const token = `preview-${newId()}`;
    const session = {
      session_id: newId(), user_id: user.user_id, token, created_at: Date.now(), last_seen: Date.now(),
      user_agent: globalThis.navigator?.userAgent || "Nightcord preview", device_id: deviceId || "preview-device",
      ip: "127.0.0.1",
    };
    s.sessions.set(session.session_id, session);
    s.me = user.user_id;
    s.sessionToken = token;
    s.focus = null;
    if (user.presence !== "invisible") s.presence.set(user.user_id, user.presence || "online");
    return {
      session_token: token,
      user: s.selfUser(user.user_id),
      legal_update_required: !!s.legal.version && !user.is_server_owner && user.legal_version !== s.legal.version,
    };
  };

  s.on("auth.login", (_uid, p) => {
    const user = s.userByName(p.username);
    if (!user || user.password !== p.password || user.status === "rejected") fail(ERR.INVALID_CREDENTIALS, "Wrong username or password.");
    if (user.status === "pending") fail(ERR.REGISTRATION_PENDING_APPROVAL, "Your account is waiting for the owner's approval.");
    if (user.status === "disabled") fail(ERR.ACCOUNT_DISABLED, "This account has been disabled.");
    return login(user, p.device_id);
  });

  s.on("auth.resume", (_uid, p) => {
    const session = [...s.sessions.values()].find((x) => x.token === p.session_token);
    const user = session && s.users.get(session.user_id);
    if (!user || user.deleted || user.status !== "active") fail(ERR.SESSION_EXPIRED, "Please log in again.");
    session.last_seen = Date.now();
    s.me = user.user_id;
    s.sessionToken = session.token;
    s.focus = null;
    return {
      session_token: session.token, user: s.selfUser(user.user_id),
      legal_update_required: !!s.legal.version && !user.is_server_owner && user.legal_version !== s.legal.version,
    };
  });

  const createUser = (p, status) => {
    if (typeof p.username !== "string" || !LIMITS.USERNAME_RE.test(p.username)) {
      fail(ERR.INVALID_USERNAME, "Usernames are 3–32 letters, digits, _ . or -.");
    }
    const bytes = new TextEncoder().encode(String(p.password || "")).length;
    if (bytes < LIMITS.PASSWORD_MIN_BYTES || bytes > LIMITS.PASSWORD_MAX_BYTES) {
      fail(ERR.INVALID_PASSWORD, "Passwords are 8–72 characters.");
    }
    if (s.userByName(p.username)) fail(ERR.USERNAME_TAKEN, "That username is taken.");
    if (s.legal.version && p.accept_legal_version !== s.legal.version) fail(ERR.LEGAL_REQUIRED, "Accept the rules first.");
    const user = s.addUser({ username: p.username, password: p.password, status, note: p.note || null, legal_version: s.legal.version });
    return user;
  };

  s.on("auth.register", (_uid, p) => {
    if (s.config.account_creation !== "on") fail(ERR.REGISTRATION_CLOSED, "This server isn't taking new accounts.");
    return login(createUser(p, "active"), p.device_id);
  });

  s.on("auth.request_account", (_uid, p) => {
    if (s.config.account_creation === "off") fail(ERR.REGISTRATION_CLOSED, "This server isn't taking new accounts.");
    if (s.config.account_creation === "on") badRequest("Just register; no approval is needed here.");
    const user = createUser(p, "pending");
    if (s.me && s.staffRank(s.me) >= 1) s.emit("admin.account_requested", { user: s.adminUser(user.user_id) });
    return { status: "pending" };
  });

  s.on("setup.claim", () => fail(ERR.SETUP_ALREADY_DONE, "This server is already set up."));

  s.on("auth.logout", (uid) => {
    for (const [id, x] of s.sessions) if (x.token === s.sessionToken) s.sessions.delete(id);
    s.setPresence(uid, "offline");
    s.me = null;
    s.sessionToken = null;
    return {};
  });

  // --- your account ------------------------------------------------------------------------

  s.on("user.profile", (uid, p) => {
    const u = s.users.get(p.user_id);
    if (!u) notFound("That user");
    const user = { ...s.publicUser(u.user_id), bio: u.deleted ? null : u.bio, created_at: u.created_at };
    if (u.user_id === uid) user.custom_status = u.custom_status;
    return { user, status: s.visibleStatus(u.user_id), note: s.notes.get(`${uid}:${u.user_id}`) || null };
  });

  s.on("user.update", (uid, p) => {
    const u = s.users.get(uid);
    const limits = { display_name: LIMITS.DISPLAY_NAME_MAX, bio: LIMITS.BIO_MAX, custom_status: LIMITS.CUSTOM_STATUS_MAX };
    let changed = false;
    for (const [key, max] of Object.entries(limits)) {
      if (key in p) { u[key] = optStr(p[key], { max, field: key }); changed = true; }
    }
    if ("custom_status" in p) u.custom_status_expires_at = u.custom_status ? statusExpiry(p.custom_status_clear_after) : null;
    else if ("custom_status_clear_after" in p) badRequest("'custom_status_clear_after' needs a 'custom_status'");
    if ("dm_privacy" in p) { u.dm_privacy = oneOf(p.dm_privacy, LIMITS.DM_PRIVACY, "dm_privacy"); changed = true; }
    if ("avatar_color" in p) {
      if (p.avatar_color !== null && !HEX.test(p.avatar_color)) badRequest("Colours look like #rrggbb.");
      u.avatar_color = p.avatar_color; changed = true;
    }
    if ("profile_colors" in p) {
      const c = p.profile_colors;
      if (c !== null && !(Array.isArray(c) && c.length === 2 && c.every((x) => HEX.test(x)))) badRequest("Pick two colours.");
      u.profile_colors = c; changed = true;
    }
    if ("banner_media_id" in p) {
      u.banner_id = p.banner_media_id === null ? null : s.mediaRef(s.claimMedia(p.banner_media_id, "banner"));
      changed = true;
    }
    if (!changed) badRequest("Nothing to update");
    s.userUpdated(uid);
    return { user: s.selfUser(uid) };
  });

  s.on("user.avatar.set", (uid, p) => {
    const u = s.users.get(uid);
    if (p.media_id !== undefined && p.media_id !== null) u.avatar_id = s.mediaRef(s.claimMedia(p.media_id, "avatar"));
    else if (p.data_b64) u.avatar_id = s.addMedia("avatar", { url: `data:image/png;base64,${p.data_b64}` }).media_id;
    else u.avatar_id = null;
    s.userUpdated(uid);
    return { user: s.selfUser(uid) };
  });

  s.on("user.password.change", (uid, p) => {
    const u = s.users.get(uid);
    if (p.current_password !== u.password) fail(ERR.INVALID_CURRENT_PASSWORD, "Your current password is wrong");
    const bytes = new TextEncoder().encode(String(p.new_password || "")).length;
    if (bytes < LIMITS.PASSWORD_MIN_BYTES || bytes > LIMITS.PASSWORD_MAX_BYTES) fail(ERR.INVALID_PASSWORD, "Passwords are 8–72 characters.");
    u.password = p.new_password;
    for (const [id, x] of s.sessions) if (x.user_id === uid && x.token !== s.sessionToken) s.sessions.delete(id);
    return {};
  });

  s.on("user.sessions.list", (uid) => ({
    sessions: [...s.sessions.values()].filter((x) => x.user_id === uid).sort((a, b) => b.last_seen - a.last_seen).map((x) => ({
      session_id: x.session_id, created_at: iso(x.created_at), last_seen: iso(x.last_seen), user_agent: x.user_agent,
      current: x.token === s.sessionToken,
    })),
  }));

  s.on("user.sessions.revoke", (uid, p) => {
    if (p.session_id === "others") {
      for (const [id, x] of s.sessions) if (x.user_id === uid && x.token !== s.sessionToken) s.sessions.delete(id);
      return {};
    }
    const x = s.sessions.get(p.session_id);
    if (!x || x.user_id !== uid) notFound("That session");
    s.sessions.delete(x.session_id);
    return {};
  });

  s.on("user.search", (uid, p) => {
    const mode = s.config.user_search;
    if (mode === "off" || (mode === "staff" && s.staffRank(uid) < 1)) fail(ERR.FEATURE_DISABLED, "User search is off on this server.");
    const q = String(p.query || "").toLowerCase();
    if (!q) return { users: [] };
    const users = [...s.users.values()].filter((u) => !u.deleted && u.status === "active"
      && (u.username.toLowerCase().startsWith(q) || (u.display_name || "").toLowerCase().startsWith(q)));
    return { users: users.slice(0, 20).map((u) => s.publicUser(u.user_id)) };
  });

  s.on("user.delete", (uid, p) => {
    const u = s.users.get(uid);
    if (u.is_server_owner) forbidden("The server owner can't delete their account.");
    if (p.password !== u.password) fail(ERR.INVALID_CURRENT_PASSWORD, "Your password is wrong");
    s.deleteUser(uid);
    s.me = null;
    return {};
  });

  s.on("user.note.set", (uid, p) => {
    s.requireUser(p.user_id);
    const note = optStr(p.note, { max: LIMITS.USER_NOTE_MAX, field: "Note" });
    if (note) s.notes.set(`${uid}:${p.user_id}`, note);
    else s.notes.delete(`${uid}:${p.user_id}`);
    return { user_id: p.user_id, note };
  });

  // --- presence --------------------------------------------------------------------------------

  s.on("presence.list", (uid, p) => {
    let ids = [];
    if (p.guild_id) {
      s.requireMember(p.guild_id, uid);
      ids = s.guildMembers(p.guild_id).map((m) => m.user_id);
    } else if (Array.isArray(p.user_ids)) {
      ids = p.user_ids.slice(0, 200).filter((id) => s.hearsPresence(uid, id) || id === uid);
    } else badRequest("Give a guild_id or user_ids.");
    const presences = {};
    for (const id of ids) {
      const status = s.visibleStatus(id);
      if (status !== "offline") presences[id] = status;
    }
    return { presences };
  });

  s.on("presence.set", (uid, p) => {
    const u = s.users.get(uid);
    const before = s.visibleStatus(uid);
    if (p.status !== undefined) u.presence = oneOf(p.status, ["online", "idle", "dnd", "invisible"], "status");
    if (p.afk !== undefined) u.afk = !!p.afk;
    const status = u.presence === "invisible" ? "offline" : u.presence === "online" && u.afk ? "idle" : u.presence;
    s.presence.set(uid, status);
    if (before !== s.visibleStatus(uid) && uid === s.me) s.userUpdated(uid);
    return { status };
  });

  // --- friends and blocking ------------------------------------------------------------------------

  const target = (p) => {
    const u = p.user_id ? s.users.get(p.user_id) : s.userByName(p.username);
    if (!u || u.deleted || u.status !== "active") notFound("Nobody has that username");
    return u;
  };

  // A change to how `a` sees `b`, announced to whichever of them is watching.
  const relationChanged = (a, b) => {
    for (const [x, y] of [[a, b], [b, a]]) {
      if (x !== s.me) continue;
      const rel = s.relationship(x, y);
      if (rel) s.emit("relationship.updated", rel);
      else s.emit("relationship.removed", { user_id: y });
    }
  };

  s.on("friend.list", (uid) => ({
    relationships: [...s.relations.keys()].filter((k) => k.startsWith(`${uid}:`)).map((k) => s.relationship(uid, k.split(":")[1])),
  }));

  s.on("friend.request", (uid, p) => {
    const other = target(p);
    if (other.user_id === uid) badRequest("You can't friend yourself.");
    if (s.blockedEither(uid, other.user_id)) fail(ERR.BLOCKED, "You can't send them a friend request.");
    const mine = s.relation(uid, other.user_id);
    if (mine === "friend") fail(ERR.ALREADY_FRIENDS, "You're already friends.");
    if (mine === "incoming") {
      s.setRelation(uid, other.user_id, "friend");
      s.setRelation(other.user_id, uid, "friend");
    } else {
      s.setRelation(uid, other.user_id, "outgoing");
      s.setRelation(other.user_id, uid, "incoming");
    }
    relationChanged(uid, other.user_id);
    if (s.relation(uid, other.user_id) === "friend") presenceBoth(uid, other.user_id);
    s.afterFriendRequest?.(uid, other.user_id);
    return { relationship: s.relationship(uid, other.user_id) };
  });

  const presenceBoth = (a, b) => {
    const other = a === s.me ? b : b === s.me ? a : null;
    if (other) s.emit("presence.update", { user_id: other, status: s.visibleStatus(other) });
  };

  s.on("friend.accept", (uid, p) => {
    if (s.relation(uid, p.user_id) !== "incoming") notFound("That friend request");
    s.setRelation(uid, p.user_id, "friend");
    s.setRelation(p.user_id, uid, "friend");
    relationChanged(uid, p.user_id);
    presenceBoth(uid, p.user_id);
    return { relationship: s.relationship(uid, p.user_id) };
  });

  s.on("friend.remove", (uid, p) => {
    const mine = s.relation(uid, p.user_id);
    if (!mine || mine === "blocked") notFound("That friend");
    s.setRelation(uid, p.user_id, null);
    if (s.relation(p.user_id, uid) !== "blocked") s.setRelation(p.user_id, uid, null);
    relationChanged(uid, p.user_id);
    return {};
  });

  s.on("user.block", (uid, p) => {
    const other = target(p);
    if (other.user_id === uid) badRequest("You can't block yourself.");
    s.setRelation(uid, other.user_id, "blocked");
    if (s.relation(other.user_id, uid) !== "blocked") s.setRelation(other.user_id, uid, null);
    relationChanged(uid, other.user_id);
    return { relationship: s.relationship(uid, other.user_id) };
  });

  s.on("user.unblock", (uid, p) => {
    if (s.relation(uid, p.user_id) !== "blocked") notFound("That block");
    s.setRelation(uid, p.user_id, null);
    relationChanged(uid, p.user_id);
    return {};
  });
}
