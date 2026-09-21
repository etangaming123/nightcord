// Desktop notifications and the notification sound. Which messages notify is
// decided by the synced notify prefs (PROTOCOL.md §5 Notification
// preferences); whether to show a popup / play a sound is per device.

import { getPrefs } from "./prefs.js";
import { channelTitle, isMuted, mentionsMe, notifyLevel, state, userById } from "./state.js";
import { displayName, avatarUrl } from "./ui/dom.js";
import { plainText } from "./ui/markdown.js";
import { scopedT } from "./strings.js";

const t = scopedT("notify");

let audio = null;

function blip() {
  try {
    audio = audio || new AudioContext();
    const t = audio.currentTime;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(1320, t + 0.08);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + 0.3);
  } catch {
    /* audio unavailable (autoplay policy etc.) */
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
  if (prefs.sound) blip();
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
