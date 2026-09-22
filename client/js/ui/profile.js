// Profile popout: avatar, names, status, bio, roles in this guild, and
// actions (message, edit profile, moderation) the viewer is allowed to use.

import { LIMITS, T } from "../protocol.js";
import { STAFF_LABEL, can, memberById, memberRoles, state, statusOf, userById } from "../state.js";
import { add, avatar, clear, displayName, fmtDate, h, statusLabel } from "./dom.js";
import { closePopover, confirmAction, openMenu, openPopover, repositionPopover, toast } from "./modals.js";
import { renderInline } from "./markdown.js";
import { nameAttrs, profileBanner, profileThemeAttrs, roleIconOf, roleSwatch } from "./names.js";
import { scopedT } from "../strings.js";

const t = scopedT("ui/profile");

export function openProfile(userId, anchor, actions, { placement = "right" } = {}) {
  const cached = userById(userId) || memberById(userId)?.user;
  const body = h("div", { class: "profile" });
  // The card is drawn twice — once from cache, once from user.profile — so the
  // note box is built once and moved across, keeping focus and any edit.
  let noteField = null;
  const draw = (user, extra = {}) => {
    const status = statusOf(user.user_id);
    const member = state.view === "guild" ? memberById(user.user_id) : null;
    const me = user.user_id === state.user?.user_id;
    if (user.deleted) {
      body.className = "profile";
      body.style.cssText = "";
      clear(body,
        h("div", { class: "profile-banner", style: "background:var(--muted)" }),
        h("div", { class: "profile-avatar" }, avatar(user, { size: "xl" })),
        h("div", { class: "profile-card" }, h("div", { class: "profile-name" }, t("deleted_user_name")),
          h("p", { class: "muted small" }, t("deleted_user_note"))));
      repositionPopover();
      return;
    }
    const theme = profileThemeAttrs(user);
    body.className = theme.class;
    body.style.cssText = theme.style || "";
    clear(body,
      profileBanner(user),
      h("div", { class: "profile-avatar" }, avatar(user, { size: "xl", status })),
      h("div", { class: "profile-card" },
        h("div", member ? nameAttrs(user.user_id, "profile-name") : { class: "profile-name" }, member?.nickname || displayName(user)),
        h("div", { class: "profile-username" }, member?.nickname ? `${displayName(user)} · ${user.username}` : user.username,
          STAFF_LABEL[user.server_role] ? h("span", { class: `tag staff ${user.server_role}` }, STAFF_LABEL[user.server_role].toUpperCase()) : null),
        user.custom_status ? h("div", { class: "profile-status" }, user.custom_status) : null,
        h("div", { class: "muted small" }, statusLabel(status)),
        extra.bio ? section(t("about_me"), h("p", { class: "profile-bio" },
          renderInline(extra.bio, { user: userById, meId: state.user?.user_id }))) : null,
        section(t("member_since_heading"), h("p", {},
          extra.created_at ? t("nightcord_since", { date: fmtDate(extra.created_at) }) : t("unknown_date_placeholder"),
          member ? h("br") : null,
          member ? t("this_guild_since", { date: fmtDate(member.joined_at) }) : null)),
        member ? rolesSection(member, actions) : null,
        me ? null : noteSection(user.user_id, actions, () => noteField, (el) => { noteField = el; }),
        member?.timed_out_until && new Date(member.timed_out_until) > new Date()
          ? h("p", { class: "timeout-note" }, t("timed_out_note", { until: new Date(member.timed_out_until).toLocaleString() })) : null,
        h("div", { class: "profile-actions" },
          me
            ? h("button", { class: "btn wide", type: "button", on: { click: () => { closePopover(); actions.userSettings("profile"); } } }, t("edit_profile"))
            : h("button", { class: "btn primary wide", type: "button", on: { click: () => { closePopover(); actions.messageUser(user.user_id); } } }, t("message_button")),
          me && member && can("CHANGE_NICKNAME") ? h("button", { class: "btn wide", type: "button", on: { click: () => { closePopover(); actions.changeNickname(user.user_id); } } }, t("nickname_button")) : null,
          !me ? friendButton(user, actions) : null,
          !me ? modButton(user, actions, member) : null)));
    repositionPopover();
  };
  if (cached) draw(cached);
  else add(body, h("p", { class: "muted pad" }, t("loading")));
  if (!openPopover(anchor, body, { placement, cls: "profile-pop", key: `profile:${userId}` })) return;
  actions.req(T.USER_PROFILE, { user_id: userId }).then(({ user, note }) => {
    if (!body.isConnected) return;
    actions.applyUserNote({ user_id: userId, note });
    const fresh = actions.rememberUser(user);
    draw(fresh, { bio: user.bio, created_at: user.created_at });
  }).catch((e) => { if (body.isConnected && !cached) clear(body, h("p", { class: "pad" }, e.message)); });
}

