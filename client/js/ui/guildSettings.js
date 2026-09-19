// Guild Settings (full screen). Tabs appear according to the viewer's
// permissions: Overview, Roles, Members, Invites, Bans, Audit log, Delete.

import { LIMITS, PERMS, T } from "../protocol.js";
import { can, currentGuild, isGuildOwner, memberRoles, state, userById } from "../state.js";
import { add, avatar, clear, displayName, fmtDateTime, h, iconBtn } from "./dom.js";
import { closeFullscreen, confirmModal, openFullscreen, openMenu, refreshFullscreen, toast } from "./modals.js";
import { copyText } from "./profile.js";

export const PERM_INFO = [
  { heading: "General" },
  ["VIEW_CHANNEL", "View channels", "See channels and read new messages in them."],
  ["MANAGE_CHANNELS", "Manage channels", "Create, edit, reorder and delete channels."],
  ["MANAGE_ROLES", "Manage roles", "Create and edit roles below their highest role, assign them, and edit channel permissions."],
  ["MANAGE_GUILD", "Manage guild", "Rename the guild and change its listing."],
  ["VIEW_AUDIT_LOG", "View audit log", "Read the record of changes made in this guild."],
  { heading: "Membership" },
  ["CREATE_INVITE", "Create invite", "Invite new people to this guild."],
  ["KICK_MEMBERS", "Kick members", "Remove members below them. Kicked members can rejoin with an invite."],
  ["BAN_MEMBERS", "Ban members", "Remove members below them for good, and manage the ban list."],
  ["MODERATE_MEMBERS", "Time out members", "Stop members below them from talking for a while."],
  { heading: "Text" },
  ["SEND_MESSAGES", "Send messages", "Post messages in channels."],
  ["READ_HISTORY", "Read message history", "Scroll back through older messages."],
  ["ADD_REACTIONS", "Add reactions", "React to messages with emoji."],
  ["MENTION_EVERYONE", "Mention @everyone", "Notify everyone who can see the channel."],
  ["MANAGE_MESSAGES", "Manage messages", "Delete other people's messages."],
  { heading: "Advanced" },
  ["ADMINISTRATOR", "Administrator", "Every permission, ignoring channel overrides. Grant with care."],
];

