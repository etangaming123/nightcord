// Message composer: drafts per channel, reply bar, @mention autocomplete,
// emoji button, typing notifications, ↑ to edit your last message.

import { LIMITS } from "../protocol.js";
import { can, currentChannel, currentGuild, isDm, memberById, state as appState, userById } from "../state.js";
import { $, add, avatar, clear, displayName, h } from "./dom.js";
import { openEmojiPicker } from "./emoji.js";
import { toast } from "./modals.js";

const drafts = new Map(); // channel_id -> text
const TYPING_EVERY_MS = 5000;
const MENTION_TOKEN = /@([A-Za-z0-9_.-]{3,32})/g;

// Who can be @mentioned in the current channel.
function candidates() {
  const ch = currentChannel();
  if (!ch) return [];
  if (isDm(ch)) return ch.recipients.map((u) => userById(u.user_id) || u);
  return appState.members.map((m) => userById(m.user.user_id) || m.user);
}

// "@alice" -> "<@id>" for users who can be mentioned here.
export function toWire(text) {
  const byName = new Map(candidates().map((u) => [u.username.toLowerCase(), u.user_id]));
  return text.replace(MENTION_TOKEN, (all, name) => {
    const id = byName.get(name.toLowerCase());
    return id ? `<@${id}>` : all;
  });
}

// "<@id>" -> "@username" for editing.
export function fromWire(content) {
  return content.replace(/<@(\d{1,20})>/g, (all, id) => {
    const u = userById(id) || memberById(id)?.user;
    return u ? `@${u.username}` : all;
  });
}

export function clearDraft(channelId) {
  drafts.delete(channelId);
}

export function focusComposer() {
  $("#composer textarea")?.focus();
}

