// Chat column: header, message list (with scroll-back, toolbar, inline edit,
// reactions, replies, unread divider) and the typing line.

import { LIMITS } from "../protocol.js";
import {
  STAFF_LABEL, can, channelTitle, currentChannel, currentGuild, isDm, isPrivate, mentionsMe, nameOf, roleColor,
  statusOf, userById,
} from "../state.js";
import { renderAttachments } from "./attachments.js";
import { $, add, avatar, clear, h, iconBtn, idGt } from "./dom.js";
import { QUICK_REACTIONS } from "./emoji.js";
import { plainText, render as renderMarkdown } from "./markdown.js";

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
  if (dayKey(d) === dayKey(today)) return "Today";
  if (dayKey(d) === dayKey(yesterday)) return "Yesterday";
  return dayFmt.format(d);
}

function stamp(d, { short = false } = {}) {
  const label = short ? timeFmt.format(d) : `${relativeDay(d)} at ${timeFmt.format(d)}`;
  return h("time", { class: "msg-time", datetime: d.toISOString(), title: fullFmt.format(d) }, label);
}

// Latest known profile for a message author.
const authorOf = (m) => userById(m.author?.user_id) || m.author;

export function mdContext(state, actions) {
  return {
    user: userById,
    meId: state.user?.user_id,
    onMention: (id, el) => actions.openProfile(id, el),
  };
}

// --- header ----------------------------------------------------------------

export function renderChatHeader(state, actions) {
  const header = clear($("#chat-header"));
  const channel = currentChannel();
  add(header, iconBtn("☰", "Open guilds and channels", () => actions.toggleNav(), { cls: "menu-btn" }));
  if (channel && isDm(channel)) {
    const others = channel.recipients.filter((u) => u.user_id !== state.user?.user_id);
    if (channel.kind === "dm" && others[0]) {
      const u = userById(others[0].user_id) || others[0];
      add(header, avatar(u, { size: "sm", status: statusOf(u.user_id) }));
    } else {
      add(header, h("span", { class: "hash", "aria-hidden": "true" }, "👥"));
    }
    add(header, h("span", { class: "title" }, channelTitle(channel)));
    add(header, h("span", { class: "grow" }));
    add(header, iconBtn("📌", "Pinned messages", (e) => actions.showPins(e.currentTarget)));
    if (channel.kind === "group_dm") {
      add(header, iconBtn("✎", "Rename group", () => actions.renameGroup(channel)));
      add(header, iconBtn("＋", "Add people", () => actions.addToGroup(channel)));
      add(header, iconBtn("👥", "Show members", actions.toggleMembers, { cls: "members-btn" }));
    }
    add(header, searchButton(actions));
  } else if (channel) {
    add(header,
      h("span", { class: "hash", "aria-hidden": "true", title: isPrivate(channel) ? "Private channel" : null }, isPrivate(channel) ? "🔒" : "#"),
      h("span", { class: "title" }, channel.name),
      channel.topic ? h("button", {
        class: "topic", type: "button", title: channel.topic,
        on: { click: () => actions.showTopic(channel) },
      }, renderMarkdown(channel.topic.split("\n")[0], mdContext(state, actions))) : h("span", { class: "grow" }),
    );
    if (channel.slowmode_seconds) add(header, h("span", { class: "slow-tag", title: `Slowmode: one message every ${channel.slowmode_seconds}s` }, "🐢"));
    if (can("CREATE_INVITE") && !currentGuild()?.ghost) add(header, iconBtn("✉", "Invite people", () => actions.openInviteDialog(), { cls: "hide-narrow" }));
    add(header, iconBtn("📌", "Pinned messages", (e) => actions.showPins(e.currentTarget)));
    add(header, iconBtn("👥", "Show members", actions.toggleMembers, { cls: "members-btn" }));
    add(header, searchButton(actions));
  } else {
    add(header, h("span", { class: "title" }, currentGuild()?.name || (state.view === "home" ? "Direct Messages" : "")));
  }
}

function searchButton(actions) {
  return h("button", {
    class: "search-btn", type: "button", title: "Search (Ctrl+F)", "aria-label": "Search messages",
    on: { click: () => actions.showSearch() },
  }, h("span", {}, "Search"), h("span", { "aria-hidden": "true" }, "🔍"));
}

// --- message list ----------------------------------------------------------

