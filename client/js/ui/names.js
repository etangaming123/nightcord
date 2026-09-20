// Member names with role colours, gradients and role icons (PROTOCOL.md §4
// Role, §8d).

import { guildCan, roleDisplay, userCan } from "../perks.js";
import { state, userById } from "../state.js";
import { h, imageEl } from "./dom.js";

// CSS for a role colour or gradient ({ color, gradient } from roleDisplay).
export function colorStyle({ color, gradient }) {
  if (gradient) return `--grad:linear-gradient(90deg, ${gradient.join(", ")}, ${gradient[0]})`;
  return color ? `color:${color}` : null;
}

// Attributes for an element showing userId's name in the current guild.
export function nameAttrs(userId, cls = "") {
  const d = roleDisplay(userId);
  return { class: `${cls} ${d.gradient ? "grad-name" : ""}`.trim(), style: colorStyle(d) };
}

// The small icon of a member's top role with one, or null.
export function roleIconEl(userId) {
  const { icon } = roleDisplay(userId);
  if (!icon) return null;
  return roleIconOf(icon.role);
}

export function roleIconOf(role) {
  const guild = state.guilds.get(role.guild_id);
  if (!guildCan("role_icons", guild)) return null;
  if (role.icon_id) {
    const img = imageEl(role.icon_id, { animate: guildCan("animated_media", guild), alt: role.name, cls: "role-icon" });
    if (img) img.title = role.name;
    return img;
  }
  if (role.icon_emoji) return h("span", { class: "role-icon emoji", title: role.name, role: "img", "aria-label": role.name }, role.icon_emoji);
  return null;
}

// --- profile banners and colours (PROTOCOL.md §4 User, §8d) ---------------------

// The coloured strip or image at the top of a profile card.
// live: use the freshest copy of the user (false for previews of unsaved edits).
export function profileBanner(user, { live = true } = {}) {
  const fresh = (live && userById(user.user_id)) || user;
  if (fresh.banner_id && userCan("profile_banner", fresh)) {
    return h("div", { class: "profile-banner has-image" },
      imageEl(fresh.banner_id, { animate: userCan("animated_media", fresh), alt: "", lazy: false }));
  }
  // With profile colours on, the card already paints one gradient top to
  // bottom; a coloured strip here would show a seam where the two meet.
  if (themeColors(fresh, { live })) return h("div", { class: "profile-banner" });
  return h("div", { class: "profile-banner", style: `background:${fresh.avatar_color || "var(--accent)"}` });
}

export function themeColors(user, { live = true } = {}) {
  const fresh = (live && userById(user.user_id)) || user;
  return fresh.profile_colors?.length === 2 && userCan("profile_colors", fresh) ? fresh.profile_colors : null;
}

// Class and style for a whole profile card with profile colours.
export function profileThemeAttrs(user, cls = "profile", { live = true } = {}) {
  const colors = themeColors(user, { live });
  if (!colors) return { class: cls };
  return { class: `${cls} themed`, style: `--p1:${colors[0]};--p2:${colors[1]}` };
}

// A role's colour swatch: solid, or its gradient when allowed.
export function roleSwatch(role, cls = "role-dot") {
  const guild = state.guilds.get(role.guild_id);
  const grad = role.colors?.length > 1 && guildCan("gradient_roles", guild);
  return h("span", { class: cls, style: grad ? `background:linear-gradient(135deg, ${role.colors.join(", ")})` : `background:${role.color || "var(--muted)"}` });
}
