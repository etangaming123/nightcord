// Guild Settings (full screen). Tabs appear according to the viewer's
// permissions: Overview, Roles, Emoji, Stickers, Members, Invites, Bans,
// Audit log, Delete.

import { LIMITS, PERMS, T } from "../protocol.js";
import { can, currentGuild, isGuildOwner, memberRoles, nameOf, state, userById } from "../state.js";
import { add, avatar, clear, displayName, fmtDate, fmtDateTime, h, iconBtn, imageEl } from "./dom.js";
import { emojiTab, stickersTab } from "./expressionSettings.js";
import { guildIcon, invitesTab } from "./invites.js";
import { closeFullscreen, confirmModal, openFullscreen, openMenu, refreshFullscreen, toast } from "./modals.js";
import { copyText } from "./profile.js";
import { guildCan } from "../perks.js";
import { openEmojiPicker } from "./emoji.js";
import { pickImage, uploadImage } from "./images.js";
import { roleIconOf, roleSwatch } from "./names.js";

export const PERM_INFO = [
  { heading: "General" },
  ["VIEW_CHANNEL", "View channels", "See channels and read new messages in them."],
  ["MANAGE_CHANNELS", "Manage channels", "Create, edit, reorder and delete channels."],
  ["MANAGE_ROLES", "Manage roles", "Create and edit roles below their highest role, assign them, and edit channel permissions."],
  ["MANAGE_GUILD", "Manage guild", "Change the guild's name, icon, listing, system messages and public invite link, and see every invite."],
  ["MANAGE_EXPRESSIONS", "Manage expressions", "Add, rename and delete this guild's custom emoji and stickers."],
  ["VIEW_AUDIT_LOG", "View audit log", "Read the record of changes made in this guild."],
  { heading: "Membership" },
  ["CREATE_INVITE", "Create invite", "Invite new people to this guild."],
  ["KICK_MEMBERS", "Kick members", "Remove members below them. Kicked members can rejoin with an invite."],
  ["BAN_MEMBERS", "Ban members", "Remove members below them for good, and manage the ban list."],
  ["MODERATE_MEMBERS", "Time out members", "Stop members below them from talking for a while."],
  ["CHANGE_NICKNAME", "Change nickname", "Set their own nickname in this guild."],
  ["MANAGE_NICKNAMES", "Manage nicknames", "Change the nicknames of members below them."],
  { heading: "Text" },
  ["SEND_MESSAGES", "Send messages", "Post messages in channels."],
  ["READ_HISTORY", "Read message history", "Scroll back through older messages."],
  ["ADD_REACTIONS", "Add reactions", "React to messages with emoji."],
  ["ATTACH_FILES", "Attach files", "Upload images, videos and other files."],
  ["MENTION_EVERYONE", "Mention @everyone", "Notify everyone who can see the channel."],
  ["MANAGE_MESSAGES", "Manage messages", "Delete and pin other people's messages, and skip slowmode."],
  { heading: "Voice" },
  ["CONNECT", "Connect", "Join voice channels."],
  { heading: "Advanced" },
  ["ADMINISTRATOR", "Administrator", "Every permission, ignoring channel overrides. Grant with care."],
];

export const CHANNEL_PERM_KEYS = ["VIEW_CHANNEL", "SEND_MESSAGES", "READ_HISTORY", "ADD_REACTIONS", "ATTACH_FILES", "MENTION_EVERYONE", "MANAGE_MESSAGES", "MANAGE_CHANNELS", "CONNECT"];

const ACTION_TEXT = {
  "guild.update": "updated the guild",
  "channel.create": "created a channel",
  "channel.update": "updated a channel",
  "channel.delete": "deleted a channel",
  "role.create": "created a role",
  "role.update": "updated a role",
  "role.reorder": "reordered roles",
  "role.delete": "deleted a role",
  "member.roles": "changed roles for",
  "member.kick": "kicked",
  "member.ban": "banned",
  "member.unban": "unbanned",
  "member.timeout": "timed out",
  "message.delete": "deleted a message by",
  "message.pin": "pinned a message by",
  "member.nickname": "changed the nickname of",
  "invite.revoke": "revoked an invite by",
  "channel.reorder": "reordered channels",
  "guild.transfer": "became the guild owner",
  "emoji.create": "added an emoji",
  "emoji.update": "renamed an emoji",
  "emoji.delete": "deleted an emoji",
  "sticker.create": "added a sticker",
  "sticker.update": "edited a sticker",
  "sticker.delete": "deleted a sticker",
};

