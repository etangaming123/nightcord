// Guild rail (far left) and the channel sidebar: guild header + channels, or
// the DM list on Home, plus the user panel.

import {
  can, channelTree, dmTitle, guildBadge, homeBadge, isMuted, isPrivate, isStaff, isUnread, memberById, mentionCount,
  nameOf, sortDms, statusOf, userById, voiceEnabled, voiceIn,
} from "../state.js";
import { guildCan } from "../perks.js";
import { $, add, avatar, clear, displayName, h, iconBtn, imageEl, initials, mayAnimate } from "./dom.js";
import { scopedT } from "../strings.js";

const t = scopedT("ui/sidebar");

function badge(n) {
  return n ? h("span", { class: "badge", "aria-label": t("mentions_count", { count: n }) }, n > 99 ? "99+" : String(n)) : null;
}

export function renderRail(state, actions) {
  const rail = clear($("#guild-rail"));
  const home = homeBadge();
  const homeActive = state.view === "home";
  add(rail,
    h("button", {
      class: `guild-icon home ${homeActive ? "active" : ""}`, type: "button",
      title: t("rail_dm_label"), "aria-label": t("rail_dm_label"), "aria-current": homeActive ? "page" : null,
      on: { click: actions.openHome },
    }, h("img", { class: "brand-mark", src: "assets/logo.png", alt: "" }), badge(home)),
    h("div", { class: "rail-sep", role: "separator" }),
  );
  for (const g of state.guilds.values()) {
    const active = state.view === "guild" && g.guild_id === state.guildId;
    const { unread, mentions } = guildBadge(g.guild_id);
    add(rail, h("button", {
      class: `guild-icon ${active ? "active" : ""} ${unread ? "unread" : ""}`, type: "button",
      title: g.ghost ? t("rail_guild_ghost_title", { name: g.name }) : g.name,
      "aria-label": mentions ? t("guild_aria_mentions", { name: g.name, mentions: t("mentions_count", { count: mentions }) })
        : unread ? t("guild_aria_unread", { name: g.name }) : g.name,
      "aria-current": active ? "page" : null,
      on: {
        click: () => actions.openGuild(g.guild_id),
        contextmenu: (e) => { e.preventDefault(); actions.guildMenu(g, { x: e.clientX, y: e.clientY }); },
      },
    }, g.icon_id ? imageEl(g.icon_id, { animate: mayAnimate(g) }) : initials(g.name),
    g.ghost ? h("span", { class: "ghost-badge", "aria-hidden": "true" }, "👻") : null, badge(mentions)));
  }
  add(rail, h("button", {
    class: "guild-icon add", type: "button", title: t("rail_add_guild"), "aria-label": t("rail_add_guild"),
    on: { click: actions.addGuild },
  }, "+"));
  const serverName = state.info?.server_name || t("rail_server_fallback");
  add(rail,
    h("div", { class: "rail-spacer" }),
    h("button", {
      class: "guild-icon server", type: "button",
      title: t("rail_switch_server_title", { server: serverName }), "aria-label": t("rail_switch_server_aria", { server: serverName }),
      on: { click: actions.switchServer },
    }, "⇄"),
  );
}

export function renderChannelSidebar(state, actions) {
  if (state.view === "home") renderHome(state, actions);
  else renderGuild(state, actions);
  renderUserPanel(state, actions);
}

