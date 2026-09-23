// Desktop notifications and the notification sound. Which messages notify is
// decided by the synced notify prefs (PROTOCOL.md §5 Notification
// preferences); whether to show a popup / play a sound is per device.

import { getPrefs } from "./prefs.js";
import { channelTitle, isMuted, mentionsMe, notifyLevel, state, userById } from "./state.js";
import { displayName, avatarUrl } from "./ui/dom.js";
import { plainText } from "./ui/markdown.js";
import { scopedT } from "./strings.js";

const t = scopedT("notify");

// Sound files live in assets/sounds/ so they can be swapped without touching
// code (README → Customising). A missing or blocked file just stays silent.
const SOUNDS = {
  message: "assets/sounds/message.wav",
  mention: "assets/sounds/mention.wav",
  voiceJoin: "assets/sounds/voice-join.wav",
  voiceLeave: "assets/sounds/voice-leave.wav",
};
const players = new Map();

export function playSound(name) {
  if (!getPrefs().sound || state.user?.presence === "dnd") return;
  const src = SOUNDS[name];
  if (!src) return;
  let audio = players.get(name);
  if (!audio) {
    audio = new Audio(src);
    audio.volume = 0.6;
    players.set(name, audio);
  }
  try {
    audio.currentTime = 0;
    audio.play()?.catch(() => {}); // autoplay rules before the first click
  } catch {
    /* audio unavailable */
  }
}

// A desktop notification that isn't about a message (a reminder, the
// touch-grass nudge). Silently does nothing when they aren't allowed.
export function showDesktopNotification(title, body) {
  if (!getPrefs().desktopNotifications || !("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body: String(body).slice(0, 200), tag: "nightcord-local" });
    n.onclick = () => { window.focus(); n.close(); };
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}

export function shouldNotify(message, channel) {
  if (!state.user || message.author?.user_id === state.user.user_id) return false;
  if (state.user.presence === "dnd") return false;
  const dm = channel.guild_id === null;
  const looking = !document.hidden && document.hasFocus() && state.channelId === channel.channel_id;
  if (looking) return false;
  if (dm) return !isMuted(channel.channel_id, null) && notifyLevel(channel.channel_id, null) !== "none";
  const mentioned = mentionsMe(message);
  const level = notifyLevel(channel.channel_id, channel.guild_id);
  if (isMuted(channel.channel_id, channel.guild_id) && !mentioned) return false;
  return level === "all" || (level === "mentions" && mentioned);
}

export function notifyMessage(message, channel, onClick) {
  if (!shouldNotify(message, channel)) return;
  const prefs = getPrefs();
  playSound(mentionsMe(message) ? "mention" : "message");
  if (!prefs.desktopNotifications || !("Notification" in window) || Notification.permission !== "granted") return;
  if (!document.hidden && document.hasFocus()) return; // the in-app badge is enough
  const author = userById(message.author?.user_id) || message.author;
  const guild = channel.guild_id ? state.guilds.get(channel.guild_id) : null;
  const title = guild ? t("notif_title_guild", { author: displayName(author), channel: channelTitle(channel), guild: guild.name }) : displayName(author);
  try {
    const n = new Notification(title, {
      body: plainText(message.content, { user: userById }).slice(0, 200),
      icon: avatarUrl(author?.avatar_id) || undefined,
      tag: channel.channel_id,
    });
    n.onclick = () => {
      window.focus();
      onClick?.();
      n.close();
    };
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}
