// Guild Settings (full screen). Tabs appear according to the viewer's
// permissions: Overview, Roles, Emoji, Stickers, Members, Invites, Bans,
// Audit log, Delete.

import { LIMITS, PERMS, T } from "../protocol.js";
import { can, currentGuild, isGuildOwner, memberRoles, nameOf, state, userById } from "../state.js";
import { add, avatar, clear, displayName, fmtDate, fmtDateTime, h, iconBtn, imageEl } from "./dom.js";
import { emojiTab, stickersTab } from "./expressionSettings.js";
import { guildIcon, invitesTab } from "./invites.js";
import { closeFullscreen, confirmAction, confirmModal, openFullscreen, openMenu, refreshFullscreen, toast } from "./modals.js";
import { copyText } from "./profile.js";
import { guildCan } from "../perks.js";
import { openEmojiPicker } from "./emoji.js";
import { cropImage } from "./cropper.js";
import { pickImage, uploadImage } from "./images.js";
import { roleIconOf, roleSwatch } from "./names.js";
import { scopedT } from "../strings.js";
import { icon } from "./icons.js";

const t = scopedT("ui/guildSettings");

export const PERM_INFO = () => [
  { heading: t("perm_heading_general") },
  ["VIEW_CHANNEL", t("perm_view_channel_label"), t("perm_view_channel_desc")],
  ["MANAGE_CHANNELS", t("perm_manage_channels_label"), t("perm_manage_channels_desc")],
  ["MANAGE_ROLES", t("perm_manage_roles_label"), t("perm_manage_roles_desc")],
  ["MANAGE_GUILD", t("perm_manage_guild_label"), t("perm_manage_guild_desc")],
  ["MANAGE_EXPRESSIONS", t("perm_manage_expressions_label"), t("perm_manage_expressions_desc")],
  ["VIEW_AUDIT_LOG", t("perm_view_audit_log_label"), t("perm_view_audit_log_desc")],
  { heading: t("perm_heading_membership") },
  ["CREATE_INVITE", t("perm_create_invite_label"), t("perm_create_invite_desc")],
  ["KICK_MEMBERS", t("perm_kick_members_label"), t("perm_kick_members_desc")],
  ["BAN_MEMBERS", t("perm_ban_members_label"), t("perm_ban_members_desc")],
  ["MODERATE_MEMBERS", t("perm_moderate_members_label"), t("perm_moderate_members_desc")],
  ["CHANGE_NICKNAME", t("perm_change_nickname_label"), t("perm_change_nickname_desc")],
  ["MANAGE_NICKNAMES", t("perm_manage_nicknames_label"), t("perm_manage_nicknames_desc")],
  { heading: t("perm_heading_text") },
  ["SEND_MESSAGES", t("perm_send_messages_label"), t("perm_send_messages_desc")],
  ["READ_HISTORY", t("perm_read_history_label"), t("perm_read_history_desc")],
  ["ADD_REACTIONS", t("perm_add_reactions_label"), t("perm_add_reactions_desc")],
  ["ATTACH_FILES", t("perm_attach_files_label"), t("perm_attach_files_desc")],
  ["MENTION_EVERYONE", t("perm_mention_everyone_label"), t("perm_mention_everyone_desc")],
  ["MANAGE_MESSAGES", t("perm_manage_messages_label"), t("perm_manage_messages_desc")],
  { heading: t("perm_heading_voice") },
  ["CONNECT", t("perm_connect_label"), t("perm_connect_desc")],
  { heading: t("perm_heading_advanced") },
  ["ADMINISTRATOR", t("perm_administrator_label"), t("perm_administrator_desc")],
];

export const CHANNEL_PERM_KEYS = ["VIEW_CHANNEL", "SEND_MESSAGES", "READ_HISTORY", "ADD_REACTIONS", "ATTACH_FILES", "MENTION_EVERYONE", "MANAGE_MESSAGES", "MANAGE_CHANNELS", "CONNECT"];

