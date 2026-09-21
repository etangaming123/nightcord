// Server admin panel (PROTOCOL.md §5 Admin, §8b, §8c): shown in User settings
// to server staff. Sections depend on the viewer's server role:
// moderators enforce, admins also manage accounts and guilds, and only the
// owner changes server config, legal documents and appoints admins.

import { LIMITS, T } from "../protocol.js";
import { STAFF_LABEL, staffLevel, state } from "../state.js";
import { add, avatar, clear, displayName, fmtBytes, fmtDate, fmtDateTime, h, initials } from "./dom.js";
import { renderDocument } from "./markdown.js";
import { closeFullscreen, confirmModal, formModal, openMenu, openModal, refreshFullscreen, toast } from "./modals.js";
import { copyText } from "./profile.js";
import { scopedT } from "../strings.js";

const t = scopedT("ui/admin");

const MOD = 1;
const ADMIN = 2;
const OWNER = 3;
const fail = (e) => toast(e.message, { error: true });

const MUTE_OPTIONS = () => [
  ["600", t("mute_10m")],
  ["3600", t("mute_1h")],
  ["86400", t("mute_1d")],
  ["604800", t("mute_1w")],
  ["2592000", t("mute_30d")],
  ["permanent", t("mute_until_unmuted")],
];

export function adminSections(actions) {
  const lvl = staffLevel();
  if (!lvl) return [];
  return [
    { heading: t("heading_server_admin") },
    lvl >= ADMIN ? { id: "admin-overview", label: t("tab_overview"), render: (el) => overview(el, actions) } : null,
    lvl >= OWNER ? { id: "server", label: t("tab_server_settings"), render: (el) => serverSection(el, actions) } : null,
    lvl >= OWNER ? { id: "rules", label: t("tab_rules_privacy"), render: (el) => legalSection(el, actions) } : null,
    lvl >= ADMIN ? { id: "customization", label: t("tab_customisation"), render: (el) => customizationSection(el, actions) } : null,
    { id: "accounts", label: t("tab_accounts"), badge: state.pendingAccounts, render: (el) => accountsSection(el, actions) },
    lvl >= OWNER || lvl >= ADMIN ? { id: "staff", label: t("tab_staff"), render: (el) => staffSection(el, actions) } : null,
    { id: "bans", label: t("tab_bans"), render: (el) => bansSection(el, actions) },
    lvl >= ADMIN ? { id: "guilds", label: t("tab_guilds"), render: (el) => guildsSection(el, actions) } : null,
    { id: "server-audit", label: t("tab_audit_log"), render: (el) => auditSection(el, actions) },
  ];
}

