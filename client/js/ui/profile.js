// Profile popout: avatar, names, status, bio, roles in this guild, and
// actions (message, edit profile, moderation) the viewer is allowed to use.

import { T } from "../protocol.js";
import { memberById, memberRoles, state, statusOf, userById } from "../state.js";
import { add, avatar, clear, displayName, fmtDate, h, statusLabel } from "./dom.js";
import { closePopover, openMenu, openPopover, repositionPopover, toast } from "./modals.js";

export function openProfile(userId, anchor, actions, { placement = "right" } = {}) {
  const cached = userById(userId) || memberById(userId)?.user;
  const body = h("div", { class: "profile" });
  const draw = (user, extra = {}) => {
    const status = statusOf(user.user_id);
    const member = state.view === "guild" ? memberById(user.user_id) : null;
    const me = user.user_id === state.user?.user_id;
    clear(body,
      h("div", { class: "profile-banner", style: `background:${user.avatar_color || "var(--accent)"}` }),
      h("div", { class: "profile-avatar" }, avatar(user, { size: "xl", status })),
      h("div", { class: "profile-card" },
        h("div", { class: "profile-name" }, displayName(user)),
        h("div", { class: "profile-username" }, user.username,
          user.is_server_owner ? h("span", { class: "tag" }, "SERVER OWNER") : null),
        user.custom_status ? h("div", { class: "profile-status" }, user.custom_status) : null,
        h("div", { class: "muted small" }, statusLabel(status)),
        extra.bio ? section("About me", h("p", { class: "profile-bio" }, extra.bio)) : null,
        section("Member since", h("p", {},
          extra.created_at ? `Nightcord: ${fmtDate(extra.created_at)}` : "…",
          member ? h("br") : null,
          member ? `This guild: ${fmtDate(member.joined_at)}` : null)),
        member ? rolesSection(member, actions) : null,
        member?.timed_out_until && new Date(member.timed_out_until) > new Date()
          ? h("p", { class: "timeout-note" }, `⏳ Timed out until ${new Date(member.timed_out_until).toLocaleString()}`) : null,
        h("div", { class: "profile-actions" },
          me
            ? h("button", { class: "btn", type: "button", on: { click: () => { closePopover(); actions.userSettings("profile"); } } }, "Edit profile")
            : h("button", { class: "btn primary", type: "button", on: { click: () => { closePopover(); actions.messageUser(user.user_id); } } }, "Message"),
          member && !me ? modButton(user, actions) : null)));
    repositionPopover();
  };
  if (cached) draw(cached);
  else add(body, h("p", { class: "muted pad" }, "Loading…"));
  openPopover(anchor, body, { placement, cls: "profile-pop" });
  actions.req(T.USER_PROFILE, { user_id: userId }).then(({ user }) => {
    if (!body.isConnected) return;
    const fresh = actions.rememberUser(user);
    draw(fresh, { bio: user.bio, created_at: user.created_at });
  }).catch((e) => { if (body.isConnected && !cached) clear(body, h("p", { class: "pad" }, e.message)); });
}

function section(title, content) {
  return h("div", { class: "profile-section" }, h("div", { class: "profile-section-title" }, title), content);
}

function rolesSection(member, actions) {
  const roles = memberRoles(member);
  const editable = actions.assignableRoles();
  const chips = roles.map((r) => h("span", { class: "role-chip" },
    h("span", { class: "role-dot", style: `background:${r.color || "var(--muted)"}` }),
    r.name,
    editable.some((e) => e.role_id === r.role_id)
      ? h("button", {
        class: "role-x", type: "button", title: `Remove ${r.name}`, "aria-label": `Remove ${r.name}`,
        on: { click: () => actions.setMemberRoles(member.user.user_id, member.role_ids.filter((id) => id !== r.role_id)) },
      }, "×")
      : null));
  const addable = editable.filter((r) => !member.role_ids.includes(r.role_id));
  const add = addable.length
    ? h("button", {
      class: "role-chip add", type: "button", title: "Add role", "aria-label": "Add role",
      on: {
        click: (e) => openMenu(e.currentTarget, addable.map((r) => ({
          label: r.name,
          icon: h("span", { class: "role-dot", style: `background:${r.color || "var(--muted)"}` }),
          onClick: () => actions.setMemberRoles(member.user.user_id, [...member.role_ids, r.role_id]),
        })), { placement: "right" }),
      },
    }, "+")
    : null;
  if (!chips.length && !add) return null;
  return section(roles.length ? "Roles" : "No roles", h("div", { class: "role-chips" }, chips, add));
}

function modButton(user, actions) {
  const items = actions.moderationItems(user.user_id);
  if (!items.length) return null;
  return h("button", {
    class: "btn", type: "button", "aria-haspopup": "menu",
    on: { click: (e) => openMenu(e.currentTarget, items, { placement: "top" }) },
  }, "Moderate ▾");
}

export function copyText(text, what = "Copied") {
  navigator.clipboard?.writeText(text).then(() => toast(what), () => toast("Couldn't copy", { error: true }));
}
