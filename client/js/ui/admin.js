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

const MOD = 1;
const ADMIN = 2;
const OWNER = 3;
const fail = (e) => toast(e.message, { error: true });

const MUTES = [["600", "10 minutes"], ["3600", "1 hour"], ["86400", "1 day"], ["604800", "1 week"], ["2592000", "30 days"], ["permanent", "Until unmuted"]];

export function adminSections(actions) {
  const lvl = staffLevel();
  if (!lvl) return [];
  return [
    { heading: "Server admin" },
    lvl >= ADMIN ? { id: "admin-overview", label: "Overview", render: (el) => overview(el, actions) } : null,
    lvl >= OWNER ? { id: "server", label: "Server settings", render: (el) => serverSection(el, actions) } : null,
    lvl >= OWNER ? { id: "rules", label: "Rules & privacy", render: (el) => legalSection(el, actions) } : null,
    { id: "accounts", label: "Accounts", badge: state.pendingAccounts, render: (el) => accountsSection(el, actions) },
    lvl >= OWNER || lvl >= ADMIN ? { id: "staff", label: "Staff", render: (el) => staffSection(el, actions) } : null,
    { id: "bans", label: "Bans", render: (el) => bansSection(el, actions) },
    lvl >= ADMIN ? { id: "guilds", label: "Guilds", render: (el) => guildsSection(el, actions) } : null,
    { id: "server-audit", label: "Audit log", render: (el) => auditSection(el, actions) },
  ];
}

function formRow(form, onSubmit, { okText = "Saved" } = {}) {
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
    h("p", { class: "muted" }, `You're a ${STAFF_LABEL[state.user.server_role] || "staff member"} on ${state.info.server_name}.`),
    h("div", { class: "stats" },
      stat(s.users, "active accounts"), stat(s.guilds, "guilds"), stat(s.messages, "messages"),
      stat(fmtBytes(s.attachments.bytes), `in ${s.attachments.count} files`)),
    h("p", { class: "muted small" }, `Upload limit: ${fmtBytes(state.info.max_upload_bytes)} per file · Voice channels ${state.info.voice_enabled ? "on" : "off"}.`));
}

// --- server settings (owner) ----------------------------------------------------

function serverSection(el, actions) {
  const info = state.info;
  const select = (name, value, options) =>
    h("select", { name }, options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)));
  add(el, formRow(h("form", { class: "stack narrow" },
    h("label", {}, "Server name", h("input", { name: "server_name", required: true, maxLength: LIMITS.SERVER_NAME_MAX, value: info.server_name })),
    h("label", {}, "Account creation", select("account_creation", info.account_creation, [
      ["on", "Open: anyone can register"],
      ["request", "By request: staff approve new accounts"],
      ["off", "Closed"],
    ])),
    h("label", {}, "Guild creation", select("guild_creation", info.guild_creation, [
      ["on", "Anyone can create guilds"],
      ["off", "Only the server owner"],
    ])),
    h("label", { class: "check" }, h("input", { type: "checkbox", name: "guild_list_visible", checked: info.guild_list_visible }), "Allow a public guild directory"),
    h("label", {}, "Maximum upload size (MB)",
      h("input", { name: "max_upload_mb", type: "number", min: 1, max: 1024, required: true, value: Math.round(info.max_upload_bytes / 1048576) }),
      h("span", { class: "muted small block" }, "Per file. Files are stored in the server's data folder.")),
    h("label", { class: "check" }, h("input", { type: "checkbox", name: "voice_enabled", checked: info.voice_enabled }),
      h("span", {}, "Voice channels", h("span", { class: "muted small block" }, "A preview: people can join voice channels and see who's there, but audio isn't available yet."))),
    h("div", {}, h("button", { class: "btn primary", type: "submit" }, "Save"))),
  async (fd) => {
    const res = await actions.req(T.SERVER_CONFIG_UPDATE, {
      server_name: String(fd.get("server_name")).trim(),
      account_creation: fd.get("account_creation"),
      guild_creation: fd.get("guild_creation"),
      guild_list_visible: fd.get("guild_list_visible") === "on",
      max_upload_bytes: Math.max(1, Math.min(1024, Number(fd.get("max_upload_mb")) || 25)) * 1048576,
      voice_enabled: fd.get("voice_enabled") === "on",
    });
    actions.setServerInfo(res.config);
  }, { okText: "Server settings saved" }));
}

// --- legal documents (owner) ------------------------------------------------------