function formRow(form, onSubmit, { okText = t("saved") } = {}) {
  const error = h("div", { class: "error-box", hidden: true });
  add(form, error);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.hidden = true;
    const btn = form.querySelector("button[type=submit]");
    if (btn) btn.disabled = true;
    try {
      await onSubmit(new FormData(form));
      if (okText) toast(okText);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  return form;
}

// --- overview ---------------------------------------------------------------

async function overview(el, actions) {
  const s = await actions.req(T.ADMIN_STATS);
  const stat = (n, label) => h("div", { class: "stat" }, h("div", { class: "stat-n" }, String(n)), h("div", { class: "stat-l" }, label));
  add(el,
    h("p", { class: "muted" }, t("overview_role_line", { role: STAFF_LABEL[state.user.server_role] || t("staff_member_fallback"), server: state.info.server_name })),
    h("div", { class: "stats" },
      stat(s.users, t("stat_active_accounts")), stat(s.guilds, t("stat_guilds")), stat(s.messages, t("stat_messages")),
      stat(fmtBytes(s.attachments.bytes), t("stat_files_label", { count: s.attachments.count }))),
    h("p", { class: "muted small" }, t("overview_limits", { limit: fmtBytes(state.info.max_upload_bytes), voice: state.info.voice_enabled ? t("voice_on") : t("voice_off") })));
}

// --- server settings (owner) ----------------------------------------------------

function serverSection(el, actions) {
  const info = state.info;
  const select = (name, value, options) =>
    h("select", { name }, options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)));
  add(el, formRow(h("form", { class: "stack narrow" },
    h("label", {}, t("server_name_label"), h("input", { name: "server_name", required: true, maxLength: LIMITS.SERVER_NAME_MAX, value: info.server_name })),
    h("label", {}, t("account_creation_label"), select("account_creation", info.account_creation, [
      ["on", t("account_creation_open")],
      ["request", t("account_creation_request")],
      ["off", t("account_creation_closed")],
    ])),
    h("label", {}, t("guild_creation_label"), select("guild_creation", info.guild_creation, [
      ["on", t("guild_creation_anyone")],
      ["off", t("guild_creation_owner_only")],
    ])),
    h("label", { class: "check" }, h("input", { type: "checkbox", name: "guild_list_visible", checked: info.guild_list_visible }), t("guild_list_visible_label")),
    h("label", {}, t("max_upload_label"),
      h("input", { name: "max_upload_mb", type: "number", min: 1, max: 1024, required: true, value: Math.round(info.max_upload_bytes / 1048576) }),
      h("span", { class: "muted small block" }, t("max_upload_hint"))),
    h("label", { class: "check" }, h("input", { type: "checkbox", name: "voice_enabled", checked: info.voice_enabled }),
      h("span", {}, t("voice_channels_label"), h("span", { class: "muted small block" }, t("voice_channels_hint")))),
    h("label", {}, t("user_search_label"), select("user_search", info.user_search || "off", [
      ["off", t("user_search_off")],
      ["staff", t("user_search_staff")],
      ["on", t("user_search_on")],
    ]), h("span", { class: "muted small block" }, t("user_search_hint"))),
    h("div", {}, h("button", { class: "btn primary", type: "submit" }, t("save")))),
  async (fd) => {
    const res = await actions.req(T.SERVER_CONFIG_UPDATE, {
      server_name: String(fd.get("server_name")).trim(),
      account_creation: fd.get("account_creation"),
      guild_creation: fd.get("guild_creation"),
      guild_list_visible: fd.get("guild_list_visible") === "on",
      max_upload_bytes: Math.max(1, Math.min(1024, Number(fd.get("max_upload_mb")) || 25)) * 1048576,
      voice_enabled: fd.get("voice_enabled") === "on",
      user_search: fd.get("user_search"),
    });
    actions.setServerInfo(res.config);
  }, { okText: t("server_settings_saved") }));
}

// --- customisation perks (owner sets the mode; admins keep the allow-list) ----------

const FEATURES = () => [
  ["profile_banner", t("feature_profile_banner_label"), t("feature_profile_banner_hint")],
  ["profile_colors", t("feature_profile_colors_label"), t("feature_profile_colors_hint")],
  ["animated_media", t("feature_animated_media_label"), t("feature_animated_media_hint")],
  ["guild_banner", t("feature_guild_banner_label"), t("feature_guild_banner_hint")],
  ["gradient_roles", t("feature_gradient_roles_label"), t("feature_gradient_roles_hint")],
  ["role_icons", t("feature_role_icons_label"), t("feature_role_icons_hint")],
  ["client_themes", t("feature_client_themes_label"), t("feature_client_themes_hint")],
];
const MODES = () => [
  ["on", t("mode_on_label"), t("mode_on_hint")],
  ["allowlist", t("mode_allowlist_label"), t("mode_allowlist_hint")],
  ["off", t("mode_off_label"), t("mode_off_hint")],
];

