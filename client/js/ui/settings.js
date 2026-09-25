// User Settings (full screen): account, profile, devices, appearance,
// notifications — plus the Admin panel for server staff (admin.js).

import { getPrefs, setPrefs } from "../prefs.js";
import { LIMITS, T } from "../protocol.js";
import { STAFF_LABEL, state } from "../state.js";
import { lockedReason, userCan } from "../perks.js";
import { MAX_THEME_COLORS, PRESETS, gradientCss, normalizeCustom } from "../themes.js";
import { adminSections } from "./admin.js";
import { add, avatar, clear, displayName, fmtDate, fmtDateTime, fmtSeen, h } from "./dom.js";
import { cropImage } from "./cropper.js";
import { pickImage, uploadImage } from "./images.js";
import { renderInline } from "./markdown.js";
import { untrustDomain } from "./links.js";
import { profileBanner, profileThemeAttrs } from "./names.js";
import { closeFullscreen, confirmAction, confirmModal, openFullscreen, refreshFullscreen, toast } from "./modals.js";
import { scopedT } from "../strings.js";
import { icon } from "./icons.js";

const t = scopedT("ui/settings");
const tl = scopedT("ui/links");

// Profile toggles that aren't form controls, so a redraw (after an avatar or
// banner upload) can't read them back off the page. Cleared when the settings
// page is opened afresh or the profile is saved.
let profileDraft = null;