export function guildSettings(actions, initial) {
  const g = currentGuild();
  if (!g) return;
  const owner = isGuildOwner(g);
  const any = (...flags) => flags.some((f) => can(f));
  openFullscreen({
    title: `${g.name} settings`,
    initial,
    sections: [
      { heading: g.name },
      any("MANAGE_GUILD") ? { id: "overview", label: "Overview", render: (el) => overview(el, actions) } : null,
      any("MANAGE_ROLES") ? { id: "roles", label: "Roles", render: (el) => roles(el, actions) } : null,
      any("MANAGE_EXPRESSIONS") ? { id: "emoji", label: "Emoji", render: (el) => emojiTab(el, actions) } : null,
      any("MANAGE_EXPRESSIONS") ? { id: "stickers", label: "Stickers", render: (el) => stickersTab(el, actions) } : null,
      any("MANAGE_ROLES", "KICK_MEMBERS", "BAN_MEMBERS", "MODERATE_MEMBERS") ? { id: "members", label: "Members", render: (el) => members(el, actions) } : null,
      any("CREATE_INVITE", "MANAGE_GUILD") ? { id: "invites", label: "Invites", render: (el) => invitesTab(el, actions) } : null,
      any("BAN_MEMBERS") ? { id: "bans", label: "Bans", render: (el) => bans(el, actions) } : null,
      any("VIEW_AUDIT_LOG") ? { id: "audit", label: "Audit log", render: (el) => audit(el, actions) } : null,
      owner ? { separator: true } : null,
      owner ? { id: "delete", label: "Delete guild", title: "Delete guild", render: (el) => deleteGuild(el, actions) } : null,
    ],
  });
}