async function customizationSection(el, actions) {
  const info = state.info;
  const owner = staffLevel() >= OWNER;
  const feats = info.customization_features || {};
  const features = FEATURES();
  const form = h("form", { class: "stack narrow" },
    h("fieldset", { class: "radio-cards", disabled: !owner }, h("legend", {}, t("who_can_customise_legend")),
      MODES().map(([v, label, hint]) => h("label", { class: "radio-card" },
        h("input", { type: "radio", name: "mode", value: v, checked: (info.customization_mode || "on") === v }),
        h("span", {}, h("strong", {}, label), h("span", { class: "muted small block" }, hint))))),
    h("fieldset", { class: "stack", disabled: !owner }, h("legend", {}, t("features_legend")),
      features.map(([key, label, hint]) => h("label", { class: "check" },
        h("input", { type: "checkbox", name: key, checked: feats[key] !== false }),
        h("span", {}, label, h("span", { class: "muted small block" }, hint))))),
    owner ? h("div", {}, h("button", { class: "btn primary", type: "submit" }, t("save"))) : h("p", { class: "muted small" }, t("owner_only_note")));
  add(el, h("p", { class: "muted" }, t("customization_intro")),
    owner ? formRow(form, async (fd) => {
      const res = await actions.req(T.SERVER_CONFIG_UPDATE, {
        customization_mode: fd.get("mode"),
        customization_features: Object.fromEntries(features.map(([key]) => [key, fd.get(key) === "on"])),
      });
      actions.setServerInfo(res.config);
    }, { okText: t("customisation_saved") }) : form);

  // Allow-list.
  const list = h("div", { class: "list" });
  const search = h("input", { type: "search", placeholder: t("add_someone_placeholder"), "aria-label": t("search_accounts_perks_aria") });
  const results = h("div", { class: "list" });
  const setPerks = async (u, perks) => {
    try {
      await actions.req(T.ADMIN_USERS_SET_PERKS, { user_id: u.user_id, perks });
      toast(perks ? t("perks_given_toast", { name: displayName(u) }) : t("perks_removed_toast", { name: displayName(u) }));
      search.value = "";
      clear(results);
      await draw();
    } catch (e) { fail(e); }
  };
  const draw = async () => {
    const { users } = await actions.req(T.ADMIN_USERS_LIST, { status: "active" });
    const allowed = users.filter((u) => u.perks);
    clear(list, allowed.length ? allowed.map((u) => h("div", { class: "list-row" }, avatar(u, { size: "sm" }),
      h("span", { class: "meta" }, h("span", { class: "name" }, displayName(u)), h("span", { class: "sub" }, u.username)),
      h("button", { class: "btn", type: "button", on: { click: () => setPerks(u, false) } }, t("remove_btn"))))
      : h("p", { class: "muted" }, t("nobody_yet")));
  };
  let timer;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = search.value.trim();
      if (!q) { clear(results); return; }
      const { users } = await actions.req(T.ADMIN_USERS_LIST, { status: "active", query: q });
      clear(results, users.filter((u) => !u.perks).slice(0, 8).map((u) => h("div", { class: "list-row" }, avatar(u, { size: "sm" }),
        h("span", { class: "meta" }, h("span", { class: "name" }, displayName(u)), h("span", { class: "sub" }, u.username)),
        h("button", { class: "btn primary", type: "button", on: { click: () => setPerks(u, true) } }, t("give_perks_btn")))));
    }, 200);
  });
  add(el, h("h3", {}, t("allowlist_heading")),
    h("p", { class: "muted small" }, (info.customization_mode || "on") === "allowlist"
      ? t("allowlist_active_hint")
      : t("allowlist_inactive_hint")),
    search, results, list);
  await draw();
}

// --- legal documents (owner) ------------------------------------------------------

async function legalSection(el, actions) {
  const docs = await actions.req(T.LEGAL_GET);
  add(el, h("p", { class: "muted" }, t("legal_intro")));
  for (const [key, label] of [["terms", t("terms_label")], ["privacy", t("privacy_label")]]) {
    const area = h("textarea", { rows: 12, maxLength: LIMITS.LEGAL_MAX_CHARS, class: "mono legal-edit", "aria-label": label, placeholder: key === "terms" ? t("terms_placeholder") : t("privacy_placeholder") });
    area.value = docs[key] || "";
    const preview = h("div", { class: "legal-doc legal-preview", hidden: true });
    const toggle = h("button", { class: "btn", type: "button" }, t("preview_btn"));
    toggle.addEventListener("click", () => {
      preview.hidden = !preview.hidden;
      area.hidden = !preview.hidden;
      toggle.textContent = preview.hidden ? t("preview_btn") : t("edit_btn");
      if (!preview.hidden) clear(preview, renderDocument(area.value || "*(empty)*"));
    });
    const save = h("button", {
      class: "btn primary", type: "button",
      on: {
        click: async () => {
          save.disabled = true;
          try {
            const res = await actions.req(T.ADMIN_LEGAL_SET, { [key]: area.value.trim() || null });
            actions.setServerInfo(res);
            toast(t("legal_saved_toast", { label }));
          } catch (e) { fail(e); } finally { save.disabled = false; }
        },
      },
    }, t("save"));
    add(el, h("section", { class: "legal-section stack" }, h("h3", {}, label), area, preview, h("div", { class: "row" }, save, toggle)));
  }
}

