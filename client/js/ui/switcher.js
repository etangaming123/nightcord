// Quick switcher (Ctrl/Cmd+K): jump to a channel, DM, guild or person.
// Prefix the query with # (channels), @ (people), * (guilds).

import { T } from "../protocol.js";
import { dmTitle, nameOf, state, userById } from "../state.js";
import { avatar, clear, h, initials } from "./dom.js";
import { closeModal, openModal } from "./modals.js";
import { scopedT } from "../strings.js";

const t = scopedT("ui/switcher");

// guild_id -> channels, fetched when the switcher opens.
const channelCache = new Map();

function score(label, q) {
  const l = label.toLowerCase();
  if (!q) return 1;
  if (l === q) return 100;
  if (l.startsWith(q)) return 50 - l.length / 100;
  const i = l.indexOf(q);
  if (i >= 0) return 20 - i / 10;
  // Letters in order ("gnrl" finds "general").
  let j = 0;
  for (const ch of l) if (ch === q[j]) j++;
  return j === q.length ? 5 : 0;
}

function entries() {
  const out = [];
  for (const g of state.guilds.values()) {
    out.push({ kind: "guild", label: g.name, icon: h("div", { class: "guild-icon static xs", "aria-hidden": "true" }, initials(g.name)), go: (a) => a.openGuild(g.guild_id) });
    const channels = g.guild_id === state.guildId ? state.channels : channelCache.get(g.guild_id) || [];
    for (const c of channels) {
      if (c.kind === "category") continue;
      const voice = c.kind === "voice";
      out.push({
        kind: "channel", label: c.name, sub: g.name, icon: h("span", { class: "sw-hash", "aria-hidden": "true" }, voice ? "🔊" : "#"),
        go: (a) => (voice ? a.openGuild(g.guild_id).then(() => a.joinVoice(c)) : a.openGuild(g.guild_id, c.channel_id)),
      });
    }
  }
  const seen = new Set();
  for (const ch of state.dms.values()) {
    const other = ch.kind === "dm" ? ch.recipients.find((u) => u.user_id !== state.user.user_id) : null;
    if (other) seen.add(other.user_id);
    out.push({
      kind: other ? "person" : "group", label: dmTitle(ch), sub: other ? other.username : t("group_label"),
      icon: other ? avatar(userById(other.user_id) || other, { size: "xs" }) : h("span", { class: "sw-hash", "aria-hidden": "true" }, "👥"),
      go: (a) => a.openDm(ch.channel_id),
    });
  }
  for (const m of state.members) {
    const u = userById(m.user.user_id) || m.user;
    if (seen.has(u.user_id) || u.user_id === state.user.user_id) continue;
    out.push({ kind: "person", label: nameOf(u), sub: u.username, icon: avatar(u, { size: "xs" }), go: (a) => a.messageUser(u.user_id) });
  }
  return out;
}

export function openSwitcher(actions) {
  // Load other guilds' channel lists in the background.
  for (const g of state.guilds.values()) {
    if (g.guild_id !== state.guildId && !channelCache.has(g.guild_id)) {
      channelCache.set(g.guild_id, []);
      actions.req(T.CHANNEL_LIST, { guild_id: g.guild_id }).then(({ channels }) => { channelCache.set(g.guild_id, channels); draw(); }).catch(() => {});
    }
  }
  const input = h("input", { type: "text", placeholder: t("search_placeholder"), "aria-label": t("search_aria_label"), spellcheck: "false", autocomplete: "off" });
  const list = h("div", { class: "switcher-list", role: "listbox" });
  let index = 0;
  let items = [];
  const go = (item) => { closeModal(); item.go(actions); };
  function draw() {
    if (!list.isConnected && items.length) return;
    let q = input.value.trim().toLowerCase();
    let only = null;
    if (/^[#@*]/.test(q)) { only = { "#": "channel", "@": "person", "*": "guild" }[q[0]]; q = q.slice(1); }
    items = entries()
      .filter((e) => !only || e.kind === only || (only === "person" && e.kind === "group"))
      .map((e) => ({ ...e, s: score(e.label, q) + (e.sub ? score(e.sub, q) / 4 : 0) }))
      .filter((e) => e.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 12);
    index = Math.min(index, Math.max(0, items.length - 1));
    clear(list, items.length ? items.map((e, i) => h("div", {
      class: `sw-item ${i === index ? "active" : ""}`, role: "option", "aria-selected": String(i === index),
      on: { mousedown: (ev) => { ev.preventDefault(); go(e); }, mousemove: () => { if (index !== i) { index = i; draw(); } } },
    }, e.icon, h("span", { class: "sw-label" }, e.label), e.sub ? h("span", { class: "sw-sub" }, e.sub) : null))
      : h("p", { class: "muted pad" }, t("nothing_matches")));
  }
  input.addEventListener("input", () => { index = 0; draw(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      index = (index + (e.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(1, items.length);
      draw();
    } else if (e.key === "Enter" && items[index]) {
      e.preventDefault();
      go(items[index]);
    }
  });
  openModal({
    title: t("modal_title"),
    content: [input, list, h("p", { class: "muted small sw-tip" }, t("tip"))],
    cls: "switcher",
  });
  input.focus();
  draw();
}
