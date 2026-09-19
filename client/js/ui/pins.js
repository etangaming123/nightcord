// Pinned messages popover (PROTOCOL.md §5 Messaging: channel.pins).

import { T } from "../protocol.js";
import { can, currentChannel, isDm, nameOf, state, userById } from "../state.js";
import { add, avatar, clear, fmtDateTime, h, iconBtn } from "./dom.js";
import { mdContext } from "./chat.js";
import { render as renderMarkdown } from "./markdown.js";
import { closePopover, openPopover, toast } from "./modals.js";

export async function openPins(anchor, actions) {
  const channel = currentChannel();
  if (!channel) return;
  const list = h("div", { class: "pins-list" }, h("p", { class: "muted pad" }, "Loading…"));
  const el = openPopover(anchor, h("div", { class: "pins" },
    h("div", { class: "pins-head" }, h("strong", {}, "Pinned messages")),
    list), { placement: "bottom", cls: "pins-pop" });
  const canUnpin = isDm(channel) || can("MANAGE_MESSAGES", channel);
  const draw = async () => {
    const { messages } = await actions.req(T.CHANNEL_PINS, { channel_id: channel.channel_id });
    if (!el.isConnected) return;
    clear(list);
    if (!messages.length) {
      add(list, h("div", { class: "empty-pins" }, h("div", { class: "big", "aria-hidden": "true" }, "📌"),
        h("p", {}, "This channel doesn't have any pinned messages yet."),
        h("p", { class: "muted small" }, canUnpin ? "Hover over a message and press 📌 to pin it." : "Moderators can pin important messages here.")));
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
            m.attachments?.length ? h("div", { class: "muted small" }, `📎 ${m.attachments.length} attachment${m.attachments.length > 1 ? "s" : ""}`) : null)),
        h("div", { class: "pin-actions" },
          h("button", { class: "btn small-btn", type: "button", on: { click: () => { closePopover(); actions.jumpTo(m.message_id, m.channel_id); } } }, "Jump"),
          canUnpin ? iconBtn("✕", "Unpin", async () => { try { await actions.unpinMessage(m); await draw(); } catch (e) { toast(e.message, { error: true }); } }) : null)));
    }
  };
  draw().catch((e) => clear(list, h("p", { class: "pad" }, e.message)));
}
