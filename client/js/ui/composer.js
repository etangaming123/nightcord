// Message composer: drafts per channel, reply bar, @mention and :emoji:
// autocomplete, emoji and sticker buttons, attachments (button, paste, drag
// and drop), slowmode, typing notifications, ↑ to edit your last message.

import { emojiByName, emojiToken, searchEmojis, usableStickerGroups } from "../perks.js";
import { LIMITS } from "../protocol.js";
import { can, currentChannel, currentGuild, isDm, memberById, mutedUntil, nameOf, state as appState, userById } from "../state.js";
import { addFiles, removePending, uploading } from "../uploads.js";
import { $, add, avatar, clear, fmtBytes, h } from "./dom.js";
import { UNICODE_EMOJI, customOf, emojiGlyph, openEmojiPicker } from "./emoji.js";
import { toast } from "./modals.js";
import { openStickerPicker } from "./stickers.js";
import { scopedT } from "../strings.js";

const t = scopedT("ui/composer");

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

// Custom emoji are typed as :name: and sent as <:name:id> (PROTOCOL.md §4 Emoji).
const EMOJI_NAME_TOKEN = /(?<![<\w]|<a):([A-Za-z0-9_]{2,32}):(?!\d)/g;

// "@alice" -> "<@id>" for users who can be mentioned here; ":name:" -> <:name:id>.
export function toWire(text) {
  const byName = new Map(candidates().map((u) => [u.username.toLowerCase(), u.user_id]));
  return text.replace(MENTION_TOKEN, (all, name) => {
    const id = byName.get(name.toLowerCase());
    return id ? `<@${id}>` : all;
  }).replace(EMOJI_NAME_TOKEN, (all, name) => {
    const e = emojiByName(name);
    return e ? emojiToken(e) : all;
  });
}

// "<@id>" -> "@username" and <:name:id> -> ":name:" (when it maps back) for editing.
export function fromWire(content) {
  return content.replace(/<@(\d{1,20})>/g, (all, id) => {
    const u = userById(id) || memberById(id)?.user;
    return u ? `@${u.username}` : all;
  }).replace(/<a?:([A-Za-z0-9_]{2,32}):(\d{1,20})>/g, (all, name, id) => (emojiByName(name)?.emoji_id === id ? `:${name}:` : all));
}

export function clearDraft(channelId) {
  drafts.delete(channelId);
}

export function focusComposer() {
  $("#composer textarea")?.focus();
}

let slowTimer = null;

// Seconds left before this channel's slowmode lets you send again.
function slowmodeLeft(channel) {
  const until = appState.slowmodeUntil.get(channel.channel_id) || 0;
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

const canAttach = (channel) => can("ATTACH_FILES", channel);

// Drag files anywhere over the chat to attach them.
export function setupDropZone() {
  const chat = $("#chat");
  let depth = 0;
  const overlay = h("div", { class: "drop-overlay", hidden: true }, h("div", {}, h("strong", {}, t("drop_overlay_title")), h("span", { class: "muted" }, t("drop_overlay_body"))));
  chat.append(overlay);
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  const usable = () => { const ch = currentChannel(); return ch && can("SEND_MESSAGES", ch) && canAttach(ch) && !mutedUntil(); };
  chat.addEventListener("dragenter", (e) => { if (!hasFiles(e) || !usable()) return; e.preventDefault(); depth++; overlay.hidden = false; });
  chat.addEventListener("dragover", (e) => { if (hasFiles(e) && usable()) e.preventDefault(); });
  chat.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) overlay.hidden = true; });
  chat.addEventListener("drop", (e) => {
    depth = 0;
    overlay.hidden = true;
    if (!hasFiles(e) || !usable()) return;
    e.preventDefault();
    addFiles([...e.dataTransfer.files]);
    focusComposer();
  });
}

function uploadTray(state) {
  if (!state.pending.length) return null;
  return h("div", { class: "upload-tray", role: "list", "aria-label": t("attachments_aria") }, state.pending.map((p) => h("div", {
    class: `upload ${p.error ? "failed" : p.attachment ? "done" : "busy"}`, role: "listitem", dataset: { upload: String(p.id) },
  },
  p.preview ? h("img", { class: "up-thumb", src: p.preview, alt: "" }) : h("span", { class: "up-thumb icon", "aria-hidden": "true" }, "📄"),
  h("span", { class: "up-name", title: p.name }, p.name),
  h("span", { class: "up-size" }, p.error ? p.error : fmtBytes(p.size)),
  p.attachment || p.error ? null : h("span", { class: "up-bar", "aria-hidden": "true" }, h("i", { style: `width:${Math.round(p.progress * 100)}%` })),
  h("button", { class: "icon-btn up-x", type: "button", title: t("remove_upload"), "aria-label": t("remove_upload_aria", { name: p.name }), on: { click: () => removePending(p.id) } }, "✕"))));
}

