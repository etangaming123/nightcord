// Chat column: header, message list (with scroll-back, toolbar, inline edit,
// reactions, replies, unread divider) and the typing line.

import { LIMITS } from "../protocol.js";
import {
  STAFF_LABEL, can, channelById, channelTitle, currentChannel, currentGuild, isBlocked, isDm, isPrivate, mentionsMe,
  nameOf, statusOf, userById,
} from "../state.js";
import { renderAttachments } from "./attachments.js";
import { commandHeader, commandResult } from "./commands.js";
import { forwardCard, messageMenuHandlers } from "./messageMenu.js";
import { renderEmbeds } from "./embeds.js";
import { renderPoll } from "./polls.js";
import { messageQuote } from "./quote.js";
import { $, add, avatar, clear, h, iconBtn, idGt } from "./dom.js";
import { renderFriendsHeader, renderFriendsPage } from "./friends.js";
import { QUICK_REACTIONS, customOf, emojiGlyph } from "./emoji.js";
import { jumboCount, plainText, render as renderMarkdown } from "./markdown.js";
import { badgeEls, nameAttrs, roleIconEl } from "./names.js";
import { stickerImg } from "./stickers.js";
import { scopedT } from "../strings.js";
import { icon } from "./icons.js";
import { renderHomeHeader, renderHomePage } from "./home.js";

const t = scopedT("ui/chat");
const tc = scopedT("common");

const displayName = (u) => nameOf(u);

const GROUP_GAP_MS = 7 * 60 * 1000;
const NEAR_BOTTOM_PX = 120;
const LOAD_OLDER_PX = 240;

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" });

function dayKey(d) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function relativeDay(d) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(d) === dayKey(today)) return t("today");
  if (dayKey(d) === dayKey(yesterday)) return t("yesterday");
  return dayFmt.format(d);
}

function stamp(d, { short = false } = {}) {
  const label = short ? timeFmt.format(d) : t("time_full", { day: relativeDay(d), time: timeFmt.format(d) });
  return h("time", { class: "msg-time", datetime: d.toISOString(), title: fullFmt.format(d) }, label);
}

// Latest known profile for a message author.
const authorOf = (m) => userById(m.author?.user_id) || m.author;

export function mdContext(state, actions) {
  return {
    user: userById,
    meId: state.user?.user_id,
    onMention: (id, el) => actions.openProfile(id, el),
    onEmoji: (emoji, el) => actions.emojiInfo(emoji, el),
    channel: channelById,
    onChannel: (id) => actions.openChannelById(id),
    quote: (href) => messageQuote(href, actions),
  };
}

// --- header ----------------------------------------------------------------