const AUDIT_TEXT = () => ({
  "guild.update": t("audit_guild_update"),
  "channel.create": t("audit_channel_create"),
  "channel.update": t("audit_channel_update"),
  "channel.delete": t("audit_channel_delete"),
  "role.create": t("audit_role_create"),
  "role.update": t("audit_role_update"),
  "role.reorder": t("audit_role_reorder"),
  "role.delete": t("audit_role_delete"),
  "member.roles": t("audit_member_roles"),
  "member.kick": t("audit_member_kick"),
  "member.ban": t("audit_member_ban"),
  "member.unban": t("audit_member_unban"),
  "member.timeout": t("audit_member_timeout"),
  "message.delete": t("audit_message_delete"),
  "message.pin": t("audit_message_pin"),
  "member.nickname": t("audit_member_nickname"),
  "invite.revoke": t("audit_invite_revoke"),
  "channel.reorder": t("audit_channel_reorder"),
  "guild.transfer": t("audit_guild_transfer"),
  "emoji.create": t("audit_emoji_create"),
  "emoji.update": t("audit_emoji_update"),
  "emoji.delete": t("audit_emoji_delete"),
  "sticker.create": t("audit_sticker_create"),
  "sticker.update": t("audit_sticker_update"),
  "sticker.delete": t("audit_sticker_delete"),
});

export function guildSettings(actions, initial) {
  const g = currentGuild();
  if (!g) return;
  const owner = isGuildOwner(g);
  const any = (...flags) => flags.some((f) => can(f));
  openFullscreen({
    title: t("settings_title", { name: g.name }),
    initial,
    route: { kind: "guild", guildId: g.guild_id },
    sections: [
      { heading: g.name },
      any("MANAGE_GUILD") ? { id: "overview", label: t("tab_overview"), render: (el) => overview(el, actions) } : null,
      any("MANAGE_ROLES") ? { id: "roles", label: t("tab_roles"), render: (el) => roles(el, actions) } : null,
      any("MANAGE_EXPRESSIONS") ? { id: "emoji", label: t("tab_emoji"), render: (el) => emojiTab(el, actions) } : null,
      any("MANAGE_EXPRESSIONS") ? { id: "stickers", label: t("tab_stickers"), render: (el) => stickersTab(el, actions) } : null,
      any("MANAGE_ROLES", "KICK_MEMBERS", "BAN_MEMBERS", "MODERATE_MEMBERS") ? { id: "members", label: t("tab_members"), render: (el) => members(el, actions) } : null,
      any("CREATE_INVITE", "MANAGE_GUILD") ? { id: "invites", label: t("tab_invites"), render: (el) => invitesTab(el, actions) } : null,
      any("BAN_MEMBERS") ? { id: "bans", label: t("tab_bans"), render: (el) => bans(el, actions) } : null,
      any("VIEW_AUDIT_LOG") ? { id: "audit", label: t("tab_audit_log"), render: (el) => audit(el, actions) } : null,
      owner ? { separator: true } : null,
      owner ? { id: "delete", label: t("tab_delete_guild"), title: t("tab_delete_guild"), render: (el) => deleteGuild(el, actions) } : null,
    ],
  });
}