export function renderComposer(state, actions) {
  const form = clear($("#composer"));
  form.onsubmit = null;
  const channel = currentChannel();
  if (!channel) return;
  const guild = currentGuild();
  if (guild?.ghost) {
    add(form, h("div", { class: "readonly" }, t("ghost_view")));
    return;
  }
  const member = guild ? memberById(state.user.user_id) : null;
  if (member?.timed_out_until && new Date(member.timed_out_until) > new Date()) {
    add(form, h("div", { class: "readonly" }, t("timed_out_until", { date: new Date(member.timed_out_until).toLocaleString() })));
    return;
  }
  if (!can("SEND_MESSAGES", channel)) {
    add(form, h("div", { class: "readonly" }, t("no_send_permission")));
    return;
  }
  const muted = mutedUntil();
  if (muted) {
    add(form, h("div", { class: "readonly" }, muted === "permanent"
      ? t("muted_permanent")
      : t("muted_until", { date: new Date(muted).toLocaleString() })));
    return;
  }

  const channelId = channel.channel_id;
  const dmName = channel.name || channel.recipients.filter((u) => u.user_id !== state.user.user_id).map((u) => nameOf(userById(u.user_id) || u, null)).join(", ");
  const input = h("textarea", {
    rows: 1, placeholder: isDm(channel) ? t("message_dm_placeholder", { name: dmName }) : t("message_channel_placeholder", { name: channel.name }),
    "aria-label": t("message_aria"), maxLength: LIMITS.CONTENT_MAX_CHARS + 500, disabled: !state.connected,
    autocomplete: "off",
  });
  input.value = drafts.get(channelId) || "";
  const count = h("div", { class: "count", hidden: true });
  const send = h("button", { class: "btn primary send", type: "submit", disabled: true, "aria-label": t("send_aria") }, t("send"));
  const popup = h("div", { class: "autocomplete", role: "listbox", hidden: true });
  let lastTyping = 0;
  let ac = null; // { start, items, index }

  const slow = channel.slowmode_seconds && !can("MANAGE_MESSAGES", channel) && !can("MANAGE_CHANNELS", channel);
  const waitFor = slow ? slowmodeLeft(channel) : 0;
  const slowNote = slow ? h("div", { class: "slowmode", title: t("slowmode_title", { seconds: channel.slowmode_seconds }) },
    "🐢 ", waitFor ? t("slowmode_wait", { seconds: waitFor }) : t("slowmode_note", { seconds: channel.slowmode_seconds })) : null;
  clearTimeout(slowTimer);
  if (waitFor) slowTimer = setTimeout(() => actions.rerenderComposer(), 1000);
  const autosize = () => {
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
    const n = input.value.trim().length;
    count.hidden = n < LIMITS.CONTENT_MAX_CHARS - 200;
    count.textContent = t("char_count", { count: n, max: LIMITS.CONTENT_MAX_CHARS });
    count.classList.toggle("over", n > LIMITS.CONTENT_MAX_CHARS);
    const files = state.pending.length > 0;
    send.disabled = !state.connected || (n === 0 && !files) || n > LIMITS.CONTENT_MAX_CHARS || waitFor > 0 || uploading();
    if (input.value) drafts.set(channelId, input.value);
    else drafts.delete(channelId);
  };

  // --- @mention autocomplete ---
  const closeAc = () => { ac = null; popup.hidden = true; clear(popup); };
  const pickAc = (item) => {
    if (!ac) return;
    const before = input.value.slice(0, ac.start);
    const after = input.value.slice(input.selectionStart);
    const insert = ac.kind === "emoji" ? `${item.custom ? `:${item.name}:` : item.emoji} ` : `@${item.username} `;
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
    if (ac.kind === "emoji") {
      add(popup, h("div", { class: "ac-title" }, t("emoji_matching", { query: ac.query })));
      ac.items.forEach((e, i) => add(popup, h("div", {
        class: `ac-item ${i === ac.index ? "active" : ""}`, role: "option", "aria-selected": String(i === ac.index),
        on: { mousedown: (ev) => { ev.preventDefault(); pickAc(e); } },
      }, emojiGlyph(e.custom ? emojiToken(e) : e.emoji, { cls: "ac-emoji" }),
      h("span", { class: "ac-name" }, `:${e.name}:`),
      h("span", { class: "ac-sub" }, e.custom ? e.guildName : ""))));
      return;
    }
    add(popup, h("div", { class: "ac-title" }, t("members_heading")));
    ac.items.forEach((u, i) => add(popup, h("div", {
      class: `ac-item ${i === ac.index ? "active" : ""}`, role: "option", "aria-selected": String(i === ac.index),
      on: { mousedown: (e) => { e.preventDefault(); pickAc(u); } },
    }, u.everyone ? h("span", { class: "avatar xs everyone", "aria-hidden": "true" }, "@") : avatar(u, { size: "xs" }),
    h("span", { class: "ac-name" }, u.everyone ? t("everyone_label") : nameOf(u)),
    h("span", { class: "ac-sub" }, u.everyone ? t("everyone_hint") : u.username))));
  };
  const updateAc = () => {
    const pos = input.selectionStart;
    const em = /(^|\s):([A-Za-z0-9_]{2,32})$/.exec(input.value.slice(0, pos));
    if (em) {
      const q = em[2].toLowerCase();
      const custom = searchEmojis(q, 8).map((e) => ({ ...e, custom: true }));
      const unicode = UNICODE_EMOJI.filter((e) => e.words.split(" ").some((w) => w.startsWith(q)))
        .slice(0, 10 - custom.length).map((e) => ({ emoji: e.emoji, name: e.words.split(" ")[0] }));
      ac = { kind: "emoji", query: em[2], start: pos - em[2].length - 1, items: [...custom, ...unicode], index: 0 };
      drawAc();
      return;
    }
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
    ac = { kind: "user", start: pos - m[2].length - 1, items: list, index: 0 };
    drawAc();
  };

  const submit = async () => {
    const raw = input.value.trim();
    if ((!raw && !state.pending.length) || raw.length > LIMITS.CONTENT_MAX_CHARS || !state.connected) return;
    if (slowmodeLeft(channel) && slow) return;
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
  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length || !canAttach(channel)) return;
    e.preventDefault();
    addFiles(files);
  });
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
    class: "icon-btn emoji-btn", type: "button", title: t("emoji_title"), "aria-label": t("emoji_aria"),
    on: {
      click: (e) => openEmojiPicker(e.currentTarget, (picked) => {
        const c = customOf(picked);
        const emoji = c ? `:${c.name}: ` : picked;
        const pos = input.selectionStart ?? input.value.length;
        input.value = input.value.slice(0, pos) + emoji + input.value.slice(input.selectionEnd ?? pos);
        input.setSelectionRange(pos + emoji.length, pos + emoji.length);
        autosize();
        input.focus();
      }, { placement: "top" }),
    },
  }, "☺");
  const stickerBtn = usableStickerGroups().length ? h("button", {
    class: "icon-btn sticker-btn", type: "button", title: t("send_sticker_title"), "aria-label": t("send_sticker_aria"),
    disabled: !state.connected,
    on: {
      click: (e) => openStickerPicker(e.currentTarget, async (sticker) => {
        if (slow && slowmodeLeft(channel)) return;
        try { await actions.sendSticker(sticker); } catch (err) { toast(err.message, { error: true }); }
      }),
    },
  }, "🗒") : null;

  const fileInput = h("input", { type: "file", multiple: true, hidden: true });
  fileInput.addEventListener("change", () => { addFiles([...fileInput.files]); fileInput.value = ""; input.focus(); });
  const attachBtn = canAttach(channel) ? h("button", {
    class: "icon-btn attach-btn", type: "button", title: t("upload_file_title"), "aria-label": t("upload_file_aria"),
    disabled: !state.connected, on: { click: () => fileInput.click() },
  }, "＋") : null;

  let replyBar = null;
  if (state.replyTo) {
    const r = state.replyTo;
    const author = userById(r.author?.user_id) || r.author;
    const mine = author?.user_id === state.user.user_id;
    replyBar = h("div", { class: "reply-bar" },
      h("span", {}, t("replying_to"), h("strong", {}, nameOf(author))),
      mine ? null : h("button", {
        class: `btn link ping ${state.replyPing ? "on" : ""}`, type: "button",
        title: state.replyPing ? t("ping_on_title") : t("ping_off_title"),
        on: { click: () => { state.replyPing = !state.replyPing; actions.rerenderComposer(); } },
      }, state.replyPing ? t("ping_on") : t("ping_off")),
      h("button", { class: "icon-btn", type: "button", title: t("cancel_reply_title"), "aria-label": t("cancel_reply_aria"), on: { click: actions.cancelReply } }, "✕"));
  }

  const tray = uploadTray(state);
  add(form, ...[popup, replyBar, tray, h("div", { class: `box ${replyBar || tray ? "with-reply" : ""}` }, attachBtn, fileInput, input, stickerBtn, emojiBtn, send), slowNote, count].filter(Boolean));
  autosize();
  if (state.connected && matchMedia("(pointer: fine)").matches && !state.editingId) input.focus();
}