function renderGuild(state, actions) {
  const guild = state.guilds.get(state.guildId);
  const header = clear($("#guild-header"));
  const list = clear($("#channel-list"));
  const banner = guild?.banner_id && guildCan("guild_banner", guild);
  header.classList.toggle("with-banner", !!banner);
  if (banner) add(header, h("div", { class: "guild-banner", "aria-hidden": "true" }, imageEl(guild.banner_id, { animate: guildCan("animated_media", guild), lazy: false })));
  if (!guild) {
    add(header, h("span", { class: "title muted" }, state.info?.server_name || ""));
    if (state.user) add(list, h("p", { class: "muted small pad" }, t("guild_pick_prompt")));
    return;
  }
  add(header, h("button", {
    class: "guild-header-btn", type: "button", "aria-haspopup": "menu",
    on: { click: (e) => actions.guildMenu(guild, e.currentTarget) },
  }, h("span", { class: "title", title: guild.name }, guild.name), h("span", { class: "chev", "aria-hidden": "true" }, "▾")));

  const manage = can("MANAGE_CHANNELS");
  const drag = dragController(state, actions, manage);
  const tree = channelTree();
  const showVoice = voiceEnabled();
  const visible = (c) => showVoice || c.kind !== "voice";
  for (const c of tree.loose.filter(visible)) add(list, channelRow(c, state, actions, drag));
  if (!tree.categories.length && manage) {
    add(list, h("div", { class: "section-label" }, h("span", {}, t("channels_section_label")), iconBtn("+", t("create_channel"), () => actions.createChannel())));
  }
  for (const { cat, channels } of tree.categories) {
    const collapsed = actions.isCollapsed(cat.channel_id);
    const kids = channels.filter(visible);
    add(list, h("div", {
      class: `category ${collapsed ? "collapsed" : ""}`, role: "button", tabindex: "0", "aria-expanded": String(!collapsed),
      ...drag.attrs(cat),
      on: {
        ...drag.handlers(cat),
        click: () => actions.toggleCategory(cat.channel_id),
        keydown: (e) => { if (e.key === "Enter" && e.target === e.currentTarget) actions.toggleCategory(cat.channel_id); },
        contextmenu: (e) => { e.preventDefault(); actions.channelMenu(cat, { x: e.clientX, y: e.clientY }); },
      },
    },
    h("span", { class: "cat-chev", "aria-hidden": "true" }, "▾"),
    h("span", { class: "cat-name" }, cat.name),
    can("MANAGE_CHANNELS", cat) ? iconBtn("+", t("create_channel_in", { category: cat.name }), () => actions.createChannel({ parentId: cat.channel_id }), { cls: "cat-add" }) : null));
    for (const c of kids) {
      // Collapsed categories still show the open channel and unread ones, like Discord.
      if (collapsed && c.channel_id !== state.channelId && !(isUnread(c.channel_id) && !isMuted(c.channel_id, c.guild_id)) && !voiceIn(c.channel_id).length) continue;
      add(list, channelRow(c, state, actions, drag));
    }
  }
  if (!state.channels.length && state.members.length) {
    add(list, h("p", { class: "muted small pad" }, t("no_channels_visible")));
  }
  if (manage && state.channels.length) {
    add(list, h("button", { class: "btn link add-channel", type: "button", on: { click: () => actions.createChannel() } }, t("add_channel_button")));
  }
}

function channelRow(c, state, actions, drag) {
  if (c.kind === "voice") return voiceRow(c, state, actions, drag);
  const active = c.channel_id === state.channelId;
  const unread = isUnread(c.channel_id) && !active;
  const muted = isMuted(c.channel_id, c.guild_id);
  const open = () => { if (!active) actions.openChannel(c.channel_id); else actions.toggleNav(false); };
  return h("div", {
    class: `channel ${active ? "active" : ""} ${unread && !muted ? "unread" : ""} ${muted ? "muted" : ""} ${c.parent_id ? "nested" : ""}`,
    role: "link", tabindex: "0", "aria-current": active ? "page" : null,
    ...drag.attrs(c),
    on: {
      ...drag.handlers(c),
      click: open,
      keydown: (e) => { if (e.key === "Enter" && e.target === e.currentTarget) open(); },
      contextmenu: (e) => { e.preventDefault(); actions.channelMenu(c, { x: e.clientX, y: e.clientY }); },
    },
  },
  h("span", { class: "hash", "aria-hidden": "true", title: isPrivate(c) ? t("private_channel_title") : null }, isPrivate(c) ? "🔒" : "#"),
  h("span", { class: "name" }, c.name),
  badge(active ? 0 : mentionCount(c.channel_id)),
  h("span", { class: "actions" },
    can("CREATE_INVITE") && !state.guilds.get(state.guildId)?.ghost ? iconBtn("✉", t("invite_people"), () => actions.openInviteDialog()) : null,
    can("MANAGE_CHANNELS", c) ? iconBtn("⚙", t("edit_channel"), () => actions.channelSettings(c)) : null));
}