export function userSettings(actions, initial) {
  profileDraft = null;
  openFullscreen({
    title: t("title_user_settings"),
    initial,
    sections: [
      { heading: t("title_user_settings") },
      { id: "account", label: t("section_my_account"), render: (el) => account(el, actions) },
      { id: "profile", label: t("section_profile"), render: (el) => profile(el, actions) },
      { id: "privacy", label: t("section_privacy"), render: (el) => privacy(el, actions) },
      { id: "devices", label: t("section_devices"), render: (el) => devices(el, actions) },
      { heading: t("heading_app_settings") },
      { id: "appearance", label: t("section_appearance"), render: (el) => appearance(el, actions) },
      { id: "notifications", label: t("section_notifications"), render: (el) => notifications(el, actions) },
      globalThis.__NIGHTCORD_BUILD_VERSION__
        ? { id: "local-options", label: t("section_local_options"), render: localOptions }
        : null,
      ...adminSections(actions),
      { separator: true },
      { label: t("log_out"), danger: true, onClick: () => { closeFullscreen(); actions.logout(); } },
    ],
  });
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

// --- Privacy (PROTOCOL.md §5 Message requests) ---------------------------------

function privacy(el, actions) {
  const current = state.user.dm_privacy || "requests";
  const options = [
    ["everyone", t("dm_privacy_everyone"), t("dm_privacy_everyone_hint")],
    ["requests", t("dm_privacy_requests"), t("dm_privacy_requests_hint")],
    ["friends", t("dm_privacy_friends"), t("dm_privacy_friends_hint")],
  ];
  const save = async (value) => {
    try {
      actions.setSelf((await actions.req(T.USER_UPDATE, { dm_privacy: value })).user);
      toast(t("saved"));
    } catch (e) {
      toast(e.message, { error: true });
    }
  };
  const blocked = [...state.relationships.values()].filter((r) => r.kind === "blocked");
  add(el,
    h("fieldset", { class: "radio-cards narrow" }, h("legend", {}, t("dm_privacy_legend")),
      options.map(([v, label, hint]) => h("label", { class: "radio-card" },
        h("input", { type: "radio", name: "dm_privacy", value: v, checked: current === v, on: { change: () => save(v) } }),
        h("span", {}, h("strong", {}, label), h("span", { class: "muted small block" }, hint))))),
    h("p", { class: "muted small" }, t("dm_privacy_note")),
    trustedDomainList(),
    h("div", { class: "section-label" }, t("blocked_heading", { count: blocked.length })),
    blocked.length
      ? h("div", { class: "list" }, blocked.map((r) => h("div", { class: "list-row" },
        avatar(r.user, { size: "sm" }),
        h("span", { class: "grow" }, displayName(r.user), " ", h("span", { class: "muted small" }, r.user.username)),
        h("button", { class: "btn small", type: "button", on: { click: async () => { await actions.unblockUser(r.user.user_id); refreshFullscreen(); } } }, t("unblock")))))
      : h("p", { class: "muted small" }, t("blocked_none")));
}

// Link domains this device stops asking about (ui/links.js).
function trustedDomainList() {
  const domains = getPrefs().trustedDomains || [];
  return h("div", {},
    h("div", { class: "section-label" }, tl("trusted_heading")),
    h("p", { class: "muted small" }, tl("trusted_note")),
    domains.length
      ? h("div", { class: "list" }, domains.map((d) => h("div", { class: "list-row" },
        h("span", { class: "list-icon", "aria-hidden": "true" }, icon("link")),
        h("span", { class: "grow mono" }, d),
        h("button", {
          class: "btn small", type: "button",
          on: {
            click: (e) => confirmAction(e, {
              title: tl("forget_domain_title", { host: d }),
              message: tl("forget_domain_body"),
              confirmLabel: tl("forget_domain", { host: d }),
              onConfirm: () => { untrustDomain(d); refreshFullscreen(); },
            }),
          },
        }, t("remove")))))
      : h("p", { class: "muted small" }, tl("trusted_none")));
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
        h("button", { class: "btn primary", type: "button", on: { click: () => userSettings(actions, "profile") } }, t("edit_profile"))),
      h("dl", { class: "facts" },
        h("dt", {}, t("username_label")), h("dd", {}, me.username),
        h("dt", {}, t("member_since_label")), h("dd", {}, fmtDate(me.created_at)),
        h("dt", {}, t("server_label")), h("dd", {}, state.info?.server_name || ""),
        STAFF_LABEL[me.server_role] ? [h("dt", {}, t("role_label")), h("dd", {}, STAFF_LABEL[me.server_role])] : null)),
    h("h3", {}, t("password_heading")),
    formRow(h("form", { class: "stack narrow" },
      h("label", {}, t("current_password_label"), h("input", { name: "current", type: "password", required: true, autocomplete: "current-password" })),
      h("label", {}, t("new_password_label"), h("input", { name: "new", type: "password", required: true, minLength: LIMITS.PASSWORD_MIN_BYTES, autocomplete: "new-password" })),
      h("label", {}, t("confirm_new_password_label"), h("input", { name: "confirm", type: "password", required: true, autocomplete: "new-password" })),
      h("p", { class: "muted small" }, t("password_change_note")),
      h("div", {}, h("button", { class: "btn primary", type: "submit" }, t("change_password_button")))),
    async (fd) => {
      if (fd.get("new") !== fd.get("confirm")) throw new Error(t("passwords_dont_match"));
      if (new TextEncoder().encode(String(fd.get("new"))).length > LIMITS.PASSWORD_MAX_BYTES) throw new Error(t("password_too_long"));
      await actions.req(T.USER_PASSWORD_CHANGE, { current_password: fd.get("current"), new_password: fd.get("new") });
      el.querySelector("form").reset();
    }, { okText: t("password_changed") }),
    me.is_server_owner ? null : h("h3", {}, t("delete_account_heading")),
    me.is_server_owner ? null : h("p", { class: "muted" }, t("delete_account_description")),
    me.is_server_owner ? null : h("div", {}, h("button", {
      class: "btn danger", type: "button",
      on: {
        click: () => confirmModal({
          title: t("delete_account_title"),
          message: t("delete_account_message", { username: me.username, server: state.info?.server_name || t("this_server_fallback") }),
          confirmLabel: t("delete_my_account"),
          fields: [h("label", {}, t("password_field_label"), h("input", { name: "password", type: "password", required: true, autocomplete: "current-password" }))],
          onConfirm: async (fd) => {
            await actions.req(T.USER_DELETE, { password: fd.get("password") });
            closeFullscreen();
            actions.accountDeleted();
          },
        }),
      },
    }, t("delete_account_button"))),
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
  throw new Error(t("avatar_shrink_failed"));
}