function overview(el, actions) {
  const g = currentGuild();
  const listedNote = state.info.guild_list_visible
    ? "Anyone on this server can find and join it from Browse."
    : "The server owner has turned off the public list, so this has no effect right now.";
  const animated = guildCan("animated_media", g);
  const upload = (kind, apply, ok) => (e) => {
    const btn = e.currentTarget;
    pickImage(async (file) => {
      btn.disabled = true;
      try {
        const media = await uploadImage(file, kind, { still: !animated });
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
    h("option", { value: "" }, "No system messages"),
    texts.map((c) => h("option", { value: c.channel_id, selected: c.channel_id === g.system_channel_id }, `#${c.name}`)));
  const flag = (bit, label) => h("label", { class: "check" },
    h("input", { type: "checkbox", name: `flag${bit}`, checked: !!(g.system_flags & bit) }), label);
  const form = h("form", { class: "stack narrow" },
    h("div", { class: "avatar-edit" },
      guildIcon(g, "lg"),
      h("div", { class: "stack" },
        h("div", { class: "row" },
          h("button", { class: "btn primary", type: "button", on: { click: upload("guild_icon", (id) => actions.setGuildIconMedia(id), "Icon updated") } }, "Upload icon"),
          g.icon_id ? h("button", { class: "btn", type: "button", on: { click: async () => { try { await actions.setGuildIcon(null); refreshFullscreen(); } catch (e) { toast(e.message, { error: true }); } } } }, "Remove") : null),
        h("span", { class: "muted small" }, animated ? "Square images work best. GIFs stay animated." : "Square images work best."))),
    h("div", { class: "field" },
      h("span", { class: "field-label" }, "Banner"),
      g.banner_id && bannerAllowed ? h("div", { class: "guild-banner-preview" }, imageEl(g.banner_id, { animate: animated, alt: "" })) : null,
      bannerAllowed
        ? h("div", { class: "row" },
          h("button", { class: "btn", type: "button", on: { click: upload("guild_banner", (id) => actions.updateGuild({ banner_media_id: id }), "Banner updated") } }, g.banner_id ? "Change banner" : "Upload banner"),
          g.banner_id ? h("button", { class: "btn", type: "button", on: { click: async () => { try { await actions.updateGuild({ banner_media_id: null }); refreshFullscreen(); } catch (e) { toast(e.message, { error: true }); } } } }, "Remove") : null,
          h("span", { class: "muted small" }, "Shown above the channel list and on invites (16:9)."))
        : h("div", { class: "locked-note" }, "🔒 ", state.info.customization_mode === "allowlist"
          ? "Guild banners need the guild owner to have perks on this server."
          : "Guild banners are turned off on this server.")),
    h("label", {}, "Guild name", h("input", { name: "name", required: true, maxLength: LIMITS.GUILD_NAME_MAX, value: g.name })),
    h("label", { class: "check" }, h("input", { type: "checkbox", name: "listed", checked: g.listed }), h("span", {}, "List in the public guild directory", h("span", { class: "muted small block" }, listedNote))),
    h("h3", {}, "System messages"),
    h("label", {}, "Channel", sysChannel),
    flag(LIMITS.SYSTEM_JOIN, "Say hello when someone joins"),
    flag(LIMITS.SYSTEM_LEAVE, "Say when someone leaves (or is kicked or banned)"),
    h("div", { class: "muted small" }, "Guild ID: ", h("button", { class: "btn link mono", type: "button", on: { click: () => copyText(g.guild_id, "Guild ID copied") } }, g.guild_id)),
    h("div", {}, h("button", { class: "btn primary", type: "submit" }, "Save changes")));
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
      toast("Saved");
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
      h("button", { class: "btn primary block", type: "button", on: { click: create } }, "＋ Create role"),
      state.roles.map((r) => {
        const editable = r.is_everyone || r.position < rank;
        const idx = movable.findIndex((x) => x.role_id === r.role_id);
        const menu = (anchor) => openMenu(anchor, [
          { label: "Move up", icon: "↑", disabled: !(idx > 0 && movable[idx - 1].position < rank), onClick: () => move(r, -1) },
          { label: "Move down", icon: "↓", disabled: !(idx < movable.length - 1), onClick: () => move(r, 1) },
          "-",
          { label: "Delete role", icon: "🗑", danger: true, onClick: () => deleteRole(r) },
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
        r.hoist ? h("span", { class: "muted small", title: "Displayed separately" }, "▤") : null,
        editable ? null : h("span", { class: "lock", title: "Above your highest role" }, "🔒"),
        !r.is_everyone && editable ? iconBtn("⋯", `More options for ${r.name}`, (e) => menu(e.currentTarget)) : null);
      }));
  };

  // Unsaved edits: switching roles asks first (like Discord's "Careful!" bar).
  let dirty = false;
  const select = (id) => {
    if (id === selected) return;
    if (dirty) {
      confirmModal({
        title: "Discard unsaved changes?", message: "You changed this role but didn't save.", confirmLabel: "Discard",
        onConfirm: () => { dirty = false; selected = id; drawList(); drawEditor(); },
      });
      return;
    }
    selected = id;
    drawList();
    drawEditor();
  };

  const deleteRole = (role) => confirmModal({
    title: `Delete the ${role.name} role?`,
    message: "Members lose it and any channel overrides for it. This can't be undone.",
    confirmLabel: "Delete role",
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
      const { role } = await actions.req(T.ROLE_CREATE, { guild_id: state.guildId, name: "new role" });
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
    const stop2 = h("input", { type: "color", value: role.colors?.[1] || "#f7768e", disabled: !editable, "aria-label": "Second colour" });
    let third = role.colors?.length > 2;
    const stop3 = h("input", { type: "color", value: role.colors?.[2] || "#e0af68", disabled: !editable, "aria-label": "Third colour" });
    const gradPreview = h("span", { class: "grad-sample" }, role.name);
    const drawGrad = () => {
      const stops = [color.value, stop2.value, ...(third ? [stop3.value] : [])];
      gradPreview.className = gradOn ? "grad-sample grad-name" : "grad-sample";
      gradPreview.style.cssText = gradOn ? `--grad:linear-gradient(90deg, ${stops.join(", ")}, ${stops[0]})` : `color:${useColor ? color.value : "inherit"}`;
      stop2.hidden = !gradOn;
      stop3.hidden = !gradOn || !third;
      thirdBtn.hidden = !gradOn;
      thirdBtn.textContent = third ? "− Third colour" : "+ Third colour";
    };
    const thirdBtn = h("button", { class: "btn link", type: "button", disabled: !editable, on: { click: () => { third = !third; drawGrad(); form.dispatchEvent(new Event("input")); } } });
    for (const input of [color, stop2, stop3]) input.addEventListener("input", drawGrad);
    const iconAllowed = guildCan("role_icons", g);
    const setIcon = async (payload, btn) => {
      if (btn) btn.disabled = true;
      try {
        await actions.req(T.ROLE_UPDATE, { role_id: role.role_id, ...payload });
        toast("Role icon updated");
      } catch (err) {
        toast(err.message, { error: true });
      } finally {
        if (btn) btn.disabled = false;
      }
    };
    const iconField = role.is_everyone ? null : h("div", { class: "field" },
      h("span", { class: "field-label" }, "Role icon"),
      iconAllowed
        ? h("div", { class: "row" },
          h("span", { class: "role-icon-preview" }, roleIconOf(role) || h("span", { class: "muted small" }, "None")),
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
          }, "Upload image"),
          h("button", {
            class: "btn", type: "button", disabled: !editable,
            on: { click: (e) => openEmojiPicker(e.currentTarget, (emoji) => setIcon({ icon_emoji: emoji }), { custom: false, placement: "bottom" }) },
          }, "Pick emoji"),
          role.icon_id || role.icon_emoji ? h("button", {
            class: "btn", type: "button", disabled: !editable,
            on: { click: (e) => setIcon({ icon_media_id: null, icon_emoji: null }, e.currentTarget) },
          }, "Remove") : null)
        : h("div", { class: "locked-note" }, "🔒 Role icons ", state.info.customization_mode === "allowlist" ? "need the guild owner to have perks." : "are turned off on this server."));
    const bar = h("div", { class: "unsaved-bar", hidden: true },
      h("span", {}, "Careful — you have unsaved changes!"),
      h("button", { class: "btn link", type: "button", on: { click: () => { dirty = false; drawEditor(); } } }, "Reset"),
      h("button", { class: "btn primary", type: "submit" }, "Save changes"));
    const markDirty = () => { dirty = true; bar.hidden = false; };
    form.addEventListener("input", markDirty);
    form.addEventListener("change", markDirty);
    add(form,
      h("div", { class: "row" },
        h("label", { class: "grow" }, "Role name", h("input", { name: "name", maxLength: LIMITS.ROLE_NAME_MAX, value: role.name, disabled: role.is_everyone || !editable })),
        role.is_everyone ? null : h("div", { class: "field" }, h("span", { class: "field-label" }, "Color"),
          h("div", { class: "row" }, color, stop2, stop3, h("label", { class: "check" }, h("input", {
            type: "checkbox", class: "no-color", checked: !useColor, disabled: !editable, on: { change: (e) => { useColor = !e.currentTarget.checked; drawGrad(); } },
          }), "None")))),
      role.is_everyone ? null : h("div", { class: "field" },
        h("span", { class: "field-label" }, "Gradient"),
        gradAllowed
          ? h("div", { class: "row" },
            h("label", { class: "check" }, h("input", {
              type: "checkbox", checked: gradOn, disabled: !editable,
              on: { change: (e) => { gradOn = e.currentTarget.checked; if (gradOn) { useColor = true; form.querySelector(".no-color").checked = false; } drawGrad(); } },
            }), "Gradient name"),
            thirdBtn, gradPreview)
          : h("div", { class: "locked-note" }, "🔒 Gradient roles ", state.info.customization_mode === "allowlist" ? "need the guild owner to have perks." : "are turned off on this server.")),
      iconField,
      role.is_everyone ? h("p", { class: "muted small" }, "@everyone applies to every member of the guild.") : null,
      role.is_everyone ? null : h("label", { class: "perm-row" },
        h("span", { class: "meta" }, h("span", { class: "name" }, "Display role members separately"), h("span", { class: "sub" }, "Online members with this role get their own group in the member list.")),
        h("input", { type: "checkbox", class: "switch", name: "hoist", checked: role.hoist, disabled: !editable })),
      editable ? null : h("p", { class: "error-box info" }, "This role is at or above your highest role, so you can't edit it."));
    color.addEventListener("input", () => { useColor = true; form.querySelector(".no-color").checked = false; drawGrad(); });
    if (!role.is_everyone) drawGrad();
    const permBox = h("div", { class: "perm-list" });
    for (const item of PERM_INFO) {
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
        toast("Role saved");
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
  const search = h("input", { type: "search", placeholder: "Search members", "aria-label": "Search members" });
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
            m.is_owner ? h("span", { class: "crown" }, " ♛") : null,
            timedOut ? h("span", { class: "tag warn" }, "TIMED OUT") : null),
          h("span", { class: "sub" }, `Joined ${fmtDate(m.joined_at)}`,
            m.invited_by ? ` · invited by ${nameOf(userById(m.invited_by) || { username: "someone" })}` : m.invite_code ? " · via the public link" : "",
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
          }, "Roles ▾") : null,
          items.length ? h("button", { class: "btn", type: "button", on: { click: (e) => openMenu(e.currentTarget, items) } }, "Moderate ▾") : null)));
    }
  };
  search.addEventListener("input", draw);
  add(el, search, list);
  draw();
}