async function legalSection(el, actions) {
  const docs = await actions.req(T.LEGAL_GET);
  add(el, h("p", { class: "muted" }, "Markdown. People see these before creating an account, and existing members are asked to accept them again whenever you change them. Leave both empty to turn this off."));
  for (const [key, label] of [["terms", "Terms of Service"], ["privacy", "Privacy Policy"]]) {
    const area = h("textarea", { rows: 12, maxLength: LIMITS.LEGAL_MAX_CHARS, class: "mono legal-edit", "aria-label": label, placeholder: key === "terms" ? "# Rules\n\n1. Be kind.\n2. No spam." : "# Privacy\n\nWhat this server stores and who can see it." });
    area.value = docs[key] || "";
    const preview = h("div", { class: "legal-doc legal-preview", hidden: true });
    const toggle = h("button", { class: "btn", type: "button" }, "Preview");
    toggle.addEventListener("click", () => {
      preview.hidden = !preview.hidden;
      area.hidden = !preview.hidden;
      toggle.textContent = preview.hidden ? "Preview" : "Edit";
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
            toast(`${label} saved — members will be asked to accept it`);
          } catch (e) { fail(e); } finally { save.disabled = false; }
        },
      },
    }, "Save");
    add(el, h("section", { class: "legal-section stack" }, h("h3", {}, label), area, preview, h("div", { class: "row" }, save, toggle)));
  }
}

// --- accounts ---------------------------------------------------------------------