export const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

function profile(el, actions) {
  const me = state.user;
  profileDraft ??= { useColor: !!me.avatar_color, themeOn: !!me.profile_colors };
  const draft = profileDraft;
  const preview = h("div", { class: "profile-preview" });
  const form = h("form", { class: "stack narrow" });
  const colorInput = h("input", { type: "color", name: "avatar_color", value: me.avatar_color || "#884499" });
  const themeLocked = lockedReason("profile_colors");
  const bannerLocked = lockedReason("profile_banner");
  const theme1 = h("input", { type: "color", name: "profile_color_1", value: me.profile_colors?.[0] || "#5b21b6", "aria-label": t("profile_colour_top") });
  const theme2 = h("input", { type: "color", name: "profile_color_2", value: me.profile_colors?.[1] || "#db2777", "aria-label": t("profile_colour_bottom") });
  const drawPreview = () => {
    const fd = new FormData(form);
    const shown = {
      ...state.user,
      display_name: String(fd.get("display_name") || "").trim() || null,
      custom_status: String(fd.get("custom_status") || "").trim() || null,
      avatar_color: draft.useColor ? colorInput.value : null,
      profile_colors: draft.themeOn && !themeLocked ? [theme1.value, theme2.value] : null,
    };
    const attrs = profileThemeAttrs(shown, "profile-preview", { live: false });
    preview.className = attrs.class;
    preview.style.cssText = attrs.style || "";
    clear(preview,
      profileBanner(shown, { live: false }),
      h("div", { class: "profile-avatar" }, avatar(shown, { size: "xl", status: "online" })),
      h("div", { class: "profile-card" },
        h("div", { class: "profile-name" }, displayName(shown)),
        h("div", { class: "profile-username" }, shown.username),
        shown.custom_status ? h("div", { class: "profile-status" }, shown.custom_status) : null,
        String(fd.get("bio") || "").trim()
          ? h("div", { class: "profile-section" }, h("div", { class: "profile-section-title" }, t("about_me_label")),
            h("p", { class: "profile-bio" }, renderInline(String(fd.get("bio")).trim(), { user: () => null })))
          : null));
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
    pickImage(async (file) => {
      const cropped = await cropImage(file, "avatar", { allowAnimated: !still() });
      if (!cropped) return;
      busy(btn, async () => {
        const media = await uploadImage(cropped, "avatar", { still: still() });
        actions.setSelf((await actions.req(T.USER_AVATAR_SET, { media_id: media.media_id })).user);
      }, t("avatar_updated"));
    });
  };
  const changeBanner = (e) => {
    const btn = e.currentTarget;
    pickImage(async (file) => {
      const cropped = await cropImage(file, "banner", { allowAnimated: !still() });
      if (!cropped) return;
      busy(btn, async () => {
        const media = await uploadImage(cropped, "banner", { still: still() });
        actions.setSelf((await actions.req(T.USER_UPDATE, { banner_media_id: media.media_id })).user);
      }, t("banner_updated"));
    });
  };
  add(form,
    h("div", { class: "avatar-edit" },
      avatar(me, { size: "xl" }),
      h("div", { class: "row" },
        h("button", { class: "btn primary", type: "button", on: { click: changeAvatar } }, t("change_avatar")),
        me.avatar_id ? h("button", {
          class: "btn", type: "button",
          on: {
            click: (e) => confirmAction(e, {
              title: t("remove_avatar_title"),
              message: t("remove_avatar_body"),
              confirmLabel: t("remove"),
              onConfirm: () => busy(e.currentTarget, async () => actions.setSelf((await actions.req(T.USER_AVATAR_SET, { data_b64: null })).user)),
            }),
          },
        }, t("remove")) : null),
      userCan("animated_media") ? h("p", { class: "muted small" }, t("animated_avatar_note")) : null),
    h("label", {}, t("display_name_label"), h("input", { name: "display_name", maxLength: LIMITS.DISPLAY_NAME_MAX, value: me.display_name || "", placeholder: me.username })),
    h("div", { class: "field" },
      h("span", { class: "field-label" }, t("profile_banner_label")),
      bannerLocked
        ? h("div", { class: "locked-note" }, icon("lock"), " ", bannerLocked)
        : h("div", { class: "row" },
          h("button", { class: "btn", type: "button", on: { click: changeBanner } }, me.banner_id ? t("change_banner") : t("upload_banner")),
          me.banner_id ? h("button", {
            class: "btn", type: "button",
            on: {
              click: (e) => confirmAction(e, {
                title: t("remove_banner_title"),
                message: t("remove_banner_body"),
                confirmLabel: t("remove"),
                onConfirm: () => busy(e.currentTarget, async () => actions.setSelf((await actions.req(T.USER_UPDATE, { banner_media_id: null })).user)),
              }),
            },
          }, t("remove")) : null,
          h("span", { class: "muted small" }, t("wide_images_note")))),
    h("div", { class: "field" },
      h("span", { class: "field-label" }, t("banner_colour_label")),
      h("div", { class: "row" }, colorInput,
        h("label", { class: "check" }, h("input", {
          type: "checkbox", checked: !draft.useColor, class: "default-color",
          on: { change: (e) => { draft.useColor = !e.currentTarget.checked; drawPreview(); } },
        }), t("default_checkbox")))),
    h("div", { class: "field" },
      h("span", { class: "field-label" }, t("profile_colours_label")),
      themeLocked
        ? h("div", { class: "locked-note" }, icon("lock"), " ", themeLocked)
        : h("div", { class: "row" },
          h("label", { class: "check" }, h("input", {
            type: "checkbox", checked: draft.themeOn, on: { change: (e) => { draft.themeOn = e.currentTarget.checked; drawPreview(); } },
          }), t("use_checkbox")),
          theme1, theme2, h("span", { class: "muted small" }, t("profile_colours_note")))),
    h("label", {}, t("custom_status_label"), h("input", { name: "custom_status", maxLength: LIMITS.CUSTOM_STATUS_MAX, value: me.custom_status || "" })),
    h("label", {}, t("about_me_label"), h("textarea", { name: "bio", rows: 3, maxLength: LIMITS.BIO_MAX }, me.bio || "")),
    h("div", {}, h("button", { class: "btn primary", type: "submit" }, t("save_profile"))),
  );
  colorInput.addEventListener("input", () => { draft.useColor = true; form.querySelector(".default-color").checked = false; drawPreview(); });
  for (const input of [theme1, theme2]) {
    input.addEventListener("input", () => {
      draft.themeOn = true;
      const box = form.querySelector(".check input:not(.default-color)");
      if (box) box.checked = true;
      drawPreview();
    });
  }
  form.addEventListener("input", drawPreview);
  formRow(form, async (fd) => {
    const patch = {
      display_name: String(fd.get("display_name")).trim() || null,
      bio: String(fd.get("bio")).trim() || null,
      custom_status: String(fd.get("custom_status")).trim() || null,
      avatar_color: draft.useColor ? colorInput.value : null,
    };
    if (!themeLocked) patch.profile_colors = draft.themeOn ? [theme1.value, theme2.value] : null;
    const res = await actions.req(T.USER_UPDATE, patch);
    profileDraft = null;
    actions.setSelf(res.user);
  }, { okText: t("profile_saved") });
  add(el, h("div", { class: "split" }, form, h("div", {}, h("div", { class: "field-label" }, t("preview_label")), preview)));
  drawPreview();
}

