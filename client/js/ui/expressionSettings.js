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
  return u ? nameOf(u) : "someone";
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
        status.textContent = `Uploading ${done + 1} of ${files.length}…`;
        try {
          await actions.createEmoji(file, name);
          done++;
        } catch (e) {
          toast(`${file.name}: ${e.message}`, { error: true, ms: 6000 });
        }
      }
      status.textContent = "";
      if (done) toast(done === 1 ? "Emoji added" : `${done} emoji added`);
    });
    input.click();
  };
  const row = (e) => {
    const name = h("input", { class: "input emoji-name", value: e.name, maxLength: 32, "aria-label": `Rename :${e.name}:` });
    const save = async () => {
      const v = name.value.trim();
      if (v === e.name) return;
      if (!LIMITS.EMOJI_NAME_RE.test(v)) {
        toast("Emoji names are 2-32 letters, digits or _", { error: true });
        name.value = e.name;
        return;
      }
      try { await actions.renameEmoji(e.emoji_id, v); toast(`Renamed to :${v}:`); } catch (err) { name.value = e.name; fail(err); }
    };
    name.addEventListener("keydown", (ev) => { if (ev.key === "Enter") name.blur(); if (ev.key === "Escape") { name.value = e.name; name.blur(); } });
    name.addEventListener("blur", save);
    return h("div", { class: "list-row expr-row" },
      h("img", { class: "cemoji big", src: emojiUrl(e.emoji_id), alt: `:${e.name}:` }),
      name,
      e.animated ? h("span", { class: "tag" }, "GIF") : null,
      h("span", { class: "grow muted small" }, `by ${creator(e.creator_id)}`),
      iconBtn("🗑", `Delete :${e.name}:`, () => confirmModal({
        title: `Delete :${e.name}:?`,
        message: "It disappears from messages and reactions everywhere (they show its name instead).",
        confirmLabel: "Delete",
        onConfirm: () => actions.deleteEmoji(e.emoji_id),
      }), { cls: "danger" }));
  };
  clear(el,
    h("p", { class: "muted" }, "Add custom emoji for this guild. Everyone in it can use them in any guild or DM — no Nitro needed. ",
      "PNG, JPEG, WebP or GIF (animated is fine), up to 256 KB; images are shrunk to 128×128."),
    h("div", { class: "row gap" },
      h("button", { class: "btn primary", type: "button", disabled: full, on: { click: upload } }, "Upload emoji"),
      h("span", { class: "muted small" }, `${emojis.length} / ${LIMITS.MAX_GUILD_EMOJI}`), status),
    emojis.length
      ? h("div", { class: "list expr-list" }, emojis.map(row))
      : h("div", { class: "empty-note" }, h("span", { class: "big-emoji", "aria-hidden": "true" }, "🥞"), h("p", { class: "muted" }, "No custom emoji yet.")));
}

export function stickersTab(el, actions) {
  const g = currentGuild();
  const stickers = g.stickers || [];
  const full = stickers.length >= LIMITS.MAX_GUILD_STICKERS;
  let file = null;
  let tag = null;
  const preview = h("div", { class: "sticker-drop", role: "button", tabindex: "0", title: "Choose an image" }, "Choose image");
  const nameIn = h("input", { class: "input", placeholder: "Sticker name", maxLength: LIMITS.STICKER_NAME_MAX, "aria-label": "Sticker name" });
  const descIn = h("input", { class: "input", placeholder: "Description (optional)", maxLength: LIMITS.STICKER_DESCRIPTION_MAX, "aria-label": "Description" });
  const tagBtn = h("button", { class: "btn", type: "button", title: "Related emoji — helps people find it" }, "Related emoji");
  const submit = h("button", { class: "btn primary", type: "button", disabled: true }, "Upload sticker");
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
    submit.textContent = "Uploading…";
    try {
      await actions.createSticker(file, { name: nameIn.value.trim(), description: descIn.value.trim() || null, tag_emoji: tag });
      toast("Sticker added");
    } catch (e) {
      fail(e);
      submit.textContent = "Upload sticker";
      ready();
    }
  });
  const card = (s) => h("div", { class: "sticker-card" },
    stickerImg(s, { cls: "sticker-thumb" }),
    h("div", { class: "sticker-meta" },
      h("strong", {}, s.tag_emoji ? `${s.tag_emoji} ` : "", s.name),
      s.description ? h("span", { class: "muted small" }, s.description) : null,
      h("span", { class: "muted small" }, `by ${creator(s.creator_id)}${s.animated ? " · animated" : ""}`)),
    h("div", { class: "sticker-actions" },
      iconBtn("✎", `Edit ${s.name}`, () => formModal({
        title: "Edit sticker",
        fields: [
          h("label", {}, "Name", h("input", { name: "name", value: s.name, maxLength: LIMITS.STICKER_NAME_MAX, required: true, minLength: 2 })),
          h("label", {}, "Description", h("input", { name: "description", value: s.description || "", maxLength: LIMITS.STICKER_DESCRIPTION_MAX })),
        ],
        onSubmit: (fd) => actions.updateSticker(s.sticker_id, {
          name: String(fd.get("name")).trim(), description: String(fd.get("description")).trim() || null,
        }),
      })),
      iconBtn("🗑", `Delete ${s.name}`, () => confirmModal({
        title: `Delete ${s.name}?`,
        message: "Messages that used it will show it as deleted.",
        confirmLabel: "Delete",
        onConfirm: () => actions.deleteSticker(s.sticker_id),
      }), { cls: "danger" })));
  clear(el,
    h("p", { class: "muted" }, "Stickers are big images people can send on their own. Everyone in this guild can use them anywhere. ",
      "PNG, JPEG, WebP or GIF, up to 512 KB and 320×320."),
    full ? h("p", { class: "muted" }, `This guild has the maximum of ${LIMITS.MAX_GUILD_STICKERS} stickers.`)
      : h("div", { class: "sticker-form" }, preview, h("div", { class: "stack" }, nameIn, descIn, h("div", { class: "row gap" }, tagBtn, submit))),
    h("div", { class: "section-label" }, `Stickers — ${stickers.length} / ${LIMITS.MAX_GUILD_STICKERS}`),
    stickers.length ? h("div", { class: "sticker-cards" }, stickers.map(card)) : h("p", { class: "muted" }, "No stickers yet."));
}
