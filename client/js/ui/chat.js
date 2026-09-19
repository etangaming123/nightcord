// Chat column: header, message list (with scroll-back), composer.

import { LIMITS } from "../protocol.js";
import { $, avatar, clear, colorFor, h, linkify } from "./dom.js";
import { toast } from "./modals.js";

const GROUP_GAP_MS = 7 * 60 * 1000;
// Unsent text per channel, so re-renders and channel switches don't lose it.
const drafts = new Map();
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

// Returns DOM nodes for message m given the message before it (or null).
function messageNodes(m, prev) {
  const d = new Date(m.sent_at);
  const pd = prev ? new Date(prev.sent_at) : null;
  const nodes = [];
  const newDay = !pd || dayKey(d) !== dayKey(pd);
  if (newDay) nodes.push(h("div", { class: "day-divider", role: "separator" }, relativeDay(d)));
  const continued = !newDay && prev.author_user_id === m.author_user_id && d - pd < GROUP_GAP_MS;
  const body = h("div", { class: "msg-body" }, linkify(m.content));
  if (continued) {
    nodes.push(h("div", { class: "msg msg-line", dataset: { id: m.message_id } }, stamp(d, { short: true }), body));
  } else {
    nodes.push(h("div", { class: "msg msg-group", dataset: { id: m.message_id } },
      avatar(m.author_username, { size: "lg" }),
      h("div", { class: "msg-head" },
        h("span", { class: "msg-author", style: `color:${colorFor(m.author_username)}` }, m.author_username),
        stamp(d)),
      body));
  }
  return nodes;
}

export function renderChatHeader(state, actions) {
  const header = clear($("#chat-header"));
  const channel = state.channels.find((c) => c.channel_id === state.channelId);
  header.append(h("button", {
    class: "icon-btn menu-btn", type: "button", "aria-label": "Open guilds and channels",
    on: { click: () => actions.toggleNav() },
  }, "☰"));
  if (channel) {
    header.append(h("span", { class: "hash", "aria-hidden": "true" }, "#"), h("span", { class: "title" }, channel.name));
  } else {
    header.append(h("span", { class: "title" }, state.guilds.get(state.guildId)?.name || ""));
  }
  if (state.guildId) {
    header.append(h("button", {
      class: "icon-btn members-btn", type: "button", "aria-label": "Show members", title: "Members",
      on: { click: actions.toggleMembers },
    }, "👥"));
  }
}

export function renderChat(state, actions) {
  const box = $("#messages");
  // Re-rendering keeps the viewport anchored to the bottom edge, which is what
  // both live updates and prepending older history want.
  const fromBottom = box.scrollHeight - box.scrollTop;
  box.onscroll = null;
  clear(box);
  const guild = state.guilds.get(state.guildId);
  const channel = state.channels.find((c) => c.channel_id === state.channelId);

  if (!state.user) return;
  if (!state.guilds.size) {
    box.append(h("div", { class: "empty-state" },
      h("h2", {}, "No guilds yet"),
      h("p", {}, "Create a guild, join one with an invite code, or browse the public list."),
      h("button", { class: "btn primary", type: "button", on: { click: actions.addGuild } }, "Create or join a guild")));
    return;
  }
  if (!guild || !channel) {
    if (guild && !state.channels.length && state.members.length) {
      box.append(h("div", { class: "empty-state" }, h("h2", {}, "No channels"),
        h("p", {}, actions.isGuildOwner() ? "Create one with the + next to “Text channels”." : "The guild owner hasn't created any channels.")));
    }
    return;
  }

  if (state.hasMore) {
    box.append(h("div", { class: "history-edge" }, state.loadingOlder ? "Loading…" : "Scroll up for older messages"));
  } else {
    box.append(h("div", { class: "channel-intro" },
      h("h2", {}, `Welcome to #${channel.name}`),
      h("p", {}, `This is the start of #${channel.name} in ${guild.name}.`)));
  }
  let prev = null;
  const frag = document.createDocumentFragment();
  for (const m of state.messages) {
    frag.append(...messageNodes(m, prev));
    prev = m;
  }
  box.append(frag);
  box.scrollTop = box.scrollHeight - fromBottom;
  box.onscroll = () => {
    if (box.scrollTop < LOAD_OLDER_PX) actions.loadOlder();
  };
}

export function appendMessage(state, m) {
  const box = $("#messages");
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM_PX;
  const prev = state.messages[state.messages.length - 2] || null;
  box.append(...messageNodes(m, prev));
  const mine = m.author_user_id === state.user?.user_id;
  if (nearBottom || mine) scrollToBottom();
}

export function scrollToBottom() {
  const box = $("#messages");
  box.scrollTop = box.scrollHeight;
}

export function renderComposer(state, actions) {
  const form = clear($("#composer"));
  form.onsubmit = null;
  const guild = state.guilds.get(state.guildId);
  const channel = state.channels.find((c) => c.channel_id === state.channelId);
  if (!guild || !channel) return;
  if (guild.ghost) {
    form.append(h("div", { class: "readonly" }, "👻 Ghost view — you can read this guild, but not post. Members can't see you."));
    return;
  }

  const input = h("textarea", {
    rows: 1, placeholder: `Message #${channel.name}`, "aria-label": `Message #${channel.name}`,
    maxLength: LIMITS.CONTENT_MAX_CHARS + 500, disabled: !state.connected,
  });
  input.value = drafts.get(channel.channel_id) || "";
  const count = h("div", { class: "count", hidden: true });
  const send = h("button", { class: "btn primary", type: "submit", disabled: true }, "Send");

  const autosize = () => {
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
    const n = input.value.trim().length;
    count.hidden = n < LIMITS.CONTENT_MAX_CHARS - 200;
    count.textContent = `${n} / ${LIMITS.CONTENT_MAX_CHARS}`;
    count.classList.toggle("over", n > LIMITS.CONTENT_MAX_CHARS);
    send.disabled = !state.connected || n === 0 || n > LIMITS.CONTENT_MAX_CHARS;
    if (input.value) drafts.set(channel.channel_id, input.value);
    else drafts.delete(channel.channel_id);
  };

  const submit = async () => {
    const content = input.value.trim();
    if (!content || content.length > LIMITS.CONTENT_MAX_CHARS || !state.connected) return;
    input.value = "";
    autosize();
    try {
      await actions.sendMessage(content);
    } catch (e) {
      // Put the text back so nothing is lost.
      if (!input.value) input.value = content;
      autosize();
      toast(e.message, { error: true });
    }
    input.focus();
  };

  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  form.onsubmit = (e) => {
    e.preventDefault();
    submit();
  };
  form.append(h("div", { class: "box" }, input, send), count);
  autosize();
  if (state.connected && matchMedia("(pointer: fine)").matches) input.focus();
}