// --- accounts ---------------------------------------------------------------------

async function accountsSection(el, actions) {
  let filter = state.pendingAccounts ? "pending" : "";
  const tabs = h("div", { class: "tabs inline" });
  const search = h("input", { type: "search", placeholder: t("search_accounts_placeholder"), "aria-label": t("search_accounts_aria") });
  const list = h("div", { class: "list" });
  const draw = async () => {
    clear(tabs, [["", t("filter_all")], ["pending", t("filter_pending")], ["active", t("filter_active")], ["disabled", t("filter_disabled")], ["rejected", t("filter_rejected")]].map(([v, l]) =>
      h("button", { class: "tab", type: "button", "aria-selected": String(filter === v), on: { click: () => { filter = v; draw(); } } }, l)));
    const { users } = await actions.req(T.ADMIN_USERS_LIST, { status: filter || undefined, query: search.value.trim() || undefined });
    if (filter === "pending" || !filter) {
      state.pendingAccounts = users.filter((u) => u.status === "pending").length || (filter === "pending" ? 0 : state.pendingAccounts);
      actions.refreshChrome();
    }
    clear(list);
    if (!users.length) add(list, h("p", { class: "muted" }, filter === "pending" ? t("no_account_requests") : t("no_accounts_match")));
    for (const u of users) add(list, accountRow(u, actions, draw));
  };
  let timer;
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(draw, 200); });
  add(el, h("p", { class: "muted small" }, t("ip_visibility_note")), h("div", { class: "row wrap" }, tabs, search), list);
  await draw();
}

const isMuted = (u) => u.muted_until && (u.muted_until === "permanent" || new Date(u.muted_until) > new Date());

function accountRow(u, actions, redraw) {
  const act = (label, status, cls = "") => h("button", {
    class: `btn ${cls}`, type: "button",
    on: { click: async () => { try { await actions.req(T.ADMIN_USERS_SET_STATUS, { user_id: u.user_id, status }); await redraw(); } catch (e) { fail(e); } } },
  }, label);
  const below = staffLevel(u) < staffLevel();
  const buttons = [];
  if (u.status === "pending" && below) buttons.push(act(t("approve_btn"), "active", "primary"), act(t("reject_btn"), "rejected"));
  else if (u.status === "disabled" && below) buttons.push(act(t("enable_btn"), "active"));
  if (u.status === "active" && below) {
    buttons.push(h("button", {
      class: "btn", type: "button", "aria-haspopup": "menu",
      on: { click: (e) => openMenu(e.currentTarget, adminModeration(u, actions, redraw), { placement: "left" }) },
    }, t("manage_btn")));
  }
  const role = staffLevel(u) ? h("span", { class: `tag staff ${u.server_role}` }, (u.server_role || "").toUpperCase()) : null;
  const facts = [
    t("joined_fact", { date: fmtDate(u.created_at) }),
    u.last_ip ? t("ip_fact", { ip: u.last_ip }) : null,
    u.last_seen ? t("seen_fact", { date: fmtDateTime(u.last_seen) }) : null,
    u.device_count ? t("device_count_fact", { count: u.device_count }) : null,
    u.note ? t("note_fact", { note: u.note }) : null,
  ].filter(Boolean).join(" · ");
  return h("div", { class: "list-row" },
    avatar(u, { size: "sm" }),
    h("span", { class: "meta" },
      h("span", { class: "name" }, displayName(u), u.display_name ? h("span", { class: "muted small" }, ` ${u.username}`) : null, role,
        u.status !== "active" ? h("span", { class: `tag ${u.status}` }, u.status.toUpperCase()) : null,
        isMuted(u) ? h("span", { class: "tag warn" }, t("muted_tag")) : null,
        u.perks ? h("span", { class: "tag perks", title: t("perks_tag_title") }, t("perks_tag")) : null),
      h("span", { class: "sub" }, facts)),
    h("span", { class: "row" }, buttons));
}

