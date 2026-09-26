// Server admin panel (PROTOCOL.md §5 Admin, §8b, §8c): shown in User settings
// to server staff. Sections depend on the viewer's server role:
// moderators enforce, admins also manage accounts and guilds, and only the
// owner changes server config, legal documents and appoints admins.

import { getPrefs } from "../prefs.js";
import { LIMITS, T } from "../protocol.js";
import { STAFF_LABEL, staffLevel, state } from "../state.js";
import { add, avatar, clear, displayName, fmtBytes, fmtDate, fmtDateTime, fmtSeen, h, initials } from "./dom.js";
import { lastSeenSelect } from "./settings.js";
import { renderDocument } from "./markdown.js";
import { closeFullscreen, confirmAction, confirmModal, formModal, openMenu, openModal, refreshFullscreen, toast } from "./modals.js";
import { badgesSection, giveBadgesDialog } from "./adminBadges.js";
import { copyText } from "./profile.js";
import { scopedT } from "../strings.js";
import { icon } from "./icons.js";

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
    lvl >= OWNER ? { id: "badges", label: t("tab_badges"), render: (el) => badgesSection(el, actions) } : null,
    { id: "accounts", label: t("tab_accounts"), badge: state.pendingAccounts, render: (el) => accountsSection(el, actions) },
    lvl >= OWNER || lvl >= ADMIN ? { id: "staff", label: t("tab_staff"), render: (el) => staffSection(el, actions) } : null,
    { id: "bans", label: t("tab_bans"), render: (el) => bansSection(el, actions) },
    lvl >= ADMIN ? { id: "guilds", label: t("tab_guilds"), render: (el) => guildsSection(el, actions) } : null,
    { id: "server-audit", label: t("tab_audit_log"), render: (el) => auditSection(el, actions) },
    lvl >= OWNER ? { id: "data", label: t("tab_data"), render: (el) => dataSection(el, actions) } : null,
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
      stat(fmtBytes(s.attachments.bytes), t("stat_files_label", { count: s.attachments.count })),
      s.media ? stat(fmtBytes(s.media.bytes), t("stat_media_label", { count: s.media.count })) : null),
    h("p", { class: "muted small" }, t("overview_limits", { limit: fmtBytes(state.info.max_upload_bytes), voice: state.info.voice_enabled ? t("voice_on") : t("voice_off") })));
}

// --- server settings (owner) ----------------------------------------------------

