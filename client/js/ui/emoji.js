// Emoji picker: custom emoji from every guild you're in (usable anywhere,
// PROTOCOL.md §5 Emoji and stickers) plus common unicode emoji with search
// keywords. Picks are a unicode string or a custom token <:name:id>.

import { CUSTOM_EMOJI, emojiToken, emojiUrl, usableEmojiById, usableEmojiGroups } from "../perks.js";
import { EMOJI_GROUPS } from "./emojiData/unicode.js";
import { getPrefs, noteEmojiUse } from "../prefs.js";
import { add, clear, h, imageUrl, initials } from "./dom.js";
import { closePopover, openPopover } from "./modals.js";
import { scopedT } from "../strings.js";

const t = scopedT("ui/emoji");

const ALL = EMOJI_GROUPS.map(([key, list]) => [key, list.split("|").map((entry) => {
  const [head, tags = ""] = entry.split(";");
  const [emoji, ...names] = head.split(" ");
  return { emoji, names, words: `${names.join(" ")} ${tags}` };
})]);

const GROUP_ICONS = {
  smileys: "😀", people: "👋", nature: "🌿", food: "🍕", travel: "🚗", activities: "⚽",
  objects: "💡", symbols: "🔣", flags: "🏳️",
};
const groupLabel = (key) => t(`group_${key}`);

// Every unicode emoji with its keywords, for :name autocomplete.
export const UNICODE_EMOJI = ALL.flatMap(([, list]) => list);

// :shortcode: -> glyph, for every Discord shortcode and alias (all unique).
const BY_NAME = new Map();
for (const e of UNICODE_EMOJI) for (const name of e.names) BY_NAME.set(name, e.emoji);

// :name: for a unicode emoji (its main Discord shortcode), or null.
const NAME_OF = new Map(UNICODE_EMOJI.map((e) => [e.emoji, e.names[0]]));
export const nameOfUnicode = (emoji) => NAME_OF.get(emoji) || null;
export const unicodeByName = (name) => BY_NAME.get(String(name).toLowerCase()) || null;

// The custom emoji behind a picked value, or null for unicode.
export function customOf(value) {
  const m = CUSTOM_EMOJI.exec(value || "");
  return m ? { animated: m[1] === "a", name: m[2], emoji_id: m[3] } : null;
}

// An emoji as shown in pickers, reactions and autocomplete.
export function emojiGlyph(value, { cls = "" } = {}) {
  const c = customOf(value);
  if (!c) return h("span", { class: `emoji ${cls}` }, value);
  const img = h("img", { class: `cemoji ${cls}`, src: emojiUrl(c.emoji_id), alt: `:${c.name}:`, draggable: "false", loading: "lazy" });
  img.addEventListener("error", () => img.replaceWith(h("span", { class: `emoji ${cls}` }, `:${c.name}:`)));
  return img;
}

// Opens the picker next to anchor; onPick(value) is called once.
export function openEmojiPicker(anchor, onPick, { placement = "top", custom = true, key = null } = {}) {
  const search = h("input", { type: "search", placeholder: t("search_placeholder"), "aria-label": t("search_aria"), class: "emoji-search" });
  const grid = h("div", { class: "emoji-grid" });
  const tabs = h("div", { class: "emoji-tabs", role: "tablist", "aria-label": t("emoji_categories_aria") });
  const preview = h("div", { class: "emoji-preview muted small" }, t("pick_an_emoji"));
  const pick = (value) => {
    noteEmojiUse(value);
    closePopover();
    onPick(value);
  };
  const hover = (glyph, label) => clear(preview, glyph, h("span", {}, label));
  const cell = (e) => {
    const name = nameOfUnicode(e.emoji);
    const label = name ? `:${name}:` : e.emoji;
    return h("button", {
      class: "emoji-cell", type: "button", title: label, "aria-label": label,
      on: { click: () => pick(e.emoji), mouseenter: () => hover(h("span", { class: "emoji big" }, e.emoji), label) },
    }, e.emoji);
  };
  const customCell = (e, guildName) => h("button", {
    class: "emoji-cell custom", type: "button", title: `:${e.name}:`, "aria-label": t("custom_emoji_from", { name: e.name, guild: guildName }),
    on: { click: () => pick(emojiToken(e)), mouseenter: () => hover(emojiGlyph(emojiToken(e), { cls: "big" }), t("custom_emoji_hover", { name: e.name, guild: guildName })) },
  }, emojiGlyph(emojiToken(e)));
  const groups = custom ? usableEmojiGroups() : [];
  const section = (id, label) => h("div", { class: "emoji-group", id }, label);
  const draw = () => {
    const q = search.value.trim().toLowerCase().replace(/^:|:$/g, "");
    clear(grid);
    tabs.hidden = !!q;
    if (q) {
      const customHits = groups.flatMap(({ guild, emojis }) => emojis.filter((e) => e.name.toLowerCase().includes(q)).map((e) => customCell(e, guild.name)));
      const hits = ALL.flatMap(([, list]) => list).filter((e) => e.words.includes(q));
      if (!hits.length && !customHits.length) add(grid, h("p", { class: "muted small emoji-empty" }, t("no_emoji_found")));
      add(grid, ...customHits, ...hits.map(cell));
      return;
    }
    const recent = getPrefs().frequentEmoji.filter((v) => {
      const c = customOf(v);
      return !c || (custom && usableEmojiById(c.emoji_id));
    });
    if (recent.length) {
      add(grid, section("emoji-sec-recent", t("frequently_used")), ...recent.map((v) => {
        const c = customOf(v);
        return c ? customCell(usableEmojiById(c.emoji_id), "") : cell({ emoji: v });
      }));
    }
    for (const { guild, emojis } of groups) {
      add(grid, section(`emoji-sec-${guild.guild_id}`, guild.name), ...emojis.map((e) => customCell(e, guild.name)));
    }
    ALL.forEach(([key, list], i) => add(grid, section(`emoji-sec-u${i}`, groupLabel(key)), ...list.map(cell)));
  };
  const tab = (id, label, glyph) => h("button", {
    class: "emoji-tab", type: "button", title: label, "aria-label": label,
    on: { click: () => grid.querySelector(`#${id}`)?.scrollIntoView({ block: "start" }) },
  }, glyph);
  add(tabs,
    getPrefs().frequentEmoji.length ? tab("emoji-sec-recent", t("frequently_used"), "🕘") : null,
    groups.map(({ guild }) => tab(`emoji-sec-${guild.guild_id}`, guild.name,
      guild.icon_id ? h("img", { src: imageUrl(guild.icon_id), alt: "", draggable: "false" }) : h("span", { class: "tab-initials" }, initials(guild.name)))),
    ALL.map(([key], i) => tab(`emoji-sec-u${i}`, groupLabel(key), GROUP_ICONS[key] || "•")));
  search.addEventListener("input", draw);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      grid.querySelector(".emoji-cell")?.click();
    }
  });
  draw();
  const el = openPopover(anchor, h("div", { class: "emoji-picker" }, search, h("div", { class: "emoji-body" }, tabs, grid), preview), { placement, cls: "emoji-pop", key });
  if (el) search.focus();
  return el;
}

export const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "😮", "😢"];