export const CHANNEL_PERM_KEYS = ["VIEW_CHANNEL", "SEND_MESSAGES", "READ_HISTORY", "ADD_REACTIONS", "MENTION_EVERYONE", "MANAGE_MESSAGES", "MANAGE_CHANNELS"];

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
      any("MANAGE_ROLES", "KICK_MEMBERS", "BAN_MEMBERS", "MODERATE_MEMBERS") ? { id: "members", label: "Members", render: (el) => members(el, actions) } : null,
      any("CREATE_INVITE") ? { id: "invites", label: "Invites", render: (el) => invites(el, actions) } : null,
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
  const form = h("form", { class: "stack narrow" },
    h("label", {}, "Guild name", h("input", { name: "name", required: true, maxLength: LIMITS.GUILD_NAME_MAX, value: g.name })),
    h("label", { class: "check" }, h("input", { type: "checkbox", name: "listed", checked: g.listed }), h("span", {}, "List in the public guild directory", h("span", { class: "muted small block" }, listedNote))),
    h("div", { class: "muted small" }, "Guild ID: ", h("button", { class: "btn link mono", type: "button", on: { click: () => copyText(g.guild_id, "Guild ID copied") } }, g.guild_id)),
    h("div", {}, h("button", { class: "btn primary", type: "submit" }, "Save changes")));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const patch = {};
    const name = String(fd.get("name")).trim();
    if (name !== g.name) patch.name = name;
    if ((fd.get("listed") === "on") !== g.listed) patch.listed = fd.get("listed") === "on";
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
        return h("div", {
          class: `role-item ${r.role_id === selected ? "active" : ""} ${editable ? "" : "locked"}`,
          role: "button", tabindex: "0",
          on: { click: () => { selected = r.role_id; drawList(); drawEditor(); } },
        },
        h("span", { class: "role-dot", style: `background:${r.color || "var(--muted)"}` }),
        h("span", { class: "name" }, r.name),
        editable ? null : h("span", { class: "lock", title: "Above your highest role" }, "🔒"),
        !r.is_everyone && editable && idx > 0 && movable[idx - 1].position < rank ? iconBtn("↑", "Move up", () => move(r, -1)) : null,
        !r.is_everyone && editable && idx < movable.length - 1 ? iconBtn("↓", "Move down", () => move(r, 1)) : null);
      }));
  };

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
    add(form,
      h("div", { class: "row" },
        h("label", { class: "grow" }, "Role name", h("input", { name: "name", maxLength: LIMITS.ROLE_NAME_MAX, value: role.name, disabled: role.is_everyone || !editable })),
        role.is_everyone ? null : h("div", { class: "field" }, h("span", { class: "field-label" }, "Color"),
          h("div", { class: "row" }, color, h("label", { class: "check" }, h("input", {
            type: "checkbox", checked: !useColor, disabled: !editable, on: { change: (e) => { useColor = !e.currentTarget.checked; } },
          }), "None")))),
      role.is_everyone ? h("p", { class: "muted small" }, "@everyone applies to every member of the guild.") : null,
      editable ? null : h("p", { class: "error-box info" }, "This role is at or above your highest role, so you can't edit it."));
    color.addEventListener("input", () => { useColor = true; form.querySelector(".check input").checked = false; });
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
    if (editable) {
      add(form, h("div", { class: "row sticky-actions" },
        h("button", { class: "btn primary", type: "submit" }, "Save changes"),
        role.is_everyone ? null : h("button", {
          class: "btn danger", type: "button",
          on: {
            click: () => confirmModal({
              title: `Delete the ${role.name} role?`,
              message: "Members lose it and any channel overrides for it.",
              confirmLabel: "Delete role",
              onConfirm: async () => {
                await actions.req(T.ROLE_DELETE, { role_id: role.role_id });
                selected = state.roles.find((r) => r.role_id !== role.role_id && !r.is_everyone)?.role_id || state.guildId;
              },
            }),
          },
        }, "Delete role")));
    }
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const patch = { permissions: perms.value };
      if (!role.is_everyone) {
        patch.name = String(fd.get("name")).trim() || role.name;
        patch.color = useColor ? color.value : null;
      }
      try {
        await actions.req(T.ROLE_UPDATE, { role_id: role.role_id, ...patch });
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
      if (q && !u.username.toLowerCase().includes(q) && !(u.display_name || "").toLowerCase().includes(q)) continue;
      const items = actions.moderationItems(u.user_id);
      const assignable = actions.assignableRoles();
      const timedOut = m.timed_out_until && new Date(m.timed_out_until) > new Date();
      add(list, h("div", { class: "list-row" },
        avatar(u, { size: "sm" }),
        h("span", { class: "meta" },
          h("span", { class: "name" }, displayName(u), m.is_owner ? h("span", { class: "crown" }, " ♛") : null,
            timedOut ? h("span", { class: "tag warn" }, "TIMED OUT") : null),
          h("span", { class: "role-chips" }, memberRoles(m).map((r) => h("span", { class: "role-chip" },
            h("span", { class: "role-dot", style: `background:${r.color || "var(--muted)"}` }), r.name)))),
        h("span", { class: "row" },
          assignable.length && (u.user_id === state.user.user_id || actions.outranks(u.user_id)) ? h("button", {
            class: "btn", type: "button",
            on: {
              click: (e) => openMenu(e.currentTarget, assignable.map((r) => ({
                label: r.name, checked: m.role_ids.includes(r.role_id),
                icon: h("span", { class: "role-dot", style: `background:${r.color || "var(--muted)"}` }),
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

// --- Invites, bans, audit log --------------------------------------------------

function invites(el, actions) {
  const area = h("div", { class: "stack narrow" });
  const make = async () => {
    try {
      const code = await actions.createInvite();
      clear(area,
        h("div", { class: "row" }, h("div", { class: "code-display" }, code),
          h("button", { class: "btn", type: "button", on: { click: () => copyText(code, "Invite code copied") } }, "Copy")),
        h("p", { class: "muted small" }, "Share this code. It doesn't expire. People enter it under + → Join with code."),
        h("div", {}, h("button", { class: "btn", type: "button", on: { click: make } }, "Create another")));
    } catch (e) {
      toast(e.message, { error: true });
    }
  };
  clear(area, h("p", { class: "muted" }, "Invite codes let people join this guild."),
    h("div", {}, h("button", { class: "btn primary", type: "button", on: { click: make } }, "Create invite code")));
  add(el, area);
}

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