// --- Bans, audit log -----------------------------------------------------------

async function bans(el, actions) {
  const { bans: list } = await actions.req(T.GUILD_BANS_LIST, { guild_id: state.guildId });
  if (!list.length) { add(el, h("p", { class: "muted" }, "Nobody is banned.")); return; }
  const box = h("div", { class: "list" });
  for (const b of list) {
    add(box, h("div", { class: "list-row" },
      avatar(b.user, { size: "sm" }),
      h("span", { class: "meta" }, h("span", { class: "name" }, displayName(b.user)),
        h("span", { class: "sub" }, `${b.reason ? `“${b.reason}” · ` : ""}${fmtDateTime(b.created_at)}`)),
      h("button", {
        class: "btn", type: "button",
        on: { click: async () => { await actions.req(T.MEMBER_UNBAN, { guild_id: state.guildId, user_id: b.user.user_id }); toast(`${displayName(b.user)} unbanned`); refreshFullscreen(); } },
      }, "Unban")));
  }
  add(el, box);
}

async function audit(el, actions) {
  const box = h("div", { class: "list" });
  const more = h("button", { class: "btn", type: "button", hidden: true }, "Load more");
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
        d.reason ? `reason: ${d.reason}` : null,
        d.until ? `until ${fmtDateTime(d.until)}` : e.action === "member.timeout" ? "(lifted)" : null,
        d.added?.length ? `added ${d.added.join(", ")}` : null,
        d.removed?.length ? `removed ${d.removed.join(", ")}` : null,
        d.channel ? `in #${d.channel}` : null,
      ].filter(Boolean).join(" · ");
      add(box, h("div", { class: "list-row" },
        avatar(e.actor, { size: "sm" }),
        h("span", { class: "meta" },
          h("span", { class: "name" }, h("strong", {}, displayName(e.actor)), ` ${ACTION_TEXT[e.action] || e.action}`,
            target && (e.action.startsWith("member") || e.action === "message.delete") ? h("strong", {}, ` ${target}`) : null),
          h("span", { class: "sub" }, [fmtDateTime(e.created_at), extra].filter(Boolean).join(" · ")))));
      before = e.entry_id;
    }
    if (!box.children.length) add(box, h("p", { class: "muted" }, "Nothing has happened yet."));
    more.hidden = !res.has_more;
  };
  more.addEventListener("click", load);
  add(el, box, more);
  await load();
}

function deleteGuild(el, actions) {
  const g = currentGuild();
  const input = h("input", { placeholder: g.name, "aria-label": "Type the guild name to confirm" });
  const btn = h("button", { class: "btn danger", type: "button", disabled: true }, "Delete guild");
  input.addEventListener("input", () => { btn.disabled = input.value.trim() !== g.name; });
  btn.addEventListener("click", async () => {
    try {
      await actions.req(T.GUILD_DELETE, { guild_id: g.guild_id });
      closeFullscreen();
    } catch (e) {
      toast(e.message, { error: true });
    }
  });
  add(el, h("div", { class: "stack narrow" },
    h("p", {}, "This deletes every channel, message, role and invite in ", h("strong", {}, g.name), " for everyone. It can't be undone."),
    h("label", {}, "Type the guild name to confirm", input),
    h("div", {}, btn)));
}