async function accountsSection(el, actions) {
  let filter = state.pendingAccounts ? "pending" : "";
  const tabs = h("div", { class: "tabs inline" });
  const search = h("input", { type: "search", placeholder: "Search accounts", "aria-label": "Search accounts" });
  const list = h("div", { class: "list" });
  const draw = async () => {
    clear(tabs, [["", "All"], ["pending", "Pending"], ["active", "Active"], ["disabled", "Disabled"], ["rejected", "Rejected"]].map(([v, l]) =>
      h("button", { class: "tab", type: "button", "aria-selected": String(filter === v), on: { click: () => { filter = v; draw(); } } }, l)));
    const { users } = await actions.req(T.ADMIN_USERS_LIST, { status: filter || undefined, query: search.value.trim() || undefined });
    if (filter === "pending" || !filter) {
      state.pendingAccounts = users.filter((u) => u.status === "pending").length || (filter === "pending" ? 0 : state.pendingAccounts);
      actions.refreshChrome();
    }
    clear(list);
    if (!users.length) add(list, h("p", { class: "muted" }, filter === "pending" ? "No account requests right now." : "No accounts match."));
    for (const u of users) add(list, accountRow(u, actions, draw));
  };
  let timer;
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(draw, 200); });
  add(el, h("p", { class: "muted small" }, "IP addresses are visible to server staff only."), h("div", { class: "row wrap" }, tabs, search), list);
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
  if (u.status === "pending" && below) buttons.push(act("Approve", "active", "primary"), act("Reject", "rejected"));
  else if (u.status === "disabled" && below) buttons.push(act("Enable", "active"));
  if (u.status === "active" && below) {
    buttons.push(h("button", {
      class: "btn", type: "button", "aria-haspopup": "menu",
      on: { click: (e) => openMenu(e.currentTarget, adminModeration(u, actions, redraw), { placement: "left" }) },
    }, "Manage ▾"));
  }
  const role = staffLevel(u) ? h("span", { class: `tag staff ${u.server_role}` }, (u.server_role || "").toUpperCase()) : null;
  const facts = [
    `Joined ${fmtDate(u.created_at)}`,
    u.last_ip ? `IP ${u.last_ip}` : null,
    u.last_seen ? `seen ${fmtDateTime(u.last_seen)}` : null,
    u.device_count ? `${u.device_count} device${u.device_count === 1 ? "" : "s"}` : null,
    u.note ? `“${u.note}”` : null,
  ].filter(Boolean).join(" · ");
  return h("div", { class: "list-row" },
    avatar(u, { size: "sm" }),
    h("span", { class: "meta" },
      h("span", { class: "name" }, displayName(u), u.display_name ? h("span", { class: "muted small" }, ` ${u.username}`) : null, role,
        u.status !== "active" ? h("span", { class: `tag ${u.status}` }, u.status.toUpperCase()) : null,
        isMuted(u) ? h("span", { class: "tag warn" }, "MUTED") : null),
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
      ? { label: "Unmute on server", icon: "🔊", onClick: () => done(actions.req(T.ADMIN_USERS_MUTE, { user_id: u.user_id }).then(() => toast(`${name} unmuted`))) }
      : { label: "Mute on server…", icon: "🔇", onClick: () => muteDialog(u, (payload) => done(actions.req(T.ADMIN_USERS_MUTE, { user_id: u.user_id, ...payload }).then(() => toast(`${name} muted`)))) },
    { label: "Disable account", icon: "⛔", danger: true, onClick: () => confirmModal({
      title: `Disable ${name}?`, message: "They're logged out everywhere and can't log in until re-enabled.", confirmLabel: "Disable",
      onConfirm: () => done(actions.req(T.ADMIN_USERS_SET_STATUS, { user_id: u.user_id, status: "disabled" })),
    }) },
    { label: "Ban their devices…", icon: "📵", danger: true, onClick: () => reasonDialog(`Ban ${name}'s devices?`,
      "Blocks every browser they've logged in from on this server. It's easy to get around (clearing site data), so pair it with an IP ban for raids.",
      "Ban devices", (reason) => done(actions.req(T.ADMIN_DEVICE_BANS_ADD, { user_id: u.user_id, reason }).then(() => toast("Devices banned")))) },
    { label: "Ban their IP address…", icon: "🌐", danger: true, onClick: async () => {
      try {
        const { users } = await actions.req(T.ADMIN_USERS_LIST, { query: u.username });
        const ip = users.find((x) => x.user_id === u.user_id)?.last_ip;
        if (!ip) { toast("No known IP address for them", { error: true }); return; }
        reasonDialog(`Ban ${ip}?`, `Everyone connecting from ${ip} is disconnected and blocked, not just ${name}.`, "Ban IP",
          (reason) => done(actions.req(T.ADMIN_IP_BANS_ADD, { cidr: ip, reason }).then(() => toast(`${ip} banned`))));
      } catch (e) { fail(e); }
    } },
    lvl >= ADMIN ? "-" : null,
    lvl >= ADMIN ? { label: "Reset password", icon: "🔑", onClick: () => confirmModal({
      title: `Reset ${name}'s password?`, message: "They'll be logged out everywhere. You'll see the new password once.", confirmLabel: "Reset password",
      onConfirm: async () => {
        const { password } = await actions.req(T.ADMIN_USERS_RESET_PASSWORD, { user_id: u.user_id });
        setTimeout(() => openModal({
          title: "New password", subtitle: `Give this to ${name}. It won't be shown again.`,
          content: h("div", { class: "row" }, h("div", { class: "code-display" }, password),
            h("button", { class: "btn", type: "button", on: { click: () => copyText(password, "Password copied") } }, "Copy")),
        }));
      },
    }) } : null,
    lvl >= ADMIN ? { label: "Delete account…", icon: "🗑", danger: true, onClick: () => deleteAccountDialog(u, () => done(actions.req(T.ADMIN_USERS_DELETE, { user_id: u.user_id }).then(() => toast(`${name}'s account was deleted`)))) } : null,
  ];
}