// Menu items for acting on a user as server staff (Accounts, member menus, profiles).
export function adminModeration(u, actions, after = () => {}) {
  const lvl = staffLevel();
  const done = async (p) => { try { await p; await after(); } catch (e) { fail(e); } };
  const name = displayName(u);
  const muted = isMuted(u);
  return [
    muted
      ? { label: t("unmute_label"), icon: "🔊", onClick: () => done(actions.req(T.ADMIN_USERS_MUTE, { user_id: u.user_id }).then(() => toast(t("unmuted_toast", { name })))) }
      : { label: t("mute_label"), icon: "🔇", onClick: () => muteDialog(u, (payload) => done(actions.req(T.ADMIN_USERS_MUTE, { user_id: u.user_id, ...payload }).then(() => toast(t("muted_toast", { name }))))) },
    { label: t("disable_account_label"), icon: "⛔", danger: true, onClick: () => confirmModal({
      title: t("disable_confirm_title", { name }), message: t("disable_confirm_message"), confirmLabel: t("disable_confirm_btn"),
      onConfirm: () => done(actions.req(T.ADMIN_USERS_SET_STATUS, { user_id: u.user_id, status: "disabled" })),
    }) },
    { label: t("ban_devices_label"), icon: "📵", danger: true, onClick: () => reasonDialog(t("ban_devices_title", { name }),
      t("ban_devices_message"),
      t("ban_devices_btn"), (reason) => done(actions.req(T.ADMIN_DEVICE_BANS_ADD, { user_id: u.user_id, reason }).then(() => toast(t("devices_banned_toast"))))) },
    { label: t("ban_ip_label"), icon: "🌐", danger: true, onClick: async () => {
      try {
        const { users } = await actions.req(T.ADMIN_USERS_LIST, { query: u.username });
        const ip = users.find((x) => x.user_id === u.user_id)?.last_ip;
        if (!ip) { toast(t("no_known_ip_toast"), { error: true }); return; }
        reasonDialog(t("ban_ip_title", { ip }), t("ban_ip_message", { ip, name }), t("ban_ip_btn"),
          (reason) => done(actions.req(T.ADMIN_IP_BANS_ADD, { cidr: ip, reason }).then(() => toast(t("ip_banned_toast", { ip })))));
      } catch (e) { fail(e); }
    } },
    lvl >= ADMIN ? "-" : null,
    lvl >= ADMIN ? { label: t("reset_password_label"), icon: "🔑", onClick: () => confirmModal({
      title: t("reset_password_title", { name }), message: t("reset_password_message"), confirmLabel: t("reset_password_btn"),
      onConfirm: async () => {
        const { password } = await actions.req(T.ADMIN_USERS_RESET_PASSWORD, { user_id: u.user_id });
        setTimeout(() => openModal({
          title: t("new_password_title"), subtitle: t("new_password_subtitle", { name }),
          content: h("div", { class: "row" }, h("div", { class: "code-display" }, password),
            h("button", { class: "btn", type: "button", on: { click: () => copyText(password, t("password_copied_toast")) } }, t("copy_btn"))),
        }));
      },
    }) } : null,
    lvl >= ADMIN ? { label: u.perks ? t("remove_perks_label") : t("give_perks_btn"), icon: "✨", hint: t("give_perks_hint"), onClick: () => done(actions.req(T.ADMIN_USERS_SET_PERKS, { user_id: u.user_id, perks: !u.perks }).then(() => toast(u.perks ? t("perks_removed_toast2") : t("perks_given_toast2")))) } : null,
    lvl >= ADMIN ? { label: t("delete_account_label"), icon: "🗑", danger: true, onClick: () => deleteAccountDialog(u, () => done(actions.req(T.ADMIN_USERS_DELETE, { user_id: u.user_id }).then(() => toast(t("account_deleted_toast", { name }))))) } : null,
  ];
}

