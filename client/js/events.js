// Server → client events (PROTOCOL.md §5): keep state in sync and redraw.

import {
  ackCurrent, addMessage, applyGuildEmojis, applyGuildStickers, applyReaction, applyRelationship,
  dropRelationship, expireTyping, forgetGuild, legalChanged, loadAll, openFriends, openGuild, openHome, reloadRoles,
  removeMessage, setServerInfo, updateMessage, upsertMember,
} from "./actions.js";
import { req } from "./api.js";
import { notifyMessage, playSound } from "./notify.js";
import { applyPrefs } from "./prefs.js";
import { T } from "./protocol.js";
import { invalidate } from "./render.js";
import {
  currentChannel, ensureReadState, isIncomingRequest, mentionsMe, nameOf, rememberUser, sortChannels, state,
} from "./state.js";
import { renderTyping } from "./ui/chat.js";
import { idGt } from "./ui/dom.js";
import { fullscreenOpen, refreshFullscreen, toast } from "./ui/modals.js";
import { scopedT } from "./strings.js";

const t = scopedT("events");

const TYPING_MS = 8000;

// guild.permissions_changed can arrive in bursts (role edits); refetch once.
let permsTimer = null;
function permissionsChanged(guildId) {
  clearTimeout(permsTimer);
  permsTimer = setTimeout(async () => {
    try {
      const [{ guilds }, { read_states }] = await Promise.all([req(T.GUILD_LIST), req(T.READ_STATE_LIST)]);
      state.guilds = new Map(guilds.map((g) => [g.guild_id, g]));
      state.readStates = new Map(read_states.map((s) => [s.channel_id, s]));
      if (state.view === "guild" && state.guildId === guildId) {
        const { channels, voice_states: voice } = await req(T.CHANNEL_LIST, { guild_id: guildId });
        state.channels = sortChannels(channels);
        state.voice = new Map((voice || []).map((v) => [v.user_id, v]));
        if (state.channelId && !channels.some((c) => c.channel_id === state.channelId)) {
          toast(t("channel_access_removed"));
          await openGuild(guildId);
          return;
        }
      }
      invalidate();
      if (fullscreenOpen()) refreshFullscreen();
    } catch {
      /* reconnect will reload everything */
    }
  }, 250);
}

// Where a notification click should take the user.
function goTo(channel) {
  if (channel.guild_id) openGuild(channel.guild_id, channel.channel_id);
  else openHome(channel.channel_id);
}

function channelFor(m) {
  if (m.guild_id === null) return state.dms.get(m.channel_id) || { channel_id: m.channel_id, guild_id: null, kind: "dm", recipients: [] };
  return state.channels.find((c) => c.channel_id === m.channel_id) || { channel_id: m.channel_id, guild_id: m.guild_id, name: "" };
}