function voiceRow(c, state, actions, drag) {
  const here = voiceIn(c.channel_id);
  const mine = state.myVoice?.channel_id === c.channel_id;
  const canJoin = can("CONNECT", c);
  return h("div", { class: "voice-block" },
    h("div", {
      class: `channel voice ${mine ? "active" : ""} ${c.parent_id ? "nested" : ""} ${canJoin ? "" : "locked"}`,
      role: "button", tabindex: "0", title: canJoin ? t("join_channel_title", { name: c.name }) : t("cant_join_channel_title"),
      ...drag.attrs(c),
      on: {
        ...drag.handlers(c),
        click: () => { if (canJoin) actions.joinVoice(c); },
        keydown: (e) => { if (e.key === "Enter" && e.target === e.currentTarget && canJoin) actions.joinVoice(c); },
        contextmenu: (e) => { e.preventDefault(); actions.channelMenu(c, { x: e.clientX, y: e.clientY }); },
      },
    },
    h("span", { class: "hash", "aria-hidden": "true" }, isPrivate(c) ? "🔒" : "🔊"),
    h("span", { class: "name" }, c.name),
    h("span", { class: "actions" }, can("MANAGE_CHANNELS", c) ? iconBtn("⚙", t("edit_channel"), () => actions.channelSettings(c)) : null)),
    here.length ? h("div", { class: "voice-users" }, here.map((v) => {
      const u = userById(v.user_id) || memberById(v.user_id)?.user || { username: "…", user_id: v.user_id };
      return h("button", {
        class: "voice-user", type: "button",
        on: { click: (e) => actions.openProfile(v.user_id, e.currentTarget) },
      }, avatar(u, { size: "xs" }), h("span", { class: "name" }, nameOf(u)),
      v.self_deaf ? h("span", { class: "vflag", title: t("deafened_title") }, "🔕") : v.self_mute ? h("span", { class: "vflag", title: t("muted_title") }, "🔇") : null);
    })) : null);
}

