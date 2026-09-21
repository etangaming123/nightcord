// The Friends page — Home with no conversation open (PROTOCOL.md §5 Friends
// and blocking, Message requests). Tabs: online, all friends, pending friend
// requests, blocked people, message requests and the Add Friend box.

import { LIMITS, T } from "../protocol.js";
import { messageRequests, nameOf, relationsOf, state, statusOf, userById } from "../state.js";
import { add, avatar, clear, h, iconBtn, statusLabel } from "./dom.js";
import { scopedT } from "../strings.js";

const t = scopedT("ui/friends");

function count(n) {
  return n ? h("span", { class: "badge" }, n > 99 ? "99+" : String(n)) : null;
}

// --- header: title + tabs ----------------------------------------------------------

export function renderFriendsHeader(header, state, actions) {
  const tab = (id, label, n = 0) => h("button", {
    class: `friends-tab ${state.homeTab === id ? "active" : ""}`, type: "button", role: "tab",
    "aria-selected": String(state.homeTab === id),
    on: { click: () => actions.openFriends(id) },
  }, label, count(n));
  add(header,
    h("span", { class: "hash", "aria-hidden": "true" }, "👋"),
    h("span", { class: "title friends-title" }, t("title")),
    h("div", { class: "friends-tabs", role: "tablist", "aria-label": t("title") },
      tab("online", t("tab_online")),
      tab("all", t("tab_all")),
      tab("pending", t("tab_pending"), relationsOf("incoming").length),
      tab("blocked", t("tab_blocked")),
      tab("requests", t("tab_requests"), messageRequests().length),
      h("button", {
        class: `friends-tab add ${state.homeTab === "add" ? "active" : ""}`, type: "button", role: "tab",
        "aria-selected": String(state.homeTab === "add"),
        on: { click: () => actions.openFriends("add") },
      }, t("tab_add"))));
  // On narrow screens the tab row scrolls; keep the current tab in view.
  const row = header.querySelector(".friends-tabs");
  const active = row.querySelector(".active");
  if (active && row.scrollWidth > row.clientWidth) {
    const over = active.getBoundingClientRect().right - row.getBoundingClientRect().right;
    if (over > 0) row.scrollLeft = over + 8;
  }
}

// --- page body -----------------------------------------------------------------------

export function renderFriendsPage(state, actions) {
  const page = h("div", { class: "friends-page" });
  const tab = state.homeTab;
  if (tab === "add") addFriendTab(page, actions);
  else if (tab === "pending") pendingTab(page, actions);
  else if (tab === "blocked") blockedTab(page, actions);
  else if (tab === "requests") requestsTab(page, actions);
  else friendsTab(page, actions, tab === "online");
  return page;
}

const fresh = (u) => userById(u.user_id) || u;

function personRow(user, { sub, buttons = [], onClick = null }) {
  const u = fresh(user);
  return h("div", {
    class: `friend-row ${onClick ? "clickable" : ""}`, role: onClick ? "button" : null, tabindex: onClick ? "0" : null,
    on: onClick ? {
      click: (e) => { if (!e.target.closest("button")) onClick(); },
      keydown: (e) => { if (e.key === "Enter" && e.target === e.currentTarget) onClick(); },
    } : {},
  },
  avatar(u, { status: statusOf(u.user_id) }),
  h("span", { class: "friend-meta" },
    h("span", { class: "name" }, nameOf(u, null), h("span", { class: "handle" }, u.username)),
    sub ? h("span", { class: "sub" }, sub) : null),
  h("span", { class: "friend-actions" }, buttons));
}

function emptyNote(glyph, text, cta = null) {
  return h("div", { class: "empty-note friends-empty" },
    h("span", { class: "big-emoji", "aria-hidden": "true" }, glyph), h("p", { class: "muted" }, text), cta);
}

function friendsTab(page, actions, onlineOnly) {
  const all = relationsOf("friend").map((r) => fresh(r.user)).sort((a, b) => nameOf(a, null).localeCompare(nameOf(b, null)));
  const list = onlineOnly ? all.filter((u) => statusOf(u.user_id) !== "offline") : all;
  add(page, h("div", { class: "section-label" }, onlineOnly ? t("online_count", { count: list.length }) : t("all_count", { count: list.length })));
  if (!list.length) {
    add(page, all.length
      ? emptyNote("🌙", t("nobody_online"))
      : emptyNote("🦗", t("no_friends"), h("button", { class: "btn primary", type: "button", on: { click: () => actions.openFriends("add") } }, t("tab_add"))));
    return;
  }
  for (const u of list) {
    add(page, personRow(u, {
      sub: u.custom_status || statusLabel(statusOf(u.user_id)),
      onClick: () => actions.messageUser(u.user_id),
      buttons: [
        iconBtn("💬", t("message"), () => actions.messageUser(u.user_id)),
        iconBtn("⋮", t("more"), (e) => actions.memberMenu(u.user_id, e.currentTarget)),
      ],
    }));
  }
}

