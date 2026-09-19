// Feature dialogs: add guild, leave guild, channels, DMs, moderation.

import { LIMITS, PERMS } from "../protocol.js";
import { add, avatar, clear, displayName, h, initials } from "./dom.js";
import { closeModal, confirmModal, formModal, openModal, toast } from "./modals.js";

// Lowercase, spaces to dashes, drop anything the protocol doesn't allow.
export function normalizeChannelName(raw) {
  return raw.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "").slice(0, 32);
}

export function addGuildDialog(state, api) {
  let tab = "create";
  const body = h("div");
  const tabs = h("div", { class: "tabs", role: "tablist" });

  const render = () => {
    clear(tabs);
    for (const [key, label] of [["create", "Create"], ["join", "Join with code"], ["browse", "Browse"]]) {
      add(tabs, h("button", {
        class: "tab", type: "button", role: "tab", "aria-selected": String(key === tab),
        on: { click: () => { tab = key; render(); } },
      }, label));
    }
    clear(body);
    if (tab === "create") add(body, createForm());
    if (tab === "join") add(body, joinForm());
    if (tab === "browse") add(body, browseList());
    body.querySelector("input")?.focus();
  };

  const withError = (form, fn) => {
    const error = h("div", { class: "error-box", hidden: true });
    add(form, error);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      error.hidden = true;
      const button = form.querySelector("button[type=submit]");
      button.disabled = true;
      try {
        await fn(new FormData(form));
        closeModal();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      } finally {
        button.disabled = false;
      }
    });
    return form;
  };

  const createForm = () => {
    if (state.info.guild_creation !== "on" && !state.user.is_server_owner) {
      return h("p", { class: "muted" }, "Guild creation is turned off on this server.");
    }
    return withError(h("form", { class: "stack" },
      h("label", {}, "Guild name", h("input", { name: "name", required: true, maxLength: LIMITS.GUILD_NAME_MAX, placeholder: "My friends" })),
      h("button", { class: "btn primary", type: "submit" }, "Create guild"),
    ), (fd) => api.create(String(fd.get("name")).trim()));
  };

  const joinForm = () => withError(h("form", { class: "stack" },
    h("label", {}, "Invite code", h("input", { name: "code", required: true, placeholder: "ABCD2345", spellcheck: "false", autocapitalize: "characters", class: "mono" })),
    h("button", { class: "btn primary", type: "submit" }, "Join guild"),
  ), (fd) => api.joinByCode(String(fd.get("code")).trim()));

  const browseList = () => {
    const list = h("div", { class: "public-list" }, h("p", { class: "muted" }, "Loading…"));
    api.loadPublic().then((guilds) => {
      clear(list);
      if (!guilds.length) {
        add(list, h("p", { class: "muted" }, "No public guilds on this server."));
        return;
      }
      for (const g of guilds) {
        const joined = state.guilds.has(g.guild_id) && !state.guilds.get(g.guild_id).ghost;
        add(list, h("div", { class: "public-guild" },
          h("div", { class: "guild-icon static", "aria-hidden": "true" }, initials(g.name)),
          h("span", { class: "meta" }, h("span", { class: "name" }, g.name), h("span", { class: "sub" }, `${g.member_count} member${g.member_count === 1 ? "" : "s"}`)),
          h("button", {
            class: "btn primary", type: "button", disabled: joined,
            on: {
              click: async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true;
                try { await api.joinById(g.guild_id); closeModal(); } catch (err) { toast(err.message, { error: true }); btn.disabled = false; }
              },
            },
          }, joined ? "Joined" : "Join")));
      }
    }).catch((err) => clear(list, h("p", { class: "muted" }, err.message)));
    return list;
  };

  openModal({ title: "Add a guild", content: [tabs, body] });
  render();
}

export function leaveGuildDialog(guild, onLeave) {
  confirmModal({
    title: `Leave ${guild.name}?`,
    message: guild.ghost
      ? "You'll stop seeing this guild. Nobody is notified."
      : "You'll need a new invite to come back.",
    confirmLabel: "Leave guild",
    onConfirm: onLeave,
  });
}

