// Member list (right column). Ghost memberships never reach here: the server
// already excludes them from guild.members / presence (PROTOCOL.md §7).

import { $, avatar, clear, h } from "./dom.js";

export function renderMembers(state) {
  const el = clear($("#member-list"));
  if (!state.guildId) return;
  const guild = state.guilds.get(state.guildId);
  const byName = (a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: "base" });
  const online = state.members.filter((m) => state.online.has(m.user_id)).sort(byName);
  const offline = state.members.filter((m) => !state.online.has(m.user_id)).sort(byName);
  const section = (label, list, isOnline) => {
    if (!list.length) return;
    el.append(h("div", { class: "section-label" }, `${label} — ${list.length}`));
    for (const m of list) {
      const isOwner = m.role === "owner" || m.user_id === guild?.owner_user_id;
      el.append(h("div", { class: `member ${isOnline ? "" : "offline"}` },
        avatar(m.username, { online: isOnline }),
        h("span", { class: "name" }, m.username),
        isOwner ? h("span", { class: "crown", title: "Guild owner", "aria-label": "Guild owner" }, "♛") : null,
      ));
    }
  };
  section("Online", online, true);
  section("Offline", offline, false);
}