const JOIN_LINES = [
  (n) => [n, " joined the party."],
  (n) => ["Welcome, ", n, ". We hope you brought pizza."],
  (n) => ["A wild ", n, " appeared."],
  (n) => [n, " just landed."],
  (n) => [n, " hopped into the guild."],
  (n) => ["Everyone welcome ", n, "!"],
  (n) => ["Glad you're here, ", n, "."],
  (n) => [n, " just showed up!"],
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
    text = [who, " left the guild."];
  } else {
    icon = h("span", { class: "sys-icon sys-pin", "aria-hidden": "true" }, "📌");
    text = [who, " pinned ",
      m.reply_to_id ? h("button", { class: "btn link", type: "button", on: { click: () => actions.jumpTo(m.reply_to_id) } }, "a message") : "a message",
      " to this channel. ",
      h("button", { class: "btn link", type: "button", on: { click: (e) => actions.showPins(e.currentTarget) } }, "See all pinned messages"), "."];
  }
  return h("div", { class: "msg msg-system", dataset: { id: m.message_id } },
    icon, h("span", { class: "sys-text" }, text), stamp(d),
    reactionsRow(m, state, actions), toolbar(m, state, actions));
}

function replyPreview(m, state, actions) {
  if (!m.reply_to_id) return null;
  const r = m.reply_to;
  if (!r) {
    return h("div", { class: "reply-preview missing" }, h("span", { class: "reply-spine", "aria-hidden": "true" }), "Original message was deleted");
  }
  const author = userById(r.author?.user_id) || r.author;
  return h("div", {
    class: "reply-preview", role: "button", tabindex: "0", title: "Jump to message",
    on: { click: () => actions.jumpTo(r.message_id), keydown: (e) => { if (e.key === "Enter") actions.jumpTo(r.message_id); } },
  },
  h("span", { class: "reply-spine", "aria-hidden": "true" }),
  avatar(author, { size: "xs" }),
  h("span", { class: "reply-author", style: roleColor(author?.user_id) ? `color:${roleColor(author.user_id)}` : null }, displayName(author)),
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
      const names = r.user_ids.slice(0, 10).map((id) => displayName(userById(id) || { username: "someone" }));
      const more = r.user_ids.length > 10 ? ` and ${r.user_ids.length - 10} more` : "";
      return h("button", {
        class: `reaction ${mine ? "mine" : ""}`, type: "button",
        title: `${names.join(", ")}${more} reacted with ${r.emoji}`,
        "aria-pressed": String(mine), disabled: !mine && !canReact,
        on: { click: () => (mine ? actions.unreact(m, r.emoji) : actions.react(m, r.emoji)) },
      }, h("span", { class: "emoji" }, r.emoji), h("span", { class: "count" }, String(r.user_ids.length)));
    }),
    canReact ? h("button", {
      class: "reaction add", type: "button", title: "Add reaction", "aria-label": "Add reaction",
      on: { click: (e) => actions.pickReaction(m, e.currentTarget) },
    }, "☺＋") : null);
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
  return h("div", { class: "msg-toolbar", role: "toolbar", "aria-label": "Message actions" },
    canReact ? QUICK_REACTIONS.slice(0, 3).map((e) => iconBtn(e, `React ${e}`, () => actions.react(m, e), { cls: "quick" })) : null,
    canReact ? iconBtn("☺", "Add reaction", (e) => actions.pickReaction(m, e.currentTarget)) : null,
    canSend && !system ? iconBtn("↩", "Reply", () => actions.reply(m)) : null,
    mine && canSend ? iconBtn("✎", "Edit", () => actions.startEdit(m)) : null,
    canPin ? iconBtn("📌", m.pinned ? "Unpin" : "Pin", () => (m.pinned ? actions.unpinMessage(m) : actions.pinMessage(m)), { cls: m.pinned ? "on" : "" }) : null,
    canDelete ? iconBtn("🗑", "Delete (shift-click skips confirmation)", (e) => actions.deleteMessage(m, e.shiftKey), { cls: "danger" }) : null,
  );
}

