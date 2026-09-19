// User Settings (full screen): account, profile, devices, appearance,
// notifications — plus the server owner's Admin panel.

import { getPrefs, setPrefs } from "../prefs.js";
import { LIMITS, T } from "../protocol.js";
import { state } from "../state.js";
import { add, avatar, clear, displayName, fmtDate, fmtDateTime, h, initials } from "./dom.js";
import { closeFullscreen, confirmModal, openFullscreen, openModal, refreshFullscreen, toast } from "./modals.js";
import { copyText } from "./profile.js";

export function userSettings(actions, initial) {
  const owner = state.user?.is_server_owner;
  openFullscreen({
    title: "User settings",
    initial,
    sections: [
      { heading: "User settings" },
      { id: "account", label: "My Account", render: (el) => account(el, actions) },
      { id: "profile", label: "Profile", render: (el) => profile(el, actions) },
      { id: "devices", label: "Devices", render: (el) => devices(el, actions) },
      { heading: "App settings" },
      { id: "appearance", label: "Appearance", render: appearance },
      { id: "notifications", label: "Notifications", render: notifications },
      owner ? { heading: "Server admin" } : null,
      owner ? { id: "server", label: "Server", render: (el) => serverSection(el, actions) } : null,
      owner ? { id: "accounts", label: "Accounts", badge: state.pendingAccounts, render: (el) => accountsSection(el, actions) } : null,
      owner ? { id: "guilds", label: "Guilds", render: (el) => guildsSection(el, actions) } : null,
      { separator: true },
      { label: "Log out", danger: true, onClick: () => { closeFullscreen(); actions.logout(); } },
    ],
  });
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

// --- My Account --------------------------------------------------------------

function account(el, actions) {
  const me = state.user;
  add(el,
    h("div", { class: "account-card" },
      h("div", { class: "profile-banner", style: `background:${me.avatar_color || "var(--accent)"}` }),
      h("div", { class: "account-row" },
        avatar(me, { size: "xl" }),
        h("div", { class: "meta" }, h("div", { class: "profile-name" }, displayName(me)), h("div", { class: "muted" }, me.username)),
        h("button", { class: "btn primary", type: "button", on: { click: () => userSettings(actions, "profile") } }, "Edit profile")),
      h("dl", { class: "facts" },
        h("dt", {}, "Username"), h("dd", {}, me.username),
        h("dt", {}, "Member since"), h("dd", {}, fmtDate(me.created_at)),
        h("dt", {}, "Server"), h("dd", {}, state.info?.server_name || ""),
        me.is_server_owner ? [h("dt", {}, "Role"), h("dd", {}, "Server owner")] : null)),
    h("h3", {}, "Password"),
    formRow(h("form", { class: "stack narrow" },
      h("label", {}, "Current password", h("input", { name: "current", type: "password", required: true, autocomplete: "current-password" })),
      h("label", {}, "New password", h("input", { name: "new", type: "password", required: true, minLength: LIMITS.PASSWORD_MIN_BYTES, autocomplete: "new-password" })),
      h("label", {}, "Confirm new password", h("input", { name: "confirm", type: "password", required: true, autocomplete: "new-password" })),
      h("p", { class: "muted small" }, "Changing your password logs you out everywhere else."),
      h("div", {}, h("button", { class: "btn primary", type: "submit" }, "Change password"))),
    async (fd) => {
      if (fd.get("new") !== fd.get("confirm")) throw new Error("The new passwords don't match.");
      if (new TextEncoder().encode(String(fd.get("new"))).length > LIMITS.PASSWORD_MAX_BYTES) throw new Error("Password must be at most 72 bytes.");
      await actions.req(T.USER_PASSWORD_CHANGE, { current_password: fd.get("current"), new_password: fd.get("new") });
      el.querySelector("form").reset();
    }, { okText: "Password changed" }),
  );
}

// --- Profile -----------------------------------------------------------------

async function resizeAvatar(file) {
  const bitmap = await createImageBitmap(file);
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const s = Math.min(bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, (bitmap.width - s) / 2, (bitmap.height - s) / 2, s, s, 0, 0, size, size);
  const toBlob = (type, q) => new Promise((resolve) => canvas.toBlob(resolve, type, q));
  for (const type of ["image/webp", "image/jpeg"]) {
    for (const q of [0.9, 0.8, 0.65, 0.5, 0.35]) {
      const blob = await toBlob(type, q);
      if (!blob || blob.type !== type) break; // this browser can't encode it
      if (blob.size <= LIMITS.AVATAR_MAX_BYTES) return blob;
    }
  }
  throw new Error("Couldn't shrink that image enough; try a simpler one.");
}

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

function profile(el, actions) {
  const me = state.user;
  const preview = h("div", { class: "profile-preview" });
  const form = h("form", { class: "stack narrow" });
  const colorInput = h("input", { type: "color", name: "avatar_color", value: me.avatar_color || "#7aa2f7" });
  let useColor = !!me.avatar_color;
  const drawPreview = () => {
    const fd = new FormData(form);
    const draft = {
      ...state.user,
      display_name: String(fd.get("display_name") || "").trim() || null,
      custom_status: String(fd.get("custom_status") || "").trim() || null,
      avatar_color: useColor ? colorInput.value : null,
    };
    clear(preview,
      h("div", { class: "profile-banner", style: `background:${draft.avatar_color || "var(--accent)"}` }),
      h("div", { class: "profile-avatar" }, avatar(draft, { size: "xl", status: "online" })),
      h("div", { class: "profile-card" },
        h("div", { class: "profile-name" }, displayName(draft)),
        h("div", { class: "profile-username" }, draft.username),
        draft.custom_status ? h("div", { class: "profile-status" }, draft.custom_status) : null,
        String(fd.get("bio") || "").trim() ? h("div", { class: "profile-section" }, h("div", { class: "profile-section-title" }, "About me"), h("p", { class: "profile-bio" }, String(fd.get("bio")).trim())) : null));
  };
  const fileInput = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", hidden: true });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    try {
      const blob = await resizeAvatar(file);
      const res = await actions.req(T.USER_AVATAR_SET, { data_b64: await blobToBase64(blob) });
      actions.setSelf(res.user);
      toast("Avatar updated");
      refreshFullscreen();
    } catch (e) {
      toast(e.message, { error: true });
    }
  });
  add(form,
    h("div", { class: "avatar-edit" },
      avatar(me, { size: "xl" }),
      h("div", { class: "row" },
        h("button", { class: "btn primary", type: "button", on: { click: () => fileInput.click() } }, "Change avatar"),
        me.avatar_id ? h("button", {
          class: "btn", type: "button",
          on: { click: async () => { try { actions.setSelf((await actions.req(T.USER_AVATAR_SET, { data_b64: null })).user); refreshFullscreen(); } catch (e) { toast(e.message, { error: true }); } } },
        }, "Remove") : null),
      fileInput),
    h("label", {}, "Display name", h("input", { name: "display_name", maxLength: LIMITS.DISPLAY_NAME_MAX, value: me.display_name || "", placeholder: me.username })),
    h("div", { class: "field" },
      h("span", { class: "field-label" }, "Profile color"),
      h("div", { class: "row" }, colorInput,
        h("label", { class: "check" }, h("input", {
          type: "checkbox", checked: !useColor,
          on: { change: (e) => { useColor = !e.currentTarget.checked; drawPreview(); } },
        }), "Default"))),
    h("label", {}, "Custom status", h("input", { name: "custom_status", maxLength: LIMITS.CUSTOM_STATUS_MAX, value: me.custom_status || "" })),
    h("label", {}, "About me", h("textarea", { name: "bio", rows: 3, maxLength: LIMITS.BIO_MAX }, me.bio || "")),
    h("div", {}, h("button", { class: "btn primary", type: "submit" }, "Save profile")),
  );
  colorInput.addEventListener("input", () => { useColor = true; form.querySelector(".check input").checked = false; drawPreview(); });
  form.addEventListener("input", drawPreview);
  formRow(form, async (fd) => {
    const res = await actions.req(T.USER_UPDATE, {
      display_name: String(fd.get("display_name")).trim() || null,
      bio: String(fd.get("bio")).trim() || null,
      custom_status: String(fd.get("custom_status")).trim() || null,
      avatar_color: useColor ? colorInput.value : null,
    });
    actions.setSelf(res.user);
  }, { okText: "Profile saved" });
  add(el, h("div", { class: "split" }, form, h("div", {}, h("div", { class: "field-label" }, "Preview"), preview)));
  drawPreview();
}