// roles: guild roles (highest first, @everyone last); canSetPerms: MANAGE_ROLES.
export function createChannelDialog({ roles, canSetPerms, onSubmit }) {
  const preview = h("p", { class: "muted small hint" });
  const input = h("input", { name: "name", required: true, maxLength: 40, placeholder: "new-channel", spellcheck: "false", autocapitalize: "off" });
  const update = () => { preview.textContent = `Will be created as #${normalizeChannelName(input.value) || "…"}`; };
  input.addEventListener("input", update);
  update();
  const privateBox = h("input", { type: "checkbox", name: "private" });
  const roleList = h("div", { class: "check-list", hidden: true },
    h("p", { class: "muted small" }, roles.length > 1
      ? "Who can see it (you always can):"
      : "No roles yet — only you and admins will see it. Create roles in Guild settings → Roles."),
    roles.filter((r) => !r.is_everyone).map((r) => h("label", { class: "check" },
      h("input", { type: "checkbox", name: "role", value: r.role_id }),
      h("span", { class: "role-dot", style: `background:${r.color || "var(--muted)"}` }), r.name)));
  privateBox.addEventListener("change", () => { roleList.hidden = !privateBox.checked; });
  formModal({
    title: "Create channel",
    submitLabel: "Create channel",
    fields: [
      h("label", {}, "Channel name", input), preview,
      canSetPerms ? h("label", { class: "check" }, privateBox, h("span", {}, "🔒 Private channel", h("span", { class: "muted small block" }, "Only selected roles can see it."))) : null,
      canSetPerms ? roleList : null,
    ],
    onSubmit: async (fd) => {
      const name = normalizeChannelName(input.value);
      if (!LIMITS.CHANNEL_NAME_RE.test(name)) throw new Error("Use letters, numbers, - or _ (up to 32).");
      let overwrites;
      if (privateBox.checked) {
        const everyone = roles.find((r) => r.is_everyone);
        overwrites = [{ role_id: everyone.role_id, allow: 0, deny: PERMS.VIEW_CHANNEL },
          ...fd.getAll("role").map((role_id) => ({ role_id, allow: PERMS.VIEW_CHANNEL, deny: 0 }))];
      }
      await onSubmit(name, overwrites);
    },
  });
}

export function deleteChannelDialog(channel, onDelete) {
  confirmModal({
    title: `Delete #${channel.name}?`,
    message: "All of its messages will be deleted too. This can't be undone.",
    confirmLabel: "Delete channel",
    onConfirm: onDelete,
  });
}

// A search-as-you-type user picker. multi: allow several (group DMs).
function userPicker({ search, exclude = [], multi = true, max = LIMITS.GROUP_DM_MAX - 1 }) {
  const picked = new Map();
  const input = h("input", { type: "search", placeholder: "Search by username", "aria-label": "Search users", spellcheck: "false", autocapitalize: "off" });
  const chips = h("div", { class: "pick-chips" });
  const results = h("div", { class: "pick-results" });
  let seq = 0;
  const drawChips = () => {
    clear(chips, [...picked.values()].map((u) => h("span", { class: "role-chip" }, displayName(u),
      h("button", { class: "role-x", type: "button", "aria-label": `Remove ${u.username}`, on: { click: () => { picked.delete(u.user_id); drawChips(); run(); } } }, "×"))));
  };
  const run = async () => {
    const q = input.value.trim();
    const mine = ++seq;
    if (!q) { clear(results, h("p", { class: "muted small" }, "Type a username to search.")); return; }
    try {
      const users = (await search(q)).filter((u) => !exclude.includes(u.user_id));
      if (mine !== seq) return;
      clear(results);
      if (!users.length) add(results, h("p", { class: "muted small" }, "Nobody found."));
      for (const u of users) {
        const on = picked.has(u.user_id);
        add(results, h("button", {
          class: `pick-row ${on ? "on" : ""}`, type: "button", "aria-pressed": String(on),
          on: {
            click: () => {
              if (on) picked.delete(u.user_id);
              else {
                if (!multi) picked.clear();
                if (picked.size >= max) { toast(`At most ${max} people`, { error: true }); return; }
                picked.set(u.user_id, u);
              }
              drawChips();
              run();
            },
          },
        }, avatar(u, { size: "sm" }), h("span", { class: "meta" }, h("span", { class: "name" }, displayName(u)), h("span", { class: "sub" }, u.username)),
        h("span", { class: "tick", "aria-hidden": "true" }, on ? "✓" : "")));
      }
    } catch (e) {
      clear(results, h("p", { class: "muted small" }, e.message));
    }
  };
  let timer;
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 150); });
  run();
  return { el: h("div", { class: "user-picker" }, input, chips, results), picked };
}

