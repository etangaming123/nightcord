// Guild Settings → Emoji and Stickers tabs (PROTOCOL.md §5 Emoji and
// stickers). Needs MANAGE_EXPRESSIONS; members can use them anywhere.

import { emojiUrl } from "../perks.js";
import { LIMITS } from "../protocol.js";
import { currentGuild, nameOf, userById } from "../state.js";
import { clear, h, iconBtn } from "./dom.js";
import { openEmojiPicker } from "./emoji.js";
import { pickImage } from "./images.js";
import { confirmModal, formModal, toast } from "./modals.js";
import { stickerImg } from "./stickers.js";
import { scopedT } from "../strings.js";

const t = scopedT("ui/expressionSettings");

const fail = (e) => toast(e.message, { error: true });

// "My Cat (1).png" -> "My_Cat_1", unique in the guild.
function nameFromFile(file, taken) {
  let base = file.name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 28);
  if (base.length < 2) base = "emoji";
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base}_${i}`;
  return name;
}

const creator = (id) => {
  const u = userById(id);
  return u ? nameOf(u) : t("unknown_creator");
};

export function emojiTab(el, actions) {
  const g = currentGuild();
  const emojis = g.emojis || [];
  const full = emojis.length >= LIMITS.MAX_GUILD_EMOJI;
  const status = h("span", { class: "muted small" });
  const upload = () => {
    const input = h("input", { type: "file", multiple: true, accept: "image/png,image/jpeg,image/gif,image/webp" });
    input.addEventListener("change", async () => {
      const taken = new Set(emojis.map((e) => e.name.toLowerCase()));
      const files = [...input.files].slice(0, LIMITS.MAX_GUILD_EMOJI - emojis.length);
      let done = 0;
      for (const file of files) {
        const name = nameFromFile(file, taken);
        taken.add(name.toLowerCase());
        status.textContent = t("uploading_progress", { done: done + 1, total: files.length });
        try {
          await actions.createEmoji(file, name);
          done++;
        } catch (e) {
          toast(t("file_error", { file: file.name, message: e.message }), { error: true, ms: 6000 });
        }
      }
      status.textContent = "";
      if (done) toast(t("emoji_added", { count: done }));
    });
    input.click();
  };
  const row = (e) => {
    const name = h("input", { class: "input emoji-name", value: e.name, maxLength: 32, "aria-label": t("rename_emoji_aria", { name: e.name }) });
    const save = async () => {
      const v = name.value.trim();
      if (v === e.name) return;
      if (!LIMITS.EMOJI_NAME_RE.test(v)) {
        toast(t("emoji_name_invalid"), { error: true });
        name.value = e.name;
        return;
      }
      try { await actions.renameEmoji(e.emoji_id, v); toast(t("renamed_to", { name: v })); } catch (err) { name.value = e.name; fail(err); }
    };
    name.addEventListener("keydown", (ev) => { if (ev.key === "Enter") name.blur(); if (ev.key === "Escape") { name.value = e.name; name.blur(); } });
    name.addEventListener("blur", save);
    return h("div", { class: "list-row expr-row" },
      h("img", { class: "cemoji big", src: emojiUrl(e.emoji_id), alt: `:${e.name}:` }),
      name,
      e.animated ? h("span", { class: "tag" }, t("gif_tag")) : null,
      h("span", { class: "grow muted small" }, t("by_creator", { creator: creator(e.creator_id) })),
      iconBtn("trash-2", t("delete_emoji_aria", { name: e.name }), () => confirmModal({
        title: t("delete_emoji_title", { name: e.name }),
        message: t("delete_emoji_message"),
        confirmLabel: t("delete_button"),
        onConfirm: () => actions.deleteEmoji(e.emoji_id),
      }), { cls: "danger" }));
  };
  clear(el,
    h("p", { class: "muted" }, t("emoji_intro"),
      t("emoji_formats_note")),
    h("div", { class: "row gap" },
      h("button", { class: "btn primary", type: "button", disabled: full, on: { click: upload } }, t("upload_emoji")),
      h("span", { class: "muted small" }, t("emoji_count", { count: emojis.length, max: LIMITS.MAX_GUILD_EMOJI })), status),
    emojis.length
      ? h("div", { class: "list expr-list" }, emojis.map(row))
      : h("div", { class: "empty-note" }, h("span", { class: "big-emoji", "aria-hidden": "true" }, "🥞"), h("p", { class: "muted" }, t("no_emoji_yet"))));
}

export function stickersTab(el, actions) {
  const g = currentGuild();
  const stickers = g.stickers || [];
  const full = stickers.length >= LIMITS.MAX_GUILD_STICKERS;
  let file = null;
  let tag = null;
  const preview = h("div", { class: "sticker-drop", role: "button", tabindex: "0", title: t("choose_image_title") }, t("choose_image"));
  const nameIn = h("input", { class: "input", placeholder: t("sticker_name_placeholder"), maxLength: LIMITS.STICKER_NAME_MAX, "aria-label": t("sticker_name_aria") });
  const descIn = h("input", { class: "input", placeholder: t("description_placeholder"), maxLength: LIMITS.STICKER_DESCRIPTION_MAX, "aria-label": t("description_aria") });
  const tagBtn = h("button", { class: "btn", type: "button", title: t("related_emoji_title") }, t("related_emoji_button"));
  const submit = h("button", { class: "btn primary", type: "button", disabled: true }, t("upload_sticker"));
  const ready = () => { submit.disabled = !file || nameIn.value.trim().length < 2 || full; };
  const choose = () => pickImage((f) => {
    file = f;
    if (!nameIn.value) nameIn.value = f.name.replace(/\.[^.]+$/, "").slice(0, LIMITS.STICKER_NAME_MAX);
    const url = URL.createObjectURL(f);
    clear(preview, h("img", { src: url, alt: "" }));
    ready();
  });
  preview.addEventListener("click", choose);
  preview.addEventListener("keydown", (e) => { if (e.key === "Enter") choose(); });
  nameIn.addEventListener("input", ready);
  tagBtn.addEventListener("click", (e) => openEmojiPicker(e.currentTarget, (v) => { tag = v; tagBtn.textContent = v; }, { custom: false, placement: "bottom" }));
  submit.addEventListener("click", async () => {
    submit.disabled = true;
    submit.textContent = t("uploading");
    try {
      await actions.createSticker(file, { name: nameIn.value.trim(), description: descIn.value.trim() || null, tag_emoji: tag });
      toast(t("sticker_added"));
    } catch (e) {
      fail(e);
      submit.textContent = t("upload_sticker");
      ready();
    }
  });
  const card = (s) => h("div", { class: "sticker-card" },
    stickerImg(s, { cls: "sticker-thumb" }),
    h("div", { class: "sticker-meta" },
      h("strong", {}, s.tag_emoji ? `${s.tag_emoji} ` : "", s.name),
      s.description ? h("span", { class: "muted small" }, s.description) : null,
      h("span", { class: "muted small" }, `${t("by_creator", { creator: creator(s.creator_id) })}${s.animated ? " · animated" : ""}`)),
    h("div", { class: "sticker-actions" },
      iconBtn("pencil", t("edit_sticker_aria", { name: s.name }), () => formModal({
        title: t("edit_sticker_title"),
        fields: [
          h("label", {}, t("name_label"), h("input", { name: "name", value: s.name, maxLength: LIMITS.STICKER_NAME_MAX, required: true, minLength: 2 })),
          h("label", {}, t("description_label"), h("input", { name: "description", value: s.description || "", maxLength: LIMITS.STICKER_DESCRIPTION_MAX })),
        ],
        onSubmit: (fd) => actions.updateSticker(s.sticker_id, {
          name: String(fd.get("name")).trim(), description: String(fd.get("description")).trim() || null,
        }),
      })),
      iconBtn("trash-2", t("delete_sticker_aria", { name: s.name }), () => confirmModal({
        title: t("delete_sticker_title", { name: s.name }),
        message: t("delete_sticker_message"),
        confirmLabel: t("delete_button"),
        onConfirm: () => actions.deleteSticker(s.sticker_id),
      }), { cls: "danger" })));
  clear(el,
    h("p", { class: "muted" }, t("sticker_intro"),
      t("sticker_formats_note")),
    full ? h("p", { class: "muted" }, t("sticker_limit_reached", { max: LIMITS.MAX_GUILD_STICKERS }))
      : h("div", { class: "sticker-form" }, preview, h("div", { class: "stack" }, nameIn, descIn, h("div", { class: "row gap" }, tagBtn, submit))),
    h("div", { class: "section-label" }, t("stickers_section_label", { count: stickers.length, max: LIMITS.MAX_GUILD_STICKERS })),
    stickers.length ? h("div", { class: "sticker-cards" }, stickers.map(card)) : h("p", { class: "muted" }, t("no_stickers_yet")));
}