// --- Devices -----------------------------------------------------------------

function describeAgent(ua) {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /python|aiohttp/i.test(ua) ? "Script" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

async function devices(el, actions) {
  const { sessions } = await actions.req(T.USER_SESSIONS_LIST);
  add(el, h("p", { class: "muted" }, "Everywhere you're logged in. Log out anything you don't recognise."));
  const list = h("div", { class: "list" });
  for (const s of sessions) {
    add(list, h("div", { class: "list-row" },
      h("span", { class: "list-icon", "aria-hidden": "true" }, "💻"),
      h("span", { class: "meta" },
        h("span", { class: "name" }, describeAgent(s.user_agent), s.current ? h("span", { class: "tag ok" }, "THIS DEVICE") : null),
        h("span", { class: "sub" }, `Last active ${fmtDateTime(s.last_seen)} · signed in ${fmtDate(s.created_at)}`)),
      s.current ? null : h("button", {
        class: "btn", type: "button",
        on: { click: async () => { await actions.req(T.USER_SESSIONS_REVOKE, { session_id: s.session_id }); refreshFullscreen(); } },
      }, "Log out")));
  }
  add(el, list);
  if (sessions.length > 1) {
    add(el, h("button", {
      class: "btn danger", type: "button",
      on: { click: async () => { await actions.req(T.USER_SESSIONS_REVOKE, { session_id: "others" }); toast("Logged out of all other devices"); refreshFullscreen(); } },
    }, "Log out all other devices"));
  }
}

// --- Appearance & notifications (this device) -------------------------------

function appearance(el) {
  const p = getPrefs();
  const radio = (name, value, label, current, onChange) => h("label", { class: "radio-card" },
    h("input", { type: "radio", name, value, checked: current === value, on: { change: () => onChange(value) } }), label);
  add(el,
    h("p", { class: "muted" }, "These settings apply to this browser only."),
    h("div", { class: "field" }, h("span", { class: "field-label" }, "Theme"),
      h("div", { class: "radio-row" },
        radio("theme", "dark", "Dark", p.theme, (v) => setPrefs({ theme: v })),
        radio("theme", "light", "Light", p.theme, (v) => setPrefs({ theme: v })),
        radio("theme", "system", "Sync with system", p.theme, (v) => setPrefs({ theme: v })))),
    h("label", {}, `Chat font size`,
      h("input", {
        type: "range", min: 12, max: 20, step: 1, value: p.fontSize,
        on: { input: (e) => setPrefs({ fontSize: Number(e.currentTarget.value) }) },
      })),
    h("label", { class: "check" }, h("input", {
      type: "checkbox", checked: p.compact, on: { change: (e) => setPrefs({ compact: e.currentTarget.checked }) },
    }), "Compact message layout"),
  );
}

function notifications(el) {
  const p = getPrefs();
  const supported = "Notification" in window;
  const perm = supported ? Notification.permission : "unsupported";
  const desktop = h("input", {
    type: "checkbox", checked: p.desktopNotifications && perm === "granted", disabled: !supported || perm === "denied",
    on: {
      change: async (e) => {
        const box = e.currentTarget;
        if (box.checked && Notification.permission !== "granted") {
          const result = await Notification.requestPermission();
          if (result !== "granted") { box.checked = false; toast("Notifications are blocked by the browser", { error: true }); refreshFullscreen(); return; }
        }
        setPrefs({ desktopNotifications: box.checked });
      },
    },
  });
  add(el,
    h("p", { class: "muted" }, "These settings apply to this browser only. Per-guild and per-channel notification levels and mutes are in the guild and channel menus, and sync across your devices."),
    h("label", { class: "check" }, desktop, h("span", {}, "Desktop notifications",
      h("span", { class: "muted small block" },
        perm === "denied" ? "Blocked in your browser's site settings." : perm === "unsupported" ? "Not supported in this browser." : "Shown when Nightcord isn't focused."))),
    h("label", { class: "check" }, h("input", {
      type: "checkbox", checked: p.sound, on: { change: (e) => setPrefs({ sound: e.currentTarget.checked }) },
    }), "Play a sound for new notifications"),
    h("p", { class: "muted small" }, "Do Not Disturb mutes all notifications."),
  );
}

// --- Server admin ------------------------------------------------------------

function serverSection(el, actions) {
  const info = state.info;
  const select = (name, value, options) =>
    h("select", { name }, options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)));
  add(el, formRow(h("form", { class: "stack narrow" },
    h("label", {}, "Server name", h("input", { name: "server_name", required: true, maxLength: LIMITS.SERVER_NAME_MAX, value: info.server_name })),
    h("label", {}, "Account creation", select("account_creation", info.account_creation, [
      ["on", "Open: anyone can register"],
      ["request", "By request: you approve new accounts"],
      ["off", "Closed"],
    ])),
    h("label", {}, "Guild creation", select("guild_creation", info.guild_creation, [
      ["on", "Anyone can create guilds"],
      ["off", "Only the server owner"],
    ])),
    h("label", { class: "check" }, h("input", { type: "checkbox", name: "guild_list_visible", checked: info.guild_list_visible }), "Allow a public guild directory"),
    h("div", {}, h("button", { class: "btn primary", type: "submit" }, "Save"))),
  async (fd) => {
    const res = await actions.req(T.SERVER_CONFIG_UPDATE, {
      server_name: String(fd.get("server_name")).trim(),
      account_creation: fd.get("account_creation"),
      guild_creation: fd.get("guild_creation"),
      guild_list_visible: fd.get("guild_list_visible") === "on",
    });
    actions.setServerInfo(res.config);
  }, { okText: "Server settings saved" }));
}

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
  add(el, h("div", { class: "row wrap" }, tabs, search), list);
  await draw();
}

