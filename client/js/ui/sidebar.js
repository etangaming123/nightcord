// Guild rail (far left) and the channel sidebar: guild header + channels, or
// the DM list on Home, plus the user panel.

import {
  can, dmTitle, guildBadge, homeBadge, isMuted, isPrivate, isUnread, mentionCount, sortDms, statusOf, userById,
} from "../state.js";
import { $, add, avatar, clear, displayName, h, iconBtn, initials } from "./dom.js";

function badge(n) {
  return n ? h("span", { class: "badge", "aria-label": `${n} mentions` }, n > 99 ? "99+" : String(n)) : null;
}

export function renderRail(state, actions) {
  const rail = clear($("#guild-rail"));
  const home = homeBadge();
  const homeActive = state.view === "home";
  add(rail,
    h("button", {
      class: `guild-icon home ${homeActive ? "active" : ""}`, type: "button",
      title: "Direct Messages", "aria-label": "Direct Messages", "aria-current": homeActive ? "page" : null,
      on: { click: actions.openHome },
    }, h("span", { class: "brand-mark", "aria-hidden": "true" }), badge(home)),
    h("div", { class: "rail-sep", role: "separator" }),
  );
  for (const g of state.guilds.values()) {
    const active = state.view === "guild" && g.guild_id === state.guildId;
    const { unread, mentions } = guildBadge(g.guild_id);
    add(rail, h("button", {
      class: `guild-icon ${active ? "active" : ""} ${unread ? "unread" : ""}`, type: "button",
      title: g.ghost ? `${g.name} (ghost view)` : g.name,
      "aria-label": `${g.name}${mentions ? `, ${mentions} mentions` : unread ? ", unread" : ""}`,
      "aria-current": active ? "page" : null,
      on: {
        click: () => actions.openGuild(g.guild_id),
        contextmenu: (e) => { e.preventDefault(); actions.guildMenu(g, { x: e.clientX, y: e.clientY }); },
      },
    }, initials(g.name), g.ghost ? h("span", { class: "ghost-badge", "aria-hidden": "true" }, "👻") : null, badge(mentions)));
  }
  add(rail, h("button", {
    class: "guild-icon add", type: "button", title: "Create or join a guild", "aria-label": "Create or join a guild",
    on: { click: actions.addGuild },
  }, "+"));
  const serverName = state.info?.server_name || "Server";
  add(rail,
    h("div", { class: "rail-spacer" }),
    h("button", {
      class: "guild-icon server", type: "button",
      title: `${serverName} — switch server`, "aria-label": `Switch server (connected to ${serverName})`,
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
  if (!guild) {
    add(header, h("span", { class: "title muted" }, state.info?.server_name || ""));
    if (state.user) add(list, h("p", { class: "muted small pad" }, "Pick a guild on the left, or press + to create or join one."));
    return;
  }
  add(header, h("button", {
    class: "guild-header-btn", type: "button", "aria-haspopup": "menu",
    on: { click: (e) => actions.guildMenu(guild, e.currentTarget) },
  }, h("span", { class: "title", title: guild.name }, guild.name), h("span", { class: "chev", "aria-hidden": "true" }, "▾")));

  add(list, h("div", { class: "section-label" },
    h("span", {}, "Text channels"),
    can("MANAGE_CHANNELS") ? iconBtn("+", "Create channel", actions.createChannel) : null,
  ));
  for (const c of state.channels) {
    const active = c.channel_id === state.channelId;
    const unread = isUnread(c.channel_id) && !active;
    const muted = isMuted(c.channel_id, c.guild_id);
    const open = () => { if (!active) actions.openChannel(c.channel_id); else actions.toggleNav(false); };
    add(list, h("div", {
      class: `channel ${active ? "active" : ""} ${unread && !muted ? "unread" : ""} ${muted ? "muted" : ""}`,
      role: "link", tabindex: "0", "aria-current": active ? "page" : null,
      on: {
        click: open,
        keydown: (e) => { if (e.key === "Enter" && e.target === e.currentTarget) open(); },
        contextmenu: (e) => { e.preventDefault(); actions.channelMenu(c, { x: e.clientX, y: e.clientY }); },
      },
    },
    h("span", { class: "hash", "aria-hidden": "true", title: isPrivate(c) ? "Private channel" : null }, isPrivate(c) ? "🔒" : "#"),
    h("span", { class: "name" }, c.name),
    badge(active ? 0 : mentionCount(c.channel_id)),
    h("span", { class: "actions" },
      can("MANAGE_CHANNELS", c) ? iconBtn("⚙", "Edit channel", () => actions.channelSettings(c)) : null,
      iconBtn("⋯", "Channel options", (e) => actions.channelMenu(c, e.currentTarget)))));
  }
  if (!state.channels.length && state.members.length) {
    add(list, h("p", { class: "muted small pad" }, "No channels you can see yet."));
  }
}

function renderHome(state, actions) {
  clear($("#guild-header"), h("span", { class: "title" }, "Direct Messages"));
  const list = clear($("#channel-list"));
  add(list, h("div", { class: "section-label" },
    h("span", {}, "Direct messages"),
    iconBtn("+", "New message", actions.newDm)));
  const dms = sortDms([...state.dms.values()]);
  if (!dms.length) {
    add(list, h("p", { class: "muted small pad" }, "No conversations yet. Press + to message someone on this server."));
  }
  for (const ch of dms) {
    const active = ch.channel_id === state.channelId;
    const unread = isUnread(ch.channel_id) && !active;
    const others = ch.recipients.filter((u) => u.user_id !== state.user?.user_id);
    const other = ch.kind === "dm" ? userById(others[0]?.user_id) || others[0] : null;
    const icon = other
      ? avatar(other, { status: statusOf(other.user_id) })
      : h("div", { class: "avatar group", "aria-hidden": "true" }, "👥");
    const sub = other ? (other.custom_status || "") : `${ch.recipients.length} members`;
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
    h("span", { class: "actions" }, iconBtn("✕", ch.kind === "dm" ? "Close conversation" : "Leave group", () => actions.leaveDm(ch)))));
  }
}

function renderUserPanel(state, actions) {
  const panel = clear($("#user-panel"));
  if (!state.user) return;
  const me = state.user;
  const status = statusOf(me.user_id);
  const pending = state.user.is_server_owner && state.pendingAccounts;
  clear(panel,
    h("button", {
      class: "me", type: "button", title: "Set status", "aria-haspopup": "menu",
      on: { click: (e) => actions.statusMenu(e.currentTarget) },
    },
    avatar(me, { status: me.presence === "invisible" && state.connected ? "invisible" : status }),
    h("span", { class: "who" },
      h("span", { class: "name" }, displayName(me)),
      h("span", { class: "sub" }, me.custom_status || (me.presence === "invisible" ? "Invisible" : me.username)))),
    h("button", {
      class: "icon-btn gear", type: "button", title: "User settings", "aria-label": "User settings",
      on: { click: () => actions.userSettings() },
    }, "⚙", pending ? h("span", { class: "badge small" }, String(pending)) : null),
  );
}
