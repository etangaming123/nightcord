// Message search panel (PROTOCOL.md §5 Messaging: message.search).
// Filters typed into the box: from:user in:channel has:file|image|video|link pinned:true

import { T } from "../protocol.js";
import { currentChannel, currentGuild, isDm, nameOf, state, userById } from "../state.js";
import { add, avatar, clear, fmtStamp, h, iconBtn } from "./dom.js";
import { mdContext } from "./chat.js";
import { render as renderMarkdown } from "./markdown.js";
import { scopedT } from "../strings.js";
import { icon } from "./icons.js";

const t = scopedT("ui/search");

let panel = null;

export function closeSearch() {
  panel?.remove();
  panel = null;
}

// Pull filters out of the query text.
export function parseQuery(text) {
  const out = { words: [], from: null, in: null, has: null, pinned: false };
  for (const token of text.trim().split(/\s+/).filter(Boolean)) {
    const m = /^(from|in|has|pinned):(.+)$/i.exec(token);
    if (!m) { out.words.push(token); continue; }
    const key = m[1].toLowerCase();
    const val = m[2].replace(/^[@#]/, "");
    if (key === "pinned") out.pinned = /^(true|yes|1)$/i.test(val);
    else out[key] = val;
  }
  return out;
}

function resolveUser(name) {
  const q = name.toLowerCase();
  const pool = state.view === "guild" ? state.members.map((m) => userById(m.user.user_id) || m.user)
    : (currentChannel()?.recipients || []).map((u) => userById(u.user_id) || u);
  return pool.find((u) => u.username.toLowerCase() === q)
    || pool.find((u) => nameOf(u).toLowerCase() === q)
    || pool.find((u) => u.username.toLowerCase().startsWith(q));
}

export function openSearch(actions, initial = "") {
  const channel = currentChannel();
  const guild = currentGuild();
  if (!guild && !channel) return;
  closeSearch();
  const input = h("input", { type: "search", placeholder: guild ? t("search_guild_placeholder", { guild: guild.name }) : t("search_conversation_placeholder"), "aria-label": t("search_aria"), value: initial, spellcheck: "false" });
  const hint = h("p", { class: "muted small search-hint" }, t("filters_label"), h("code", {}, "from:user"), " ", guild ? h("code", {}, "in:channel") : null, " ", h("code", {}, "has:image"), " ", h("code", {}, "has:file"), " ", h("code", {}, "has:link"), " ", h("code", {}, "pinned:true"));
  const results = h("div", { class: "search-results scroll" });
  const more = h("button", { class: "btn block", type: "button", hidden: true }, t("more_results"));
  let offset = 0;
  let last = null;
  const run = async (append = false) => {
    const q = parseQuery(input.value);
    const payload = {};
    if (guild) payload.guild_id = guild.guild_id;
    else payload.channel_id = channel.channel_id;
    if (q.words.length) payload.query = q.words.join(" ");
    if (q.from) {
      const u = resolveUser(q.from);
      if (!u) { clear(results, h("p", { class: "muted pad" }, t("no_user_named", { name: q.from }))); more.hidden = true; return; }
      payload.author_id = u.user_id;
    }
    if (q.in && guild) {
      const ch = state.channels.find((c) => c.kind === "text" && c.name.toLowerCase() === q.in.toLowerCase());
      if (!ch) { clear(results, h("p", { class: "muted pad" }, t("no_channel_named", { name: q.in }))); more.hidden = true; return; }
      delete payload.guild_id;
      payload.channel_id = ch.channel_id;
    }
    if (q.has) payload.has = q.has.toLowerCase();
    if (q.pinned) payload.pinned = true;
    if (!payload.query && !payload.author_id && !payload.has && !payload.pinned) {
      clear(results);
      more.hidden = true;
      return;
    }
    offset = append ? offset : 0;
    payload.offset = offset;
    const key = JSON.stringify(payload);
    last = key;
    if (!append) clear(results, h("p", { class: "muted pad" }, t("searching")));
    try {
      const res = await actions.req(T.MESSAGE_SEARCH, payload);
      if (last !== key) return;
      if (!append) clear(results, h("div", { class: "search-count muted small" }, t("result_count", { count: res.total })));
      if (!res.total) add(results, h("div", { class: "empty-pins" }, h("div", { class: "big", "aria-hidden": "true" }, "🔍"), h("p", {}, t("no_results"))));
      for (const m of res.messages) add(results, resultRow(m, actions));
      offset += res.messages.length;
      more.hidden = offset >= res.total;
    } catch (e) {
      clear(results, h("div", { class: "error-box" }, e.message));
    }
  };
  let timer;
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => run(), 300); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { clearTimeout(timer); run(); }
    if (e.key === "Escape") { e.stopPropagation(); closeSearch(); }
  });
  more.addEventListener("click", () => run(true));
  panel = h("aside", { class: "side-panel search-panel", "aria-label": t("search_aside_aria") },
    h("div", { class: "side-head" }, h("span", { class: "search-icon", "aria-hidden": "true" }, icon("search")), input, iconBtn("x", t("close_search"), closeSearch)),
    hint, results, more);
  document.body.append(panel);
  input.focus();
  if (initial) run();
}

function resultRow(m, actions) {
  actions.rememberUser(m.author);
  const author = userById(m.author?.user_id) || m.author;
  const ch = m.guild_id ? state.channels.find((c) => c.channel_id === m.channel_id) : null;
  return h("div", {
    class: "search-hit", role: "button", tabindex: "0", title: t("jump_to_message"),
    on: {
      // A link (or a spoiler) inside the preview keeps its own click.
      click: (e) => { if (!e.target.closest("a, .md-spoiler, button")) actions.jumpTo(m.message_id, m.channel_id, m.guild_id); },
      keydown: (e) => { if (e.key === "Enter" && e.target === e.currentTarget) actions.jumpTo(m.message_id, m.channel_id, m.guild_id); },
    },
  },
  ch ? h("div", { class: "hit-channel muted small" }, `#${ch.name}`) : null,
  h("div", { class: "hit-main" },
    avatar(author, { size: "sm" }),
    h("div", { class: "hit-body" },
      h("div", { class: "pin-head" }, h("strong", {}, nameOf(author)), h("span", { class: "muted small" }, fmtStamp(m.sent_at)), m.pinned ? h("span", { class: "muted small" }, icon("pin")) : null),
      h("div", { class: "pin-body" }, renderMarkdown(m.content, mdContext(state, actions)),
        m.attachments?.length ? h("div", { class: "muted small" }, t("attachment_list", { names: m.attachments.map((a) => a.filename).join(", ") })) : null))));
}

export const searchOpen = () => !!panel;
export const isDmSearch = () => isDm(currentChannel());
