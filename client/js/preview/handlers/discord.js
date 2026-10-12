// Discord link (PROTOCOL.md §5 Discord link). The preview has no real bot: a
// code links itself a few seconds after you ask for one, as if you'd typed
// /nightcord link, and nothing ever reaches Discord.

import { ERR, badRequest, fail, iso, notFound } from "../server.js";

const KINDS = ["mentions", "dms", "message_requests", "friend_requests", "announcements"];
const LINK_AFTER_MS = 4000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export default function register(s) {
  s.discordLinks = new Map(); // user_id -> DiscordLink
  const timers = new Map();
  const view = (uid) => (s.discordLinks.has(uid) ? structuredClone(s.discordLinks.get(uid)) : null);
  const push = (uid) => { if (s.me === uid) s.emit("discord.link.updated", { link: view(uid) }); };
  const need = (uid) => s.discordLinks.get(uid) ?? notFound("Your Discord link");

  s.on("discord.get", (uid) => ({
    bot: { online: true, name: "Nightcord Preview", install_url: null },
    link: view(uid),
  }));

  s.on("discord.link.start", (uid) => {
    const raw = Array.from({ length: 8 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");
    clearTimeout(timers.get(uid));
    const timer = setTimeout(() => {
      timers.delete(uid);
      s.discordLinks.set(uid, {
        discord_id: "1000000000000000001",
        discord_username: `${s.users.get(uid).username}.on.discord`,
        linked_at: iso(Date.now()),
        notify: Object.fromEntries(KINDS.map((k) => [k, true])),
        only_when_away: true,
        include_content: true,
        dm_refused: false,
      });
      push(uid);
    }, LINK_AFTER_MS);
    timer.unref?.(); // don't hold node open in tests
    timers.set(uid, timer);
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expires_at: iso(Date.now() + 600e3) };
  });

  s.on("discord.unlink", (uid) => {
    need(uid);
    s.discordLinks.delete(uid);
    push(uid);
    return {};
  });

  s.on("discord.settings.set", (uid, p) => {
    const link = need(uid);
    if (p.notify !== undefined) {
      for (const [k, v] of Object.entries(p.notify || {})) {
        if (!KINDS.includes(k) || typeof v !== "boolean") badRequest("Unknown notification kind.");
        link.notify[k] = v;
      }
    }
    for (const key of ["only_when_away", "include_content"]) if (typeof p[key] === "boolean") link[key] = p[key];
    push(uid);
    return { link: view(uid) };
  });

  s.on("discord.sync", (uid) => {
    need(uid);
    fail(ERR.DISCORD_UNAVAILABLE, "The preview has no real Discord profile to copy.");
  });

  s.on("discord.test", (uid) => {
    need(uid);
    return { delivered: true };
  });
}