function muteDialog(u, onMute) {
  formModal({
    title: `Mute ${displayName(u)} on this server`,
    subtitle: "They can still read, but can't send messages, react, upload or join voice anywhere on the server — including DMs.",
    submitLabel: "Mute",
    danger: true,
    fields: [
      h("label", {}, "Duration", h("select", { name: "d" }, MUTES.map(([v, l]) => h("option", { value: v, selected: v === "86400" }, l)))),
      h("label", {}, "Reason (optional, shown in the audit log)", h("input", { name: "reason", maxLength: LIMITS.BAN_REASON_MAX })),
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
    fields: [h("label", {}, "Reason (optional)", h("input", { name: "reason", maxLength: LIMITS.BAN_REASON_MAX }))],
    onConfirm: (fd) => onConfirm(String(fd.get("reason") || "").trim() || undefined),
  });
}

function deleteAccountDialog(u, onDelete) {
  const input = h("input", { placeholder: u.username, "aria-label": "Type their username to confirm", autocomplete: "off" });
  confirmModal({
    title: `Delete ${displayName(u)}'s account?`,
    message: "Their messages stay but show as “Deleted User”. Their avatar and uploads are deleted, guilds they own pass to their highest-ranked member, and the username becomes free. This can't be undone.",
    confirmLabel: "Delete account",
    fields: [h("label", {}, `Type ${u.username} to confirm`, input)],
    onConfirm: () => {
      if (input.value.trim() !== u.username) throw new Error("The username doesn't match.");
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
    h("p", { class: "muted" }, "Moderators can approve and disable accounts, mute people server-wide and ban IPs and devices. Admins can also delete accounts, reset passwords and manage every guild. Only the server owner changes server settings and appoints admins."));
  const list = h("div", { class: "list" });
  for (const u of staff) {
    const canEdit = staffLevel(u) < lvl;
    add(list, h("div", { class: "list-row" },
      avatar(u, { size: "sm" }),
      h("span", { class: "meta" }, h("span", { class: "name" }, displayName(u)), h("span", { class: "sub" }, STAFF_LABEL[u.server_role] || u.server_role)),
      canEdit ? h("button", { class: "btn", type: "button", on: { click: () => setRole(u, "none") } }, "Remove from staff") : null));
  }
  add(el, h("h3", {}, "Current staff"), list);
  const search = h("input", { type: "search", placeholder: "Find someone to add", "aria-label": "Find a user" });
  const results = h("div", { class: "list" });
  const setRole = async (u, role) => {
    try {
      await actions.req(T.ADMIN_STAFF_SET, { user_id: u.user_id, role });
      toast(role === "none" ? `${displayName(u)} is no longer staff` : `${displayName(u)} is now a ${role}`);
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
          u.server_role !== "moderator" ? h("button", { class: "btn", type: "button", on: { click: () => setRole(u, "moderator") } }, "Make moderator") : null,
          lvl >= OWNER && u.server_role !== "admin" ? h("button", { class: "btn", type: "button", on: { click: () => setRole(u, "admin") } }, "Make admin") : null)));
    }
  };
  let timer;
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(find, 200); });
  add(el, h("h3", {}, "Add staff"), search, results);
}

// --- bans ---------------------------------------------------------------------------

async function bansSection(el, actions) {
  const [{ bans: ips }, { bans: devices }] = await Promise.all([
    actions.req(T.ADMIN_IP_BANS_LIST), actions.req(T.ADMIN_DEVICE_BANS_LIST),
  ]);
  const cidr = h("input", { name: "cidr", required: true, placeholder: "203.0.113.7 or 203.0.113.0/24", spellcheck: "false", class: "mono" });
  add(el,
    h("h3", {}, "IP bans"),
    h("p", { class: "muted small" }, "Banned addresses can't connect at all. Use a range (/24) for people who hop between nearby addresses."),
    formRow(h("form", { class: "row wrap" }, cidr, h("input", { name: "reason", placeholder: "Reason (optional)", maxLength: LIMITS.BAN_REASON_MAX }),
      h("button", { class: "btn danger", type: "submit" }, "Ban")),
    async (fd) => {
      await actions.req(T.ADMIN_IP_BANS_ADD, { cidr: String(fd.get("cidr")).trim(), reason: String(fd.get("reason") || "").trim() || undefined });
      refreshFullscreen();
    }, { okText: "Banned" }));
  const ipList = h("div", { class: "list" });
  if (!ips.length) add(ipList, h("p", { class: "muted" }, "No IP bans."));
  for (const b of ips) {
    add(ipList, h("div", { class: "list-row" }, h("span", { class: "list-icon", "aria-hidden": "true" }, "🌐"),
      h("span", { class: "meta" }, h("span", { class: "name mono" }, b.cidr),
        h("span", { class: "sub" }, [b.reason ? `“${b.reason}”` : null, b.banned_by ? `by ${displayName(b.banned_by)}` : null, fmtDateTime(b.created_at)].filter(Boolean).join(" · "))),
      h("button", { class: "btn", type: "button", on: { click: () => actions.req(T.ADMIN_IP_BANS_REMOVE, { cidr: b.cidr }).then(refreshFullscreen, fail) } }, "Unban")));
  }
  add(el, ipList, h("h3", {}, "Device bans"),
    h("p", { class: "muted small" }, "Added from an account's Manage menu. A device ban only stops that browser profile; clearing site data gets around it."));
  const devList = h("div", { class: "list" });
  if (!devices.length) add(devList, h("p", { class: "muted" }, "No device bans."));
  for (const b of devices) {
    add(devList, h("div", { class: "list-row" }, h("span", { class: "list-icon", "aria-hidden": "true" }, "📵"),
      h("span", { class: "meta" }, h("span", { class: "name" }, b.user ? displayName(b.user) : "Unknown user", h("span", { class: "muted small mono" }, ` ${b.device_id.slice(0, 8)}…`)),
        h("span", { class: "sub" }, [b.reason ? `“${b.reason}”` : null, fmtDateTime(b.created_at)].filter(Boolean).join(" · "))),
      h("button", { class: "btn", type: "button", on: { click: () => actions.req(T.ADMIN_DEVICE_BANS_REMOVE, { device_id: b.device_id }).then(refreshFullscreen, fail) } }, "Unban")));
  }
  add(el, devList);
}