// --- Devices -----------------------------------------------------------------

function describeAgent(ua) {
  if (!ua) return t("unknown_device");
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /python|aiohttp/i.test(ua) ? t("script_fallback") : t("browser_fallback");
  const os = /Windows/.test(ua) ? "Windows" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

async function devices(el, actions) {
  const { sessions } = await actions.req(T.USER_SESSIONS_LIST);
  add(el, h("p", { class: "muted" }, t("devices_intro")));
  const list = h("div", { class: "list" });
  for (const s of sessions) {
    add(list, h("div", { class: "list-row" },
      h("span", { class: "list-icon", "aria-hidden": "true" }, icon("laptop")),
      h("span", { class: "meta" },
        h("span", { class: "name" }, describeAgent(s.user_agent), s.current ? h("span", { class: "tag ok" }, t("this_device_tag")) : null),
        h("span", { class: "sub" }, t("device_last_active", { lastActive: fmtSeen(s.last_seen, getPrefs().lastSeenFormat), signedIn: fmtDate(s.created_at) }))),
      s.current ? null : h("button", {
        class: "btn", type: "button",
        on: {
          click: (e) => confirmAction(e, {
            title: t("log_out_device_title"),
            message: t("log_out_device_body", { device: describeAgent(s.user_agent) }),
            confirmLabel: t("log_out"),
            onConfirm: async () => {
              try {
                await actions.req(T.USER_SESSIONS_REVOKE, { session_id: s.session_id });
                refreshFullscreen();
              } catch (err) {
                toast(err.message, { error: true });
              }
            },
          }),
        },
      }, t("log_out"))));
  }
  add(el, list);
  if (sessions.length > 1) {
    add(el, h("button", {
      class: "btn danger", type: "button",
      on: {
        click: (e) => confirmAction(e, {
          title: t("log_out_all_title"),
          message: t("log_out_all_body", { count: sessions.length - 1 }),
          confirmLabel: t("log_out_all_other_devices"),
          onConfirm: async () => {
            try {
              await actions.req(T.USER_SESSIONS_REVOKE, { session_id: "others" });
              toast(t("logged_out_other_devices"));
              refreshFullscreen();
            } catch (err) {
              toast(err.message, { error: true });
            }
          },
        }),
      },
    }, t("log_out_all_other_devices")));
  }
}

// --- Appearance & notifications (this device) -------------------------------

function appearance(el, actions) {
  const p = getPrefs();
  const radio = (name, value, label, current, onChange) => h("label", { class: "radio-card" },
    h("input", { type: "radio", name, value, checked: current === value, on: { change: () => onChange(value) } }), label);
  const locked = lockedReason("client_themes");
  const presetCards = h("div", { class: "theme-cards", role: "group", "aria-label": t("theme_presets_aria") }, PRESETS.map((theme) => {
    const swatch = theme.id === "custom" ? gradientCss(normalizeCustom(p.customTheme)) : `linear-gradient(135deg, ${theme.swatch[0]} 55%, ${theme.swatch[1]} 55%)`;
    return h("button", {
      class: "theme-card", type: "button", "aria-pressed": String((p.themePreset || "default") === theme.id), disabled: !!locked && theme.id !== "default",
      on: { click: () => { setPrefs({ themePreset: theme.id }); refreshFullscreen(); } },
    }, h("span", { class: "theme-swatch", style: `background:${swatch}` }), theme.name);
  }));
  add(el,
    h("p", { class: "muted" }, t("browser_only_note")),
    h("div", { class: "field" }, h("span", { class: "field-label" }, t("light_or_dark_label")),
      h("div", { class: "radio-row" },
        radio("theme", "dark", t("theme_dark"), p.theme, (v) => setPrefs({ theme: v })),
        radio("theme", "light", t("theme_light"), p.theme, (v) => setPrefs({ theme: v })),
        radio("theme", "system", t("theme_sync_system"), p.theme, (v) => setPrefs({ theme: v }))),
      p.themePreset && p.themePreset !== "default" && !locked ? h("span", { class: "muted small" }, t("theme_own_look_note")) : null),
    h("div", { class: "field" }, h("span", { class: "field-label" }, t("theme_label")),
      locked ? h("div", { class: "locked-note" }, icon("lock"), " ", locked) : null,
      presetCards),
    p.themePreset === "custom" && !locked ? themeEditor() : null,
    h("label", {}, t("chat_font_size_label"),
      h("input", {
        type: "range", min: 12, max: 20, step: 1, value: p.fontSize,
        on: { input: (e) => setPrefs({ fontSize: Number(e.currentTarget.value) }) },
      })),
    h("label", { class: "check" }, h("input", {
      type: "checkbox", checked: p.compact, on: { change: (e) => setPrefs({ compact: e.currentTarget.checked }) },
    }), t("compact_message_layout")),
    h("label", {}, t("last_seen_format_label"), lastSeenSelect()),
    h("label", { class: "check" }, h("input", {
      type: "checkbox", checked: p.twemoji, on: { change: (e) => setPrefs({ twemoji: e.currentTarget.checked }) },
    }), t("twemoji_label")),
    h("label", { class: "check" }, h("input", {
      type: "checkbox", checked: p.autoReconnect, on: { change: (e) => setPrefs({ autoReconnect: e.currentTarget.checked }) },
    }), t("auto_reconnect_label")),
    h("h3", {}, t("shortcuts_heading")),
    h("p", { class: "muted small" }, t("shortcuts_note")),
    h("div", {}, h("button", {
      class: "btn", type: "button", on: { click: () => actions.showShortcuts() },
    }, t("shortcuts_button"))),
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
      h("input", { type: "color", value: color, "aria-label": t("colour_n_aria", { n: i + 1 }), on: { input: (e) => { c.colors[i] = e.currentTarget.value; save({}); } } }),
      c.colors.length > 1 ? h("button", {
        class: "icon-btn", type: "button", title: t("remove_colour_title"), "aria-label": t("remove_colour_n_aria", { n: i + 1 }),
        on: { click: () => { c.colors.splice(i, 1); save({}, true); } },
      }, icon("x")) : null)),
    c.colors.length < MAX_THEME_COLORS ? h("button", {
      class: "btn", type: "button",
      on: { click: () => { c.colors.push(c.colors[c.colors.length - 1]); save({}, true); } },
    }, t("add_colour")) : null,
    h("span", { class: "muted small" }, t("colour_count", { count: c.colors.length, max: MAX_THEME_COLORS })));
  const accentOn = h("input", { type: "checkbox", checked: !c.accent });
  const accent = h("input", { type: "color", value: c.accent || c.colors[0], disabled: !c.accent, "aria-label": t("accent_label") });
  accentOn.addEventListener("change", () => { accent.disabled = accentOn.checked; save({ accent: accentOn.checked ? null : accent.value }); });
  accent.addEventListener("input", () => save({ accent: accent.value }));
  const draw = () => clear(box,
    drawStops() && null,
    preview,
    h("div", { class: "field" }, h("span", { class: "field-label" }, t("colours_label")), stops),
    h("label", {}, t("direction_label"), h("input", { type: "range", min: 0, max: 359, value: c.angle, on: { input: (e) => save({ angle: Number(e.currentTarget.value) }) } })),
    h("label", {}, t("strength_label"), h("input", { type: "range", min: 10, max: 90, value: c.strength, on: { input: (e) => save({ strength: Number(e.currentTarget.value) }) } }),
      h("span", { class: "muted small block" }, t("gradient_strength_note"))),
    h("div", { class: "field" }, h("span", { class: "field-label" }, t("panels_label")),
      h("div", { class: "radio-row" },
        ...["dark", "light"].map((b) => h("label", { class: "radio-card" },
          h("input", { type: "radio", name: "theme-base", checked: c.base === b, on: { change: () => save({ base: b }) } }), b === "dark" ? t("theme_dark") : t("theme_light"))))),
    h("div", { class: "field" }, h("span", { class: "field-label" }, t("accent_label")),
      h("div", { class: "row" }, h("label", { class: "check" }, accentOn, t("match_first_colour")), accent)));
  draw();
  return box;
}

