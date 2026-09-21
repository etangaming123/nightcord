// Feature dialogs: add guild, leave guild, channels, DMs, moderation.

import { LIMITS, PERMS } from "../protocol.js";
import { scopedT } from "../strings.js";
import { add, avatar, clear, displayName, h, initials } from "./dom.js";
import { closeModal, confirmModal, formModal, openModal, toast } from "./modals.js";

const t = scopedT("ui/dialogs");
const tc = scopedT("common");

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
    for (const [key, label] of [["create", t("tab_create")], ["join", t("tab_join")], ["browse", t("tab_browse")]]) {
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
      return h("p", { class: "muted" }, t("guild_creation_off"));
    }
    return withError(h("form", { class: "stack" },
      h("label", {}, t("guild_name_label"), h("input", { name: "name", required: true, maxLength: LIMITS.GUILD_NAME_MAX, placeholder: t("guild_name_placeholder") })),
      h("button", { class: "btn primary", type: "submit" }, t("create_guild_button")),
    ), (fd) => api.create(String(fd.get("name")).trim()));
  };

  const joinForm = () => withError(h("form", { class: "stack" },
    h("label", {}, t("invite_code_label"), h("input", { name: "code", required: true, placeholder: t("invite_code_placeholder"), spellcheck: "false", autocapitalize: "characters", class: "mono" })),
    h("button", { class: "btn primary", type: "submit" }, t("join_guild_button")),
  ), (fd) => api.joinByCode(String(fd.get("code")).trim()));

  const browseList = () => {
    const list = h("div", { class: "public-list" }, h("p", { class: "muted" }, tc("loading")));
    api.loadPublic().then((guilds) => {
      clear(list);
      if (!guilds.length) {
        add(list, h("p", { class: "muted" }, t("no_public_guilds")));
        return;
      }
      for (const g of guilds) {
        const joined = state.guilds.has(g.guild_id) && !state.guilds.get(g.guild_id).ghost;
        add(list, h("div", { class: "public-guild" },
          h("div", { class: "guild-icon static", "aria-hidden": "true" }, initials(g.name)),
          h("span", { class: "meta" }, h("span", { class: "name" }, g.name), h("span", { class: "sub" }, t("member_count", { count: g.member_count }))),
          h("button", {
            class: "btn primary", type: "button", disabled: joined,
            on: {
              click: async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true;
                try { await api.joinById(g.guild_id); closeModal(); } catch (err) { toast(err.message, { error: true }); btn.disabled = false; }
              },
            },
          }, joined ? t("joined_button") : t("join_button"))));
      }
    }).catch((err) => clear(list, h("p", { class: "muted" }, err.message)));
    return list;
  };

  openModal({ title: t("add_guild_title"), content: [tabs, body] });
  render();
}

export function leaveGuildDialog(guild, onLeave) {
  confirmModal({
    title: t("leave_guild_title", { name: guild.name }),
    message: guild.ghost
      ? t("leave_guild_message_ghost")
      : t("leave_guild_message"),
    confirmLabel: t("leave_guild_confirm"),
    onConfirm: onLeave,
  });
}