function muteDialog(u, onMute) {
  formModal({
    title: t("mute_dialog_title", { name: displayName(u) }),
    subtitle: t("mute_dialog_subtitle"),
    submitLabel: t("mute_btn"),
    danger: true,
    fields: [
      h("label", {}, t("duration_label"), h("select", { name: "d" }, MUTE_OPTIONS().map(([v, l]) => h("option", { value: v, selected: v === "86400" }, l)))),
      h("label", {}, t("reason_audit_label"), h("input", { name: "reason", maxLength: LIMITS.BAN_REASON_MAX })),
    ],
    onSubmit: (fd) => {
      const d = fd.get("d");
      const reason = String(fd.get("reason") || "").trim() || undefined;
      return onMute(d === "permanent" ? { permanent: true, reason } : { duration_seconds: Number(d), reason });
    },
  });
}

function reasonDialog(title, message, confirmLabel, onConfirm) {
  confirmModal({
    title, message, confirmLabel,
    fields: [h("label", {}, t("reason_optional_label"), h("input", { name: "reason", maxLength: LIMITS.BAN_REASON_MAX }))],
    onConfirm: (fd) => onConfirm(String(fd.get("reason") || "").trim() || undefined),
  });
}

function deleteAccountDialog(u, onDelete) {
  const input = h("input", { placeholder: u.username, "aria-label": t("type_username_aria"), autocomplete: "off" });
  confirmModal({
    title: t("delete_account_title", { name: displayName(u) }),
    message: t("delete_account_message"),
    confirmLabel: t("delete_account_btn"),
    fields: [h("label", {}, t("type_to_confirm_label", { username: u.username }), input)],
    onConfirm: () => {
      if (input.value.trim() !== u.username) throw new Error(t("username_mismatch_error"));
      return onDelete();
    },
  });
}

// --- staff --------------------------------------------------------------------------

async function staffSection(el, actions) {
  const lvl = staffLevel();
  const { users } = await actions.req(T.ADMIN_USERS_LIST, { status: "active" });
  const staff = users.filter((u) => staffLevel(u) > 0).sort((a, b) => staffLevel(b) - staffLevel(a));
  add(el,
    h("p", { class: "muted" }, t("staff_intro")));
  const list = h("div", { class: "list" });
  for (const u of staff) {
    const canEdit = staffLevel(u) < lvl;
    add(list, h("div", { class: "list-row" },
      avatar(u, { size: "sm" }),
      h("span", { class: "meta" }, h("span", { class: "name" }, displayName(u)), h("span", { class: "sub" }, STAFF_LABEL[u.server_role] || u.server_role)),
      canEdit ? h("button", { class: "btn", type: "button", on: { click: () => setRole(u, "none") } }, t("remove_from_staff_btn")) : null));
  }
  add(el, h("h3", {}, t("current_staff_heading")), list);
  const search = h("input", { type: "search", placeholder: t("find_someone_placeholder"), "aria-label": t("find_user_aria") });
  const results = h("div", { class: "list" });
  const setRole = async (u, role) => {
    try {
      await actions.req(T.ADMIN_STAFF_SET, { user_id: u.user_id, role });
      toast(role === "none" ? t("removed_from_staff_toast", { name: displayName(u) }) : t("made_role_toast", { name: displayName(u), role }));
      refreshFullscreen();
    } catch (e) { fail(e); }
  };
  const find = async () => {
    const q = search.value.trim();
    clear(results);
    if (!q) return;
    const { users: found } = await actions.req(T.ADMIN_USERS_LIST, { status: "active", query: q });
    for (const u of found.filter((x) => staffLevel(x) < lvl).slice(0, 8)) {
      add(results, h("div", { class: "list-row" }, avatar(u, { size: "sm" }),
        h("span", { class: "meta" }, h("span", { class: "name" }, displayName(u)), h("span", { class: "sub" }, u.username)),
        h("span", { class: "row" },
          u.server_role !== "moderator" ? h("button", { class: "btn", type: "button", on: { click: () => setRole(u, "moderator") } }, t("make_moderator_btn")) : null,
          lvl >= OWNER && u.server_role !== "admin" ? h("button", { class: "btn", type: "button", on: { click: () => setRole(u, "admin") } }, t("make_admin_btn")) : null)));
    }
  };
  let timer;
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(find, 200); });
  add(el, h("h3", {}, t("add_staff_heading")), search, results);
}