export function wireEvents(conn) {
  const on = (type, fn) => conn.on(type, (p) => { if (conn === state.conn && state.user) fn(p); });

  // --- messages ---
  on(T.MESSAGE_NEW, (m) => {
    rememberUser(m.author);
    const channel = channelFor(m);
    const rs = ensureReadState(channel);
    if (idGt(m.message_id, rs.last_message_id)) rs.last_message_id = m.message_id;
    const mine = m.author?.user_id === state.user.user_id;
    if (mine) rs.last_read_id = m.message_id;
    else if (mentionsMe(m)) rs.mention_count = (rs.mention_count || 0) + 1;
    if (m.guild_id === null && state.dms.has(m.channel_id)) {
      state.dms.get(m.channel_id).last_message_id = m.message_id;
    } else if (m.guild_id === null) {
      req(T.DM_LIST).then(({ channels }) => {
        for (const c of channels) { state.dms.set(c.channel_id, c); c.recipients.forEach(rememberUser); }
        invalidate("sidebar", "rail");
      }).catch(() => {});
    }
    if (m.channel_id === state.channelId && !state.hasMoreAfter) {
      if (state.typing.delete(m.author.user_id)) renderTyping(state);
      if (addMessage(m)) {
        if (mine) state.scrollTo = "bottom";
        invalidate("chat");
        requestAnimationFrame(() => ackCurrent());
      }
    }
    // Message requests make one sound when they arrive (dm.created), not per message.
    if (!mine && !isIncomingRequest(channel)) notifyMessage(m, channel, () => goTo(channel));
    invalidate("rail", "sidebar", "title");
  });

  on(T.MESSAGE_UPDATED, (m) => {
    rememberUser(m.author);
    if (m.channel_id === state.channelId && updateMessage(m)) invalidate("chat");
    // A reply preview elsewhere in view may quote this message.
    let quoted = false;
    for (const x of state.messages) {
      if (x.reply_to?.message_id === m.message_id) { x.reply_to = { ...x.reply_to, content: m.content.slice(0, 120) }; quoted = true; }
    }
    if (quoted) invalidate("chat");
  });

  on(T.MESSAGE_DELETED, ({ channel_id, message_id }) => {
    if (channel_id === state.channelId && removeMessage(message_id)) invalidate("chat");
  });

  on(T.REACTION_ADDED, (r) => { if (r.channel_id === state.channelId && applyReaction(r, true)) invalidate("chat"); });
  on(T.REACTION_REMOVED, (r) => { if (r.channel_id === state.channelId && applyReaction(r, false)) invalidate("chat"); });

  on(T.TYPING_STARTED, ({ channel_id, user_id }) => {
    if (channel_id !== state.channelId) return;
    state.typing.set(user_id, Date.now() + TYPING_MS);
    renderTyping(state);
    setTimeout(expireTyping, TYPING_MS + 50);
  });

  on(T.READ_STATE_UPDATED, (rs) => {
    state.readStates.set(rs.channel_id, rs);
    invalidate("rail", "sidebar", "title");
  });

  on(T.NOTIFY_PREFS_UPDATED, (p) => {
    state.notifyPrefs.set(p.target_id, p);
    invalidate("rail", "sidebar", "title");
  });

  // --- users & presence ---
  on(T.PRESENCE_UPDATE, ({ user_id, status }) => {
    if (status === "offline") state.presences.delete(user_id);
    else state.presences.set(user_id, status);
    invalidate("members", "sidebar", "header");
  });

  on(T.USER_UPDATED, (u) => {
    if (u.user_id === state.user.user_id) {
      const wasMuted = state.user.muted_until;
      const perksBefore = state.user.perks;
      state.user = { ...state.user, ...u };
      if ("perks" in u && u.perks !== perksBefore) applyPrefs();
      if ("muted_until" in u && u.muted_until !== wasMuted) {
        toast(u.muted_until ? t("user_muted") : t("user_unmuted"), { error: !!u.muted_until });
      }
    }
    rememberUser(u);
    invalidate("members", "sidebar", "header", "chat", "composer");
  });

  on(T.SERVER_CONFIG_UPDATED, (config) => {
    const before = state.info?.legal_version;
    const voiceBefore = state.info?.voice_enabled;
    setServerInfo(config);
    if (!config.voice_enabled && voiceBefore) {
      state.voice.clear();
      state.myVoice = null;
    }
    if (config.voice_enabled !== voiceBefore && state.view === "guild" && state.guildId) permissionsChanged(state.guildId);
    if (config.legal_version !== before && config.legal_version) legalChanged();
    // Customisation settings change what every view shows, and the theme.
    applyPrefs();
    invalidate();
    if (fullscreenOpen()) refreshFullscreen();
  });

  on(T.VOICE_STATE_UPDATED, (v) => {
    // Someone else joining or leaving the voice channel you're in (your own
    // joins and leaves play from joinVoice / leaveVoice).
    const mine = state.myVoice?.channel_id;
    const before = state.voice.get(v.user_id)?.channel_id;
    if (v.user_id !== state.user.user_id && mine && v.channel_id !== before && (v.channel_id === mine || before === mine)) {
      playSound(v.channel_id === mine ? "voiceJoin" : "voiceLeave");
    }
    if (v.user_id === state.user.user_id) state.myVoice = v.channel_id ? v : null;
    if (v.guild_id === state.guildId) {
      if (v.channel_id) state.voice.set(v.user_id, v);
      else state.voice.delete(v.user_id);
    }
    invalidate("sidebar");
  });

  // --- guilds ---
  on(T.GUILD_EMOJIS_UPDATED, applyGuildEmojis);
  on(T.GUILD_STICKERS_UPDATED, applyGuildStickers);

  on(T.GUILD_UPDATED, (guild) => {
    const existing = state.guilds.get(guild.guild_id);
    if (!existing) return;
    state.guilds.set(guild.guild_id, { ...existing, ...guild });
    invalidate("rail", "sidebar", "header", "title");
  });

  on(T.GUILD_REMOVED, ({ guild_id, reason }) => {
    const g = state.guilds.get(guild_id);
    if (!g) return;
    const msg = {
      kicked: t("guild_kicked", { name: g.name }),
      banned: t("guild_banned", { name: g.name }),
      deleted: t("guild_deleted", { name: g.name }),
    }[reason];
    toast(msg || t("guild_left", { name: g.name }), { error: reason !== "deleted" });
    if (state.myVoice?.guild_id === guild_id) state.myVoice = null;
    forgetGuild(guild_id);
  });

  on(T.GUILD_MEMBER_JOINED, ({ guild_id, member }) => {
    if (guild_id !== state.guildId) return;
    upsertMember(member);
  });

  on(T.GUILD_MEMBER_LEFT, ({ guild_id, user_id }) => {
    if (guild_id !== state.guildId) return;
    state.members = state.members.filter((m) => m.user.user_id !== user_id);
    invalidate("members");
    if (fullscreenOpen()) refreshFullscreen();
  });

  on(T.GUILD_MEMBER_UPDATED, ({ guild_id, member }) => {
    if (guild_id === state.guildId) upsertMember(member);
  });

  on(T.GUILD_PERMISSIONS_CHANGED, ({ guild_id }) => permissionsChanged(guild_id));

  on(T.ROLE_CREATED, (role) => { if (role.guild_id === state.guildId) reloadRoles().then(() => fullscreenOpen() && refreshFullscreen()); });
  on(T.ROLE_UPDATED, (role) => {
    if (role.guild_id !== state.guildId) return;
    const i = state.roles.findIndex((r) => r.role_id === role.role_id);
    if (i >= 0) state.roles[i] = role;
    else state.roles.push(role);
    state.roles.sort((a, b) => b.position - a.position);
    invalidate("members", "chat");
    if (fullscreenOpen()) refreshFullscreen();
  });
  on(T.ROLE_DELETED, ({ guild_id, role_id }) => {
    if (guild_id !== state.guildId) return;
    state.roles = state.roles.filter((r) => r.role_id !== role_id);
    for (const m of state.members) m.role_ids = m.role_ids.filter((id) => id !== role_id);
    invalidate("members", "chat");
    if (fullscreenOpen()) refreshFullscreen();
  });

  // --- channels ---
  on(T.CHANNEL_CREATED, (ch) => {
    ensureReadState(ch);
    if (ch.guild_id === state.guildId && !state.channels.some((c) => c.channel_id === ch.channel_id)) {
      state.channels = sortChannels([...state.channels, ch]);
    }
    invalidate("sidebar", "rail");
  });

  on(T.CHANNEL_UPDATED, (ch) => {
    ensureReadState(ch);
    if (ch.guild_id !== state.guildId) return;
    const exists = state.channels.some((c) => c.channel_id === ch.channel_id);
    state.channels = sortChannels(exists ? state.channels.map((c) => (c.channel_id === ch.channel_id ? ch : c)) : [...state.channels, ch]);
    invalidate("sidebar", "header", "composer", "chat");
    if (fullscreenOpen()) refreshFullscreen();
  });

  on(T.CHANNEL_DELETED, ({ guild_id, channel_id }) => {
    state.readStates.delete(channel_id);
    if (guild_id === state.guildId) {
      state.channels = state.channels.filter((c) => c.channel_id !== channel_id);
      if (state.channelId === channel_id) {
        toast(t("channel_gone"));
        openGuild(guild_id);
      }
    }
    invalidate("sidebar", "rail", "title");
  });

  // --- DMs ---
  on(T.DM_CREATED, (ch) => {
    const known = state.dms.has(ch.channel_id);
    state.dms.set(ch.channel_id, ch);
    ch.recipients.forEach(rememberUser);
    ensureReadState(ch);
    if (!known && isIncomingRequest(ch)) {
      const from = ch.recipients.find((u) => u.user_id === ch.request.from_user_id);
      playSound("message");
      toast(t("message_request_toast", { name: nameOf(from, null) }));
    }
    invalidate("sidebar", "rail", "title", "chat");
  });

  on(T.DM_UPDATED, (ch) => {
    const mine = ch.recipients.some((u) => u.user_id === state.user.user_id);
    // Declined (maybe on another device): it's gone for us.
    const declined = ch.request?.state === "declined" && ch.request.from_user_id !== state.user.user_id;
    if (!mine || declined) {
      state.dms.delete(ch.channel_id);
      if (state.channelId === ch.channel_id) openFriends("requests");
      else invalidate();
      return;
    }
    state.dms.set(ch.channel_id, ch);
    ch.recipients.forEach(rememberUser);
    invalidate("sidebar", "header", "members", "composer");
  });

  // --- friends ---
  on(T.RELATIONSHIP_UPDATED, (rel) => {
    const before = applyRelationship(rel);
    if (rel.kind === "incoming" && before !== "incoming") {
      playSound("message");
      toast(t("friend_request_toast", { name: nameOf(rel.user, null) }));
    } else if (rel.kind === "friend" && before === "outgoing") {
      toast(t("friend_accepted_toast", { name: nameOf(rel.user, null) }));
    }
    if (rel.kind === "friend") {
      req(T.PRESENCE_LIST, { user_ids: [rel.user.user_id] }).then(({ presences }) => {
        for (const [id, s] of Object.entries(presences)) state.presences.set(id, s);
        invalidate("chat", "sidebar");
      }).catch(() => {});
    }
  });
  on(T.RELATIONSHIP_REMOVED, ({ user_id }) => dropRelationship(user_id));

  // --- admin ---
  on(T.ADMIN_ACCOUNT_REQUESTED, ({ user }) => {
    state.pendingAccounts += 1;
    toast(t("account_request_pending", { username: user.username }));
    invalidate("sidebar");
  });
}

// Everything is reloaded after a reconnect (events may have been missed).
export async function resync() {
  await loadAll();
  if (state.view === "guild" && state.guilds.has(state.guildId)) {
    const channelId = state.channelId;
    state.channels = [];
    await openGuild(state.guildId, channelId);
  } else if (state.view === "home") {
    await openHome(state.channelId);
  } else {
    const first = state.guilds.keys().next().value;
    if (first) await openGuild(first);
    else await openHome();
  }
  if (currentChannel()) invalidate("chat");
}
