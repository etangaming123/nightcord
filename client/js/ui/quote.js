// A message link pasted into a message renders as a quote card of what it
// points at (PROTOCOL.md §4 Forward is the other half of this idea).
//
// The card is filled in from channel.history around that message, so the
// server decides what the reader is allowed to see: no permission check
// happens here, and one that fails just leaves the link as a link.

import { T } from "../protocol.js";
import { isThisServer, nameOf, userById } from "../state.js";
import { avatar, clear, fmtStamp, h } from "./dom.js";
import { parseMessageLink } from "./links.js";
import { scopedT } from "../strings.js";

const t = scopedT("ui/quote");

// message_id -> Promise<Message | null>. One lookup per message per session,
// however many times the link is posted.
const cache = new Map();

function lookup(actions, jump) {
  if (!cache.has(jump.messageId)) {
    cache.set(jump.messageId, actions.req(T.CHANNEL_HISTORY, {
      channel_id: jump.channelId, around_message_id: jump.messageId, limit: 1,
    }).then(({ messages }) => messages.find((m) => m.message_id === jump.messageId) || null)
      .catch(() => null));
  }
  return cache.get(jump.messageId);
}

// A card for `href`, or null when it isn't a message link on this server.
export function messageQuote(href, actions) {
  const jump = parseMessageLink(href);
  if (!jump) return null;
  if (!isThisServer(jump.server)) return null;
  const card = h("div", { class: "quote-card loading" }, h("span", { class: "muted small" }, t("loading")));
  lookup(actions, jump).then((m) => {
    if (!card.isConnected) return;
    card.classList.remove("loading");
    if (!m) {
      clear(card, h("span", { class: "muted small" }, t("unavailable")));
      return;
    }
    actions.rememberUser(m.author);
    const author = userById(m.author?.user_id) || m.author;
    clear(card,
      avatar(author, { size: "xs" }),
      h("div", { class: "quote-main" },
        h("div", { class: "quote-head" },
          h("strong", {}, nameOf(author)),
          h("span", { class: "muted small" }, fmtStamp(m.sent_at))),
        h("div", { class: "quote-body" }, (m.content || t("no_text")).slice(0, 300))),
      h("button", {
        class: "btn link", type: "button",
        on: { click: () => actions.jumpTo(m.message_id, m.channel_id, jump.guildId) },
      }, t("jump")));
  });
  return card;
}