function serverSection(el, actions) {
  const info = state.info;
  const select = (name, value, options) =>
    h("select", { name }, options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)));
  add(el, formRow(h("form", { class: "stack narrow" },
    h("label", {}, t("server_name_label"), h("input", { name: "server_name", required: true, maxLength: LIMITS.SERVER_NAME_MAX, value: info.server_name })),
    h("label", {}, t("server_description_label"),
      h("textarea", { name: "server_description", rows: 5, maxLength: LIMITS.SERVER_DESCRIPTION_MAX, text: info.server_description || "", placeholder: t("server_description_placeholder") }),
      h("span", { class: "muted small block" }, t("server_description_hint"))),
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
    h("label", { class: "check" }, h("input", { type: "checkbox", name: "announcements_admins", checked: !!info.announcements_admins }),
      h("span", {}, t("announcements_admins_label"), h("span", { class: "muted small block" }, t("announcements_admins_hint")))),
    h("label", { class: "check" }, h("input", { type: "checkbox", name: "link_embeds", checked: info.link_embeds !== false }),
      h("span", {}, t("link_embeds_label"), h("span", { class: "muted small block" }, t("link_embeds_hint")))),
    h("label", { class: "check" }, h("input", { type: "checkbox", name: "fx_links", checked: info.fx_links !== false }),
      h("span", {}, t("fx_links_label"), h("span", { class: "muted small block" }, t("fx_links_hint")))),
    h("label", {}, t("max_accounts_label"),
      h("input", { name: "max_accounts_per_client", type: "number", min: 0, max: LIMITS.MAX_ACCOUNTS_PER_CLIENT, required: true, value: info.max_accounts_per_client || 0 }),
      h("span", { class: "muted small block" }, t("max_accounts_hint"))),
    h("div", {}, h("button", { class: "btn primary", type: "submit" }, t("save")))),
  async (fd) => {
    const res = await actions.req(T.SERVER_CONFIG_UPDATE, {
      server_name: String(fd.get("server_name")).trim(),
      server_description: String(fd.get("server_description") || "").trim(),
      account_creation: fd.get("account_creation"),
      guild_creation: fd.get("guild_creation"),
      guild_list_visible: fd.get("guild_list_visible") === "on",
      max_upload_bytes: Math.max(1, Math.min(1024, Number(fd.get("max_upload_mb")) || 25)) * 1048576,
      voice_enabled: fd.get("voice_enabled") === "on",
      user_search: fd.get("user_search"),
      announcements_admins: fd.get("announcements_admins") === "on",
      link_embeds: fd.get("link_embeds") === "on",
      fx_links: fd.get("fx_links") === "on",
      max_accounts_per_client: Math.max(0, Math.min(LIMITS.MAX_ACCOUNTS_PER_CLIENT, Math.floor(Number(fd.get("max_accounts_per_client")) || 0))),
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

// Sort / filter choices survive switching tabs while the settings are open.
const accountView = { sort: "joined", order: "asc", flags: new Set(), seen: "", joined: "" };

async function accountsSection(el, actions) {
  let filter = state.pendingAccounts ? "pending" : "";
  const v = accountView;
  const tabs = h("div", { class: "tabs inline" });
  const search = h("input", { type: "search", placeholder: t("search_accounts_placeholder"), "aria-label": t("search_accounts_aria") });
  const list = h("div", { class: "list" });
  const count = h("span", { class: "muted small" });
  const select = (label, value, options, set) => h("label", { class: "inline-field" }, h("span", {}, label),
    h("select", { on: { change: (e) => { set(e.currentTarget.value); draw(); } } },
      options.map(([val, text]) => h("option", { value: val, selected: val === value }, text))));
  const orderBtn = h("button", { class: "btn small", type: "button", on: { click: () => { v.order = v.order === "asc" ? "desc" : "asc"; draw(); } } });
  const chips = h("div", { class: "chips filter-chips", role: "group", "aria-label": t("filter_flags_aria") });
  const drawChips = () => clear(chips, [["online", t("flag_online")], ["staff", t("flag_staff")], ["muted", t("flag_muted")], ["perks", t("flag_perks")], ["badges", t("flag_badges")]].map(([f, label]) =>
    h("button", {
      class: `chip ${v.flags.has(f) ? "on" : ""}`, type: "button", "aria-pressed": String(v.flags.has(f)),
      on: { click: () => { v.flags.has(f) ? v.flags.delete(f) : v.flags.add(f); draw(); } },
    }, label)));
  const toolbar = h("div", { class: "account-tools" },
    select(t("sort_label"), v.sort, [["joined", t("sort_joined")], ["seen", t("sort_seen")], ["name", t("sort_name")], ["devices", t("sort_devices")]], (x) => { v.sort = x; }),
    orderBtn,
    select(t("seen_filter_label"), v.seen, [["", t("any_time")], ["7d", t("seen_7d")], ["30d", t("seen_30d")], ["inactive30", t("seen_inactive30")], ["never", t("seen_never")]], (x) => { v.seen = x; }),
    select(t("joined_filter_label"), v.joined, [["", t("any_time")], ["7d", t("joined_7d")], ["30d", t("joined_30d")]], (x) => { v.joined = x; }),
    h("label", { class: "inline-field" }, h("span", {}, t("seen_format_label")), lastSeenSelect(() => draw())));
  const draw = async () => {
    clear(tabs, [["", t("filter_all")], ["pending", t("filter_pending")], ["active", t("filter_active")], ["disabled", t("filter_disabled")], ["rejected", t("filter_rejected")]].map(([val, l]) =>
      h("button", { class: "tab", type: "button", "aria-selected": String(filter === val), on: { click: () => { filter = val; draw(); } } }, l)));
    drawChips();
    clear(orderBtn, icon(v.order === "asc" ? "arrow-up" : "arrow-down"), " ", v.order === "asc" ? t("order_asc") : t("order_desc"));
    const { users } = await actions.req(T.ADMIN_USERS_LIST, {
      status: filter || undefined, query: search.value.trim() || undefined,
      sort: v.sort, order: v.order, flags: [...v.flags], seen: v.seen || undefined, joined: v.joined || undefined,
    });
    count.textContent = t("accounts_count", { count: users.length });
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
  add(el, h("p", { class: "muted small" }, t("ip_visibility_note")), h("div", { class: "row wrap" }, tabs, search), toolbar, chips, count, list);
  await draw();
}

const isMuted = (u) => u.muted_until && (u.muted_until === "permanent" || new Date(u.muted_until) > new Date());

function accountRow(u, actions, redraw) {
  const apply = async (status) => {
    try {
      await actions.req(T.ADMIN_USERS_SET_STATUS, { user_id: u.user_id, status });
      await redraw();
    } catch (e) { fail(e); }
  };
  const act = (label, status, cls = "") => h("button", {
    class: `btn ${cls}`, type: "button",
    on: { click: () => apply(status) },
  }, label);
  const reject = () => h("button", {
    class: "btn", type: "button",
    on: {
      click: (e) => confirmAction(e, {
        title: t("reject_account_title", { name: displayName(u) }),
        message: t("reject_account_body"),
        confirmLabel: t("reject_btn"),
        onConfirm: () => apply("rejected"),
      }),
    },
  }, t("reject_btn"));
  const below = staffLevel(u) < staffLevel();
  const buttons = [];
  if (u.status === "pending" && below) buttons.push(act(t("approve_btn"), "active", "primary"), reject());
  else if (u.status === "disabled" && below) buttons.push(act(t("enable_btn"), "active"));
  if (u.status === "active" && below) {
    buttons.push(h("button", {
      class: "btn", type: "button", "aria-haspopup": "menu",
      on: { click: (e) => openMenu(e.currentTarget, adminModeration(u, actions, redraw), { placement: "left", key: `admin:${u.user_id}` }) },
    }, t("manage_btn")));
  }
  const role = staffLevel(u) ? h("span", { class: `tag staff ${u.server_role}` }, (u.server_role || "").toUpperCase()) : null;
  const facts = [
    t("joined_fact", { date: fmtDate(u.created_at) }),
    u.last_ip ? t("ip_fact", { ip: u.last_ip }) : null,
    u.online ? t("online_now_fact") : u.last_seen ? t("seen_fact", { date: fmtSeen(u.last_seen, getPrefs().lastSeenFormat) }) : t("never_seen_fact"),
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
      ? { label: t("unmute_label"), icon: "volume-2", onClick: () => done(actions.req(T.ADMIN_USERS_MUTE, { user_id: u.user_id }).then(() => toast(t("unmuted_toast", { name })))) }
      : { label: t("mute_label"), icon: "volume-x", onClick: () => muteDialog(u, (payload) => done(actions.req(T.ADMIN_USERS_MUTE, { user_id: u.user_id, ...payload }).then(() => toast(t("muted_toast", { name }))))) },
    { label: t("disable_account_label"), icon: "ban", danger: true, onClick: () => confirmModal({
      title: t("disable_confirm_title", { name }), message: t("disable_confirm_message"), confirmLabel: t("disable_confirm_btn"),
      onConfirm: () => done(actions.req(T.ADMIN_USERS_SET_STATUS, { user_id: u.user_id, status: "disabled" })),
    }) },
    { label: t("ban_devices_label"), icon: "smartphone", danger: true, onClick: () => reasonDialog(t("ban_devices_title", { name }),
      t("ban_devices_message"),
      t("ban_devices_btn"), (reason) => done(actions.req(T.ADMIN_DEVICE_BANS_ADD, { user_id: u.user_id, reason }).then(() => toast(t("devices_banned_toast"))))) },
    { label: t("ban_ip_label"), icon: "globe", danger: true, onClick: async () => {
      try {
        const { users } = await actions.req(T.ADMIN_USERS_LIST, { query: u.username });
        const ip = users.find((x) => x.user_id === u.user_id)?.last_ip;
        if (!ip) { toast(t("no_known_ip_toast"), { error: true }); return; }
        reasonDialog(t("ban_ip_title", { ip }), t("ban_ip_message", { ip, name }), t("ban_ip_btn"),
          (reason) => done(actions.req(T.ADMIN_IP_BANS_ADD, { cidr: ip, reason }).then(() => toast(t("ip_banned_toast", { ip })))));
      } catch (e) { fail(e); }
    } },
    lvl >= ADMIN ? "-" : null,
    lvl >= ADMIN ? { label: t("reset_password_label"), icon: "key-round", onClick: () => confirmModal({
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
    lvl >= ADMIN ? { label: u.perks ? t("remove_perks_label") : t("give_perks_btn"), icon: "sparkles", hint: t("give_perks_hint"), onClick: () => done(actions.req(T.ADMIN_USERS_SET_PERKS, { user_id: u.user_id, perks: !u.perks }).then(() => toast(u.perks ? t("perks_removed_toast2") : t("perks_given_toast2")))) } : null,
    lvl >= OWNER && u.status === "active" ? { label: t("badges_label"), icon: "award", hint: t("badges_hint"), onClick: () => giveBadgesDialog(u, actions, after) } : null,
    lvl >= ADMIN ? { label: t("delete_account_label"), icon: "trash-2", danger: true, onClick: () => deleteAccountDialog(u, () => done(actions.req(T.ADMIN_USERS_DELETE, { user_id: u.user_id }).then(() => toast(t("account_deleted_toast", { name }))))) } : null,
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
  confirmModal({
    title: t("delete_account_title", { name: displayName(u) }),
    message: t("delete_account_message"),
    confirmLabel: t("delete_account_btn"),
    code: true,
    onConfirm: onDelete,
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
      canEdit ? h("button", {
        class: "btn", type: "button",
        on: {
          click: (e) => confirmAction(e, {
            title: t("remove_staff_title", { name: displayName(u) }),
            message: t("remove_staff_body"),
            confirmLabel: t("remove_from_staff_btn"),
            onConfirm: () => setRole(u, "none"),
          }),
        },
      }, t("remove_from_staff_btn")) : null));
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
    add(ipList, h("div", { class: "list-row" }, h("span", { class: "list-icon", "aria-hidden": "true" }, icon("globe")),
      h("span", { class: "meta" }, h("span", { class: "name mono" }, b.cidr),
        h("span", { class: "sub" }, [b.reason ? t("note_fact", { note: b.reason }) : null, b.banned_by ? t("banned_by_fact", { name: displayName(b.banned_by) }) : null, fmtDateTime(b.created_at)].filter(Boolean).join(" · "))),
      h("button", {
        class: "btn", type: "button",
        on: {
          click: (e) => confirmAction(e, {
            title: t("unban_ip_title", { cidr: b.cidr }),
            message: t("unban_ip_body"),
            confirmLabel: t("unban_btn"),
            danger: false,
            onConfirm: () => actions.req(T.ADMIN_IP_BANS_REMOVE, { cidr: b.cidr }).then(refreshFullscreen, fail),
          }),
        },
      }, t("unban_btn"))));
  }
  add(el, ipList, h("h3", {}, t("device_bans_heading")),
    h("p", { class: "muted small" }, t("device_bans_intro")));
  const devList = h("div", { class: "list" });
  if (!devices.length) add(devList, h("p", { class: "muted" }, t("no_device_bans")));
  for (const b of devices) {
    add(devList, h("div", { class: "list-row" }, h("span", { class: "list-icon", "aria-hidden": "true" }, icon("smartphone")),
      h("span", { class: "meta" }, h("span", { class: "name" }, b.user ? displayName(b.user) : t("unknown_user"), h("span", { class: "muted small mono" }, ` ${b.device_id.slice(0, 8)}…`)),
        h("span", { class: "sub" }, [b.reason ? t("note_fact", { note: b.reason }) : null, fmtDateTime(b.created_at)].filter(Boolean).join(" · "))),
      h("button", {
        class: "btn", type: "button",
        on: {
          click: (e) => confirmAction(e, {
            title: t("unban_device_title"),
            message: t("unban_device_body"),
            confirmLabel: t("unban_btn"),
            danger: false,
            onConfirm: () => actions.req(T.ADMIN_DEVICE_BANS_REMOVE, { device_id: b.device_id }).then(refreshFullscreen, fail),
          }),
        },
      }, t("unban_btn"))));
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
              code: true,
              onConfirm: async () => { await actions.req(T.ADMIN_GUILDS_DELETE, { guild_id: g.guild_id }); refreshFullscreen(); },
            }),
          },
        }, t("delete_btn")))));
  }
  add(el, list);
}

// --- audit log ----------------------------------------------------------------------

const AUDIT_TEXT = {
  "user.badges": (d) => (d.badges?.length ? t("audit_badges_set", { count: d.badges.length }) : t("audit_badges_cleared")),
  "badge.create": (d) => t("audit_badge_create", { name: d.name }),
  "badge.update": (d) => t("audit_badge_update", { name: d.name }),
  "badge.delete": (d) => t("audit_badge_delete", { name: d.name }),
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

// --- data (owner): what the server's storage goes on -------------------------------

// Slice order is fixed and colour follows the category, never its rank, so a
// category keeps its colour when others come and go. `other` and `free` are
// neutral: they aren't a kind of data anyone chose to keep.
const DATA_KEYS = ["messages", "attachments", "emoji", "images", "previews", "users", "servers", "logs", "other", "free"];
const DATA_COLOR = (key) => `var(--data-${key})`;

function donut(slices, total, { onHover }) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 200 200");
  svg.setAttribute("class", "data-donut");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", t("data_chart_aria"));
  const R = 92;
  const r = 60;
  let angle = -Math.PI / 2;
  const point = (rad, a) => [100 + rad * Math.cos(a), 100 + rad * Math.sin(a)];
  const shown = slices.filter((s) => s.bytes > 0);
  for (const s of shown) {
    const sweep = Math.min((s.bytes / total) * Math.PI * 2, Math.PI * 2 - 1e-4);
    const a0 = angle;
    const a1 = angle + sweep;
    angle = a1;
    const large = sweep > Math.PI ? 1 : 0;
    const [x0, y0] = point(R, a0);
    const [x1, y1] = point(R, a1);
    const [x2, y2] = point(r, a1);
    const [x3, y3] = point(r, a0);
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", `M${x0} ${y0}A${R} ${R} 0 ${large} 1 ${x1} ${y1}L${x2} ${y2}A${r} ${r} 0 ${large} 0 ${x3} ${y3}Z`);
    path.setAttribute("class", `slice slice-${s.key}`);
    path.setAttribute("fill", s.key === "free" ? "url(#data-free-hatch)" : DATA_COLOR(s.key));
    path.dataset.key = s.key;
    path.addEventListener("mouseenter", () => onHover(s.key));
    path.addEventListener("mouseleave", () => onHover(null));
    const title = document.createElementNS(NS, "title");
    title.textContent = `${t(`data_${s.key}`)}: ${fmtBytes(s.bytes)}`;
    path.append(title);
    svg.append(path);
  }
  // Free space is hatched, so it reads as "not data" without a colour.
  const defs = document.createElementNS(NS, "defs");
  defs.innerHTML = '<pattern id="data-free-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
    + '<rect width="6" height="6" fill="var(--data-free)"/><line x1="0" y1="0" x2="0" y2="6" stroke="var(--data-other)" stroke-width="2"/></pattern>';
  svg.prepend(defs);
  return svg;
}

async function dataSection(el, actions) {
  const body = h("div", { class: "data-tab" });
  const draw = (s) => {
    const total = s.total_bytes || 0;
    const slices = DATA_KEYS.map((key) => s.categories.find((c) => c.key === key) || { key, bytes: 0, db_bytes: 0, file_bytes: 0, files: 0 });
    const centre = h("div", { class: "data-centre" });
    const showCentre = (key) => {
      const c = key && slices.find((x) => x.key === key);
      clear(centre,
        h("div", { class: "data-centre-n" }, fmtBytes(c ? c.bytes : total)),
        h("div", { class: "data-centre-l" }, c ? t(`data_${c.key}`) : t("data_total")));
      for (const row of legend.children) row.classList.toggle("hover", row.dataset.key === key);
      for (const p of chart.querySelectorAll(".slice")) p.classList.toggle("dim", !!key && p.dataset.key !== key);
    };
    const pct = (b) => (total ? `${((b / total) * 100).toFixed(b / total < 0.01 ? 1 : 0)}%` : "0%");
    const legend = h("ul", { class: "data-legend" }, slices.map((c) => h("li", {
      class: c.bytes ? "" : "empty", dataset: { key: c.key },
      on: { mouseenter: () => showCentre(c.key), mouseleave: () => showCentre(null) },
    },
    h("span", { class: `data-swatch ${c.key}`, style: `background:${DATA_COLOR(c.key)}` }),
    h("span", { class: "data-name" }, t(`data_${c.key}`),
      h("span", { class: "muted small block" }, [
        c.db_bytes ? t("data_in_db", { size: fmtBytes(c.db_bytes) }) : null,
        c.file_bytes ? t("data_in_files", { size: fmtBytes(c.file_bytes), count: c.files }) : null,
      ].filter(Boolean).join(" · ") || t("data_nothing"))),
    h("span", { class: "data-size" }, fmtBytes(c.bytes)),
    h("span", { class: "data-pct muted" }, pct(c.bytes)))));
    const chart = donut(slices, total || 1, { onHover: showCentre });
    showCentre(null);
    const db = s.database;
    const action = (key, label, hint, danger = false) => h("div", { class: "list-row" },
      h("span", { class: "meta" }, h("span", { class: "name" }, label), h("span", { class: "sub" }, hint)),
      h("button", {
        class: `btn ${danger ? "danger" : ""}`, type: "button",
        on: {
          click: (e) => confirmAction(e, {
            title: label, message: t(`data_${key}_confirm`), confirmLabel: t(`data_${key}_btn`),
            onConfirm: async () => { draw(await actions.req(T.ADMIN_STORAGE_ACTION, { action: key })); toast(t(`data_${key}_done`)); },
          }),
        },
      }, t(`data_${key}_btn`)));
    clear(body,
      h("div", { class: "data-summary" },
        h("div", { class: "data-chart" }, chart, centre),
        legend),
      h("p", { class: "muted small" },
        t("data_db_line", { file: fmtBytes(db.file_bytes), wal: fmtBytes(db.wal_bytes), free: fmtBytes(db.free_bytes) }),
        " ", db.exact ? t("data_exact") : t("data_estimated")),
      h("h3", {}, t("data_tidy_heading")),
      h("div", { class: "list" },
        action("clear_previews", t("data_clear_previews_label"), t("data_clear_previews_hint", { count: s.cached_previews })),
        action("purge_unclaimed", t("data_purge_unclaimed_label"), t("data_purge_unclaimed_hint", { count: s.unclaimed_media.count, size: fmtBytes(s.unclaimed_media.bytes) })),
        action("vacuum", t("data_vacuum_label"), t("data_vacuum_hint", { size: fmtBytes(db.free_bytes) }))));
  };
  add(el, h("p", { class: "muted" }, t("data_intro")), body);
  add(body, h("p", { class: "muted" }, t("data_loading")));
  draw(await actions.req(T.ADMIN_STORAGE));
}

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