export function renderChatHeader(state, actions) {
  const header = clear($("#chat-header"));
  const channel = currentChannel();
  add(header, iconBtn("menu", t("open_nav"), () => actions.toggleNav(), { cls: "menu-btn" }));
  if (channel && isDm(channel)) {
    const others = channel.recipients.filter((u) => u.user_id !== state.user?.user_id);
    if (channel.kind === "dm" && others[0]) {
      const u = userById(others[0].user_id) || others[0];
      add(header, avatar(u, { size: "sm", status: statusOf(u.user_id) }));
    } else {
      add(header, h("span", { class: "hash", "aria-hidden": "true" }, icon("users")));
    }
    add(header, h("span", { class: "title" }, channelTitle(channel)));
    add(header, h("span", { class: "grow" }));
    add(header, iconBtn("pin", t("pinned_messages"), (e) => actions.showPins(e.currentTarget)));
    add(header, iconBtn("bookmark", t("saved_messages"), (e) => actions.showSaved(e.currentTarget)));
    if (channel.kind === "group_dm") {
      add(header, iconBtn("pencil", t("rename_group"), () => actions.renameGroup(channel)));
      add(header, iconBtn("plus", t("add_people"), () => actions.addToGroup(channel)));
      add(header, iconBtn("users", t("show_members"), actions.toggleMembers, { cls: "members-btn" }));
    }
    add(header, searchButton(actions));
  } else if (channel) {
    add(header,
      h("span", { class: "hash", "aria-hidden": "true", title: isPrivate(channel) ? t("private_channel") : null }, isPrivate(channel) ? icon("lock") : "#"),
      h("span", { class: "title" }, channel.name),
      channel.topic ? h("button", {
        class: "topic", type: "button", title: channel.topic,
        on: { click: () => actions.showTopic(channel) },
      }, renderMarkdown(channel.topic.split("\n")[0], { ...mdContext(state, actions), plainLinks: true })) : h("span", { class: "grow" }),
    );
    if (channel.slowmode_seconds) add(header, h("span", { class: "slow-tag", title: t("slowmode_title", { seconds: channel.slowmode_seconds }) }, icon("turtle")));
    if (can("CREATE_INVITE") && !currentGuild()?.ghost) add(header, iconBtn("user-plus", t("invite_people"), () => actions.openInviteDialog(), { cls: "hide-narrow" }));
    add(header, iconBtn("pin", t("pinned_messages"), (e) => actions.showPins(e.currentTarget)));
    add(header, iconBtn("bookmark", t("saved_messages"), (e) => actions.showSaved(e.currentTarget), { cls: "hide-narrow" }));
    add(header, iconBtn("users", t("show_members"), actions.toggleMembers, { cls: "members-btn" }));
    add(header, searchButton(actions));
  } else if (state.view === "home") {
    if (state.homeTab === "home") renderHomeHeader(header);
    else renderFriendsHeader(header, state, actions);
  } else {
    add(header, h("span", { class: "title" }, currentGuild()?.name || ""));
  }
}

function searchButton(actions) {
  return h("button", {
    class: "search-btn", type: "button", title: t("search_title"), "aria-label": t("search_aria"),
    on: { click: () => actions.showSearch() },
  }, h("span", {}, t("search_label")), icon("search"));
}

// --- message list ----------------------------------------------------------

const JOIN_LINES = [
  (n) => [n, t("join_line_1_suffix")],
  (n) => [t("join_line_2_before"), n, t("join_line_2_after")],
  (n) => [t("join_line_3_before"), n, t("join_line_3_after")],
  (n) => [n, t("join_line_4_suffix")],
  (n) => [n, t("join_line_5_suffix")],
  (n) => [t("join_line_6_before"), n, t("join_line_6_after")],
  (n) => [t("join_line_7_before"), n, t("join_line_7_after")],
  (n) => [n, t("join_line_8_suffix")],
];

// Join / leave / pin lines (PROTOCOL.md §4 Message: system messages).
function systemNodes(m, state, actions) {
  const d = new Date(m.sent_at);
  const author = authorOf(m);
  const who = h("button", { class: "sys-name", type: "button", on: { click: (e) => actions.openProfile(author.user_id, e.currentTarget) } }, displayName(author));
  let icon;
  let text;
  if (m.type === "member_join") {
    icon = h("span", { class: "sys-icon join", "aria-hidden": "true" }, "→");
    text = JOIN_LINES[Number(BigInt(m.message_id) % BigInt(JOIN_LINES.length))](who);
  } else if (m.type === "member_leave") {
    icon = h("span", { class: "sys-icon leave", "aria-hidden": "true" }, "←");
    text = [who, t("leave_suffix")];
  } else {
    icon = h("span", { class: "sys-icon sys-pin", "aria-hidden": "true" }, icon("pin"));
    text = [who, t("pin_prefix"),
      m.reply_to_id ? h("button", { class: "btn link", type: "button", on: { click: () => actions.jumpTo(m.reply_to_id) } }, t("pin_message_link")) : t("pin_message_link"),
      t("pin_suffix"),
      h("button", { class: "btn link", type: "button", on: { click: (e) => actions.showPins(e.currentTarget) } }, t("pin_see_all")), "."];
  }
  return h("div", { class: "msg msg-system", dataset: { id: m.message_id } },
    icon, h("span", { class: "sys-text" }, text), stamp(d),
    reactionsRow(m, state, actions), toolbar(m, state, actions));
}