function notifications(el, actions) {
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
          if (result !== "granted") { box.checked = false; toast(t("notifications_blocked_toast"), { error: true }); refreshFullscreen(); return; }
        }
        setPrefs({ desktopNotifications: box.checked });
      },
    },
  });
  add(el,
    h("p", { class: "muted" }, t("notifications_intro")),
    h("label", { class: "check" }, desktop, h("span", {}, t("desktop_notifications_label"),
      h("span", { class: "muted small block" },
        perm === "denied" ? t("notifications_blocked_browser") : perm === "unsupported" ? t("notifications_unsupported") : t("notifications_shown_when_unfocused")))),
    h("label", { class: "check" }, h("input", {
      type: "checkbox", checked: p.sound, on: { change: (e) => setPrefs({ sound: e.currentTarget.checked }) },
    }), t("play_sound_notifications")),
    h("p", { class: "muted small" }, t("dnd_note")),
    h("label", { class: "check" }, h("input", {
      type: "checkbox", checked: p.touchGrass, on: { change: (e) => setPrefs({ touchGrass: e.currentTarget.checked }) },
    }), h("span", {}, t("touch_grass_label"), h("span", { class: "muted small block" }, t("touch_grass_hint")))),
    reminderList(actions),
  );
}

// /remind, kept on this device for this account (client/js/reminders.js).
function reminderList(actions) {
  const reminders = actions.listReminders();
  return h("div", {},
    h("h3", {}, t("reminders_heading")),
    h("p", { class: "muted small" }, t("reminders_note")),
    reminders.length
      ? h("div", { class: "list" }, reminders.map((r) => h("div", { class: "list-row" },
        h("span", { class: "list-icon", "aria-hidden": "true" }, icon("alarm-clock")),
        h("span", { class: "meta" },
          h("span", { class: "name" }, r.text),
          h("span", { class: "sub" }, fmtDateTime(new Date(r.at).toISOString()))),
        h("button", {
          class: "btn small", type: "button",
          on: { click: () => { actions.cancelReminder(r.id); refreshFullscreen(); } },
        }, t("cancel_reminder")))))
      : h("p", { class: "muted small" }, t("reminders_none")));
}