// roles: guild roles (highest first, @everyone last); canSetPerms: MANAGE_ROLES.
// kind: text | voice | category; parentId: preselected category.
export function createChannelDialog({ roles, canSetPerms, kind = "text", parentId = null, categories = [], voiceEnabled = false, onSubmit }) {
  let current = kind;
  const preview = h("p", { class: "muted small hint" });
  const input = h("input", { name: "name", required: true, maxLength: 40, spellcheck: "false", autocapitalize: "off" });
  const kinds = h("div", { class: "radio-row kind-row" });
  const parent = h("select", { name: "parent" },
    h("option", { value: "" }, t("no_category")),
    categories.map((c) => h("option", { value: c.channel_id, selected: c.channel_id === parentId }, c.name)));
  const parentField = h("label", {}, t("category_label"), parent);
  const update = () => {
    const text = current === "text";
    input.placeholder = text ? t("channel_name_placeholder_text") : current === "voice" ? t("channel_name_placeholder_voice") : t("channel_name_placeholder_category");
    preview.hidden = !text;
    preview.textContent = t("channel_preview", { name: normalizeChannelName(input.value) || "…" });
    parentField.hidden = current === "category" || !categories.length;
  };
  const kindOption = (value, icon, label, sub, disabled = false) => h("label", { class: `radio-card kind ${disabled ? "disabled" : ""}` },
    h("input", { type: "radio", name: "kind", value, checked: value === current, disabled, on: { change: () => { current = value; update(); } } }),
    h("span", { class: "kind-icon", "aria-hidden": "true" }, icon),
    h("span", {}, h("strong", {}, label), h("span", { class: "muted small block" }, sub)));
  add(kinds,
    kindOption("text", "#", t("kind_text_label"), t("kind_text_sub")),
    kindOption("voice", "🔊", t("kind_voice_label"), voiceEnabled ? t("kind_voice_sub_enabled") : t("kind_voice_sub_disabled"), !voiceEnabled),
    kindOption("category", "▤", t("kind_category_label"), t("kind_category_sub")));
  input.addEventListener("input", update);
  update();
  const privateBox = h("input", { type: "checkbox", name: "private" });
  const roleList = h("div", { class: "check-list", hidden: true },
    h("p", { class: "muted small" }, roles.length > 1
      ? t("roles_visibility_hint")
      : t("roles_visibility_hint_empty")),
    roles.filter((r) => !r.is_everyone).map((r) => h("label", { class: "check" },
      h("input", { type: "checkbox", name: "role", value: r.role_id }),
      h("span", { class: "role-dot", style: `background:${r.color || "var(--muted)"}` }), r.name)));
  privateBox.addEventListener("change", () => { roleList.hidden = !privateBox.checked; });
  formModal({
    title: kind === "category" ? t("create_category_title") : t("create_channel_title"),
    submitLabel: t("create_submit"),
    fields: [
      h("div", { class: "field" }, h("span", { class: "field-label" }, t("type_label")), kinds),
      h("label", {}, t("name_label"), input), preview,
      parentField,
      canSetPerms ? h("label", { class: "check" }, privateBox, h("span", {}, t("private_label"), h("span", { class: "muted small block" }, t("private_sub")))) : null,
      canSetPerms ? roleList : null,
    ],
    onSubmit: async (fd) => {
      let name;
      if (current === "text") {
        name = normalizeChannelName(input.value);
        if (!LIMITS.CHANNEL_NAME_RE.test(name)) throw new Error(t("channel_name_error"));
      } else {
        name = input.value.trim().replace(/\s+/g, " ");
        if (!name || name.length > LIMITS.CHANNEL_TITLE_MAX) throw new Error(t("channel_title_error", { max: LIMITS.CHANNEL_TITLE_MAX }));
      }
      const payload = { name, kind: current };
      if (current !== "category" && parent.value) payload.parent_id = parent.value;
      if (privateBox.checked) {
        const everyone = roles.find((r) => r.is_everyone);
        payload.overwrites = [{ role_id: everyone.role_id, allow: 0, deny: PERMS.VIEW_CHANNEL },
          ...fd.getAll("role").map((role_id) => ({ role_id, allow: PERMS.VIEW_CHANNEL, deny: 0 }))];
      }
      await onSubmit(payload);
    },
  });
}

export function nicknameDialog(user, current, onSave) {
  formModal({
    title: t("change_nickname_title"),
    subtitle: t("nickname_subtitle", { username: user.username }),
    submitLabel: tc("save"),
    fields: [h("label", {}, t("nickname_label"), h("input", { name: "nick", maxLength: LIMITS.NICKNAME_MAX, value: current || "", placeholder: user.display_name || user.username }))],
    onSubmit: (fd) => onSave(String(fd.get("nick")).trim()),
  });
}

export function deleteChannelDialog(channel, onDelete) {
  const cat = channel.kind === "category";
  confirmModal({
    title: cat ? t("delete_category_title", { name: channel.name })
      : channel.kind === "voice" ? t("delete_voice_title", { name: channel.name }) : t("delete_text_title", { name: channel.name }),
    message: cat ? t("delete_category_message") : t("delete_channel_message"),
    confirmLabel: t("delete_channel_confirm"),
    onConfirm: onDelete,
  });
}