function overview(el, actions) {
  const g = currentGuild();
  const listedNote = state.info.guild_list_visible
    ? t("guild_listed_note")
    : t("guild_unlisted_note");
  const animated = guildCan("animated_media", g);
  const upload = (kind, apply, ok) => (e) => {
    const btn = e.currentTarget;
    pickImage(async (file) => {
      const cropped = await cropImage(file, kind, { allowAnimated: animated });
      if (!cropped) return;
      btn.disabled = true;
      try {
        const media = await uploadImage(cropped, kind, { still: !animated });
        await apply(media.media_id);
        toast(ok);
        refreshFullscreen();
      } catch (err) {
        toast(err.message, { error: true });
      } finally {
        btn.disabled = false;
      }
    });
  };
  const bannerAllowed = guildCan("guild_banner", g);
  const texts = state.channels.filter((c) => c.kind === "text");
  const sysChannel = h("select", { name: "system_channel_id" },
    h("option", { value: "" }, t("no_system_messages")),
    texts.map((c) => h("option", { value: c.channel_id, selected: c.channel_id === g.system_channel_id }, `#${c.name}`)));
  const flag = (bit, label) => h("label", { class: "check" },
    h("input", { type: "checkbox", name: `flag${bit}`, checked: !!(g.system_flags & bit) }), label);
  const form = h("form", { class: "stack narrow" },
    h("div", { class: "avatar-edit" },
      guildIcon(g, "lg"),
      h("div", { class: "stack" },
        h("div", { class: "row" },
          h("button", { class: "btn primary", type: "button", on: { click: upload("guild_icon", (id) => actions.setGuildIconMedia(id), t("icon_updated_toast")) } }, t("upload_icon_btn")),
          g.icon_id ? h("button", {
            class: "btn",
            type: "button",
            on: {
              click: (e) => confirmAction(e, {
                title: t("remove_icon_title"),
                message: t("remove_icon_body"),
                confirmLabel: t("remove_btn"),
                onConfirm: async () => { try { await actions.setGuildIcon(null); refreshFullscreen(); } catch (err) { toast(err.message, { error: true }); } },
              }),
            },
          }, t("remove_btn")) : null),
        h("span", { class: "muted small" }, animated ? t("icon_hint_animated") : t("icon_hint")))),
    h("div", { class: "field" },
      h("span", { class: "field-label" }, t("banner_field_label")),
      g.banner_id && bannerAllowed ? h("div", { class: "guild-banner-preview" }, imageEl(g.banner_id, { animate: animated, alt: "" })) : null,
      bannerAllowed
        ? h("div", { class: "row" },
          h("button", { class: "btn", type: "button", on: { click: upload("guild_banner", (id) => actions.updateGuild({ banner_media_id: id }), t("banner_updated_toast")) } }, g.banner_id ? t("change_banner_btn") : t("upload_banner_btn")),
          g.banner_id ? h("button", {
            class: "btn",
            type: "button",
            on: {
              click: (e) => confirmAction(e, {
                title: t("remove_guild_banner_title"),
                message: t("remove_guild_banner_body"),
                confirmLabel: t("remove_btn"),
                onConfirm: async () => { try { await actions.updateGuild({ banner_media_id: null }); refreshFullscreen(); } catch (err) { toast(err.message, { error: true }); } },
              }),
            },
          }, t("remove_btn")) : null,
          h("span", { class: "muted small" }, t("banner_hint")))
        : h("div", { class: "locked-note" }, icon("lock"), " ", state.info.customization_mode === "allowlist"
          ? t("banner_locked_allowlist")
          : t("banner_locked_off"))),
    h("label", {}, t("guild_name_label"), h("input", { name: "name", required: true, maxLength: LIMITS.GUILD_NAME_MAX, value: g.name })),
    h("label", { class: "check" }, h("input", { type: "checkbox", name: "listed", checked: g.listed }), h("span", {}, t("list_in_directory_label"), h("span", { class: "muted small block" }, listedNote))),
    h("h3", {}, t("system_messages_heading")),
    h("label", {}, t("channel_label"), sysChannel),
    flag(LIMITS.SYSTEM_JOIN, t("system_join_label")),
    flag(LIMITS.SYSTEM_LEAVE, t("system_leave_label")),
    h("div", { class: "muted small" }, t("guild_id_label"), h("button", { class: "btn link mono", type: "button", on: { click: () => copyText(g.guild_id, t("guild_id_copied_toast")) } }, g.guild_id)),
    h("div", {}, h("button", { class: "btn primary", type: "submit" }, t("save_changes_btn"))));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const patch = {};
    const name = String(fd.get("name")).trim();
    if (name !== g.name) patch.name = name;
    if ((fd.get("listed") === "on") !== g.listed) patch.listed = fd.get("listed") === "on";
    const sys = fd.get("system_channel_id") || null;
    if (sys !== g.system_channel_id) patch.system_channel_id = sys;
    const flags = (fd.get(`flag${LIMITS.SYSTEM_JOIN}`) ? LIMITS.SYSTEM_JOIN : 0) | (fd.get(`flag${LIMITS.SYSTEM_LEAVE}`) ? LIMITS.SYSTEM_LEAVE : 0);
    if (flags !== g.system_flags) patch.system_flags = flags;
    try {
      if (Object.keys(patch).length) await actions.updateGuild(patch);
      toast(t("saved_toast"));
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
  add(el, form);
}

// --- Roles -------------------------------------------------------------------

// Survives re-renders caused by live role events.
let selected = null;

function roles(el, actions) {
  if (!state.roles.some((r) => r.role_id === selected)) {
    selected = state.roles.find((r) => !r.is_everyone && r.position < actions.myRank())?.role_id || state.roles.at(-1)?.role_id;
  }
  const list = h("div", { class: "role-list" });
  const editor = h("div", { class: "role-editor" });
  const myPerms = currentGuild().my_permissions;

  const drawList = () => {
    const rank = actions.myRank();
    const movable = state.roles.filter((r) => !r.is_everyone);
    clear(list,
      h("button", { class: "btn primary block", type: "button", on: { click: create } }, t("create_role_btn")),
      state.roles.map((r) => {
        const editable = r.is_everyone || r.position < rank;
        const idx = movable.findIndex((x) => x.role_id === r.role_id);
        const menu = (anchor) => openMenu(anchor, [
          { label: t("move_up_label"), icon: "arrow-up", disabled: !(idx > 0 && movable[idx - 1].position < rank), onClick: () => move(r, -1) },
          { label: t("move_down_label"), icon: "arrow-down", disabled: !(idx < movable.length - 1), onClick: () => move(r, 1) },
          "-",
          { label: t("delete_role_label"), icon: "trash-2", danger: true, onClick: () => deleteRole(r) },
        ], { placement: "right" });
        return h("div", {
          class: `role-item ${r.role_id === selected ? "active" : ""} ${editable ? "" : "locked"}`,
          role: "button", tabindex: "0",
          on: {
            click: () => select(r.role_id),
            contextmenu: (e) => { if (!r.is_everyone && editable) { e.preventDefault(); menu({ x: e.clientX, y: e.clientY }); } },
          },
        },
        roleSwatch(r),
        h("span", { class: "name" }, r.name),
        roleIconOf(r),
        r.hoist ? h("span", { class: "muted small", title: t("hoisted_title") }, icon("rows-3")) : null,
        editable ? null : h("span", { class: "lock", title: t("locked_role_title") }, icon("lock")),
        !r.is_everyone && editable ? iconBtn("ellipsis", t("more_options_for", { name: r.name }), (e) => menu(e.currentTarget)) : null);
      }));
  };

  // Unsaved edits: switching roles asks first (like Discord's "Careful!" bar).
  let dirty = false;
  const select = (id) => {
    if (id === selected) return;
    if (dirty) {
      confirmModal({
        title: t("discard_changes_title"), message: t("discard_changes_message"), confirmLabel: t("discard_btn"),
        onConfirm: () => { dirty = false; selected = id; drawList(); drawEditor(); },
      });
      return;
    }
    selected = id;
    drawList();
    drawEditor();
  };

  const deleteRole = (role) => confirmModal({
    title: t("delete_role_title", { name: role.name }),
    message: t("delete_role_message"),
    confirmLabel: t("delete_role_label"),
    onConfirm: async () => {
      await actions.req(T.ROLE_DELETE, { role_id: role.role_id });
      dirty = false;
      if (selected === role.role_id) selected = state.roles.find((r) => r.role_id !== role.role_id && !r.is_everyone)?.role_id || state.guildId;
    },
  });

  const move = async (role, delta) => {
    const ids = state.roles.filter((r) => !r.is_everyone).map((r) => r.role_id);
    const i = ids.indexOf(role.role_id);
    const j = i + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try {
      await actions.req(T.ROLE_REORDER, { guild_id: state.guildId, role_ids: ids });
    } catch (e) {
      toast(e.message, { error: true });
    }
  };

  async function create() {
    try {
      const { role } = await actions.req(T.ROLE_CREATE, { guild_id: state.guildId, name: t("default_role_name") });
      selected = role.role_id;
      await actions.reloadRoles();
      drawList();
      drawEditor();
      editor.querySelector("input[name=name]")?.select();
    } catch (e) {
      toast(e.message, { error: true });
    }
  }

  const drawEditor = () => {
    const role = state.roles.find((r) => r.role_id === selected);
    clear(editor);
    if (!role) return;
    const editable = role.is_everyone || role.position < actions.myRank();
    const perms = { value: role.permissions };
    const form = h("form", { class: "stack" });
    const color = h("input", { type: "color", name: "color", value: role.color || "#99aab5", disabled: role.is_everyone || !editable });
    let useColor = !!role.color;
    const g = currentGuild();
    const gradAllowed = guildCan("gradient_roles", g);
    let gradOn = gradAllowed && role.colors?.length > 1;
    const stop2 = h("input", { type: "color", value: role.colors?.[1] || "#f7768e", disabled: !editable, "aria-label": t("second_colour_aria") });
    let third = role.colors?.length > 2;
    const stop3 = h("input", { type: "color", value: role.colors?.[2] || "#e0af68", disabled: !editable, "aria-label": t("third_colour_aria") });
    const gradPreview = h("span", { class: "grad-sample" }, role.name);
    const drawGrad = () => {
      const stops = [color.value, stop2.value, ...(third ? [stop3.value] : [])];
      gradPreview.className = gradOn ? "grad-sample grad-name" : "grad-sample";
      gradPreview.style.cssText = gradOn ? `--grad:linear-gradient(90deg, ${stops.join(", ")}, ${stops[0]})` : `color:${useColor ? color.value : "inherit"}`;
      stop2.hidden = !gradOn;
      stop3.hidden = !gradOn || !third;
      thirdBtn.hidden = !gradOn;
      thirdBtn.textContent = third ? t("remove_third_colour_btn") : t("add_third_colour_btn");
    };
    const thirdBtn = h("button", { class: "btn link", type: "button", disabled: !editable, on: { click: () => { third = !third; drawGrad(); form.dispatchEvent(new Event("input")); } } });
    for (const input of [color, stop2, stop3]) input.addEventListener("input", drawGrad);
    const iconAllowed = guildCan("role_icons", g);
    const setIcon = async (payload, btn) => {
      if (btn) btn.disabled = true;
      try {
        await actions.req(T.ROLE_UPDATE, { role_id: role.role_id, ...payload });
        toast(t("role_icon_updated_toast"));
      } catch (err) {
        toast(err.message, { error: true });
      } finally {
        if (btn) btn.disabled = false;
      }
    };
    const iconField = role.is_everyone ? null : h("div", { class: "field" },
      h("span", { class: "field-label" }, t("role_icon_label")),
      iconAllowed
        ? h("div", { class: "row" },
          h("span", { class: "role-icon-preview" }, roleIconOf(role) || h("span", { class: "muted small" }, t("role_icon_none"))),
          h("button", {
            class: "btn", type: "button", disabled: !editable,
            on: {
              click: (e) => {
                const btn = e.currentTarget;
                pickImage(async (file) => {
                  try {
                    const media = await uploadImage(file, "role_icon", { still: !guildCan("animated_media", g) });
                    await setIcon({ icon_media_id: media.media_id }, btn);
                  } catch (err) { toast(err.message, { error: true }); }
                });
              },
            },
          }, t("upload_image_btn")),
          h("button", {
            class: "btn", type: "button", disabled: !editable,
            on: { click: (e) => openEmojiPicker(e.currentTarget, (emoji) => setIcon({ icon_emoji: emoji }), { custom: false, placement: "bottom" }) },
          }, t("pick_emoji_btn")),
          role.icon_id || role.icon_emoji ? h("button", {
            class: "btn", type: "button", disabled: !editable,
            on: {
              click: (e) => {
                const btn = e.currentTarget;
                confirmAction(e, {
                  title: t("remove_role_icon_title", { role: role.name }),
                  message: t("remove_role_icon_body"),
                  confirmLabel: t("remove_btn"),
                  onConfirm: () => setIcon({ icon_media_id: null, icon_emoji: null }, btn),
                });
              },
            },
          }, t("remove_btn")) : null)
        : h("div", { class: "locked-note" }, t("role_icons_locked_prefix"), state.info.customization_mode === "allowlist" ? t("role_icons_locked_allowlist") : t("role_icons_locked_off")));
    const bar = h("div", { class: "unsaved-bar", hidden: true },
      h("span", {}, t("unsaved_bar_text")),
      h("button", { class: "btn link", type: "button", on: { click: () => { dirty = false; drawEditor(); } } }, t("reset_btn")),
      h("button", { class: "btn primary", type: "submit" }, t("save_changes_btn")));
    const markDirty = () => { dirty = true; bar.hidden = false; };
    form.addEventListener("input", markDirty);
    form.addEventListener("change", markDirty);
    add(form,
      h("div", { class: "row" },
        h("label", { class: "grow" }, t("role_name_label"), h("input", { name: "name", maxLength: LIMITS.ROLE_NAME_MAX, value: role.name, disabled: role.is_everyone || !editable })),
        role.is_everyone ? null : h("div", { class: "field" }, h("span", { class: "field-label" }, t("colour_field_label")),
          h("div", { class: "row" }, color, stop2, stop3, h("label", { class: "check" }, h("input", {
            type: "checkbox", class: "no-color", checked: !useColor, disabled: !editable, on: { change: (e) => { useColor = !e.currentTarget.checked; drawGrad(); } },
          }), t("no_colour_label"))))),
      role.is_everyone ? null : h("div", { class: "field" },
        h("span", { class: "field-label" }, t("gradient_field_label")),
        gradAllowed
          ? h("div", { class: "row" },
            h("label", { class: "check" }, h("input", {
              type: "checkbox", checked: gradOn, disabled: !editable,
              on: { change: (e) => { gradOn = e.currentTarget.checked; if (gradOn) { useColor = true; form.querySelector(".no-color").checked = false; } drawGrad(); } },
            }), t("gradient_name_label")),
            thirdBtn, gradPreview)
          : h("div", { class: "locked-note" }, t("gradient_locked_prefix"), state.info.customization_mode === "allowlist" ? t("gradient_locked_allowlist") : t("gradient_locked_off"))),
      iconField,
      role.is_everyone ? h("p", { class: "muted small" }, t("everyone_role_note")) : null,
      role.is_everyone ? null : h("label", { class: "perm-row" },
        h("span", { class: "meta" }, h("span", { class: "name" }, t("hoist_perm_name")), h("span", { class: "sub" }, t("hoist_perm_desc"))),
        h("input", { type: "checkbox", class: "switch", name: "hoist", checked: role.hoist, disabled: !editable })),
      editable ? null : h("p", { class: "error-box info" }, t("role_locked_note")));
    color.addEventListener("input", () => { useColor = true; form.querySelector(".no-color").checked = false; drawGrad(); });
    if (!role.is_everyone) drawGrad();
    const permBox = h("div", { class: "perm-list" });
    for (const item of PERM_INFO()) {
      if (item.heading) { add(permBox, h("div", { class: "perm-heading" }, item.heading)); continue; }
      const [key, label, desc] = item;
      const bit = PERMS[key];
      const on = !!(role.permissions & bit);
      // You can't add a permission you don't have.
      const locked = !editable || (!on && !(myPerms & bit));
      add(permBox, h("label", { class: "perm-row" },
        h("span", { class: "meta" }, h("span", { class: "name" }, label), h("span", { class: "sub" }, desc)),
        h("input", {
          type: "checkbox", class: "switch", checked: on, disabled: locked,
          on: { change: (e) => { perms.value = e.currentTarget.checked ? perms.value | bit : perms.value & ~bit; } },
        })));
    }
    add(form, permBox);
    if (editable) add(form, bar);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const patch = { permissions: perms.value };
      if (!role.is_everyone) {
        patch.name = String(fd.get("name")).trim() || role.name;
        patch.color = useColor ? color.value : null;
        if (gradOn && useColor) patch.colors = [color.value, stop2.value, ...(third ? [stop3.value] : [])];
        patch.hoist = fd.get("hoist") === "on";
      }
      try {
        await actions.req(T.ROLE_UPDATE, { role_id: role.role_id, ...patch });
        dirty = false;
        bar.hidden = true;
        toast(t("role_saved_toast"));
      } catch (err) {
        toast(err.message, { error: true });
      }
    });
    add(editor, form);
  };

  add(el, h("div", { class: "roles-layout" }, list, editor));
  drawList();
  drawEditor();
  // Live updates (role.* events) refresh this page through refreshFullscreen.
}