function replyPreview(m, state, actions) {
  if (!m.reply_to_id) return null;
  const r = m.reply_to;
  if (!r) {
    return h("div", { class: "reply-preview missing" }, h("span", { class: "reply-spine", "aria-hidden": "true" }), t("reply_deleted"));
  }
  const author = userById(r.author?.user_id) || r.author;
  return h("div", {
    class: "reply-preview", role: "button", tabindex: "0", title: t("jump_to_message"),
    on: { click: () => actions.jumpTo(r.message_id), keydown: (e) => { if (e.key === "Enter") actions.jumpTo(r.message_id); } },
  },
  h("span", { class: "reply-spine", "aria-hidden": "true" }),
  avatar(author, { size: "xs" }),
  h("span", nameAttrs(author?.user_id, "reply-author"), displayName(author)),
  h("span", { class: "reply-text" }, plainText(r.content, mdContext(state, actions)).replace(/\s+/g, " ")));
}

function reactionsRow(m, state, actions) {
  if (!m.reactions?.length) return null;
  const me = state.user?.user_id;
  const channel = currentChannel();
  const canReact = channel && can("ADD_REACTIONS", channel);
  return h("div", { class: "reactions" },
    m.reactions.map((r) => {
      const mine = r.user_ids.includes(me);
      const names = r.user_ids.slice(0, 10).map((id) => displayName(userById(id) || { username: t("someone") }));
      const more = r.user_ids.length > 10 ? t("reaction_and_more", { count: r.user_ids.length - 10 }) : "";
      const custom = customOf(r.emoji);
      const label = custom ? `:${custom.name}:` : r.emoji;
      return h("button", {
        class: `reaction ${mine ? "mine" : ""}`, type: "button",
        title: t("reaction_tooltip", { names: names.join(", "), more, label }),
        "aria-pressed": String(mine), disabled: !mine && !canReact,
        on: { click: () => (mine ? actions.unreact(m, r.emoji) : actions.react(m, r.emoji)) },
      }, emojiGlyph(r.emoji), h("span", { class: "count" }, String(r.user_ids.length)));
    }),
    canReact ? h("button", {
      class: "reaction add", type: "button", title: t("add_reaction"), "aria-label": t("add_reaction"),
      on: { click: (e) => actions.pickReaction(m, e.currentTarget) },
    }, icon("smile-plus")) : null);
}

function toolbar(m, state, actions) {
  const channel = currentChannel();
  const system = m.type && m.type !== "default";
  const mine = m.author?.user_id === state.user?.user_id && !system;
  const canReact = channel && can("ADD_REACTIONS", channel);
  const canSend = channel && can("SEND_MESSAGES", channel);
  const canDelete = mine || (channel && !isDm(channel) && can("MANAGE_MESSAGES", channel));
  const canPin = !system && channel && (isDm(channel) || can("MANAGE_MESSAGES", channel));
  if (!state.connected) return null;
  return h("div", { class: "msg-toolbar", role: "toolbar", "aria-label": t("message_actions") },
    canReact ? QUICK_REACTIONS.slice(0, 3).map((e) => iconBtn(e, t("react_with", { emoji: e }), () => actions.react(m, e), { cls: "quick" })) : null,
    canReact ? iconBtn("smile-plus", t("add_reaction"), (e) => actions.pickReaction(m, e.currentTarget)) : null,
    canSend && !system ? iconBtn("reply", t("reply"), () => actions.reply(m)) : null,
    mine && canSend ? iconBtn("pencil", t("edit"), () => actions.startEdit(m)) : null,
    !system ? iconBtn("bookmark", actions.isSaved(m) ? t("unsave") : t("save"), () => actions.toggleSaved(m), { cls: actions.isSaved(m) ? "on" : "" }) : null,
    canPin ? iconBtn("pin", m.pinned ? t("unpin_with_hint") : t("pin_with_hint"), (e) => (m.pinned ? actions.unpinMessage(m, e.shiftKey) : actions.pinMessage(m, e.shiftKey)), { cls: m.pinned ? "on" : "" }) : null,
    canDelete ? iconBtn("trash-2", t("delete_with_hint"), (e) => actions.deleteMessage(m, e.shiftKey), { cls: "danger" }) : null,
    iconBtn("ellipsis", t("more_actions"), (e) => actions.showMessageMenu(m, e.currentTarget)),
  );
}

