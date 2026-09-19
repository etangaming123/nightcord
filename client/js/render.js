// Batched rendering: invalidate("rail", "chat", …) marks parts dirty and they
// are redrawn once on the next animation frame.

import { channelTitle, currentChannel, currentGuild, guildBadge, homeBadge, state } from "./state.js";
import { renderChat, renderChatHeader, renderTyping } from "./ui/chat.js";
import { renderComposer } from "./ui/composer.js";
import { renderMembers } from "./ui/members.js";
import { renderChannelSidebar, renderRail } from "./ui/sidebar.js";

let actions = null;
export const setActions = (a) => { actions = a; };

const PARTS = {
  rail: () => renderRail(state, actions),
  sidebar: () => renderChannelSidebar(state, actions),
  header: () => renderChatHeader(state, actions),
  // Composer and typing line first: they change the message list's height,
  // and renderChat's scroll positioning must see the final layout.
  composer: () => renderComposer(state, actions),
  typing: () => renderTyping(state),
  chat: () => renderChat(state, actions),
  members: () => renderMembers(state, actions),
  title: renderTitle,
};
const ALL = Object.keys(PARTS);

const dirty = new Set();
let scheduled = false;

export function invalidate(...parts) {
  for (const p of parts.length ? parts : ALL) dirty.add(p);
  if (scheduled) return;
  scheduled = true;
  // rAF doesn't run in background tabs; the timer keeps state and DOM in step there.
  requestAnimationFrame(() => scheduled && flush());
  setTimeout(() => scheduled && flush(), 100);
}

// Render now (e.g. before measuring scroll positions).
export function flush() {
  scheduled = false;
  const parts = [...dirty];
  dirty.clear();
  if (!state.user) return;
  const box = document.getElementById("messages");
  const stick = box && box.scrollHeight - box.scrollTop - box.clientHeight < 4;
  for (const p of ALL) if (parts.includes(p)) PARTS[p]();
  // A taller composer (reply bar) mustn't hide the newest message.
  if (stick && !parts.includes("chat")) box.scrollTop = box.scrollHeight;
}

function renderTitle() {
  let unread = homeBadge();
  for (const id of state.guilds.keys()) unread += guildBadge(id).mentions;
  const ch = currentChannel();
  const g = currentGuild();
  const where = ch ? `${channelTitle(ch)}${g ? ` · ${g.name}` : ""}` : g ? g.name : state.view === "home" ? "Direct Messages" : "";
  document.title = `${unread ? `(${unread}) ` : ""}${where ? `${where} — ` : ""}Nightcord`;
}