// --- Members -------------------------------------------------------------------

function members(el, actions) {
  const search = h("input", { type: "search", placeholder: t("search_members_placeholder"), "aria-label": t("search_members_aria") });
  const list = h("div", { class: "list" });
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    clear(list);
    for (const m of state.members) {
      const u = userById(m.user.user_id) || m.user;
      if (q && !u.username.toLowerCase().includes(q) && !(u.display_name || "").toLowerCase().includes(q) && !(m.nickname || "").toLowerCase().includes(q)) continue;
      const items = actions.moderationItems(u.user_id);
      const assignable = actions.assignableRoles();
      const timedOut = m.timed_out_until && new Date(m.timed_out_until) > new Date();
      add(list, h("div", { class: "list-row" },
        avatar(u, { size: "sm" }),
        h("span", { class: "meta" },
          h("span", { class: "name" }, nameOf(u), m.nickname ? h("span", { class: "muted small" }, ` ${u.username}`) : null,
            m.is_owner ? h("span", { class: "crown" }, " ", icon("crown")) : null,
            timedOut ? h("span", { class: "tag warn" }, t("timed_out_tag")) : null),
          h("span", { class: "sub" }, t("joined_fact", { date: fmtDate(m.joined_at) }),
            m.invited_by ? t("invited_by_fact", { name: nameOf(userById(m.invited_by) || { username: t("someone_fallback") }) }) : m.invite_code ? t("invited_via_link_fact") : "",
            m.invite_code ? h("span", { class: "mono" }, ` (${m.invite_code})`) : null),
          h("span", { class: "role-chips" }, memberRoles(m).map((r) => h("span", { class: "role-chip" },
            roleSwatch(r), r.name)))),
        h("span", { class: "row" },
          assignable.length && (u.user_id === state.user.user_id || actions.outranks(u.user_id)) ? h("button", {
            class: "btn", type: "button",
            on: {
              click: (e) => openMenu(e.currentTarget, assignable.map((r) => ({
                label: r.name, checked: m.role_ids.includes(r.role_id),
                icon: roleSwatch(r),
                onClick: () => actions.setMemberRoles(u.user_id, m.role_ids.includes(r.role_id)
                  ? m.role_ids.filter((id) => id !== r.role_id) : [...m.role_ids, r.role_id]),
              }))),
            },
          }, t("roles_btn")) : null,
          items.length ? h("button", { class: "btn", type: "button", on: { click: (e) => openMenu(e.currentTarget, items) } }, t("moderate_btn")) : null)));
    }
  };
  search.addEventListener("input", draw);
  add(el, search, list);
  draw();
}

