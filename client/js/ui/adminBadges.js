// Server admin → Badges (PROTOCOL.md §5 Badges). The server owner uploads badge
// images and hands them out, and the built-in Verified badge is always there.

import { LIMITS } from "../protocol.js";
import { clear, displayName, h, iconBtn } from "./dom.js";
import { pickImage } from "./images.js";
import { confirmModal, formModal, toast } from "./modals.js";
import { badgeEl } from "./names.js";
import { scopedT } from "../strings.js";

const t = scopedT("ui/adminBadges");

const fail = (e) => toast(e.message, { error: true });

export async function badgesSection(el, actions) {
  let file = null;
  const preview = h("div", { class: "sticker-drop badge-drop", role: "button", tabindex: "0", title: t("choose_image_title") }, t("choose_image"));
  const nameIn = h("input", { class: "input", placeholder: t("name_placeholder"), maxLength: LIMITS.BADGE_NAME_MAX, "aria-label": t("name_aria") });
  const descIn = h("input", { class: "input", placeholder: t("description_placeholder"), maxLength: LIMITS.BADGE_DESCRIPTION_MAX, "aria-label": t("description_aria") });
  const inlineIn = h("input", { type: "checkbox", checked: true });
  const submit = h("button", { class: "btn primary", type: "button", disabled: true }, t("create_btn"));
  const list = h("div", { class: "list" });
  let badges = [];

  const ready = () => { submit.disabled = !file || !nameIn.value.trim() || badges.length - 1 >= LIMITS.MAX_BADGES; };
  const choose = () => pickImage((f) => {
    file = f;
    if (!nameIn.value) nameIn.value = f.name.replace(/\.[^.]+$/, "").slice(0, LIMITS.BADGE_NAME_MAX);
    clear(preview, h("img", { src: URL.createObjectURL(f), alt: "" }));
    ready();
  });
  preview.addEventListener("click", choose);
  preview.addEventListener("keydown", (e) => { if (e.key === "Enter") choose(); });
  nameIn.addEventListener("input", ready);
  submit.addEventListener("click", async () => {
    submit.disabled = true;
    submit.textContent = t("uploading");
    try {
      await actions.createBadge(file, { name: nameIn.value.trim(), description: descIn.value.trim() || null, inline: inlineIn.checked });
      toast(t("badge_created"));
      file = null;
      nameIn.value = descIn.value = "";
      clear(preview, t("choose_image"));
      await draw();
    } catch (e) { fail(e); }
    submit.textContent = t("create_btn");
    ready();
  });

  const row = (b) => {
    if (!b.image) {
      return h("div", { class: "list-row expr-row" }, badgeEl(b, { cls: "big" }),
        h("span", { class: "meta" }, h("span", { class: "name" }, b.name), h("span", { class: "sub" }, t("verified_note"))));
    }
    const name = h("input", { class: "input emoji-name", value: b.name, maxLength: LIMITS.BADGE_NAME_MAX, "aria-label": t("rename_aria", { name: b.name }) });
    const save = async () => {
      const v = name.value.trim();
      if (!v || v === b.name) { name.value = b.name; return; }
      try { await actions.updateBadge(b.id, { name: v }); b.name = v; toast(t("renamed_toast", { name: v })); } catch (e) { name.value = b.name; fail(e); }
    };
    name.addEventListener("keydown", (ev) => { if (ev.key === "Enter") name.blur(); if (ev.key === "Escape") { name.value = b.name; name.blur(); } });
    name.addEventListener("blur", save);
    const inline = h("input", { type: "checkbox", checked: b.inline });
    inline.addEventListener("change", async () => {
      try { await actions.updateBadge(b.id, { inline: inline.checked }); b.inline = inline.checked; } catch (e) { inline.checked = b.inline; fail(e); }
    });
    return h("div", { class: "list-row expr-row" }, badgeEl(b, { cls: "big" }), name,
      h("label", { class: "check grow" }, inline, h("span", { class: "small" }, t("show_next_to_name"))),
      iconBtn("🗑", t("delete_aria", { name: b.name }), () => confirmModal({
        title: t("delete_title", { name: b.name }),
        message: t("delete_message"),
        confirmLabel: t("delete_btn"),
        onConfirm: async () => { await actions.deleteBadge(b.id); await draw(); },
      }), { cls: "danger" }));
  };

  async function draw() {
    try { badges = await actions.listBadges(); } catch (e) { fail(e); return; }
    clear(list, badges.map(row));
    ready();
  }

  el.append(
    h("p", { class: "muted" }, t("intro")),
    h("div", { class: "sticker-form stack" },
      h("div", { class: "row gap" }, preview, h("div", { class: "stack grow" }, nameIn, descIn)),
      h("label", { class: "check" }, inlineIn, h("span", {}, t("show_next_to_name_hint"))),
      h("div", { class: "row gap" }, submit,
        h("span", { class: "muted small" }, t("image_note")))),
    h("h3", {}, t("all_badges_heading")),
    list);
  await draw();
}

// Owner-only: choose which badges a user has. New ones go on the end.
export async function giveBadgesDialog(u, actions, after = () => {}) {
  let badges;
  try { badges = await actions.listBadges(); } catch (e) { fail(e); return; }
  const have = (u.badges || []).map((b) => b.id);
  const ordered = [...have.filter((id) => badges.some((b) => b.id === id)), ...badges.map((b) => b.id).filter((id) => !have.includes(id))];
  formModal({
    title: t("give_title", { name: displayName(u) }),
    subtitle: t("give_subtitle", { max: LIMITS.MAX_USER_BADGES }),
    submitLabel: t("save_btn"),
    fields: ordered.map((id) => {
      const b = badges.find((x) => x.id === id);
      return h("label", { class: "check badge-pick" },
        h("input", { type: "checkbox", name: id, checked: have.includes(id) }),
        badgeEl(b), h("span", {}, b.name, b.inline ? null : h("span", { class: "muted small" }, ` · ${t("profile_only")}`)));
    }),
    onSubmit: async (fd) => {
      const ids = ordered.filter((id) => fd.get(id) === "on");
      await actions.setUserBadges(u.user_id, ids);
      toast(t("badges_saved_toast", { name: displayName(u) }));
      await after();
    },
  });
}