function editBox(m, state, actions) {
  const input = h("textarea", { class: "edit-input", rows: 1, maxLength: LIMITS.CONTENT_MAX_CHARS + 500, "aria-label": t("edit_message_aria") });
  input.value = state.editDraft;
  const autosize = () => {
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  };
  input.addEventListener("input", () => { state.editDraft = input.value; autosize(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); actions.cancelEdit(); }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); actions.saveEdit(m, input.value); }
  });
  requestAnimationFrame(() => {
    autosize();
    if (document.activeElement !== input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });
  return h("div", { class: "edit-box" }, input,
    h("div", { class: "edit-hint muted small" }, t("edit_hint_before"),
      h("button", { class: "btn link", type: "button", on: { click: actions.cancelEdit } }, t("edit_hint_cancel")),
      t("edit_hint_middle"),
      h("button", { class: "btn link", type: "button", on: { click: () => actions.saveEdit(m, input.value) } }, t("edit_hint_save"))));
}

const shownBlocked = new Set();

// DOM nodes for message m given the message before it (or null).
function messageNodes(m, prev, state, actions) {
  const d = new Date(m.sent_at);
  const pd = prev ? new Date(prev.sent_at) : null;
  const nodes = [];
  const newDay = !pd || dayKey(d) !== dayKey(pd);
  if (newDay) nodes.push(h("div", { class: "day-divider", role: "separator" }, relativeDay(d)));
  if (state.unreadMarker && idGt(m.message_id, state.unreadMarker) && (!prev || !idGt(prev.message_id, state.unreadMarker))) {
    nodes.push(h("div", { class: "new-divider", role: "separator" }, h("span", {}, "NEW")));
  }
  if (m.type && m.type !== "default") {
    nodes.push(systemNodes(m, state, actions));
    return nodes;
  }
  const author = authorOf(m);
  // Messages from people you blocked stay folded until you ask to see them.
  if (isBlocked(author?.user_id) && !shownBlocked.has(m.message_id)) {
    nodes.push(h("div", { class: "msg msg-blocked", dataset: { id: m.message_id } },
      icon("ban"), t("blocked_message"),
      h("button", {
        class: "btn link", type: "button",
        on: { click: () => { shownBlocked.add(m.message_id); actions.refreshChat(); } },
      }, t("blocked_show"))));
    return nodes;
  }
  const continued = !newDay && !m.reply_to_id && prev.author?.user_id === m.author?.user_id
    && (!prev.type || prev.type === "default") && d - pd < GROUP_GAP_MS;
  const editing = state.editingId === m.message_id;
  const jumbo = !editing && m.content && jumboCount(m.content) > 0;
  const body = editing
    ? editBox(m, state, actions)
    : h("div", { class: `msg-body ${jumbo ? "jumbo" : ""}` },
      m.content ? renderMarkdown(m.content, mdContext(state, actions)) : null,
      m.edited_at ? h("span", { class: "edited", title: `Edited ${fullFmt.format(new Date(m.edited_at))}` }, " (edited)") : null);
  const files = editing ? null : [
    forwardCard(m, actions),
    commandResult(m.command),
    renderPoll(m, actions),
    renderAttachments(m),
    renderEmbeds(m, actions),
    m.stickers?.length ? h("div", { class: "msg-stickers" }, m.stickers.map((st) => stickerImg(st))) : null,
  ];
  const cls = `msg ${mentionsMe(m) ? "mentioned" : ""} ${editing ? "editing" : ""} ${m.pinned ? "pinned" : ""}`;
  const profile = (e) => actions.openProfile(author.user_id, e.currentTarget);
  const menu = messageMenuHandlers(m, actions);
  if (continued) {
    nodes.push(h("div", { class: `${cls} msg-line`, dataset: { id: m.message_id }, on: menu },
      stamp(d, { short: true }), commandHeader(m.command), body, files,
      reactionsRow(m, state, actions), editing ? null : toolbar(m, state, actions)));
  } else {
    nodes.push(h("div", { class: `${cls} msg-group`, dataset: { id: m.message_id }, on: menu },
      replyPreview(m, state, actions),
      h("button", { class: "avatar-btn", type: "button", "aria-label": t("profile_aria", { name: displayName(author) }), on: { click: profile } }, avatar(author, { size: "lg" })),
      h("div", { class: "msg-head" },
        h("button", { ...nameAttrs(author?.user_id, "msg-author"), type: "button", on: { click: profile } }, displayName(author)),
        roleIconEl(author?.user_id),
        badgeEls(author),
        STAFF_LABEL[author?.server_role] ? h("span", { class: `tag staff ${author.server_role}`, title: STAFF_LABEL[author.server_role] },
          { owner: "OWNER", admin: "ADMIN", moderator: "MOD" }[author.server_role]) : null,
        stamp(d)),
      commandHeader(m.command),
      body,
      files,
      reactionsRow(m, state, actions),
      editing ? null : toolbar(m, state, actions)));
  }
  return nodes;
}