// Drag and drop to reorder channels and categories (needs Manage Channels).
function dragController(state, actions, enabled) {
  let dragId = null;
  const byId = (id) => state.channels.find((c) => c.channel_id === id);
  const clearMarks = () => document.querySelectorAll(".drop-before, .drop-after, .drop-into").forEach((el) => el.classList.remove("drop-before", "drop-after", "drop-into"));
  const zone = (e, target) => {
    const r = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    const dragged = byId(dragId);
    if (target.kind === "category" && dragged?.kind !== "category") return y < 0.5 ? "before" : "into";
    return y < 0.5 ? "before" : "after";
  };
  const drop = (target, where) => {
    const dragged = byId(dragId);
    if (!dragged || dragged.channel_id === target.channel_id) return;
    const tree = channelTree();
    if (dragged.kind === "category") {
      const cats = tree.categories.map((c) => c.cat.channel_id).filter((id) => id !== dragged.channel_id);
      const anchor = target.kind === "category" ? target.channel_id : target.parent_id;
      let i = anchor ? cats.indexOf(anchor) : 0;
      if (anchor && where === "after") i += 1;
      cats.splice(Math.max(0, i), 0, dragged.channel_id);
      actions.reorderChannels([
        ...tree.loose.map((c) => ({ channel_id: c.channel_id, parent_id: null })),
        ...cats.flatMap((id) => [{ channel_id: id, parent_id: null },
          ...tree.categories.find((c) => c.cat.channel_id === id).channels.map((c) => ({ channel_id: c.channel_id, parent_id: id }))]),
      ]);
      return;
    }
    const order = actions.sidebarOrder().filter((o) => o.channel_id !== dragged.channel_id);
    let parent;
    let index;
    if (target.kind === "category") {
      const at = order.findIndex((o) => o.channel_id === target.channel_id);
      if (where === "into") { parent = target.channel_id; index = at + 1; } else {
        // Just above a category header: the end of the top-level list.
        parent = null;
        index = order.findIndex((o) => byId(o.channel_id)?.kind === "category");
      }
    } else {
      parent = target.parent_id || null;
      index = order.findIndex((o) => o.channel_id === target.channel_id) + (where === "after" ? 1 : 0);
    }
    order.splice(index < 0 ? order.length : index, 0, { channel_id: dragged.channel_id, parent_id: parent });
    actions.reorderChannels(order);
  };
  return {
    attrs: () => (enabled ? { draggable: "true" } : {}),
    handlers: (c) => (!enabled ? {} : {
      dragstart: (e) => { dragId = c.channel_id; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", c.name); e.currentTarget.classList.add("dragging"); },
      dragend: (e) => { dragId = null; e.currentTarget.classList.remove("dragging"); clearMarks(); },
      dragover: (e) => {
        if (!dragId || dragId === c.channel_id) return;
        e.preventDefault();
        clearMarks();
        e.currentTarget.classList.add(`drop-${zone(e, c)}`);
      },
      dragleave: (e) => e.currentTarget.classList.remove("drop-before", "drop-after", "drop-into"),
      drop: (e) => { e.preventDefault(); const where = zone(e, c); clearMarks(); drop(c, where); dragId = null; },
    }),
  };
}

function renderHome(state, actions) {
  clear($("#guild-header"), h("span", { class: "title" }, t("rail_dm_label")));
  const list = clear($("#channel-list"));
  add(list, h("div", { class: "section-label" },
    h("span", {}, t("dm_section_label")),
    iconBtn("+", t("new_message"), actions.newDm)));
  const dms = sortDms([...state.dms.values()]);
  if (!dms.length) {
    add(list, h("p", { class: "muted small pad" }, t("no_conversations")));
  }
  for (const ch of dms) {
    const active = ch.channel_id === state.channelId;
    const unread = isUnread(ch.channel_id) && !active;
    const others = ch.recipients.filter((u) => u.user_id !== state.user?.user_id);
    const other = ch.kind === "dm" ? userById(others[0]?.user_id) || others[0] : null;
    const icon = other
      ? avatar(other, { status: statusOf(other.user_id) })
      : h("div", { class: "avatar group", "aria-hidden": "true" }, "👥");
    const sub = other ? (other.custom_status || "") : t("group_members_count", { count: ch.recipients.length });
    const open = () => actions.openDm(ch.channel_id);
    add(list, h("div", {
      class: `channel dm ${active ? "active" : ""} ${unread ? "unread" : ""}`, role: "link", tabindex: "0",
      "aria-current": active ? "page" : null,
      on: {
        click: open,
        keydown: (e) => { if (e.key === "Enter" && e.target === e.currentTarget) open(); },
        contextmenu: (e) => { e.preventDefault(); actions.dmMenu(ch, { x: e.clientX, y: e.clientY }); },
      },
    },
    icon,
    h("span", { class: "dm-meta" },
      h("span", { class: "name" }, dmTitle(ch)),
      sub ? h("span", { class: "sub" }, sub) : null),
    badge(active || !unread ? 0 : Math.max(1, mentionCount(ch.channel_id))),
    h("span", { class: "actions" }, iconBtn("✕", ch.kind === "dm" ? t("close_conversation") : t("leave_group"), () => actions.leaveDm(ch)))));
  }
}

function renderUserPanel(state, actions) {
  const panel = clear($("#user-panel"));
  if (!state.user) return;
  const me = state.user;
  const status = statusOf(me.user_id);
  const pending = isStaff(1) && state.pendingAccounts;
  clear(panel, voicePanel(state, actions),
    h("button", {
      class: "me", type: "button", title: t("set_status_title"), "aria-haspopup": "menu",
      on: { click: (e) => actions.statusMenu(e.currentTarget) },
    },
    avatar(me, { status: me.presence === "invisible" && state.connected ? "invisible" : status }),
    h("span", { class: "who" },
      h("span", { class: "name" }, nameOf(me)),
      h("span", { class: "sub" }, me.custom_status || (me.presence === "invisible" ? t("invisible_label") : me.username)))),
    h("button", {
      class: "icon-btn gear", type: "button", title: t("user_settings"), "aria-label": t("user_settings"),
      on: { click: () => actions.userSettings() },
    }, "⚙", pending ? h("span", { class: "badge small" }, String(pending)) : null),
  );
}

// "Voice connected" strip above the user panel (placeholder: no audio yet).
function voicePanel(state, actions) {
  const v = state.myVoice;
  if (!v) return null;
  const guild = state.guilds.get(v.guild_id);
  const ch = v.guild_id === state.guildId ? state.channels.find((c) => c.channel_id === v.channel_id) : null;
  return h("div", { class: "voice-panel" },
    h("div", { class: "vp-top" },
      h("span", { class: "vp-meta" },
        h("span", { class: "vp-status" }, t("voice_connected")),
        h("button", {
          class: "vp-where btn link", type: "button",
          on: { click: () => actions.openGuild(v.guild_id) },
        }, t("voice_where", { channel: ch ? ch.name : t("voice_fallback_name"), guild: guild?.name || "" }))),
      iconBtn("✆", t("disconnect"), () => actions.leaveVoice(), { cls: "vp-leave" })),
    h("div", { class: "vp-note muted small" }, t("voice_audio_note")),
    h("div", { class: "vp-buttons" },
      h("button", {
        class: `btn small-btn ${v.self_mute ? "on" : ""}`, type: "button", "aria-pressed": String(!!v.self_mute),
        on: { click: () => actions.setVoiceFlags({ self_mute: !v.self_mute }) },
      }, v.self_mute ? t("unmute_button") : t("mute_button")),
      h("button", {
        class: `btn small-btn ${v.self_deaf ? "on" : ""}`, type: "button", "aria-pressed": String(!!v.self_deaf),
        on: { click: () => actions.setVoiceFlags({ self_deaf: !v.self_deaf }) },
      }, v.self_deaf ? t("undeafen_button") : t("deafen_button"))));
}