// A search-as-you-type user picker. multi: allow several (group DMs).
function userPicker({ search, exclude = [], multi = true, max = LIMITS.GROUP_DM_MAX - 1, placeholder = t("search_friends_placeholder") }) {
  const picked = new Map();
  const input = h("input", { type: "search", placeholder, "aria-label": t("search_users_aria"), spellcheck: "false", autocapitalize: "off" });
  const chips = h("div", { class: "pick-chips" });
  const results = h("div", { class: "pick-results" });
  let seq = 0;
  const drawChips = () => {
    clear(chips, [...picked.values()].map((u) => h("span", { class: "role-chip" }, displayName(u),
      h("button", { class: "role-x", type: "button", "aria-label": t("remove_user_aria", { username: u.username }), on: { click: () => { picked.delete(u.user_id); drawChips(); run(); } } }, "×"))));
  };
  const run = async () => {
    const q = input.value.trim();
    const mine = ++seq;
    try {
      const users = (await search(q)).filter((u) => !exclude.includes(u.user_id));
      if (mine !== seq) return;
      clear(results);
      if (!users.length) add(results, h("p", { class: "muted small" }, q ? t("nobody_found") : t("no_friends_yet")));
      for (const u of users) {
        const on = picked.has(u.user_id);
        add(results, h("button", {
          class: `pick-row ${on ? "on" : ""}`, type: "button", "aria-pressed": String(on),
          on: {
            click: () => {
              if (on) picked.delete(u.user_id);
              else {
                if (!multi) picked.clear();
                if (picked.size >= max) { toast(t("max_people_toast", { max }), { error: true }); return; }
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

export function newDmDialog({ search, searchAllowed, onCreate }) {
  const picker = userPicker({ search, placeholder: t("search_friends_placeholder") });
  formModal({
    title: t("new_message_title"),
    subtitle: searchAllowed ? t("new_message_subtitle_search") : t("new_message_subtitle_friends"),
    submitLabel: t("start_conversation_button"),
    fields: [picker.el],
    onSubmit: async () => {
      if (!picker.picked.size) throw new Error(t("pick_person_error"));
      await onCreate([...picker.picked.keys()]);
    },
  });
}

export function addToGroupDialog({ channel, search, onAdd }) {
  const picker = userPicker({ search, exclude: channel.recipients.map((u) => u.user_id), multi: false, max: 1 });
  formModal({
    title: t("add_to_group_title"),
    submitLabel: t("add_button"),
    fields: [picker.el],
    onSubmit: async () => {
      const [id] = picker.picked.keys();
      if (!id) throw new Error(t("pick_someone_error"));
      await onAdd(id);
    },
  });
}

export function renameGroupDialog({ channel, onRename }) {
  formModal({
    title: t("rename_group_title"),
    submitLabel: tc("save"),
    fields: [h("label", {}, t("group_name_label"), h("input", { name: "name", maxLength: LIMITS.GROUP_DM_NAME_MAX, value: channel.name || "", placeholder: t("group_name_placeholder") }))],
    onSubmit: (fd) => onRename(String(fd.get("name")).trim()),
  });
}

export function kickDialog(user, onKick) {
  confirmModal({
    title: t("kick_title", { name: displayName(user) }),
    message: t("kick_message"),
    confirmLabel: t("kick_confirm"),
    fields: [h("label", {}, t("reason_optional_audit_label"), h("input", { name: "reason", maxLength: LIMITS.BAN_REASON_MAX }))],
    onConfirm: (fd) => onKick(String(fd.get("reason") || "").trim() || undefined),
  });
}

export function banDialog(user, onBan) {
  confirmModal({
    title: t("ban_title", { name: displayName(user) }),
    message: t("ban_message"),
    confirmLabel: t("ban_confirm"),
    fields: [
      h("label", {}, t("delete_messages_label"), h("select", { name: "delete" },
        [["0", t("delete_none_option")], ["3600", t("delete_hour_option")], ["86400", t("delete_day_option")], ["604800", t("delete_week_option")]]
          .map(([v, l]) => h("option", { value: v }, l)))),
      h("label", {}, t("reason_optional_label"), h("input", { name: "reason", maxLength: LIMITS.BAN_REASON_MAX })),
    ],
    onConfirm: (fd) => onBan(String(fd.get("reason") || "").trim() || undefined, Number(fd.get("delete"))),
  });
}

const TIMEOUT_SECONDS = [["60", "timeout_60s"], ["300", "timeout_5m"], ["600", "timeout_10m"], ["3600", "timeout_1h"], ["86400", "timeout_1d"], ["604800", "timeout_1w"]];

export function timeoutDialog(user, onTimeout) {
  confirmModal({
    title: t("timeout_title", { name: displayName(user) }),
    message: t("timeout_message"),
    confirmLabel: t("timeout_confirm"),
    fields: [
      h("label", {}, t("duration_label"), h("select", { name: "seconds" }, TIMEOUT_SECONDS.map(([v, key]) => h("option", { value: v, selected: v === "600" }, t(key))))),
      h("label", {}, t("reason_optional_label"), h("input", { name: "reason", maxLength: LIMITS.BAN_REASON_MAX })),
    ],
    onConfirm: (fd) => onTimeout(Number(fd.get("seconds")), String(fd.get("reason") || "").trim() || undefined),
  });
}

export function customStatusDialog(current, onSave) {
  formModal({
    title: t("custom_status_title"),
    submitLabel: tc("save"),
    fields: [h("label", {}, t("custom_status_label"), h("input", { name: "status", maxLength: LIMITS.CUSTOM_STATUS_MAX, value: current || "", placeholder: t("custom_status_placeholder") }))],
    onSubmit: (fd) => onSave(String(fd.get("status")).trim()),
  });
}

export function announcementDialog({ item, onSave }) {
  formModal({
    title: t("edit_announcement_title"),
    submitLabel: tc("save"),
    wide: true,
    fields: [h("label", {}, t("announcement_label"),
      h("textarea", { name: "content", rows: 8, required: true, maxLength: LIMITS.ANNOUNCEMENT_MAX_CHARS }, item.content))],
    onSubmit: (fd) => onSave(String(fd.get("content")).trim()),
  });
}