// --- bans ---------------------------------------------------------------------------

async function bansSection(el, actions) {
  const [{ bans: ips }, { bans: devices }] = await Promise.all([
    actions.req(T.ADMIN_IP_BANS_LIST), actions.req(T.ADMIN_DEVICE_BANS_LIST),
  ]);
  const cidr = h("input", { name: "cidr", required: true, placeholder: t("cidr_placeholder"), spellcheck: "false", class: "mono" });
  add(el,
    h("h3", {}, t("ip_bans_heading")),
    h("p", { class: "muted small" }, t("ip_bans_intro")),
    formRow(h("form", { class: "row wrap" }, cidr, h("input", { name: "reason", placeholder: t("reason_optional_placeholder"), maxLength: LIMITS.BAN_REASON_MAX }),
      h("button", { class: "btn danger", type: "submit" }, t("ban_btn"))),
    async (fd) => {
      await actions.req(T.ADMIN_IP_BANS_ADD, { cidr: String(fd.get("cidr")).trim(), reason: String(fd.get("reason") || "").trim() || undefined });
      refreshFullscreen();
    }, { okText: t("banned_toast") }));
  const ipList = h("div", { class: "list" });
  if (!ips.length) add(ipList, h("p", { class: "muted" }, t("no_ip_bans")));
  for (const b of ips) {
    add(ipList, h("div", { class: "list-row" }, h("span", { class: "list-icon", "aria-hidden": "true" }, "🌐"),
      h("span", { class: "meta" }, h("span", { class: "name mono" }, b.cidr),
        h("span", { class: "sub" }, [b.reason ? t("note_fact", { note: b.reason }) : null, b.banned_by ? t("banned_by_fact", { name: displayName(b.banned_by) }) : null, fmtDateTime(b.created_at)].filter(Boolean).join(" · "))),
      h("button", { class: "btn", type: "button", on: { click: () => actions.req(T.ADMIN_IP_BANS_REMOVE, { cidr: b.cidr }).then(refreshFullscreen, fail) } }, t("unban_btn"))));
  }
  add(el, ipList, h("h3", {}, t("device_bans_heading")),
    h("p", { class: "muted small" }, t("device_bans_intro")));
  const devList = h("div", { class: "list" });
  if (!devices.length) add(devList, h("p", { class: "muted" }, t("no_device_bans")));
  for (const b of devices) {
    add(devList, h("div", { class: "list-row" }, h("span", { class: "list-icon", "aria-hidden": "true" }, "📵"),
      h("span", { class: "meta" }, h("span", { class: "name" }, b.user ? displayName(b.user) : t("unknown_user"), h("span", { class: "muted small mono" }, ` ${b.device_id.slice(0, 8)}…`)),
        h("span", { class: "sub" }, [b.reason ? t("note_fact", { note: b.reason }) : null, fmtDateTime(b.created_at)].filter(Boolean).join(" · "))),
      h("button", { class: "btn", type: "button", on: { click: () => actions.req(T.ADMIN_DEVICE_BANS_REMOVE, { device_id: b.device_id }).then(refreshFullscreen, fail) } }, t("unban_btn"))));
  }
  add(el, devList);
}

// --- guilds (admin+) ------------------------------------------------------------------

