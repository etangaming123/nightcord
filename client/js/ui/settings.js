// User Settings (full screen): account, profile, devices, appearance,
// notifications — plus the Admin panel for server staff (admin.js).

import { getPrefs, setPrefs } from "../prefs.js";
import { LIMITS, T } from "../protocol.js";
import { STAFF_LABEL, state } from "../state.js";
import { lockedReason, userCan } from "../perks.js";
import { MAX_THEME_COLORS, PRESETS, gradientCss, normalizeCustom } from "../themes.js";
import { adminSections } from "./admin.js";
import { add, avatar, clear, displayName, fmtDate, fmtDateTime, h } from "./dom.js";
import { pickImage, uploadImage } from "./images.js";
import { profileBanner, profileThemeAttrs } from "./names.js";
import { closeFullscreen, confirmModal, openFullscreen, refreshFullscreen, toast } from "./modals.js";

export function userSettings(actions, initial) {
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
      ...adminSections(actions),
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
        STAFF_LABEL[me.server_role] ? [h("dt", {}, "Role"), h("dd", {}, STAFF_LABEL[me.server_role])] : null)),
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
    me.is_server_owner ? null : h("h3", {}, "Delete account"),
    me.is_server_owner ? null : h("p", { class: "muted" }, "Your messages stay but show as “Deleted User”. Your profile, avatar and uploads are deleted, you leave every guild (guilds you own pass to their highest-ranked member) and your username becomes free."),
    me.is_server_owner ? null : h("div", {}, h("button", {
      class: "btn danger", type: "button",
      on: {
        click: () => confirmModal({
          title: "Delete your account?",
          message: `This can't be undone. Enter your password to delete ${me.username} on ${state.info?.server_name || "this server"}.`,
          confirmLabel: "Delete my account",
          fields: [h("label", {}, "Password", h("input", { name: "password", type: "password", required: true, autocomplete: "current-password" }))],
          onConfirm: async (fd) => {
            await actions.req(T.USER_DELETE, { password: fd.get("password") });
            closeFullscreen();
            actions.accountDeleted();
          },
        }),
      },
    }, "Delete account")),
  );
}

// --- Profile -----------------------------------------------------------------

