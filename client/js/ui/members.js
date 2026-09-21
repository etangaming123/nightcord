// Member list (right column): members who can see the open channel, grouped
// by their highest "display separately" (hoisted) role, then Online and
// Offline — like Discord. Ghost memberships never reach here: the server
// leaves them out (§7). In a group DM it lists the recipients.

import { currentChannel, hoistedRole, isDm, memberCanView, nameOf, statusOf, userById } from "../state.js";
import { $, add, avatar, clear, displayName, h, statusLabel } from "./dom.js";
import { nameAttrs, profileBanner, profileThemeAttrs, roleIconEl } from "./names.js";
import { scopedT } from "../strings.js";

const t = scopedT("ui/members");

function row(state, actions, user, { crown = false, guild = false } = {}) {
  const status = statusOf(user.user_id);
  return h("button", {
    class: `member ${status === "offline" ? "offline" : ""}`, type: "button",
    on: {
      click: (e) => actions.openProfile(user.user_id, e.currentTarget, { placement: "left" }),
      contextmenu: (e) => { e.preventDefault(); actions.memberMenu(user.user_id, { x: e.clientX, y: e.clientY }); },
    },
  },
  avatar(user, { status }),
  h("span", { class: "member-meta" },
    h("span", { class: "name-line" },
      h("span", guild ? nameAttrs(user.user_id, "name") : { class: "name" }, guild ? nameOf(user) : displayName(user)),
      guild ? roleIconEl(user.user_id) : null),
    user.custom_status ? h("span", { class: "sub" }, user.custom_status) : null),
  crown ? h("span", { class: "crown", title: t("guild_owner_title"), "aria-label": t("guild_owner_title") }, "♛") : null);
}

// 1:1 DMs show the other person's profile instead of a member list.
function dmProfile(user, actions) {
  const status = statusOf(user.user_id);
  return h("div", profileThemeAttrs(user, "profile dm-profile"),
    profileBanner(user),
    h("div", { class: "profile-avatar" }, avatar(user, { size: "xl", status })),
    h("div", { class: "profile-card" },
      h("div", { class: "profile-name" }, displayName(user)),
      h("div", { class: "profile-username" }, user.username),
      user.custom_status ? h("div", { class: "profile-status" }, user.custom_status) : null,
      h("div", { class: "muted small" }, statusLabel(status)),
      h("div", { class: "profile-actions" },
        h("button", { class: "btn", type: "button", on: { click: (e) => actions.openProfile(user.user_id, e.currentTarget, { placement: "left" }) } }, t("view_full_profile")))));
}

export function renderMembers(state, actions) {
  const el = clear($("#member-list"));
  const channel = currentChannel();
  if (state.view === "home") {
    if (channel?.kind === "dm") {
      const other = channel.recipients.find((u) => u.user_id !== state.user.user_id);
      if (other) add(el, dmProfile(userById(other.user_id) || other, actions));
      return;
    }
    if (!channel || channel.kind !== "group_dm") return;
    add(el, h("div", { class: "section-label" }, t("group_members_count_label", { count: channel.recipients.length })));
    for (const r of channel.recipients) {
      const u = userById(r.user_id) || r;
      add(el, row(state, actions, u, { crown: u.user_id === channel.owner_user_id }));
    }
    return;
  }
  if (!state.guildId || (channel && isDm(channel))) return;
  const byName = (a, b) => nameOf(a.user).localeCompare(nameOf(b.user), undefined, { sensitivity: "base" });
  const groups = new Map(); // role_id | "online" | "offline" -> { label, members }
  const viewable = channel && channel.kind === "text" ? (m) => memberCanView(m, channel) : () => true;
  const members = state.members.filter(viewable).map((m) => ({ ...m, user: userById(m.user.user_id) || m.user }));
  for (const m of members.sort(byName)) {
    const online = statusOf(m.user.user_id) !== "offline";
    const top = online ? hoistedRole(m) : null;
    const key = online ? (top?.role_id || "online") : "offline";
    if (!groups.has(key)) groups.set(key, { label: top ? top.name : online ? t("online_label") : t("offline_label"), position: top?.position ?? (online ? 0 : -1), members: [] });
    groups.get(key).members.push(m);
  }
  const ordered = [...groups.values()].sort((a, b) => b.position - a.position);
  for (const g of ordered) {
    add(el, h("div", { class: "section-label" }, t("role_group_count_label", { label: g.label, count: g.members.length })));
    for (const m of g.members) {
      add(el, row(state, actions, m.user, { crown: m.is_owner, guild: true }));
    }
  }
  if (!members.length) add(el, h("p", { class: "muted small pad" }, t("nobody_can_see_channel")));
}