async function guildsSection(el, actions) {
  const { guilds } = await actions.req(T.ADMIN_GUILDS_LIST);
  add(el, h("p", { class: "muted" }, t("guilds_intro")));
  const list = h("div", { class: "list" });
  if (!guilds.length) add(list, h("p", { class: "muted" }, t("no_guilds_yet")));
  for (const g of guilds) {
    const mine = state.guilds.get(g.guild_id);
    add(list, h("div", { class: "list-row" },
      h("div", { class: "guild-icon static", "aria-hidden": "true" }, initials(g.name)),
      h("span", { class: "meta" },
        h("span", { class: "name" }, g.name, g.listed ? h("span", { class: "tag" }, t("listed_tag")) : null),
        h("span", { class: "sub" }, t("guild_owner_members", { owner: displayName(g.owner), count: g.member_count }), " · ",
          h("button", { class: "btn link mono", type: "button", title: t("copy_guild_id_title"), on: { click: () => copyText(g.guild_id, t("guild_id_copied_toast")) } }, g.guild_id))),
      h("span", { class: "row" },
        mine ? h("button", { class: "btn", type: "button", on: { click: () => { closeFullscreen(); actions.openGuild(g.guild_id); } } }, mine.ghost ? t("open_ghost_btn") : t("open_btn"))
          : h("button", { class: "btn", type: "button", on: { click: async () => { try { await actions.ghostJoin(g.guild_id); closeFullscreen(); } catch (e) { fail(e); } } } }, t("ghost_join_btn")),
        h("button", {
          class: "btn danger", type: "button",
          on: {
            click: () => confirmModal({
              title: t("delete_guild_title", { name: g.name }),
              message: t("delete_guild_message"),
              confirmLabel: t("delete_guild_btn"),
              onConfirm: async () => { await actions.req(T.ADMIN_GUILDS_DELETE, { guild_id: g.guild_id }); refreshFullscreen(); },
            }),
          },
        }, t("delete_btn")))));
  }
  add(el, list);
}

// --- audit log ----------------------------------------------------------------------

const AUDIT_TEXT = {
  "user.status": (d) => (d.status === "active" ? t("audit_status_approved") : d.status === "disabled" ? t("audit_status_disabled") : d.status === "rejected" ? t("audit_status_rejected") : t("audit_status_other", { status: d.status })),
  "user.reset_password": () => t("audit_reset_password"),
  "user.mute": (d) => (d.until ? t("audit_muted") : t("audit_unmuted")),
  "user.delete": () => t("audit_delete_account"),
  "user.delete_self": () => t("audit_delete_self"),
  "staff.set": (d) => (d.role === "none" ? t("audit_staff_removed") : t("audit_staff_made", { role: d.role })),
  "ip_ban.add": (d) => t("audit_ip_ban_add", { cidr: d.cidr }),
  "ip_ban.remove": (d) => t("audit_ip_ban_remove", { cidr: d.cidr }),
  "device_ban.add": (d) => t("audit_device_ban_add", { count: d.devices }),
  "device_ban.remove": () => t("audit_device_ban_remove"),
  "guild.delete": (d) => t("audit_guild_delete", { name: d.name }),
  "config.update": (d) => t("audit_config_update", { keys: Object.keys(d).join(", ") }),
  "legal.update": (d) => t("audit_legal_update", { documents: (d.documents || []).join(" and ") }),
};

async function auditSection(el, actions) {
  const box = h("div", { class: "list" });
  const more = h("button", { class: "btn", type: "button", hidden: true }, t("load_more_btn"));
  let before;
  const load = async () => {
    const res = await actions.req(T.ADMIN_AUDIT_LOG, { before, limit: 50 });
    for (const e of res.entries) {
      const d = e.details || {};
      const text = (AUDIT_TEXT[e.action] || (() => e.action))(d);
      const who = d.username && e.action !== "user.delete_self" ? ` ${d.username}` : "";
      add(box, h("div", { class: "list-row" },
        avatar(e.actor, { size: "sm" }),
        h("span", { class: "meta" },
          h("span", { class: "name" }, h("strong", {}, displayName(e.actor)), ` ${text}`, who ? h("strong", {}, who) : null),
          h("span", { class: "sub" }, [fmtDateTime(e.created_at), d.reason ? t("audit_reason", { reason: d.reason }) : null, d.until && d.until !== "permanent" ? t("audit_until", { date: fmtDateTime(d.until) }) : d.until ? t("audit_indefinitely") : null].filter(Boolean).join(" · ")))));
      before = e.entry_id;
    }
    if (!box.children.length) add(box, h("p", { class: "muted" }, t("nothing_happened_yet")));
    more.hidden = !res.has_more;
  };
  more.addEventListener("click", load);
  add(el, box, more);
  await load();
}