function editBox(m, state, actions) {
  const input = h("textarea", { class: "edit-input", rows: 1, maxLength: LIMITS.CONTENT_MAX_CHARS + 500, "aria-label": "Edit message" });
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
    h("div", { class: "edit-hint muted small" }, "Escape to ",
      h("button", { class: "btn link", type: "button", on: { click: actions.cancelEdit } }, "cancel"),
      " • Enter to ",
      h("button", { class: "btn link", type: "button", on: { click: () => actions.saveEdit(m, input.value) } }, "save")));
}

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
  const continued = !newDay && !m.reply_to_id && prev.author?.user_id === m.author?.user_id
    && (!prev.type || prev.type === "default") && d - pd < GROUP_GAP_MS;
  const editing = state.editingId === m.message_id;
  const body = editing
    ? editBox(m, state, actions)
    : h("div", { class: "msg-body" },
      m.content ? renderMarkdown(m.content, mdContext(state, actions)) : null,
      m.edited_at ? h("span", { class: "edited", title: `Edited ${fullFmt.format(new Date(m.edited_at))}` }, " (edited)") : null);
  const files = editing ? null : renderAttachments(m);
  const cls = `msg ${mentionsMe(m) ? "mentioned" : ""} ${editing ? "editing" : ""} ${m.pinned ? "pinned" : ""}`;
  const profile = (e) => actions.openProfile(author.user_id, e.currentTarget);
  if (continued) {
    nodes.push(h("div", { class: `${cls} msg-line`, dataset: { id: m.message_id } },
      stamp(d, { short: true }), body, files, reactionsRow(m, state, actions), editing ? null : toolbar(m, state, actions)));
  } else {
    const color = roleColor(author?.user_id);
    nodes.push(h("div", { class: `${cls} msg-group`, dataset: { id: m.message_id } },
      replyPreview(m, state, actions),
      h("button", { class: "avatar-btn", type: "button", "aria-label": `${displayName(author)}'s profile`, on: { click: profile } }, avatar(author, { size: "lg" })),
      h("div", { class: "msg-head" },
        h("button", { class: "msg-author", type: "button", style: color ? `color:${color}` : null, on: { click: profile } }, displayName(author)),
        STAFF_LABEL[author?.server_role] ? h("span", { class: `tag staff ${author.server_role}`, title: STAFF_LABEL[author.server_role] },
          { owner: "OWNER", admin: "ADMIN", moderator: "MOD" }[author.server_role]) : null,
        stamp(d)),
      body,
      files,
      reactionsRow(m, state, actions),
      editing ? null : toolbar(m, state, actions)));
  }
  return nodes;
}

function emptyState(state, actions) {
  if (state.view === "home") {
    return h("div", { class: "empty-state" },
      h("h2", {}, "Direct messages"),
      h("p", {}, "Talk one-on-one or in small groups with anyone on this server."),
      h("button", { class: "btn primary", type: "button", on: { click: actions.newDm } }, "Start a conversation"));
  }
  if (!state.guilds.size) {
    return h("div", { class: "empty-state" },
      h("h2", {}, "No guilds yet"),
      h("p", {}, "Create a guild, join one with an invite code, or browse the public list."),
      h("button", { class: "btn primary", type: "button", on: { click: actions.addGuild } }, "Create or join a guild"));
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
    add(box, h("div", { class: "history-edge" }, state.loadingOlder ? "Loading…" : "Scroll up for older messages"));
  } else if (isDm(channel)) {
    const others = channel.recipients.filter((u) => u.user_id !== state.user.user_id);
    add(box, h("div", { class: "channel-intro" },
      channel.kind === "dm" && others[0] ? avatar(userById(others[0].user_id) || others[0], { size: "xl" }) : null,
      h("h2", {}, channelTitle(channel)),
      h("p", {}, channel.kind === "dm"
        ? `This is the beginning of your direct message history with ${channelTitle(channel)}.`
        : "This is the beginning of this group.")));
  } else {
    add(box, h("div", { class: "channel-intro" },
      h("div", { class: "intro-icon", "aria-hidden": "true" }, "#"),
      h("h2", {}, `Welcome to #${channel.name}`),
      h("p", {}, `This is the start of #${channel.name} in ${currentGuild()?.name || "this guild"}.`),
      channel.topic ? h("p", { class: "muted topic-intro" }, renderMarkdown(channel.topic, mdContext(state, actions))) : null));
  }
  if (!can("READ_HISTORY", channel) && !state.messages.length) {
    add(box, h("p", { class: "muted small pad" }, "You can't read this channel's history — only new messages appear here."));
  }
  let prev = null;
  const frag = document.createDocumentFragment();
  for (const m of state.messages) {
    add(frag, ...messageNodes(m, prev, state, actions));
    prev = m;
  }
  add(box, frag);
  if (state.hasMoreAfter) {
    add(box, h("div", { class: "history-edge" }, state.loadingOlder ? "Loading…" : "Scroll down for newer messages"));
  }
  $("#jump-present")?.remove();
  if (state.hasMoreAfter) {
    $("#chat").append(h("button", {
      id: "jump-present", class: "jump-present", type: "button", on: { click: () => actions.jumpToPresent() },
    }, "You're viewing older messages", h("strong", {}, "Jump to present ↓")));
  }

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
  };
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
    if (until > now && uid !== state.user?.user_id) names.push(displayName(userById(uid) || { username: "Someone" }));
  }
  if (!names.length) return;
  const text = names.length === 1 ? `${names[0]} is typing…`
    : names.length === 2 ? `${names[0]} and ${names[1]} are typing…`
      : names.length === 3 ? `${names[0]}, ${names[1]} and ${names[2]} are typing…`
        : "Several people are typing…";
  add(el, h("span", { class: "typing-dots", "aria-hidden": "true" }, h("i"), h("i"), h("i")), h("strong", {}, text));
}
