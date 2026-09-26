// Everything you can do to one message, in one place: the right-click and
// long-press menu, and the same functions the hover toolbar calls.

import { can, currentChannel, currentGuild, isDm, nameOf, state, userById } from "../state.js";
import { fmtStamp, h } from "./dom.js";
import { openMenu } from "./modals.js";
import { plainText } from "./markdown.js";
import { mdContext } from "./chat.js";
import { scopedT } from "../strings.js";
import { icon } from "./icons.js";

const t = scopedT("ui/messageMenu");

const LONG_PRESS_MS = 500;

// What this viewer may do to this message, in one object so the toolbar and
// the menu can never disagree.
export function messageAbilities(m, actions) {
  const channel = currentChannel();
  const system = !!m.type && m.type !== "default";
  const mine = m.author?.user_id === state.user?.user_id && !system;
  return {
    channel,
    system,
    mine,
    react: !!channel && can("ADD_REACTIONS", channel) && state.connected,
    reply: !!channel && can("SEND_MESSAGES", channel) && !system && state.connected,
    forward: !!channel && !system && state.connected,
    edit: mine && !!channel && can("SEND_MESSAGES", channel) && state.connected,
    pin: !system && !!channel && (isDm(channel) || can("MANAGE_MESSAGES", channel)) && state.connected,
    save: !system && state.connected,
    unread: !!channel && state.connected,
    remove: (mine || (!!channel && !isDm(channel) && can("MANAGE_MESSAGES", channel))) && state.connected,
    suppress: actions.canSuppressEmbeds(m),
  };
}

// The client URL that opens this message: a real link people can paste
// anywhere. Falls back to the hosted client when this page isn't on the web
// (the standalone build runs from file://).
const HOSTED = "https://nightcord.etangaming.xyz/app/";

export function messageLink(m, serverParam) {
  const base = /^https?:$/.test(location.protocol) ? `${location.origin}${location.pathname}` : HOSTED;
  const server = serverParam();
  const where = m.guild_id || currentGuild()?.guild_id || (isDm(currentChannel()) ? "@me" : "");
  const jump = `${where || "@me"}/${m.channel_id || currentChannel()?.channel_id}/${m.message_id}`;
  return `${base}?server=${encodeURIComponent(server)}&jump=${encodeURIComponent(jump)}`;
}

export function messageMenu(m, anchor, actions) {
  const a = messageAbilities(m, actions);
  const saved = actions.isSaved(m);
  openMenu(anchor, [
    a.react ? { label: t("add_reaction"), icon: "smile-plus", onClick: () => actions.pickReaction(m, anchor) } : null,
    a.reply ? { label: t("reply"), icon: "reply", onClick: () => actions.reply(m) } : null,
    a.forward ? { label: t("forward"), icon: "forward", onClick: () => actions.forwardMessage(m) } : null,
    "-",
    m.content ? { label: t("copy_text"), icon: "copy", onClick: () => actions.copyText(plainText(m.content, mdContext(state, actions)), t("copied_text")) } : null,
    { label: t("copy_link"), icon: "link", onClick: () => actions.copyText(actions.linkToMessage(m), t("copied_link")) },
    { label: t("copy_id"), icon: "id-card", onClick: () => actions.copyText(m.message_id, t("copied_id")) },
    "-",
    a.save ? { label: saved ? t("unsave") : t("save"), icon: "bookmark", onClick: () => actions.toggleSaved(m) } : null,
    a.pin ? { label: m.pinned ? t("unpin") : t("pin"), icon: "pin", onClick: (e) => (m.pinned ? actions.unpinMessage(m, e?.shiftKey) : actions.pinMessage(m, e?.shiftKey)) } : null,
    a.unread ? { label: t("mark_unread"), icon: "eye", onClick: () => actions.markUnreadFrom(m) } : null,
    a.suppress ? { label: t("hide_previews"), icon: "image", onClick: () => actions.suppressEmbeds(m) } : null,
    a.edit || a.remove ? "-" : null,
    a.edit ? { label: t("edit"), icon: "pencil", onClick: () => actions.startEdit(m) } : null,
    a.remove ? { label: t("delete"), icon: "trash-2", danger: true, onClick: (e) => actions.deleteMessage(m, e?.shiftKey) } : null,
  ], { placement: anchor instanceof Element ? "bottom" : "right", key: `message:${m.message_id}` });
}