export function newDmDialog({ search, onCreate }) {
  const picker = userPicker({ search });
  formModal({
    title: "New message",
    subtitle: "Pick one person for a direct message, or several for a group.",
    submitLabel: "Start conversation",
    fields: [picker.el],
    onSubmit: async () => {
      if (!picker.picked.size) throw new Error("Pick at least one person.");
      await onCreate([...picker.picked.keys()]);
    },
  });
}

export function addToGroupDialog({ channel, search, onAdd }) {
  const picker = userPicker({ search, exclude: channel.recipients.map((u) => u.user_id), multi: false, max: 1 });
  formModal({
    title: "Add to group",
    submitLabel: "Add",
    fields: [picker.el],
    onSubmit: async () => {
      const [id] = picker.picked.keys();
      if (!id) throw new Error("Pick someone to add.");
      await onAdd(id);
    },
  });
}

export function renameGroupDialog({ channel, onRename }) {
  formModal({
    title: "Rename group",
    submitLabel: "Save",
    fields: [h("label", {}, "Group name", h("input", { name: "name", maxLength: LIMITS.GROUP_DM_NAME_MAX, value: channel.name || "", placeholder: "Leave empty to use member names" }))],
    onSubmit: (fd) => onRename(String(fd.get("name")).trim()),
  });
}

export function kickDialog(user, onKick) {
  confirmModal({
    title: `Kick ${displayName(user)}?`,
    message: "They can rejoin with a new invite.",
    confirmLabel: "Kick",
    fields: [h("label", {}, "Reason (optional, shown in the audit log)", h("input", { name: "reason", maxLength: LIMITS.BAN_REASON_MAX }))],
    onConfirm: (fd) => onKick(String(fd.get("reason") || "").trim() || undefined),
  });
}

export function banDialog(user, onBan) {
  confirmModal({
    title: `Ban ${displayName(user)}?`,
    message: "They'll be removed and can't rejoin until unbanned.",
    confirmLabel: "Ban",
    fields: [
      h("label", {}, "Delete their recent messages", h("select", { name: "delete" },
        [["0", "Don't delete any"], ["3600", "Previous hour"], ["86400", "Previous 24 hours"], ["604800", "Previous 7 days"]]
          .map(([v, l]) => h("option", { value: v }, l)))),
      h("label", {}, "Reason (optional)", h("input", { name: "reason", maxLength: LIMITS.BAN_REASON_MAX })),
    ],
    onConfirm: (fd) => onBan(String(fd.get("reason") || "").trim() || undefined, Number(fd.get("delete"))),
  });
}

const TIMEOUTS = [["60", "60 seconds"], ["300", "5 minutes"], ["600", "10 minutes"], ["3600", "1 hour"], ["86400", "1 day"], ["604800", "1 week"]];

export function timeoutDialog(user, onTimeout) {
  confirmModal({
    title: `Time out ${displayName(user)}`,
    message: "They can still read, but can't send messages, react or change anything.",
    confirmLabel: "Time out",
    fields: [
      h("label", {}, "Duration", h("select", { name: "seconds" }, TIMEOUTS.map(([v, l]) => h("option", { value: v, selected: v === "600" }, l)))),
      h("label", {}, "Reason (optional)", h("input", { name: "reason", maxLength: LIMITS.BAN_REASON_MAX })),
    ],
    onConfirm: (fd) => onTimeout(Number(fd.get("seconds")), String(fd.get("reason") || "").trim() || undefined),
  });
}

export function customStatusDialog(current, onSave) {
  formModal({
    title: "Set a custom status",
    submitLabel: "Save",
    fields: [h("label", {}, "What's happening?", h("input", { name: "status", maxLength: LIMITS.CUSTOM_STATUS_MAX, value: current || "", placeholder: "Support has arrived!" }))],
    onSubmit: (fd) => onSave(String(fd.get("status")).trim()),
  });
}