function emptyState(state, actions) {
  if (state.view === "home") return state.homeTab === "home" ? renderHomePage(state, actions) : renderFriendsPage(state, actions);
  if (!state.guilds.size) {
    return h("div", { class: "empty-state" },
      h("h2", {}, t("no_guilds_title")),
      h("p", {}, t("no_guilds_body")),
      h("button", { class: "btn primary", type: "button", on: { click: actions.addGuild } }, t("no_guilds_cta")));
  }
  return null;
}

export function renderChat(state, actions) {
  const box = $("#messages");
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM_PX;
  const fromBottom = box.scrollHeight - box.scrollTop;
  const fromTop = box.scrollTop;
  box.onscroll = null;
  clear(box);
  const channel = currentChannel();
  if (!state.user) return;
  if (!channel) {
    const empty = emptyState(state, actions);
    if (empty) add(box, empty);
    return;
  }

  if (state.hasMore) {
    add(box, h("div", { class: "history-edge" }, state.loadingOlder ? tc("loading") : t("scroll_older")));
  } else if (isDm(channel)) {
    const others = channel.recipients.filter((u) => u.user_id !== state.user.user_id);
    add(box, h("div", { class: "channel-intro" },
      channel.kind === "dm" && others[0] ? avatar(userById(others[0].user_id) || others[0], { size: "xl" }) : null,
      h("h2", {}, channelTitle(channel)),
      h("p", {}, channel.kind === "dm"
        ? t("dm_intro_body", { name: channelTitle(channel) })
        : t("group_intro_body"))));
  } else {
    add(box, h("div", { class: "channel-intro" },
      h("div", { class: "intro-icon", "aria-hidden": "true" }, "#"),
      h("h2", {}, t("channel_intro_title", { name: channel.name })),
      h("p", {}, t("channel_intro_body", { channel: channel.name, guild: currentGuild()?.name || t("this_guild_fallback") })),
      channel.topic ? h("p", { class: "muted topic-intro" }, renderMarkdown(channel.topic, mdContext(state, actions))) : null));
  }
  if (!can("READ_HISTORY", channel) && !state.messages.length) {
    add(box, h("p", { class: "muted small pad" }, t("no_history")));
  }
  let prev = null;
  const frag = document.createDocumentFragment();
  for (const m of state.messages) {
    add(frag, ...messageNodes(m, prev, state, actions));
    prev = m;
  }
  add(box, frag);
  if (state.hasMoreAfter) {
    add(box, h("div", { class: "history-edge" }, state.loadingOlder ? tc("loading") : t("scroll_newer")));
  }
  drawBars(state, actions, box);

  if (state.scrollTo === "bottom") {
    box.scrollTop = box.scrollHeight;
  } else if (state.scrollTo === "unread") {
    const divider = box.querySelector(".new-divider");
    if (divider) box.scrollTop = Math.max(0, divider.offsetTop - box.clientHeight / 3);
    else box.scrollTop = box.scrollHeight;
  } else if (state.scrollTo === "prepend") {
    box.scrollTop = box.scrollHeight - fromBottom;
  } else if (nearBottom && !state.hasMoreAfter) {
    box.scrollTop = box.scrollHeight;
  } else {
    box.scrollTop = fromTop;
  }
  state.scrollTo = null;
  pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 4;
  box.onscroll = () => {
    pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 4;
    if (box.scrollTop < LOAD_OLDER_PX) actions.loadOlder();
    if (box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM_PX) {
      if (state.hasMoreAfter) actions.loadNewer();
      else actions.seenBottom();
    }
    // Scrolling alone decides whether the jump bar belongs on screen.
    const away = state.hasMoreAfter
      || box.scrollHeight - box.scrollTop - box.clientHeight > box.clientHeight * TWO_SCREENS;
    if (away !== !!$("#jump-present")) drawBars(state, actions, box);
  };
}