function pendingTab(page, actions) {
  const incoming = relationsOf("incoming");
  const outgoing = relationsOf("outgoing");
  if (!incoming.length && !outgoing.length) {
    add(page, emptyNote("📭", t("no_pending")));
    return;
  }
  if (incoming.length) add(page, h("div", { class: "section-label" }, t("incoming_count", { count: incoming.length })));
  for (const r of incoming) {
    add(page, personRow(r.user, {
      sub: t("incoming_sub"),
      buttons: [
        iconBtn("✓", t("accept"), () => actions.acceptFriend(r.user.user_id), { cls: "ok" }),
        iconBtn("✕", t("decline"), () => actions.removeFriend(r.user.user_id), { cls: "danger" }),
      ],
    }));
  }
  if (outgoing.length) add(page, h("div", { class: "section-label" }, t("outgoing_count", { count: outgoing.length })));
  for (const r of outgoing) {
    add(page, personRow(r.user, {
      sub: t("outgoing_sub"),
      buttons: [iconBtn("✕", t("cancel_request"), () => actions.removeFriend(r.user.user_id), { cls: "danger" })],
    }));
  }
}

function blockedTab(page, actions) {
  const blocked = relationsOf("blocked");
  add(page, h("div", { class: "section-label" }, t("blocked_count", { count: blocked.length })));
  if (!blocked.length) { add(page, emptyNote("🕊", t("no_blocked"))); return; }
  for (const r of blocked) {
    add(page, personRow(r.user, {
      sub: t("blocked_sub"),
      buttons: [h("button", { class: "btn small", type: "button", on: { click: () => actions.unblockUser(r.user.user_id) } }, t("unblock"))],
    }));
  }
}

function requestsTab(page, actions) {
  const reqs = messageRequests();
  add(page, h("p", { class: "muted small" }, t("requests_intro")));
  if (!reqs.length) { add(page, emptyNote("📨", t("no_requests"))); return; }
  for (const ch of reqs) {
    const from = ch.recipients.find((u) => u.user_id === ch.request.from_user_id) || ch.recipients[0];
    add(page, personRow(from, {
      sub: t("request_sub"),
      onClick: () => actions.openDm(ch.channel_id),
      buttons: [
        h("button", { class: "btn small primary", type: "button", on: { click: () => actions.acceptRequest(ch) } }, t("accept")),
        h("button", { class: "btn small", type: "button", on: { click: () => actions.declineRequest(ch) } }, t("decline")),
      ],
    }));
  }
}

// --- Add Friend ----------------------------------------------------------------

// Survives re-renders (a new relationship redraws the page): the typed name
// and the last result line.
const addState = { value: "", note: "", ok: true };
const validName = (v) => LIMITS.USERNAME_RE.test(v.trim().replace(/^@/, ""));

function addFriendTab(page, actions) {
  const input = h("input", {
    class: "input", placeholder: t("add_placeholder"), "aria-label": t("add_placeholder"), maxLength: 32,
    spellcheck: "false", autocapitalize: "off", autocomplete: "off", value: addState.value,
  });
  const submit = h("button", { class: "btn primary", type: "submit", disabled: !validName(addState.value) }, t("add_send"));
  const note = h("p", { class: `small ${addState.ok ? "ok-text" : "error-text"}`, role: "status" }, addState.note);
  const suggest = h("div", { class: "pick-results", hidden: true });
  const form = h("form", { class: "add-friend" }, input, submit);
  let seq = 0;
  let timer = null;
  const lookup = async () => {
    const q = input.value.trim().replace(/^@/, "");
    const mine = ++seq;
    if (!actions.userSearchAllowed() || q.length < 2) { suggest.hidden = true; return; }
    try {
      const { users } = await actions.req(T.USER_SEARCH, { query: q });
      if (mine !== seq) return;
      clear(suggest, users.slice(0, 6).map((u) => h("button", {
        class: "pick-row", type: "button",
        on: { click: () => { input.value = u.username; suggest.hidden = true; submit.disabled = false; input.focus(); } },
      }, avatar(u, { size: "sm" }), h("span", { class: "meta" }, h("span", { class: "name" }, nameOf(u, null)), h("span", { class: "sub" }, u.username)))));
      suggest.hidden = !users.length;
    } catch {
      suggest.hidden = true;
    }
  };
  input.addEventListener("input", () => {
    addState.value = input.value;
    addState.note = "";
    submit.disabled = !validName(input.value);
    note.textContent = "";
    clearTimeout(timer);
    timer = setTimeout(lookup, 200);
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    submit.disabled = true;
    const username = input.value.trim().replace(/^@/, "");
    // Set before the request: its relationship.updated redraws this tab.
    const show = (text, ok) => {
      Object.assign(addState, { note: text, ok });
      note.className = `small ${ok ? "ok-text" : "error-text"}`;
      note.textContent = text;
    };
    try {
      addState.value = "";
      const rel = await actions.addFriend({ username });
      show(rel.kind === "friend" ? t("add_now_friends", { name: nameOf(rel.user, null) }) : t("add_sent", { name: rel.user.username }), true);
      input.value = "";
      suggest.hidden = true;
    } catch (err) {
      addState.value = username;
      show(err.message, false);
      submit.disabled = false;
    }
    actions.refreshChat();
  });
  add(page,
    h("h2", { class: "friends-h2" }, t("add_title")),
    h("p", { class: "muted" }, actions.userSearchAllowed() ? t("add_intro_search") : t("add_intro")),
    form, suggest, note,
    h("div", { class: "add-friend-tip muted small" }, t("add_tip", { username: state.user.username })));
  setTimeout(() => input.focus());
}