// "Note (only you can see this)". Saves on blur, and survives the redraw.
function noteSection(userId, actions, getField, setField) {
  let field = getField();
  if (!field) {
    field = h("textarea", {
      class: "profile-note", rows: 2, maxLength: LIMITS.USER_NOTE_MAX,
      placeholder: t("note_placeholder"), "aria-label": t("note_heading"),
    });
    field.value = actions.userNote(userId) ?? "";
    let saved = field.value;
    field.addEventListener("blur", () => {
      const next = field.value.trim();
      if (next === saved.trim()) return;
      saved = next;
      actions.setUserNote(userId, next).catch((e) => toast(e.message, { error: true }));
    });
    // Enter saves and lets go; Shift+Enter keeps typing.
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); field.blur(); }
      if (e.key === "Escape") e.stopPropagation();
    });
    setField(field);
  } else if (document.activeElement !== field && !field.value) {
    // Nothing typed yet: pick up a note that arrived with the fresh profile.
    field.value = actions.userNote(userId) ?? "";
  }
  return section(t("note_heading"), field);
}

function section(title, content) {
  return h("div", { class: "profile-section" }, h("div", { class: "profile-section-title" }, title), content);
}

function rolesSection(member, actions) {
  const roles = memberRoles(member);
  const editable = actions.assignableRoles();
  const chips = roles.map((r) => h("span", { class: "role-chip" },
    roleSwatch(r),
    roleIconOf(r),
    r.name,
    editable.some((e) => e.role_id === r.role_id)
      ? h("button", {
        class: "role-x", type: "button", title: t("remove_role_title", { role: r.name }), "aria-label": t("remove_role_title", { role: r.name }),
        on: {
          click: (ev) => confirmAction(ev, {
            title: t("remove_role_title", { role: r.name }),
            message: t("remove_role_body", { role: r.name, name: displayName(member.user) }),
            confirmLabel: t("remove_role_confirm"),
            onConfirm: () => actions.setMemberRoles(member.user.user_id, member.role_ids.filter((id) => id !== r.role_id)),
          }),
        },
      }, "×")
      : null));
  const addable = editable.filter((r) => !member.role_ids.includes(r.role_id));
  const add = addable.length
    ? h("button", {
      class: "role-chip add", type: "button", title: t("add_role_title"), "aria-label": t("add_role_title"),
      on: {
        click: (e) => openMenu(e.currentTarget, addable.map((r) => ({
          label: r.name,
          icon: roleSwatch(r),
          onClick: () => actions.setMemberRoles(member.user.user_id, [...member.role_ids, r.role_id]),
        })), { placement: "right", key: `role-add:${member.user.user_id}` }),
      },
    }, "+")
    : null;
  if (!chips.length && !add) return null;
  return section(roles.length ? t("roles_heading") : t("no_roles_heading"), h("div", { class: "role-chips" }, chips, add));
}

// Add friend when there's no relationship yet; otherwise a menu of the options.
function friendButton(user, actions) {
  const items = actions.friendItems(user.user_id);
  if (!items.length) return null;
  if (items[0].key === "add") {
    return h("button", { class: "btn", type: "button", on: { click: () => { closePopover(); items[0].onClick(); } } }, t("add_friend_label"));
  }
  return h("button", {
    class: "btn", type: "button", "aria-haspopup": "menu",
    on: { click: (e) => openMenu(e.currentTarget, items, { placement: "top", key: `friend:${user.user_id}` }) },
  }, t("friend_menu_button"));
}

function modButton(user, actions, member) {
  const guildItems = member ? actions.moderationItems(user.user_id) : [];
  const staff = actions.staffItems(user.user_id);
  const items = [...guildItems, ...(staff.length ? [guildItems.length ? "-" : null, { heading: t("server_staff_heading") }, ...staff] : [])];
  if (!guildItems.length && !staff.length) return null;
  return h("button", {
    class: "btn", type: "button", "aria-haspopup": "menu",
    on: { click: (e) => openMenu(e.currentTarget, items, { placement: "top", key: `moderate:${user.user_id}` }) },
  }, t("moderate_button"));
}

export function copyText(text, what = t("copied")) {
  navigator.clipboard?.writeText(text).then(() => toast(what), () => toast(t("copy_failed"), { error: true }));
}
