// Saved messages popover (PROTOCOL.md §4 Saved message), built like the pins
// panel. The list is private and the server re-checks permissions on every
// read, so a message in a channel you've lost access to just isn't there.

import { T } from "../protocol.js";
import { nameOf, state, userById } from "../state.js";
import { add, avatar, clear, fmtDateTime, h, iconBtn } from "./dom.js";
import { mdContext } from "./chat.js";
import { render as renderMarkdown } from "./markdown.js";
import { closePopover, openPopover, toast } from "./modals.js";
import { scopedT } from "../strings.js";

const t = scopedT("ui/saved");
const tc = scopedT("common");

export async function openSaved(anchor, actions) {
  const list = h("div", { class: "pins-list" }, h("p", { class: "muted pad" }, tc("loading")));
  const el = openPopover(anchor, h("div", { class: "pins" },
    h("div", { class: "pins-head" }, h("strong", {}, t("heading"))),
    list), { placement: "bottom", cls: "pins-pop", key: "saved" });
  if (!el) return;
  const draw = async () => {
    const { messages, count } = await actions.req(T.SAVED_LIST, {});
    if (!el.isConnected) return;
    clear(list);
    if (!messages.length) {
      add(list, h("div", { class: "empty-pins" }, h("div", { class: "big", "aria-hidden": "true" }, "🔖"),
        h("p", {}, count ? t("empty_but_hidden", { count }) : t("empty_body")),
        h("p", { class: "muted small" }, t("empty_hint"))));
      return;
    }
    for (const m of messages) {
      actions.rememberUser(m.author);
      const author = userById(m.author?.user_id) || m.author;
      add(list, h("div", { class: "pin" },
        avatar(author, { size: "sm" }),
        h("div", { class: "pin-main" },
          h("div", { class: "pin-head" }, h("strong", {}, nameOf(author)), h("span", { class: "muted small" }, fmtDateTime(m.sent_at))),
          h("div", { class: "pin-body" }, renderMarkdown(m.content, mdContext(state, actions)),
            m.attachments?.length ? h("div", { class: "muted small" }, t("attachment_count", { count: m.attachments.length })) : null)),
        h("div", { class: "pin-actions" },
          h("button", { class: "btn small", type: "button", on: { click: () => { closePopover(); actions.jumpTo(m.message_id, m.channel_id, m.guild_id); } } }, t("jump")),
          iconBtn("x", t("remove"), async () => {
            try {
              await actions.unsaveMessage(m);
              await draw();
            } catch (e) { toast(e.message, { error: true }); }
          }))));
    }
  };
  draw().catch((e) => clear(list, h("p", { class: "pad" }, e.message)));
}