// Two bars over the message list:
//  - the top one counts what arrived since you last read, and marks it read;
//  - the bottom one gets you back to the present, whether you scrolled up or
//    jumped into the past.
const TWO_SCREENS = 2;

function drawBars(state, actions, box) {
  $("#jump-present")?.remove();
  $("#new-bar")?.remove();
  const chat = $("#chat");
  const away = state.hasMoreAfter
    || box.scrollHeight - box.scrollTop - box.clientHeight > box.clientHeight * TWO_SCREENS;
  if (away) {
    chat.append(h("button", {
      id: "jump-present", class: "jump-present", type: "button",
      on: { click: () => (state.hasMoreAfter ? actions.jumpToPresent() : scrollToBottom()) },
    }, t("viewing_older"), h("strong", {}, t("jump_to_present"))));
  }
  // The NEW divider tells us where unread starts; count from there.
  const first = state.messages.findIndex((m) => idGt(m.message_id, state.unreadMarker));
  if (state.unreadMarker && first >= 0) {
    const unread = state.messages.slice(first);
    const since = new Date(unread[0].sent_at);
    chat.append(h("div", { id: "new-bar", class: "new-bar" },
      h("span", { class: "grow" }, t("new_since", { count: unread.length, time: timeFmt.format(since) })),
      h("button", {
        class: "btn link", type: "button",
        on: { click: () => actions.markChannelRead(state.channelId) },
      }, t("mark_as_read"))));
  }
}

function scrollToBottom() {
  const box = $("#messages");
  box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
}

// Images and videos load after rendering; keep a bottom-pinned chat pinned.
let pinned = true;
export function mediaLoaded() {
  const box = $("#messages");
  if (pinned) box.scrollTop = box.scrollHeight;
}

export const isNearBottom = () => {
  const box = $("#messages");
  return box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM_PX;
};

export function flashMessage(messageId) {
  const el = document.querySelector(`#messages [data-id="${CSS.escape(messageId)}"]`);
  if (!el) return false;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
  return true;
}

// --- typing line -----------------------------------------------------------

export function renderTyping(state) {
  const el = clear($("#typing"));
  const now = Date.now();
  const names = [];
  for (const [uid, until] of state.typing) {
    if (until > now && uid !== state.user?.user_id) names.push(displayName(userById(uid) || { username: t("someone") }));
  }
  if (!names.length) return;
  const text = names.length === 1 ? t("typing_one", { name: names[0] })
    : names.length === 2 ? t("typing_two", { name1: names[0], name2: names[1] })
      : names.length === 3 ? t("typing_three", { name1: names[0], name2: names[1], name3: names[2] })
        : t("typing_many");
  add(el, h("span", { class: "typing-dots", "aria-hidden": "true" }, h("i"), h("i"), h("i")), h("strong", {}, text));
}
