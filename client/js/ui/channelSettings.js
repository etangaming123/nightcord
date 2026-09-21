// Channel settings (full screen): name, topic, slowmode, per-role permission
// overrides (or syncing with the category), delete. Also used for voice
// channels and categories.

import { LIMITS, PERMS, T } from "../protocol.js";
import { can, isPrivate, state } from "../state.js";
import { add, clear, h } from "./dom.js";
import { CHANNEL_PERM_KEYS, PERM_INFO } from "./guildSettings.js";
import { closeFullscreen, confirmModal, openFullscreen, toast } from "./modals.js";
import { normalizeChannelName } from "./dialogs.js";
import { scopedT } from "../strings.js";

const t = scopedT("ui/channelSettings");

const LABELS = () => Object.fromEntries(PERM_INFO().filter((p) => Array.isArray(p)).map(([k, label, desc]) => [k, { label, desc }]));

const titleOf = (c) => (c.kind === "text" ? `#${c.name}` : c.name);
const nounOf = (c) => (c.kind === "category" ? t("noun_category") : t("noun_channel"));

const SLOWMODE_LABEL = (s) => (!s ? t("slowmode_off") : s < 60 ? `${s}s` : s < 3600 ? `${s / 60}m` : `${s / 3600}h`);

export function channelSettings(channel, actions, initial) {
  openFullscreen({
    title: t("settings_title", { title: titleOf(channel) }),
    initial,
    sections: [
      { heading: titleOf(channel) },
      { id: "overview", label: t("tab_overview"), render: (el) => overview(el, channel, actions) },
      can("MANAGE_ROLES") ? { id: "permissions", label: t("tab_permissions"), render: (el) => permissions(el, channel, actions) } : null,
      { separator: true },
      { label: t("delete_noun_label", { noun: nounOf(channel) }), danger: true, onClick: () => confirmModal({
        title: t("delete_title", { title: titleOf(channel) }),
        message: channel.kind === "category" ? t("delete_category_message") : t("delete_channel_message"),
        confirmLabel: t("delete_confirm_label", { noun: nounOf(channel) }),
        onConfirm: async () => { await actions.req(T.CHANNEL_DELETE, { channel_id: channel.channel_id }); closeFullscreen(); },
      }) },
    ],
  });
}

const fresh = (channel) => state.channels.find((c) => c.channel_id === channel.channel_id) || channel;

function overview(el, channel, actions) {
  const ch = fresh(channel);
  const text = ch.kind === "text";
  const input = h("input", { name: "name", required: true, maxLength: 40, value: ch.name, spellcheck: "false", autocapitalize: "off" });
  const hint = h("p", { class: "muted small hint", hidden: !text });
  const update = () => { hint.textContent = t("saved_as", { name: normalizeChannelName(input.value) || "…" }); };
  input.addEventListener("input", update);
  update();
  const topic = text ? h("textarea", { name: "topic", rows: 3, maxLength: LIMITS.TOPIC_MAX, placeholder: t("topic_placeholder") }, ch.topic || "") : null;
  const slow = text ? h("select", { name: "slowmode" }, LIMITS.SLOWMODE_PRESETS.map((v) => h("option", { value: v, selected: v === ch.slowmode_seconds }, SLOWMODE_LABEL(v)))) : null;
  const form = h("form", { class: "stack narrow" },
    h("label", {}, ch.kind === "category" ? t("category_name_label") : t("channel_name_label"), input), hint,
    text ? h("label", {}, t("topic_label"), topic, h("span", { class: "muted small block" }, t("topic_hint"))) : null,
    text ? h("label", {}, t("slowmode_label"), slow, h("span", { class: "muted small block" }, t("slowmode_hint"))) : null,
    h("div", {}, h("button", { class: "btn primary", type: "submit" }, t("save_changes_btn"))));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const patch = { channel_id: ch.channel_id };
    if (text) {
      patch.name = normalizeChannelName(input.value);
      if (!LIMITS.CHANNEL_NAME_RE.test(patch.name)) { toast(t("invalid_channel_name"), { error: true }); return; }
      patch.topic = topic.value.trim();
      patch.slowmode_seconds = Number(slow.value);
    } else {
      patch.name = input.value.trim().replace(/\s+/g, " ");
    }
    try {
      await actions.req(T.CHANNEL_UPDATE, patch);
      toast(t("saved_toast"));
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
  add(el, form);
}

// Tri-state per role per permission: deny / inherit / allow.
function permissions(el, channel, actions) {
  const ch = fresh(channel);
  const parent = ch.parent_id ? state.channels.find((c) => c.channel_id === ch.parent_id) : null;
  const labels = LABELS();
  if (parent) {
    add(el, h("div", { class: `sync-box ${ch.perms_synced ? "synced" : ""}` },
      h("span", {}, ch.perms_synced
        ? [t("synced_before"), h("strong", {}, parent.name), t("synced_after")]
        : [t("not_synced_before"), h("strong", {}, parent.name), t("not_synced_after")]),
      ch.perms_synced ? null : h("button", {
        class: "btn", type: "button",
        on: { click: async () => { try { await actions.req(T.CHANNEL_UPDATE, { channel_id: ch.channel_id, perms_synced: true }); toast(t("synced_now_toast")); } catch (e) { toast(e.message, { error: true }); } } },
      }, t("sync_now_btn"))));
    if (ch.perms_synced) {
      add(el, h("p", { class: "muted" }, t("sync_hint")));
    }
  }
  const source = ch.perms_synced && parent ? parent : ch;
  const draft = new Map(source.overwrites.map((o) => [o.role_id, { allow: o.allow, deny: o.deny }]));
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
        ? t("everyone_overrides_note")
        : t("role_overrides_note", { name: role?.name })));
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
        class: `tri ${v} ${value === v ? "on" : ""}`, type: "button", title: label, "aria-label": t("tri_aria_label", { action: label, perm: labels[key].label }),
        "aria-pressed": String(value === v), disabled: v === "allow" && !(myPerms & bit) && value !== "allow",
        on: { click: () => set(v) },
      }, glyph);
      add(grid, h("div", { class: "perm-row" },
        h("span", { class: "meta" }, h("span", { class: "name" }, labels[key].label), h("span", { class: "sub" }, labels[key].desc)),
        h("span", { class: "tri-group", role: "group" }, btn("deny", "✕", t("deny_label")), btn("inherit", "／", t("inherit_label")), btn("allow", "✓", t("allow_label")))));
    }
    add(grid, h("div", { class: "row sticky-actions" },
      h("button", {
        class: "btn primary", type: "button",
        on: {
          click: async () => {
            const overwrites = [...draft].map(([role_id, o]) => ({ role_id, ...o })).filter((o) => o.allow || o.deny);
            try {
              await actions.req(T.CHANNEL_UPDATE, { channel_id: ch.channel_id, overwrites });
              toast(isPrivate({ ...ch, overwrites }) ? t("saved_private_toast") : t("saved_toast"));
            } catch (e) {
              toast(e.message, { error: true });
            }
          },
        },
      }, t("save_permissions_btn"))));
  };

  add(el, h("div", { class: "roles-layout" }, roleList, grid));
  drawRoles();
  drawGrid();
}