// "Last seen" style, shared by Appearance and the admin Accounts tab.
export function lastSeenSelect(onChange = null) {
  const cur = getPrefs().lastSeenFormat;
  return h("select", {
    "aria-label": t("last_seen_format_label"),
    on: { change: (e) => { setPrefs({ lastSeenFormat: e.currentTarget.value }); onChange?.(); } },
  }, [["datetime", t("last_seen_datetime")], ["date", t("last_seen_date")], ["relative", t("last_seen_relative")], ["both", t("last_seen_both")]]
    .map(([v, label]) => h("option", { value: v, selected: v === cur }, label)));
}

// --- Local Options (standalone build only) ------------------------------------

function localOptions(el) {
  const p = getPrefs();
  add(el,
    h("p", { class: "muted" }, t("local_options_intro")),
    h("label", { class: "check" }, h("input", {
      type: "checkbox", checked: p.autoUpdateCheck, on: { change: (e) => setPrefs({ autoUpdateCheck: e.currentTarget.checked }) },
    }), t("auto_update_checker_label")),
    h("label", { class: "check" }, h("input", {
      type: "checkbox", checked: p.updateNotifier, on: { change: (e) => setPrefs({ updateNotifier: e.currentTarget.checked }) },
    }), t("update_notifier_label")),
    h("p", { class: "muted small" }, t("local_options_note")),
  );
}