// --- Bans, audit log -----------------------------------------------------------

async function bans(el, actions) {
  const { bans: list } = await actions.req(T.GUILD_BANS_LIST, { guild_id: state.guildId });
  if (!list.length) { add(el, h("p", { class: "muted" }, t("nobody_banned"))); return; }
  const box = h("div", { class: "list" });
  for (const b of list) {
    add(box, h("div", { class: "list-row" },
      avatar(b.user, { size: "sm" }),
      h("span", { class: "meta" }, h("span", { class: "name" }, displayName(b.user)),
        h("span", { class: "sub" }, `${b.reason ? `“${b.reason}” · ` : ""}${fmtDateTime(b.created_at)}`)),
      h("button", {
        class: "btn", type: "button",
        on: {
          click: (e) => confirmAction(e, {
            title: t("unban_title", { name: displayName(b.user) }),
            message: t("unban_body"),
            confirmLabel: t("unban_btn"),
            danger: false,
            onConfirm: async () => {
              try {
                await actions.req(T.MEMBER_UNBAN, { guild_id: state.guildId, user_id: b.user.user_id });
                toast(t("unbanned_toast", { name: displayName(b.user) }));
                refreshFullscreen();
              } catch (err) {
                toast(err.message, { error: true });
              }
            },
          }),
        },
      }, t("unban_btn"))));
  }
  add(el, box);
}