function accountRow(u, actions, redraw) {
  const act = (label, status, cls = "") => h("button", {
    class: `btn ${cls}`, type: "button",
    on: { click: async () => { try { await actions.req(T.ADMIN_USERS_SET_STATUS, { user_id: u.user_id, status }); await redraw(); } catch (e) { toast(e.message, { error: true }); } } },
  }, label);
  const buttons = [];
  if (u.is_server_owner) buttons.push(h("span", { class: "tag" }, "SERVER OWNER"));
  else if (u.status === "pending") buttons.push(act("Approve", "active", "primary"), act("Reject", "rejected"));
  else if (u.status === "active") {
    buttons.push(
      h("button", {
        class: "btn", type: "button",
        on: {
          click: () => confirmModal({
            title: `Reset ${u.username}'s password?`,
            message: "They'll be logged out everywhere. You'll see the new password once.",
            confirmLabel: "Reset password",
            onConfirm: async () => {
              const { password } = await actions.req(T.ADMIN_USERS_RESET_PASSWORD, { user_id: u.user_id });
              setTimeout(() => openModal({
                title: "New password",
                subtitle: `Give this to ${u.username}. It won't be shown again.`,
                content: h("div", { class: "row" }, h("div", { class: "code-display" }, password),
                  h("button", { class: "btn", type: "button", on: { click: () => copyText(password, "Password copied") } }, "Copy")),
              }));
            },
          }),
        },
      }, "Reset password"),
      act("Disable", "disabled", "danger"));
  } else if (u.status === "disabled") buttons.push(act("Enable", "active"));
  else if (u.status === "rejected") buttons.push(h("span", { class: "muted small" }, "Rejected"));
  return h("div", { class: "list-row" },
    avatar(u, { size: "sm" }),
    h("span", { class: "meta" },
      h("span", { class: "name" }, displayName(u), u.display_name ? h("span", { class: "muted small" }, ` ${u.username}`) : null,
        u.status !== "active" ? h("span", { class: `tag ${u.status}` }, u.status.toUpperCase()) : null),
      h("span", { class: "sub" }, `Joined ${fmtDate(u.created_at)}${u.note ? ` · “${u.note}”` : ""}`)),
    h("span", { class: "row" }, buttons));
}

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
          : h("button", { class: "btn", type: "button", on: { click: async () => { try { await actions.ghostJoin(g.guild_id); closeFullscreen(); } catch (e) { toast(e.message, { error: true }); } } } }, "Ghost join"),
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