// Right-click, and long-press for touch. Returns the handlers to spread onto
// a message element's `on`.
export function messageMenuHandlers(m, actions) {
  let timer = null;
  let moved = false;
  const cancel = () => { clearTimeout(timer); timer = null; };
  return {
    contextmenu: (e) => {
      // Let the browser's own menu win on links, images and selected text.
      if (e.target.closest("a, img, input, textarea") || !window.getSelection().isCollapsed) return;
      e.preventDefault();
      messageMenu(m, { x: e.clientX, y: e.clientY }, actions);
    },
    touchstart: (e) => {
      if (e.touches.length !== 1) return;
      moved = false;
      const { clientX: x, clientY: y } = e.touches[0];
      timer = setTimeout(() => {
        timer = null;
        if (!moved) messageMenu(m, { x, y }, actions);
      }, LONG_PRESS_MS);
    },
    touchmove: () => { moved = true; cancel(); },
    touchend: cancel,
    touchcancel: cancel,
  };
}

// Where to forward it: every channel you can send in, plus your DMs.
export function forwardDialog(m, actions, { formModal }) {
  const targets = [
    ...state.channels
      .filter((c) => c.kind === "text" && can("SEND_MESSAGES", c))
      .map((c) => ({ id: c.channel_id, label: `#${c.name}`, sub: currentGuild()?.name || "" })),
    ...[...state.dms.values()].map((c) => ({
      id: c.channel_id,
      label: c.name || c.recipients.filter((u) => u.user_id !== state.user?.user_id).map((u) => nameOf(userById(u.user_id) || u)).join(", "),
      sub: c.kind === "group_dm" ? t("group_conversation") : t("direct_message"),
    })),
  ];
  let picked = null;
  const list = h("div", { class: "list forward-targets" });
  const search = h("input", { type: "search", placeholder: t("forward_search"), "aria-label": t("forward_search") });
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const hits = targets.filter((x) => !q || x.label.toLowerCase().includes(q));
    list.replaceChildren();
    if (!hits.length) list.append(h("p", { class: "muted small pad" }, t("forward_none")));
    for (const target of hits.slice(0, 40)) {
      list.append(h("button", {
        class: `list-row forward-target ${picked === target.id ? "picked" : ""}`, type: "button",
        "aria-pressed": String(picked === target.id),
        on: { click: () => { picked = target.id; draw(); } },
      }, h("span", { class: "meta" }, h("span", { class: "name" }, target.label), h("span", { class: "sub" }, target.sub))));
    }
  };
  search.addEventListener("input", draw);
  draw();
  return formModal({
    title: t("forward_dialog_title"),
    submitLabel: t("forward_send"),
    fields: [search, list, h("label", {}, t("forward_note"), h("input", { name: "note", maxLength: 2000 }))],
    onSubmit: async (fd) => {
      if (!picked) throw new Error(t("forward_pick"));
      const label = targets.find((x) => x.id === picked)?.label || "";
      await actions.sendForward(m, picked, String(fd.get("note") || "").trim());
      actions.toastText(t("forward_sent", { name: label }));
    },
  });
}

// The "Forwarded" header above a forwarded snapshot.
export function forwardCard(m, actions) {
  const f = m.forward;
  if (!f) return null;
  const author = userById(f.author?.user_id) || f.author;
  return h("div", { class: "forward" },
    h("div", { class: "forward-head muted small" },
      icon("forward"),
      t("forwarded_from", { source: f.source })),
    h("div", { class: "forward-body" },
      h("div", { class: "forward-author" }, nameOf(author), " ",
        h("span", { class: "muted small" }, fmtStamp(f.sent_at))),
      f.content ? h("div", { class: "forward-content" }, f.content) : null,
      f.attachments?.length
        ? h("div", { class: "muted small" }, t("forward_attachments", { names: f.attachments.map((x) => x.filename).join(", ") }))
        : null,
      h("button", {
        class: "btn link", type: "button",
        on: { click: () => actions.jumpTo(f.message_id, f.channel_id, f.guild_id) },
      }, t("jump_to_original"))));
}
