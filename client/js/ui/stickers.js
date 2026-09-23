// Sticker picker and sticker rendering (PROTOCOL.md §4 Sticker). Stickers
// from every guild you're in can be sent anywhere.

import { stickerUrl, usableStickerGroups } from "../perks.js";
import { add, clear, h } from "./dom.js";
import { closePopover, openPopover } from "./modals.js";
import { scopedT } from "../strings.js";

const t = scopedT("ui/stickers");

export function stickerImg(sticker, { cls = "sticker" } = {}) {
  if (sticker.deleted) {
    return h("div", { class: `${cls} sticker-gone`, title: t("sticker_deleted_title") }, h("span", { "aria-hidden": "true" }, "🗒"), t("deleted_sticker"));
  }
  const img = h("img", {
    class: cls, src: stickerUrl(sticker.sticker_id), alt: sticker.name, title: sticker.name,
    draggable: "false", loading: "lazy",
  });
  img.addEventListener("error", () => img.replaceWith(h("div", { class: `${cls} sticker-gone` }, sticker.name)));
  return img;
}

// Opens the picker next to anchor; onPick(sticker) is called once.
export function openStickerPicker(anchor, onPick, { placement = "top", key = null } = {}) {
  const groups = usableStickerGroups();
  const search = h("input", { type: "search", placeholder: t("search_placeholder"), "aria-label": t("search_aria"), class: "emoji-search" });
  const grid = h("div", { class: "sticker-grid" });
  const cell = (s) => h("button", {
    class: "sticker-cell", type: "button", title: s.description ? t("sticker_title_with_description", { name: s.name, description: s.description }) : s.name, "aria-label": s.name,
    on: { click: () => { closePopover(); onPick(s); } },
  }, stickerImg(s, { cls: "sticker-thumb" }));
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    clear(grid);
    if (!groups.length) {
      add(grid, h("p", { class: "muted small emoji-empty" }, t("no_stickers_manager_note")));
      return;
    }
    let any = false;
    for (const { guild, stickers } of groups) {
      const hits = stickers.filter((s) => !q || s.name.toLowerCase().includes(q) || (s.tag_emoji || "") === q
        || (s.description || "").toLowerCase().includes(q));
      if (!hits.length) continue;
      any = true;
      add(grid, h("div", { class: "emoji-group" }, guild.name), ...hits.map(cell));
    }
    if (!any) add(grid, h("p", { class: "muted small emoji-empty" }, t("no_stickers_found")));
  };
  search.addEventListener("input", draw);
  draw();
  const el = openPopover(anchor, h("div", { class: "emoji-picker sticker-picker" }, search, grid), { placement, cls: "emoji-pop", key });
  if (el) search.focus();
  return el;
}