export async function resizeAvatar(file) {
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

export const blobToBase64 = (blob) => new Promise((resolve, reject) => {
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
  const themeLocked = lockedReason("profile_colors");
  const bannerLocked = lockedReason("profile_banner");
  let themeOn = !!me.profile_colors;
  const theme1 = h("input", { type: "color", value: me.profile_colors?.[0] || "#5b21b6", "aria-label": "Profile colour, top" });
  const theme2 = h("input", { type: "color", value: me.profile_colors?.[1] || "#db2777", "aria-label": "Profile colour, bottom" });
  const drawPreview = () => {
    const fd = new FormData(form);
    const draft = {
      ...state.user,
      display_name: String(fd.get("display_name") || "").trim() || null,
      custom_status: String(fd.get("custom_status") || "").trim() || null,
      avatar_color: useColor ? colorInput.value : null,
      profile_colors: themeOn && !themeLocked ? [theme1.value, theme2.value] : null,
    };
    const attrs = profileThemeAttrs(draft, "profile-preview", { live: false });
    preview.className = attrs.class;
    preview.style.cssText = attrs.style || "";
    clear(preview,
      profileBanner(draft, { live: false }),
      h("div", { class: "profile-avatar" }, avatar(draft, { size: "xl", status: "online" })),
      h("div", { class: "profile-card" },
        h("div", { class: "profile-name" }, displayName(draft)),
        h("div", { class: "profile-username" }, draft.username),
        draft.custom_status ? h("div", { class: "profile-status" }, draft.custom_status) : null,
        String(fd.get("bio") || "").trim() ? h("div", { class: "profile-section" }, h("div", { class: "profile-section-title" }, "About me"), h("p", { class: "profile-bio" }, String(fd.get("bio")).trim())) : null));
  };
  const busy = async (btn, work, ok) => {
    btn.disabled = true;
    try {
      await work();
      if (ok) toast(ok);
      refreshFullscreen();
    } catch (e) {
      toast(e.message, { error: true });
    } finally {
      btn.disabled = false;
    }
  };
  const still = () => !userCan("animated_media");
  const changeAvatar = (e) => {
    const btn = e.currentTarget;
    pickImage((file) => busy(btn, async () => {
      const media = await uploadImage(file, "avatar", { still: still() });
      actions.setSelf((await actions.req(T.USER_AVATAR_SET, { media_id: media.media_id })).user);
    }, "Avatar updated"));
  };
  const changeBanner = (e) => {
    const btn = e.currentTarget;
    pickImage((file) => busy(btn, async () => {
      const media = await uploadImage(file, "banner", { still: still() });
      actions.setSelf((await actions.req(T.USER_UPDATE, { banner_media_id: media.media_id })).user);
    }, "Banner updated"));
  };
  add(form,
    h("div", { class: "avatar-edit" },
      avatar(me, { size: "xl" }),
      h("div", { class: "row" },
        h("button", { class: "btn primary", type: "button", on: { click: changeAvatar } }, "Change avatar"),
        me.avatar_id ? h("button", {
          class: "btn", type: "button",
          on: { click: (e) => busy(e.currentTarget, async () => actions.setSelf((await actions.req(T.USER_AVATAR_SET, { data_b64: null })).user)) },
        }, "Remove") : null),
      userCan("animated_media") ? h("p", { class: "muted small" }, "GIFs and animated WebPs stay animated.") : null),
    h("label", {}, "Display name", h("input", { name: "display_name", maxLength: LIMITS.DISPLAY_NAME_MAX, value: me.display_name || "", placeholder: me.username })),
    h("div", { class: "field" },
      h("span", { class: "field-label" }, "Profile banner"),
      bannerLocked
        ? h("div", { class: "locked-note" }, "🔒 ", bannerLocked)
        : h("div", { class: "row" },
          h("button", { class: "btn", type: "button", on: { click: changeBanner } }, me.banner_id ? "Change banner" : "Upload banner"),
          me.banner_id ? h("button", {
            class: "btn", type: "button",
            on: { click: (e) => busy(e.currentTarget, async () => actions.setSelf((await actions.req(T.USER_UPDATE, { banner_media_id: null })).user)) },
          }, "Remove") : null,
          h("span", { class: "muted small" }, "Wide images work best (5:2)."))),
    h("div", { class: "field" },
      h("span", { class: "field-label" }, "Banner colour"),
      h("div", { class: "row" }, colorInput,
        h("label", { class: "check" }, h("input", {
          type: "checkbox", checked: !useColor, class: "default-color",
          on: { change: (e) => { useColor = !e.currentTarget.checked; drawPreview(); } },
        }), "Default"))),
    h("div", { class: "field" },
      h("span", { class: "field-label" }, "Profile colours"),
      themeLocked
        ? h("div", { class: "locked-note" }, "🔒 ", themeLocked)
        : h("div", { class: "row" },
          h("label", { class: "check" }, h("input", {
            type: "checkbox", checked: themeOn, on: { change: (e) => { themeOn = e.currentTarget.checked; drawPreview(); } },
          }), "Use"),
          theme1, theme2, h("span", { class: "muted small" }, "Tints your whole profile card."))),
    h("label", {}, "Custom status", h("input", { name: "custom_status", maxLength: LIMITS.CUSTOM_STATUS_MAX, value: me.custom_status || "" })),
    h("label", {}, "About me", h("textarea", { name: "bio", rows: 3, maxLength: LIMITS.BIO_MAX }, me.bio || "")),
    h("div", {}, h("button", { class: "btn primary", type: "submit" }, "Save profile")),
  );
  colorInput.addEventListener("input", () => { useColor = true; form.querySelector(".default-color").checked = false; drawPreview(); });
  for (const input of [theme1, theme2]) input.addEventListener("input", () => { themeOn = true; form.querySelector(".check input:not(.default-color)").checked = true; drawPreview(); });
  form.addEventListener("input", drawPreview);
  formRow(form, async (fd) => {
    const patch = {
      display_name: String(fd.get("display_name")).trim() || null,
      bio: String(fd.get("bio")).trim() || null,
      custom_status: String(fd.get("custom_status")).trim() || null,
      avatar_color: useColor ? colorInput.value : null,
    };
    if (!themeLocked) patch.profile_colors = themeOn ? [theme1.value, theme2.value] : null;
    const res = await actions.req(T.USER_UPDATE, patch);
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
  const locked = lockedReason("client_themes");
  const presetCards = h("div", { class: "theme-cards", role: "group", "aria-label": "Theme presets" }, PRESETS.map((t) => {
    const swatch = t.id === "custom" ? gradientCss(normalizeCustom(p.customTheme)) : `linear-gradient(135deg, ${t.swatch[0]} 55%, ${t.swatch[1]} 55%)`;
    return h("button", {
      class: "theme-card", type: "button", "aria-pressed": String((p.themePreset || "default") === t.id), disabled: !!locked && t.id !== "default",
      on: { click: () => { setPrefs({ themePreset: t.id }); refreshFullscreen(); } },
    }, h("span", { class: "theme-swatch", style: `background:${swatch}` }), t.name);
  }));
  add(el,
    h("p", { class: "muted" }, "These settings apply to this browser only."),
    h("div", { class: "field" }, h("span", { class: "field-label" }, "Light or dark"),
      h("div", { class: "radio-row" },
        radio("theme", "dark", "Dark", p.theme, (v) => setPrefs({ theme: v })),
        radio("theme", "light", "Light", p.theme, (v) => setPrefs({ theme: v })),
        radio("theme", "system", "Sync with system", p.theme, (v) => setPrefs({ theme: v }))),
      p.themePreset && p.themePreset !== "default" && !locked ? h("span", { class: "muted small" }, "Themes pick their own light or dark look.") : null),
    h("div", { class: "field" }, h("span", { class: "field-label" }, "Theme"),
      locked ? h("div", { class: "locked-note" }, "🔒 ", locked) : null,
      presetCards),
    p.themePreset === "custom" && !locked ? themeEditor() : null,
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

// Custom gradient theme: 1-5 colours, angle, how strongly it shows, base and accent.
function themeEditor() {
  const c = normalizeCustom(getPrefs().customTheme);
  const box = h("div", { class: "theme-editor" });
  const save = (patch, redraw = false) => {
    Object.assign(c, patch);
    setPrefs({ customTheme: { ...c, colors: [...c.colors] } });
    preview.style.background = gradientCss(c);
    if (redraw) draw();
  };
  const preview = h("div", { class: "theme-preview", style: `background:${gradientCss(c)}` });
  const stops = h("div", { class: "theme-stops" });
  const drawStops = () => clear(stops,
    c.colors.map((color, i) => h("span", { class: "theme-stop" },
      h("input", { type: "color", value: color, "aria-label": `Colour ${i + 1}`, on: { input: (e) => { c.colors[i] = e.currentTarget.value; save({}); } } }),
      c.colors.length > 1 ? h("button", {
        class: "icon-btn", type: "button", title: "Remove colour", "aria-label": `Remove colour ${i + 1}`,
        on: { click: () => { c.colors.splice(i, 1); save({}, true); } },
      }, "✕") : null)),
    c.colors.length < MAX_THEME_COLORS ? h("button", {
      class: "btn", type: "button",
      on: { click: () => { c.colors.push(c.colors[c.colors.length - 1]); save({}, true); } },
    }, "+ Add colour") : null,
    h("span", { class: "muted small" }, `${c.colors.length} of ${MAX_THEME_COLORS}${c.colors.length === 1 ? " — one colour gives a flat tint" : ""}`));
  const accentOn = h("input", { type: "checkbox", checked: !c.accent });
  const accent = h("input", { type: "color", value: c.accent || c.colors[0], disabled: !c.accent, "aria-label": "Accent colour" });
  accentOn.addEventListener("change", () => { accent.disabled = accentOn.checked; save({ accent: accentOn.checked ? null : accent.value }); });
  accent.addEventListener("input", () => save({ accent: accent.value }));
  const draw = () => clear(box,
    drawStops() && null,
    preview,
    h("div", { class: "field" }, h("span", { class: "field-label" }, "Colours"), stops),
    h("label", {}, "Direction", h("input", { type: "range", min: 0, max: 359, value: c.angle, on: { input: (e) => save({ angle: Number(e.currentTarget.value) }) } })),
    h("label", {}, "Strength", h("input", { type: "range", min: 10, max: 90, value: c.strength, on: { input: (e) => save({ strength: Number(e.currentTarget.value) }) } }),
      h("span", { class: "muted small block" }, "How much of the gradient shows through the app.")),
    h("div", { class: "field" }, h("span", { class: "field-label" }, "Panels"),
      h("div", { class: "radio-row" },
        ...["dark", "light"].map((b) => h("label", { class: "radio-card" },
          h("input", { type: "radio", name: "theme-base", checked: c.base === b, on: { change: () => save({ base: b }) } }), b === "dark" ? "Dark" : "Light")))),
    h("div", { class: "field" }, h("span", { class: "field-label" }, "Accent"),
      h("div", { class: "row" }, h("label", { class: "check" }, accentOn, "Match first colour"), accent)));
  draw();
  return box;
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