// --- guilds (admin+) ------------------------------------------------------------------

async function guildsSection(el, actions) {
  const { guilds } = await actions.req(T.ADMIN_GUILDS_LIST);
  add(el, h("p", { class: "muted" }, "Every guild on this server. A ghost join lets you read a guild without its members seeing you; you can't post."));
  const list = h("div", { class: "list" });
  if (!guilds.length) add(list, h("p", { class: "muted" }, "No guilds yet."));
  for (const g of guilds) {
    const mine = state.guilds.get(g.guild_id);
    add(list, h("div", { class: "list-row" },
      h("div", { class: "guild-icon static", "aria-hidden": "true" }, initials(g.name)),
      h("span", { class: "meta" },
        h("span", { class: "name" }, g.name, g.listed ? h("span", { class: "tag" }, "LISTED") : null),
        h("span", { class: "sub" }, `Owner ${displayName(g.owner)} · ${g.member_count} member${g.member_count === 1 ? "" : "s"} · `,
          h("button", { class: "btn link mono", type: "button", title: "Copy guild ID", on: { click: () => copyText(g.guild_id, "Guild ID copied") } }, g.guild_id))),
      h("span", { class: "row" },
        mine ? h("button", { class: "btn", type: "button", on: { click: () => { closeFullscreen(); actions.openGuild(g.guild_id); } } }, mine.ghost ? "Open (ghost)" : "Open")
          : h("button", { class: "btn", type: "button", on: { click: async () => { try { await actions.ghostJoin(g.guild_id); closeFullscreen(); } catch (e) { fail(e); } } } }, "Ghost join"),
        h("button", {
          class: "btn danger", type: "button",
          on: {
            click: () => confirmModal({
              title: `Delete ${g.name}?`,
              message: "Every channel, message and role in it is deleted for everyone. This can't be undone.",
              confirmLabel: "Delete guild",
              onConfirm: async () => { await actions.req(T.ADMIN_GUILDS_DELETE, { guild_id: g.guild_id }); refreshFullscreen(); },
            }),
          },
        }, "Delete"))));
  }
  add(el, list);
}

// --- audit log ----------------------------------------------------------------------

const AUDIT_TEXT = {
  "user.status": (d) => (d.status === "active" ? "approved / enabled" : d.status === "disabled" ? "disabled" : d.status === "rejected" ? "rejected" : `set ${d.status}`),
  "user.reset_password": () => "reset the password of",
  "user.mute": (d) => (d.until ? "muted" : "unmuted"),
  "user.delete": () => "deleted the account of",
  "user.delete_self": () => "deleted their own account",
  "staff.set": (d) => (d.role === "none" ? "removed from staff" : `made ${d.role}`),
  "ip_ban.add": (d) => `banned IP ${d.cidr}`,
  "ip_ban.remove": (d) => `unbanned IP ${d.cidr}`,
  "device_ban.add": (d) => `banned ${d.devices} device${d.devices === 1 ? "" : "s"} of`,
  "device_ban.remove": () => "removed a device ban",
  "guild.delete": (d) => `deleted the guild ${d.name}`,
  "config.update": (d) => `changed server settings (${Object.keys(d).join(", ")})`,
  "legal.update": (d) => `updated ${(d.documents || []).join(" and ")}`,
};

async function auditSection(el, actions) {
  const box = h("div", { class: "list" });
  const more = h("button", { class: "btn", type: "button", hidden: true }, "Load more");
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
          h("span", { class: "sub" }, [fmtDateTime(e.created_at), d.reason ? `reason: ${d.reason}` : null, d.until && d.until !== "permanent" ? `until ${fmtDateTime(d.until)}` : d.until ? "indefinitely" : null].filter(Boolean).join(" · ")))));
      before = e.entry_id;
    }
    if (!box.children.length) add(box, h("p", { class: "muted" }, "Nothing has happened yet."));
    more.hidden = !res.has_more;
  };
  more.addEventListener("click", load);
  add(el, box, more);
  await load();
}
