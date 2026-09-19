// Channel settings (full screen): name, per-role permission overrides, delete.

import { PERMS, T } from "../protocol.js";
import { can, isPrivate, state } from "../state.js";
import { add, clear, h } from "./dom.js";
import { CHANNEL_PERM_KEYS, PERM_INFO } from "./guildSettings.js";
import { closeFullscreen, confirmModal, openFullscreen, toast } from "./modals.js";
import { normalizeChannelName } from "./dialogs.js";

const LABELS = Object.fromEntries(PERM_INFO.filter((p) => Array.isArray(p)).map(([k, label, desc]) => [k, { label, desc }]));

export function channelSettings(channel, actions, initial) {
  openFullscreen({
    title: `#${channel.name} settings`,
    initial,
    sections: [
      { heading: `#${channel.name}` },
      { id: "overview", label: "Overview", render: (el) => overview(el, channel, actions) },
      can("MANAGE_ROLES") ? { id: "permissions", label: "Permissions", render: (el) => permissions(el, channel, actions) } : null,
      { separator: true },
      { label: "Delete channel", danger: true, onClick: () => confirmModal({
        title: `Delete #${channel.name}?`,
        message: "All of its messages will be deleted too. This can't be undone.",
        confirmLabel: "Delete channel",
        onConfirm: async () => { await actions.req(T.CHANNEL_DELETE, { channel_id: channel.channel_id }); closeFullscreen(); },
      }) },
    ],
  });
}

const fresh = (channel) => state.channels.find((c) => c.channel_id === channel.channel_id) || channel;

function overview(el, channel, actions) {
  const ch = fresh(channel);
  const input = h("input", { name: "name", required: true, maxLength: 40, value: ch.name, spellcheck: "false", autocapitalize: "off" });
  const hint = h("p", { class: "muted small hint" });
  const update = () => { hint.textContent = `Saved as #${normalizeChannelName(input.value) || "…"}`; };
  input.addEventListener("input", update);
  update();
  const form = h("form", { class: "stack narrow" },
    h("label", {}, "Channel name", input), hint,
    h("div", {}, h("button", { class: "btn primary", type: "submit" }, "Save changes")));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = normalizeChannelName(input.value);
    try {
      await actions.req(T.CHANNEL_UPDATE, { channel_id: ch.channel_id, name });
      toast("Saved");
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
  add(el, form);
}

// Tri-state per role per permission: deny / inherit / allow.
function permissions(el, channel, actions) {
  const ch = fresh(channel);
  const draft = new Map(ch.overwrites.map((o) => [o.role_id, { allow: o.allow, deny: o.deny }]));
  let selected = ch.guild_id; // @everyone
  const roleList = h("div", { class: "role-list" });
  const grid = h("div", { class: "role-editor" });
  const myPerms = state.guilds.get(ch.guild_id)?.my_permissions || 0;

  const drawRoles = () => {
    clear(roleList, state.roles.map((r) => {
      const ow = draft.get(r.role_id);
      return h("div", {
        class: `role-item ${r.role_id === selected ? "active" : ""}`, role: "button", tabindex: "0",
        on: { click: () => { selected = r.role_id; drawRoles(); drawGrid(); } },
      }, h("span", { class: "role-dot", style: `background:${r.color || "var(--muted)"}` }), h("span", { class: "name" }, r.name),
      ow && (ow.allow || ow.deny) ? h("span", { class: "muted small" }, "custom") : null);
    }));
  };

  const drawGrid = () => {
    const role = state.roles.find((r) => r.role_id === selected);
    const ow = draft.get(selected) || { allow: 0, deny: 0 };
    clear(grid,
      h("p", { class: "muted" }, role?.is_everyone
        ? "Overrides for everyone. To make a private channel, deny View channel here and allow it for some roles."
        : `Overrides for ${role?.name}. They win over @everyone's.`));
    for (const key of CHANNEL_PERM_KEYS) {
      const bit = PERMS[key];
      const value = ow.allow & bit ? "allow" : ow.deny & bit ? "deny" : "inherit";
      const set = (v) => {
        const next = { allow: ow.allow & ~bit, deny: ow.deny & ~bit };
        if (v === "allow") next.allow |= bit;
        if (v === "deny") next.deny |= bit;
        draft.set(selected, next);
        drawRoles();
        drawGrid();
      };
      const btn = (v, glyph, label) => h("button", {
        class: `tri ${v} ${value === v ? "on" : ""}`, type: "button", title: label, "aria-label": `${label}: ${LABELS[key].label}`,
        "aria-pressed": String(value === v), disabled: v === "allow" && !(myPerms & bit) && value !== "allow",
        on: { click: () => set(v) },
      }, glyph);
      add(grid, h("div", { class: "perm-row" },
        h("span", { class: "meta" }, h("span", { class: "name" }, LABELS[key].label), h("span", { class: "sub" }, LABELS[key].desc)),
        h("span", { class: "tri-group", role: "group" }, btn("deny", "✕", "Deny"), btn("inherit", "／", "Inherit"), btn("allow", "✓", "Allow"))));
    }
    add(grid, h("div", { class: "row sticky-actions" },
      h("button", {
        class: "btn primary", type: "button",
        on: {
          click: async () => {
            const overwrites = [...draft].map(([role_id, o]) => ({ role_id, ...o })).filter((o) => o.allow || o.deny);
            try {
              await actions.req(T.CHANNEL_UPDATE, { channel_id: ch.channel_id, overwrites });
              toast(isPrivate({ ...ch, overwrites }) ? "Saved — this channel is now private" : "Saved");
            } catch (e) {
              toast(e.message, { error: true });
            }
          },
        },
      }, "Save permissions")));
  };

  add(el, h("div", { class: "roles-layout" }, roleList, grid));
  drawRoles();
  drawGrid();
}
