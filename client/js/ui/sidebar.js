// Guild rail (far left) and channel sidebar (guild header, channels, user panel).

import { $, avatar, clear, h, initials } from "./dom.js";

export function renderRail(state, actions) {
  const rail = clear($("#guild-rail"));
  const serverName = state.info?.server_name || "Server";
  rail.append(
    h("button", {
      class: "guild-icon server", type: "button",
      title: `${serverName} — switch server`, "aria-label": `Switch server (connected to ${serverName})`,
      on: { click: actions.switchServer },
    }, initials(serverName)),
    h("div", { class: "rail-sep", role: "separator" }),
  );
  for (const g of state.guilds.values()) {
    const active = g.guild_id === state.guildId;
    rail.append(h("button", {
      class: `guild-icon ${active ? "active" : ""}`, type: "button",
      title: g.ghost ? `${g.name} (ghost view)` : g.name,
      "aria-label": g.name, "aria-current": active ? "page" : null,
      on: { click: () => actions.openGuild(g.guild_id) },
    }, initials(g.name), g.ghost ? h("span", { class: "ghost-badge", "aria-hidden": "true" }, "👻") : null));
  }
  rail.append(h("button", {
    class: "guild-icon add", type: "button", title: "Create or join a guild", "aria-label": "Create or join a guild",
    on: { click: actions.addGuild },
  }, "+"));
}

export function renderChannelSidebar(state, actions, { isOwner }) {
  const guild = state.guilds.get(state.guildId);

  // Header
  const header = clear($("#guild-header"));
  if (guild) {
    header.append(h("span", { class: "title", title: guild.name }, guild.name));
    if (isOwner) {
      header.append(h("button", { class: "icon-btn", type: "button", title: "Guild settings", "aria-label": "Guild settings", on: { click: actions.guildSettings } }, "⚙"));
    } else {
      header.append(h("button", { class: "icon-btn", type: "button", title: "Leave guild", "aria-label": "Leave guild", on: { click: actions.leaveGuild } }, "⇥"));
    }
  } else {
    header.append(h("span", { class: "title muted" }, state.info?.server_name || ""));
  }

  // Channels
  const list = clear($("#channel-list"));
  if (guild) {
    list.append(h("div", { class: "section-label" },
      h("span", {}, "Text channels"),
      isOwner ? h("button", { class: "icon-btn", type: "button", title: "Create channel", "aria-label": "Create channel", on: { click: actions.createChannel } }, "+") : null,
    ));
    state.channels.forEach((c, i) => {
      const active = c.channel_id === state.channelId;
      const ownerActions = isOwner ? h("span", { class: "actions" },
        i > 0 ? iconBtn("↑", "Move up", () => actions.moveChannel(c, -1)) : null,
        i < state.channels.length - 1 ? iconBtn("↓", "Move down", () => actions.moveChannel(c, 1)) : null,
        iconBtn("✎", "Rename", () => actions.renameChannel(c)),
        iconBtn("🗑", "Delete", () => actions.deleteChannel(c)),
      ) : null;
      list.append(h("div", {
        class: `channel ${active ? "active" : ""}`, role: "link", tabindex: "0",
        "aria-current": active ? "page" : null,
        on: {
          click: () => { if (!active) actions.openChannel(c.channel_id); else actions.toggleNav(false); },
          keydown: (e) => { if (e.key === "Enter" && e.target === e.currentTarget) actions.openChannel(c.channel_id); },
        },
      }, h("span", { class: "hash", "aria-hidden": "true" }, "#"), h("span", { class: "name" }, c.name), ownerActions));
    });
  } else if (state.user) {
    list.append(h("p", { class: "muted small", style: "padding:8px" }, "Pick a guild on the left, or press + to create or join one."));
  }

  // User panel
  const panel = clear($("#user-panel"));
  if (state.user) {
    clear(panel,
      avatar(state.user.username, { online: state.connected }),
      h("div", { class: "who" },
        h("div", { class: "name" }, state.user.username),
        h("div", { class: "sub" }, state.user.is_server_owner ? "Server owner" : state.info?.server_name || ""),
      ),
      state.user.is_server_owner ? iconBtn("⚙", "Server settings", actions.serverSettings) : null,
      iconBtn("⏻", "Log out", actions.logout),
    );
  }
}

function iconBtn(glyph, label, onClick) {
  return h("button", {
    class: "icon-btn", type: "button", title: label, "aria-label": label,
    on: { click: (e) => { e.stopPropagation(); onClick(); } },
  }, glyph);
}