async function audit(el, actions) {
  const box = h("div", { class: "list" });
  const more = h("button", { class: "btn", type: "button", hidden: true }, t("load_more_btn"));
  const actionText = AUDIT_TEXT();
  let before;
  const nameFor = (id) => {
    const u = userById(id);
    if (u) return displayName(u);
    const role = state.roles.find((r) => r.role_id === id);
    if (role) return role.name;
    const ch = state.channels.find((c) => c.channel_id === id);
    return ch ? `#${ch.name}` : null;
  };
  const load = async () => {
    const res = await actions.req(T.GUILD_AUDIT_LOG, { guild_id: state.guildId, before, limit: 50 });
    for (const e of res.entries) {
      actions.rememberUser(e.actor);
      const target = e.target_id ? nameFor(e.target_id) : null;
      const d = e.details || {};
      const extra = [
        d.name && e.action.startsWith("channel") ? `#${d.name}` : d.name ? d.name : null,
        d.reason ? t("audit_reason", { reason: d.reason }) : null,
        d.until ? t("audit_until", { date: fmtDateTime(d.until) }) : e.action === "member.timeout" ? t("audit_lifted") : null,
        d.added?.length ? t("audit_added", { items: d.added.join(", ") }) : null,
        d.removed?.length ? t("audit_removed", { items: d.removed.join(", ") }) : null,
        d.channel ? t("audit_in_channel", { channel: d.channel }) : null,
      ].filter(Boolean).join(" · ");
      add(box, h("div", { class: "list-row" },
        avatar(e.actor, { size: "sm" }),
        h("span", { class: "meta" },
          h("span", { class: "name" }, h("strong", {}, displayName(e.actor)), ` ${actionText[e.action] || e.action}`,
            target && (e.action.startsWith("member") || e.action === "message.delete") ? h("strong", {}, ` ${target}`) : null),
          h("span", { class: "sub" }, [fmtDateTime(e.created_at), extra].filter(Boolean).join(" · ")))));
      before = e.entry_id;
    }
    if (!box.children.length) add(box, h("p", { class: "muted" }, t("nothing_happened_yet")));
    more.hidden = !res.has_more;
  };
  more.addEventListener("click", load);
  add(el, box, more);
  await load();
}

function deleteGuild(el, actions) {
  const g = currentGuild();
  const btn = h("button", {
    class: "btn danger", type: "button",
    on: {
      click: () => confirmModal({
        title: t("delete_guild_confirm_title", { name: g.name }),
        message: t("delete_guild_confirm_body"),
        confirmLabel: t("delete_guild_btn"),
        code: true,
        onConfirm: async () => {
          await actions.req(T.GUILD_DELETE, { guild_id: g.guild_id });
          closeFullscreen();
        },
      }),
    },
  }, t("delete_guild_btn"));
  add(el, h("div", { class: "stack narrow" },
    h("p", {}, t("delete_guild_intro_before"), h("strong", {}, g.name), t("delete_guild_intro_after")),
    h("div", {}, btn)));
}