export function renderComposer(state, actions) {
  const form = clear($("#composer"));
  form.onsubmit = null;
  const channel = currentChannel();
  if (!channel) return;
  const guild = currentGuild();
  if (guild?.ghost) {
    add(form, h("div", { class: "readonly" }, "👻 Ghost view — you can read this guild, but not post. Members can't see you."));
    return;
  }
  const member = guild ? memberById(state.user.user_id) : null;
  if (member?.timed_out_until && new Date(member.timed_out_until) > new Date()) {
    add(form, h("div", { class: "readonly" }, `⏳ You're timed out until ${new Date(member.timed_out_until).toLocaleString()}.`));
    return;
  }
  if (!can("SEND_MESSAGES", channel)) {
    add(form, h("div", { class: "readonly" }, "You don't have permission to send messages in this channel."));
    return;
  }

  const channelId = channel.channel_id;
  const input = h("textarea", {
    rows: 1, placeholder: `Message ${isDm(channel) ? "@" : "#"}${isDm(channel) ? (channel.name || channel.recipients.filter((u) => u.user_id !== state.user.user_id).map((u) => displayName(userById(u.user_id) || u)).join(", ")) : channel.name}`,
    "aria-label": "Message", maxLength: LIMITS.CONTENT_MAX_CHARS + 500, disabled: !state.connected,
    autocomplete: "off",
  });
  input.value = drafts.get(channelId) || "";
  const count = h("div", { class: "count", hidden: true });
  const send = h("button", { class: "btn primary send", type: "submit", disabled: true, "aria-label": "Send" }, "Send");
  const popup = h("div", { class: "autocomplete", role: "listbox", hidden: true });
  let lastTyping = 0;
  let ac = null; // { start, items, index }

  const autosize = () => {
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
    const n = input.value.trim().length;
    count.hidden = n < LIMITS.CONTENT_MAX_CHARS - 200;
    count.textContent = `${n} / ${LIMITS.CONTENT_MAX_CHARS}`;
    count.classList.toggle("over", n > LIMITS.CONTENT_MAX_CHARS);
    send.disabled = !state.connected || n === 0 || n > LIMITS.CONTENT_MAX_CHARS;
    if (input.value) drafts.set(channelId, input.value);
    else drafts.delete(channelId);
  };

  // --- @mention autocomplete ---
  const closeAc = () => { ac = null; popup.hidden = true; clear(popup); };
  const pickAc = (item) => {
    if (!ac) return;
    const before = input.value.slice(0, ac.start);
    const after = input.value.slice(input.selectionStart);
    const insert = `@${item.username} `;
    input.value = before + insert + after;
    const pos = before.length + insert.length;
    input.setSelectionRange(pos, pos);
    closeAc();
    autosize();
    input.focus();
  };
  const drawAc = () => {
    clear(popup);
    popup.hidden = !ac?.items.length;
    if (!ac) return;
    add(popup, h("div", { class: "ac-title" }, "Members"));
    ac.items.forEach((u, i) => add(popup, h("div", {
      class: `ac-item ${i === ac.index ? "active" : ""}`, role: "option", "aria-selected": String(i === ac.index),
      on: { mousedown: (e) => { e.preventDefault(); pickAc(u); } },
    }, u.everyone ? h("span", { class: "avatar xs everyone", "aria-hidden": "true" }, "@") : avatar(u, { size: "xs" }),
    h("span", { class: "ac-name" }, u.everyone ? "@everyone" : displayName(u)),
    h("span", { class: "ac-sub" }, u.everyone ? "Notify everyone who can see this channel" : u.username))));
  };
  const updateAc = () => {
    const pos = input.selectionStart;
    const m = /(^|\s)@([A-Za-z0-9_.-]{0,32})$/.exec(input.value.slice(0, pos));
    if (!m) { closeAc(); return; }
    const q = m[2].toLowerCase();
    const list = candidates()
      .filter((u) => u.user_id !== state.user.user_id)
      .filter((u) => u.username.toLowerCase().startsWith(q) || (u.display_name || "").toLowerCase().startsWith(q))
      .slice(0, 8);
    if (!isDm(channel) && can("MENTION_EVERYONE", channel) && "everyone".startsWith(q)) {
      list.push({ everyone: true, username: "everyone", user_id: "everyone" });
    }
    ac = { start: pos - m[2].length - 1, items: list, index: 0 };
    drawAc();
  };

  const submit = async () => {
    const raw = input.value.trim();
    if (!raw || raw.length > LIMITS.CONTENT_MAX_CHARS || !state.connected) return;
    const reply = state.replyTo;
    input.value = "";
    autosize();
    closeAc();
    try {
      await actions.sendMessage(toWire(raw), reply);
    } catch (e) {
      // Put the text back so nothing is lost.
      if (!input.value) input.value = raw;
      autosize();
      toast(e.message, { error: true });
    }
    input.focus();
  };

  input.addEventListener("input", () => {
    autosize();
    updateAc();
    if (input.value.trim() && Date.now() - lastTyping > TYPING_EVERY_MS) {
      lastTyping = Date.now();
      actions.typing(channelId);
    }
  });
  input.addEventListener("click", updateAc);
  input.addEventListener("blur", () => setTimeout(closeAc, 100));
  input.addEventListener("keydown", (e) => {
    if (ac?.items.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        ac.index = (ac.index + (e.key === "ArrowDown" ? 1 : -1) + ac.items.length) % ac.items.length;
        drawAc();
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        pickAc(ac.items[ac.index]);
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeAc(); return; }
    }
    if (e.key === "Escape" && state.replyTo) { e.preventDefault(); actions.cancelReply(); return; }
    if (e.key === "ArrowUp" && !input.value) {
      const mine = [...state.messages].reverse().find((m) => m.author?.user_id === state.user.user_id);
      if (mine) { e.preventDefault(); actions.startEdit(mine); }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  form.onsubmit = (e) => {
    e.preventDefault();
    submit();
  };

  const emojiBtn = h("button", {
    class: "icon-btn emoji-btn", type: "button", title: "Emoji", "aria-label": "Insert emoji",
    on: {
      click: (e) => openEmojiPicker(e.currentTarget, (emoji) => {
        const pos = input.selectionStart ?? input.value.length;
        input.value = input.value.slice(0, pos) + emoji + input.value.slice(input.selectionEnd ?? pos);
        input.setSelectionRange(pos + emoji.length, pos + emoji.length);
        autosize();
        input.focus();
      }, { placement: "top" }),
    },
  }, "☺");

  let replyBar = null;
  if (state.replyTo) {
    const r = state.replyTo;
    const author = userById(r.author?.user_id) || r.author;
    const mine = author?.user_id === state.user.user_id;
    replyBar = h("div", { class: "reply-bar" },
      h("span", {}, "Replying to ", h("strong", {}, displayName(author))),
      mine ? null : h("button", {
        class: `btn link ping ${state.replyPing ? "on" : ""}`, type: "button",
        title: state.replyPing ? "They'll be notified — click to turn off" : "They won't be notified — click to turn on",
        on: { click: () => { state.replyPing = !state.replyPing; actions.rerenderComposer(); } },
      }, state.replyPing ? "@ON" : "@OFF"),
      h("button", { class: "icon-btn", type: "button", title: "Cancel reply", "aria-label": "Cancel reply", on: { click: actions.cancelReply } }, "✕"));
  }

  add(form, ...[popup, replyBar, h("div", { class: `box ${replyBar ? "with-reply" : ""}` }, emojiBtn, input, send), count].filter(Boolean));
  autosize();
  if (state.connected && matchMedia("(pointer: fine)").matches && !state.editingId) input.focus();
}
