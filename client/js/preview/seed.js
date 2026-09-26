// The preview's sample server: people, guilds, channels, a few days of chat,
// DMs, friends and the odd thing waiting for the owner. Built fresh every time
// the preview opens; nothing here is saved anywhere.

import { LIMITS, PERMS } from "../protocol.js";
import {
  EMOJI_ART, STICKER_ART, articleThumb, badgeArt, bannerArt, bouncingGif, iconArt, pixelScene, sunsetPhoto, textFile, videoThumb,
} from "./art.js";
import { PreviewServer, iso, newId } from "./server.js";

export const OWNER = { username: "you", password: "preview-owner" };
export const MEMBER = { username: "guest", password: "preview-member" };

const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const RICKROLL_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

// Link previews the preview "knows": posting one of these links (or the
// sample users doing it) shows a real-looking card without fetching anything.
function embedLibrary() {
  const rick = {
    kind: "video", url: RICKROLL_URL, title: "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
    description: null, site_name: "YouTube", provider_url: "https://www.youtube.com/", author: "Rick Astley",
    author_url: "https://www.youtube.com/@RickAstleyYT", color: "#ff0000", image: "/proxy/preview/rick",
    image_width: 480, image_height: 270, thumbnail: null, video: null, video_width: null, video_height: null,
    youtube_id: "dQw4w9WgXcQ",
  };
  const cards = {
    [RICKROLL_URL]: rick,
    "https://youtu.be/dQw4w9WgXcQ": { ...rick, url: "https://youtu.be/dQw4w9WgXcQ" },
    "https://github.com/etangaming123/nightcord": {
      kind: "link", url: "https://github.com/etangaming123/nightcord", title: "GitHub - etangaming123/nightcord",
      description: "An open-source, self-hostable parody of Discord. Python server, plain JavaScript client, no build step.",
      site_name: "GitHub", provider_url: "https://github.com/", color: "#1f2328", thumbnail: "/proxy/preview/github",
    },
    "https://en.wikipedia.org/wiki/Owl": {
      kind: "link", url: "https://en.wikipedia.org/wiki/Owl", title: "Owl - Wikipedia",
      description: "Owls are birds from the order Strigiformes, which includes over 200 species of mostly solitary and nocturnal birds of prey.",
      site_name: "Wikipedia", provider_url: "https://en.wikipedia.org/", thumbnail: "/proxy/preview/wiki",
    },
    "https://tenor.com/view/bouncing-ball-gif-5551234": {
      kind: "image", url: "https://tenor.com/view/bouncing-ball-gif-5551234", site_name: "Tenor",
      image: "/proxy/preview/bounce", image_width: 320, image_height: 240,
    },
    "https://x.com/nightcordapp/status/1830000000000000000": {
      kind: "link", url: "https://x.com/nightcordapp/status/1830000000000000000", title: "Nightcord (@nightcordapp)",
      description: "the preview is live!! try the whole app in your browser, no server needed 🌙\n\n💬 12   🔁 48   ❤️ 301",
      site_name: "FixupX", provider_url: "https://fixupx.com/", author: "Nightcord (@nightcordapp)",
      author_url: "https://x.com/nightcordapp", color: "#6364ff", image: "/proxy/preview/pixel", image_width: 320, image_height: 240,
    },
  };
  const images = {
    rick: videoThumb("Rick Astley"),
    github: articleThumb("#24292f", "#57606a"),
    wiki: articleThumb("#8a6bb3", "#3c2961"),
    bounce: bouncingGif(),
    pixel: pixelScene(),
  };
  const full = (e) => ({
    kind: "link", url: null, title: null, description: null, site_name: null, provider_url: null, author: null,
    author_url: null, color: null, image: null, image_width: null, image_height: null, thumbnail: null, video: null,
    video_width: null, video_height: null, youtube_id: null, ...e,
  });
  return {
    embedFor: (url) => (cards[url] ? full(cards[url]) : null),
    proxyImage: (key) => images[key] || null,
  };
}

const PEOPLE = [
  // username, display name, colour, presence, custom status, bio, staff role
  ["luna", "Luna", "#8a6bb3", "online", "painting the night sky 🌙", "Admin here. I draw owls and break things.", "admin"],
  ["milo", "Milo", "#3f8f6b", "idle", "brb, coffee ☕", "Moderator. Ask me about keyboards.", "moderator"],
  ["ava", "Ava", "#d0679d", "online", null, "Runs Pixel Garden. 16×16 or bust.", "none"],
  ["kai", "Kai", "#3b7dd8", "dnd", "in a match 🎮", "Rank up or log off.", "none"],
  ["rin", "Rin", "#e39b3b", "online", null, "Night shift nurse, day shift gamer.", "none"],
  ["jules", "Jules", "#c24c4c", "online", "have you heard this song?", "I promise every link I send is legit.", "none"],
  ["pete", "Pixel Pete", "#6d6d9e", "offline", null, "Making a game about a very small owl.", "none"],
  ["sage", "Sage", "#6aa86a", "idle", "reading 📚", null, "none"],
  ["noor", "Noor", "#b36b3d", "online", null, "New around here!", "none"],
  ["theo", "Theo", "#4a9c9c", "online", null, "Music producer, occasional DJ.", "none"],
  ["ivy", "Ivy", "#9c4a8a", "offline", null, null, "none"],
  ["dev_dan", "Dan", "#5a7a9e", "offline", "shipping", "I wrote half the bots in #dev.", "none"],
];

export function buildServer() {
  const s = new PreviewServer();
  const lib = embedLibrary();
  s.embedFor = lib.embedFor;
  s.proxyImage = lib.proxyImage;
  s.freeBytes = 192 * 1024;
  const now = Date.now();

  s.config = {
    server_name: "Nightcord Preview",
    server_description: "**This is the Nightcord preview.** Everything you see is sample data, running entirely in your browser: nothing you type, upload or change is sent anywhere, and it's all gone when you reload.\n\nClick around, send messages, make a server, poke at the owner settings. The people here are pretend, but with *Simulated activity* on they'll chat, react and reply to you.",
    guild_creation: "on",
    account_creation: "on",
    guild_list_visible: true,
    max_upload_bytes: 25 * 1024 * 1024,
    voice_enabled: true,
    customization_mode: "on",
    customization_features: Object.fromEntries(LIMITS.CUSTOMIZATION_FEATURES.map((f) => [f, true])),
    user_search: "on",
    announcements_admins: false,
    max_accounts_per_client: 0,
    link_embeds: true,
    fx_links: true,
  };
  s.legal = {
    terms: "# Terms of Service\n\n1. Be kind.\n2. No spam, no scams.\n3. This is a preview: nothing here is real, including these terms.",
    privacy: "# Privacy Policy\n\nThe preview keeps everything in your browser's memory and forgets it when you leave. The server owner of a real Nightcord server can see your IP address and what you post.",
    version: "preview1",
  };

  // --- people -----------------------------------------------------------------------------

  const verified = { id: LIMITS.BADGE_VERIFIED, name: "Verified", description: "Verified by the server owner", image: null, inline: true };
  s.badges.set(verified.id, verified);
  const badge = (name, description, shape, a, b, inline = true) => {
    const m = s.addMedia("badge", { url: badgeArt(shape, a, b), size: 2400 });
    m.claimed = true;
    const bdg = { id: m.media_id, name, description, image: m.media_id, inline };
    s.badges.set(bdg.id, bdg);
    return bdg.id;
  };
  const earlyOwl = badge("Early Owl", "Here since the first night", "owl", "#553a7f", "#8a6bb3");
  const bugHunter = badge("Bug Hunter", "Found a bug and told us about it", "bolt", "#b8860b", "#ffcc4d");
  const artist = badge("Artist", "Made something lovely for the server", "star", "#d0679d", "#8a6bb3", false);

  const media = (kind, url, size = 3000, extra = {}) => {
    const m = s.addMedia(kind, { url, size, ...extra });
    m.claimed = true;
    return m;
  };

  const created = (daysAgo) => iso(now - daysAgo * DAY);
  const me = s.addUser({
    username: OWNER.username, password: OWNER.password, display_name: "You", is_server_owner: true, server_role: "owner",
    avatar_color: "#884499", bio: "I run this (pretend) server.", created_at: created(120), legal_version: s.legal.version,
    badges: [LIMITS.BADGE_VERIFIED, earlyOwl], perks: true, dm_privacy: "requests",
  });
  const guest = s.addUser({
    username: MEMBER.username, password: MEMBER.password, display_name: "Guest", avatar_color: "#3b7dd8",
    bio: "Just looking around.", created_at: created(9), legal_version: s.legal.version,
  });
  const u = { you: me.user_id, guest: guest.user_id };
  PEOPLE.forEach(([username, display, color, presence, status, bio, role], i) => {
    const user = s.addUser({
      username, display_name: display, avatar_color: color, custom_status: status, bio, server_role: role,
      created_at: created(110 - i * 8), legal_version: s.legal.version, dm_privacy: "requests",
    });
    u[username] = user.user_id;
    s.presence.set(user.user_id, presence);
  });
  const set = (name, fields) => Object.assign(s.users.get(u[name]), fields);
  set("luna", {
    badges: [LIMITS.BADGE_VERIFIED, earlyOwl, artist], perks: true, profile_colors: ["#553a7f", "#d0679d"],
    avatar_id: media("avatar", iconArt("moon", "#553a7f", "#8a6bb3")).media_id,
    banner_id: media("banner", bannerArt("#553a7f", "#d0679d", "moon"), 9000).media_id,
  });
  set("milo", { badges: [bugHunter], avatar_id: media("avatar", iconArt("leaf", "#2f6f4f", "#6aa86a")).media_id });
  set("ava", { badges: [artist], avatar_id: media("avatar", iconArt("pixel", "#d0679d", "#ffb3d1")).media_id });
  set("kai", { avatar_id: media("avatar", iconArt("bolt", "#1d4f91", "#3b7dd8")).media_id });
  set("jules", { avatar_id: media("avatar", iconArt("note", "#7d1f1f", "#c24c4c")).media_id });
  set("theo", { avatar_id: media("avatar", iconArt("wave", "#1f5f5f", "#4a9c9c")).media_id });
  set("dev_dan", { badges: [bugHunter] });
  // An account request waiting for the owner, and an old disabled one.
  const nora = s.addUser({ username: "night_nora", status: "pending", note: "Luna sent me! I'd love to join the art channels.", created_at: iso(now - 3 * HOUR) });
  s.addUser({ username: "old_account", status: "disabled", display_name: "Old Account", created_at: created(200) });
  void nora;

  // Sessions give the Accounts tab something to show for "last seen" and devices.
  const session = (userId, agoMs, agent, device, ip) => {
    const id = newId(now - agoMs - 5 * DAY);
    s.sessions.set(id, { session_id: id, user_id: userId, token: `seed-${id}`, created_at: now - agoMs - 5 * DAY, last_seen: now - agoMs, user_agent: agent, device_id: device, ip });
  };
  const agents = ["Mozilla/5.0 (Windows NT 10.0) Chrome/128", "Mozilla/5.0 (Macintosh) Safari/17", "Mozilla/5.0 (iPhone) Mobile Safari", "Mozilla/5.0 (X11; Linux) Firefox/130"];
  PEOPLE.forEach(([name, , , presence], i) => {
    const ago = presence === "offline" ? (i + 1) * 9 * HOUR + (name === "ivy" ? 40 * DAY : 0) : (i % 3) * MIN;
    session(u[name], ago, agents[i % agents.length], `dev-${name}`, `198.51.100.${10 + i}`);
    if (i % 4 === 0) session(u[name], ago + 2 * DAY, agents[(i + 1) % agents.length], `dev-${name}-2`, `203.0.113.${40 + i}`);
  });
  session(u.you, 3 * DAY, "Nightcord standalone (Windows)", "dev-you-desktop", "192.0.2.14");
  session(u.guest, 2 * DAY, "Mozilla/5.0 (Android) Chrome/128", "dev-guest-phone", "192.0.2.77");

  // --- relationships ------------------------------------------------------------------------

  for (const meId of [u.you, u.guest]) {
    for (const name of ["luna", "milo", "kai", "ava", "rin", "jules"]) {
      s.setRelation(meId, u[name], "friend");
      s.setRelation(u[name], meId, "friend");
    }
    s.setRelation(u.theo, meId, "outgoing");
    s.setRelation(meId, u.theo, "incoming");
    s.setRelation(meId, u.ivy, "outgoing");
    s.setRelation(u.ivy, meId, "incoming");
  }
  s.setRelation(u.you, u.guest, "friend");
  s.setRelation(u.guest, u.you, "friend");

  // --- helpers for writing chat ---------------------------------------------------------------

  // "@luna", ":coffee:" and "#general" become real mentions, emoji and channel links.
  const emojiIds = {};
  const channelIds = {};
  const fmt = (text) => text
    .replace(/(^|[\s(])@([a-z_]+)/g, (m, pre, name) => (u[name] ? `${pre}<@${u[name]}>` : m))
    .replace(/:([a-z_]+):/g, (m, name) => (emojiIds[name] ? emojiIds[name] : m))
    .replace(/(^|\s)#([a-z-]+)\b/g, (m, pre, name) => (channelIds[name] ? `${pre}<#${channelIds[name]}>` : m));

  // Messages are written oldest first; `at` is how long ago.
  const say = (channel, who, text, at, extra = {}) => {
    const t = now - at;
    const content = fmt(text);
    const ch = s.channels.get(channel);
    const mentions = [...content.matchAll(/<@(\d+)>/g)].map((x) => x[1]);
    const m = {
      message_id: newId(t), channel_id: channel, author_id: u[who], content, sent_at: iso(t), edited_at: null,
      reply_to_id: null, mentions, mention_everyone: /@everyone/.test(content) && !!ch.guild_id, reactions: [],
      type: "default", pinned: false, embeds: [], embeds_suppressed: false, command: null, poll: null, forward: null,
      attachment_ids: [], stickers: [], ...extra,
    };
    if (m.reactions.length) m.reactions = m.reactions.map(([emoji, ...who2]) => ({ emoji: fmt(emoji), user_ids: who2.map((n) => u[n]) }));
    const links = content.match(/https?:\/\/\S+/g) || [];
    if (!extra.embeds && links.length) m.embeds = links.map((l) => lib.embedFor(l)).filter(Boolean);
    s.addMessage(m);
    return m;
  };
  const attach = (channel, who, filename, contentType, url, size, width = null, height = null) => {
    const id = newId();
    s.attachments.set(id, {
      attachment_id: id, filename, content_type: contentType, size, width, height,
      url: `/files/${id}/${encodeURIComponent(filename)}`, user_id: u[who], channel_id: channel, claimed: true, blobUrl: url,
    });
    return id;
  };

  // --- Night Owls (you own it) -----------------------------------------------------------------

  const owls = s.createGuild("Night Owls", u.you, { created_at: created(100), vanity_code: "night-owls", system_flags: LIMITS.SYSTEM_JOIN | LIMITS.SYSTEM_LEAVE });
  const G = owls.guild_id;
  owls.icon_id = media("guild_icon", iconArt("owl", "#2b1d47", "#8a6bb3")).media_id;
  owls.banner_id = media("guild_banner", bannerArt("#2b1d47", "#8a6bb3", "star"), 9000).media_id;
  const role = (name, color, permissions, position, extra = {}) => {
    const r = { role_id: newId(), guild_id: G, name, color, permissions, position, hoist: false, colors: null, icon_id: null, icon_emoji: null, ...extra };
    s.roles.set(r.role_id, r);
    return r.role_id;
  };
  const rAdmin = role("Admin", "#e0525a", PERMS.ADMINISTRATOR, 4, { hoist: true });
  const rMod = role("Moderator", "#3f8f6b", PERMS.MANAGE_MESSAGES | PERMS.KICK_MEMBERS | PERMS.BAN_MEMBERS | PERMS.MODERATE_MEMBERS
    | PERMS.VIEW_AUDIT_LOG | PERMS.MANAGE_NICKNAMES | PERMS.MENTION_EVERYONE, 3, { hoist: true, icon_emoji: "🛡️" });
  const rShift = role("Night Shift", "#8a6bb3", 0, 2, { hoist: true, colors: ["#8a6bb3", "#d0679d"] });
  const rArtist = role("Artist", "#d0679d", 0, 1, { icon_emoji: "🎨" });

  const general = [...s.channels.values()].find((c) => c.guild_id === G);
  const cat = (name, position, overwrites = []) => s.addChannel(G, { kind: "category", name, position, overwrites });
  const text = (name, position, parent, topic, extra = {}) => s.addChannel(G, { name, position, parent_id: parent.channel_id, topic, perms_synced: !extra.overwrites, ...extra });
  const info = cat("Information", 0);
  const welcome = text("welcome", 1, info, "Start here: rules, roles and where things are.", { overwrites: [{ role_id: G, allow: 0, deny: PERMS.SEND_MESSAGES }] });
  const news = text("announcements", 2, info, "News about the server. Only staff post here.", { overwrites: [{ role_id: G, allow: 0, deny: PERMS.SEND_MESSAGES }, { role_id: rMod, allow: PERMS.SEND_MESSAGES, deny: 0 }] });
  const chat = cat("Chat", 3);
  Object.assign(general, { position: 4, parent_id: chat.channel_id, topic: "Talk about anything. Be nice.", perms_synced: true });
  const memes = text("memes", 5, chat, "Low effort, high reward.");
  const music = text("music", 6, chat, "Share what you're listening to.", { slowmode_seconds: 0 });
  const projects = cat("Projects", 7);
  const pixel = text("pixel-art", 8, projects, "Post your work! Critique is welcome when asked for.");
  const dev = text("dev", 9, projects, "Code, bots and bug reports.", { slowmode_seconds: 5 });
  const staff = cat("Staff", 10, [{ role_id: G, allow: 0, deny: PERMS.VIEW_CHANNEL }, { role_id: rMod, allow: PERMS.VIEW_CHANNEL, deny: 0 }]);
  const staffRoom = text("staff-room", 11, staff, "Mods and admins only.");
  const voiceCat = cat("Voice", 12);
  s.addChannel(G, { kind: "voice", name: "Lounge", position: 13, parent_id: voiceCat.channel_id, perms_synced: true });
  const gaming = s.addChannel(G, { kind: "voice", name: "Gaming", position: 14, parent_id: voiceCat.channel_id, perms_synced: true });
  for (const c of [welcome, news, general, memes, music, pixel, dev, staffRoom]) channelIds[c.name] = c.channel_id;

  const join = (guildId, name, daysAgo, roles = [], extra = {}) => s.members.set(`${guildId}:${u[name]}`, {
    guild_id: guildId, user_id: u[name], role_ids: roles, joined_at: iso(now - daysAgo * DAY), timed_out_until: null,
    nickname: null, invited_by: null, invite_code: null, ghost: false, ...extra,
  });
  s.members.get(`${G}:${u.you}`).joined_at = created(100);
  join(G, "luna", 99, [rAdmin, rShift, rArtist], { nickname: "Luna 🌙" });
  join(G, "milo", 90, [rMod, rShift]);
  join(G, "ava", 80, [rArtist]);
  join(G, "kai", 70, [rShift]);
  join(G, "rin", 60, [rShift]);
  join(G, "jules", 50);
  join(G, "pete", 45, [rArtist]);
  join(G, "sage", 30);
  join(G, "dev_dan", 20, [], { invited_by: u.milo, invite_code: "k3yb0ard" });
  join(G, "guest", 9, [], { invited_by: u.luna, invite_code: "Wq8Ln2Zp" });
  join(G, "noor", 0.2);

  const emoji = (name, animated = false) => {
    const m = media("emoji", EMOJI_ART[name](), 1800, { width: 64, height: 64, animated });
    s.emojis.set(m.media_id, { emoji_id: m.media_id, guild_id: G, name, animated, creator_id: u.luna, created_at: created(90) });
    emojiIds[name] = `<${animated ? "a" : ""}:${name}:${m.media_id}>`;
  };
  emoji("nightcord"); emoji("owl_wave", true); emoji("pixel_heart"); emoji("coffee"); emoji("sparkles"); emoji("blobnod", true);
  const sticker = (name, description, tag) => {
    const m = media("sticker", STICKER_ART[name](), 5200, { width: 320, height: 320 });
    s.stickers.set(m.media_id, { sticker_id: m.media_id, guild_id: G, name: name.replace("_", " "), description, tag_emoji: tag, animated: false, creator_id: u.ava, created_at: created(60) });
    return m.media_id;
  };
  const stGoodNight = sticker("good_night", "For when it's finally bedtime", "🌙");
  const stOwlHi = sticker("owl_hi", "A very excited owl", "👋");
  sticker("ship_it", "It works on my machine", "✅");

  // #welcome
  const rules = say(welcome.channel_id, "you", "# Welcome to Night Owls 🦉\nA cozy server for people who are awake when they shouldn't be.\n\n## Rules\n1. Be kind. Disagree with ideas, not people.\n2. Keep it (mostly) safe for work.\n3. No spam, no self-promo outside #pixel-art.\n4. Spoilers go in ||spoiler tags||.\n\n-# Questions? Ask @luna or @milo.", 60 * DAY);
  rules.pinned = true; rules.pinned_at = now - 60 * DAY;
  say(welcome.channel_id, "luna", "Roles: **Night Shift** is for regulars, **Artist** for anyone who posts in #pixel-art. Just ask! :owl_wave:", 59 * DAY, { reactions: [["🦉", "milo", "ava", "kai"], [":sparkles:", "rin"]] });

  // #announcements
  say(news.channel_id, "luna", "@everyone Movie night this Saturday at <t:" + Math.floor((now + 2 * DAY) / 1000) + ":F> in the Lounge voice channel! Bring snacks 🍿", 2 * DAY, { mention_everyone: true, reactions: [["🍿", "kai", "rin", "ava", "jules"], ["🎉", "milo"]] });

  // #general: a few days of chat
  const gid = general.channel_id;
  const convo = [
    ["milo", "morning owls ☕ (it's 2am)", 3 * DAY + 5 * HOUR],
    ["rin", "just got off shift, what did I miss", 3 * DAY + 4 * HOUR],
    ["kai", "nothing, @milo has been drinking coffee for six hours", 3 * DAY + 4 * HOUR - 3 * MIN],
    ["milo", ":coffee: :coffee: :coffee:", 3 * DAY + 4 * HOUR - 2 * MIN, { reactions: [["😂", "rin", "kai"]] }],
    ["ava", "finished the new garden tileset!! posting it in #pixel-art", 2 * DAY + 20 * HOUR],
    ["luna", "it's so good. the little mushrooms :pixel_heart:", 2 * DAY + 19 * HOUR],
    ["jules", "unrelated but I found the best song ever, check #music", 2 * DAY + 3 * HOUR],
    ["kai", "@jules I'm not falling for that again", 2 * DAY + 3 * HOUR - 2 * MIN, { reactions: [["💀", "rin", "milo", "luna"]] }],
    ["sage", "has anyone read *The Night Circus*? halfway through and I can't put it down", 1 * DAY + 22 * HOUR],
    ["luna", "yes!! the ending is worth it, no spoilers", 1 * DAY + 21 * HOUR],
    ["rin", "||the clock||", 1 * DAY + 21 * HOUR - 4 * MIN],
    ["sage", "RIN", 1 * DAY + 21 * HOUR - 3 * MIN, { reactions: [["😭", "sage", "luna"]] }],
    ["pete", "small owl game update: he can now **fly**. badly.", 1 * DAY + 6 * HOUR, { reactions: [["🦉", "ava", "luna", "you"], [":blobnod:", "kai"]] }],
    ["dev_dan", "the /roll command is back, the dice are fair I promise", 1 * DAY + 2 * HOUR],
    ["kai", "", 1 * DAY + 2 * HOUR - MIN, { command: { name: "roll", args: "2d20", result: { notation: "2d20", rolls: [20, 19], modifier: 0, total: 39 } } }],
    ["kai", "rigged in my favour, excellent", 1 * DAY + 2 * HOUR - 50e3],
    ["ava", "", 20 * HOUR, { stickers: [stOwlHi] }],
    ["milo", "reminder that movie night is Saturday, details in #announcements", 10 * HOUR],
    ["rin", "what are we watching?", 9 * HOUR],
    ["luna", "poll time", 8 * HOUR + 30 * MIN],
  ];
  for (const [who, textLine, at, extra] of convo) say(gid, who, textLine, at, extra);
  const pollMsg = say(gid, "luna", "", 8 * HOUR + 29 * MIN, {
    poll: {
      question: "Movie night pick?", multi: false, expires_at: iso(now + 2 * DAY), ended_at: null,
      answers: [
        { answer_id: 1, text: "Spirited Away", emoji: "🐉", user_ids: [u.luna, u.ava, u.rin] },
        { answer_id: 2, text: "The Iron Giant", emoji: "🤖", user_ids: [u.kai, u.milo] },
        { answer_id: 3, text: "Paddington 2", emoji: "🐻", user_ids: [u.sage] },
      ],
    },
  });
  void pollMsg;
  say(gid, "jules", "Paddington 2 is objectively the best film ever made and I will not be taking questions", 8 * HOUR);
  say(gid, "noor", "", 5 * HOUR, { type: "member_join", content: "" });
  say(gid, "noor", "hi everyone! Luna told me about this place 👋", 5 * HOUR - MIN, { reactions: [[":owl_wave:", "luna", "milo", "ava"]] });
  const welcomeNoor = say(gid, "milo", "welcome @noor! grab a role in #welcome if you like", 5 * HOUR - 2 * MIN);
  welcomeNoor.reply_to_id = [...s.channelMessages.get(gid)].reverse().find((id) => s.messages.get(id).author_id === u.noor && s.messages.get(id).type === "default");
  say(gid, "rin", "@you are you coming to movie night?", 40 * MIN);
  say(gid, "kai", "the real question is who's bringing snacks", 12 * MIN);

  // #memes
  say(memes.channel_id, "kai", "me at 3am deciding to reorganise my entire room", 30 * HOUR);
  say(memes.channel_id, "kai", "https://tenor.com/view/bouncing-ball-gif-5551234", 30 * HOUR - 10e3, { reactions: [["😂", "rin", "jules"]] });
  say(memes.channel_id, "jules", "this server has 0 chill and I love it", 20 * HOUR);

  // #music: the classic
  say(music.channel_id, "theo", "been making lo-fi beats for the movie night intro, will share soon 🎧", 3 * DAY);
  say(music.channel_id, "jules", `ok this one is genuinely incredible, trust me ${RICKROLL_URL}`, 2 * DAY + 3 * HOUR + MIN,
    { reactions: [["💀", "kai", "rin"], ["🕺", "jules"], ["😭", "milo"]] });
  say(music.channel_id, "rin", "I clicked it. I knew and I still clicked it.", 2 * DAY + 3 * HOUR - 5 * MIN);

  // #pixel-art
  const sunset = attach(pixel.channel_id, "ava", "garden-sunset.svg", "image/svg+xml", sunsetPhoto(), 4100, 800, 500);
  say(pixel.channel_id, "ava", "new tileset! sunset over the garden. critique welcome :pixel_heart:", 2 * DAY + 19 * HOUR + 30 * MIN,
    { attachment_ids: [sunset], reactions: [[":pixel_heart:", "luna", "pete", "you"], ["🔥", "kai"]] });
  const scene = attach(pixel.channel_id, "pete", "small-owl-level-1.svg", "image/svg+xml", pixelScene(), 2900, 320, 240);
  say(pixel.channel_id, "pete", "level 1 of the owl game, lighting still WIP", 1 * DAY + 6 * HOUR + 10 * MIN, { attachment_ids: [scene] });
  say(pixel.channel_id, "luna", "the stars in the corner are perfect", 1 * DAY + 5 * HOUR);

  // #dev
  say(dev.channel_id, "dev_dan", "Nightcord itself is open source btw https://github.com/etangaming123/nightcord", 4 * DAY);
  say(dev.channel_id, "dev_dan", "small helper for rolling dice if anyone wants it:\n```js\nconst roll = (n, sides) =>\n  Array.from({ length: n }, () => 1 + Math.floor(Math.random() * sides));\n```", 3 * DAY);
  const notes = attach(dev.channel_id, "milo", "bug-notes.txt", "text/plain", textFile("Bugs found this week\n\n- typing indicator sticks around after leaving a channel\n- emoji picker scrolls to the top on hover\n- (fixed) avatars flicker on reconnect\n"), 160);
  say(dev.channel_id, "milo", "bug list from this week, most are fixed", 2 * DAY, { attachment_ids: [notes] });
  say(dev.channel_id, "luna", "also this is cool https://x.com/nightcordapp/status/1830000000000000000", 6 * HOUR);

  // #staff-room
  say(staffRoom.channel_id, "milo", "heads up: someone requested an account (night_nora), she says Luna invited her", 3 * HOUR);
  say(staffRoom.channel_id, "luna", "yep that's my friend! @you can you approve her in Server settings → Accounts?", 2 * HOUR);

  // Pin a couple, with the system message.
  const pinned = say(gid, "milo", "movie night: Saturday, Lounge voice channel. poll is above!", 7 * HOUR);
  pinned.pinned = true; pinned.pinned_at = now - 7 * HOUR;
  say(gid, "milo", "", 7 * HOUR - 1000, { type: "pin", reply_to_id: pinned.message_id });

  // Voice: Kai and Rin are "in" Gaming.
  s.voice.set(u.kai, { guild_id: G, channel_id: gaming.channel_id, user_id: u.kai, self_mute: false, self_deaf: false });
  s.voice.set(u.rin, { guild_id: G, channel_id: gaming.channel_id, user_id: u.rin, self_mute: true, self_deaf: false });

  // Invites and audit log
  const invite = (code, by, uses, maxUses, daysAgo) => s.invites.set(code, {
    code, guild_id: G, inviter_id: u[by], uses, max_uses: maxUses, expires_at: null, created_at: created(daysAgo), revoked: false,
  });
  invite("Wq8Ln2Zp", "luna", 4, 0, 30);
  invite("k3yb0ard", "milo", 1, 10, 21);
  const log = (who, action, target, details, agoMs) => s.guildAudit.push({ entry_id: newId(now - agoMs), guild_id: G, actor_id: u[who], action, target_id: target, details, created_at: iso(now - agoMs) });
  log("luna", "role.update", rShift, { name: "Night Shift" }, 20 * HOUR);
  log("milo", "message.delete", u.jules, { channel_id: gid, channel: "general" }, 2 * DAY);
  log("luna", "emoji.create", null, { name: "blobnod" }, 5 * DAY);
  log("you", "channel.create", staffRoom.channel_id, { name: "staff-room", kind: "text" }, 30 * DAY);
  s.guildAudit.sort((a, b) => (BigInt(b.entry_id) > BigInt(a.entry_id) ? 1 : -1));
  s.bans.set(`${G}:${u.ivy}`, { reason: "Spam links in #general", created_at: created(12), by: u.milo });

  // --- Pixel Garden (Ava's) -------------------------------------------------------------------------

  const garden = s.createGuild("Pixel Garden", u.ava, { created_at: created(70) });
  const PG = garden.guild_id;
  garden.icon_id = media("guild_icon", iconArt("pixel", "#2f6f4f", "#d0679d")).media_id;
  const gardenChat = [...s.channels.values()].find((c) => c.guild_id === PG);
  gardenChat.topic = "Chat about pixel art, games and plants.";
  const showcase = s.addChannel(PG, { name: "showcase", topic: "Finished pieces only!" });
  const feedback = s.addChannel(PG, { name: "feedback", topic: "Ask for critique here." });
  for (const name of ["pete", "luna", "you", "guest", "sage"]) join(PG, name, 40);
  say(gardenChat.channel_id, "ava", "welcome to the garden 🌱 post anything pixel-y", 40 * DAY);
  say(gardenChat.channel_id, "pete", "does anyone use a 4-colour palette for small sprites?", 2 * DAY);
  say(gardenChat.channel_id, "ava", "I start with 4 and cheat up to 6 :blobnod:", 2 * DAY - 20 * MIN);
  say(showcase.channel_id, "luna", "a moon for the garden", 6 * DAY, { attachment_ids: [attach(showcase.channel_id, "luna", "moon.svg", "image/svg+xml", iconArt("moon", "#2b1d47", "#553a7f"), 900, 128, 128)] });
  say(feedback.channel_id, "sage", "first attempt at a tree, be gentle", 3 * HOUR);

  // --- public guilds you can join ------------------------------------------------------------------

  const lounge = s.createGuild("Nightcord Lounge", u.luna, { listed: true, created_at: created(50), system_flags: LIMITS.SYSTEM_JOIN });
  lounge.icon_id = media("guild_icon", iconArt("star", "#553a7f", "#dda0ff")).media_id;
  const lobby = [...s.channels.values()].find((c) => c.guild_id === lounge.guild_id);
  lobby.name = "lobby";
  const intros = s.addChannel(lounge.guild_id, { name: "introductions", topic: "Say hi!" });
  for (const name of ["milo", "theo", "noor", "sage", "rin"]) join(lounge.guild_id, name, 20);
  say(lobby.channel_id, "luna", "This is a public server anyone on Nightcord Preview can join from the server list. Welcome!", 20 * DAY);
  say(intros.channel_id, "theo", "hey! I make music, mostly lo-fi. nice to meet you all", 10 * DAY);
  say(intros.channel_id, "noor", "hi, I'm Noor, I like tea and very long walks", 4 * HOUR);

  const books = s.createGuild("Midnight Book Club", u.sage, { listed: true, created_at: created(35) });
  books.icon_id = media("guild_icon", iconArt("leaf", "#6b4a2b", "#c98d5b")).media_id;
  const bookChat = [...s.channels.values()].find((c) => c.guild_id === books.guild_id);
  join(books.guild_id, "luna", 30);
  say(bookChat.channel_id, "sage", "This month: *The Night Circus*. No spoilers before the 20th!", 15 * DAY);

  // --- DMs -----------------------------------------------------------------------------------------

  const dm = (a, b, lines, request = null) => {
    const ch = {
      channel_id: newId(now - 30 * DAY), guild_id: null, kind: "dm", name: null, owner_user_id: null,
      recipients: [u[a], u[b]], request, open: new Set([u[a], u[b]]),
    };
    s.channels.set(ch.channel_id, ch);
    s.channelMessages.set(ch.channel_id, []);
    for (const [who, textLine, at, extra] of lines) say(ch.channel_id, who, textLine, at, extra);
    return ch;
  };
  for (const meName of ["you", "guest"]) {
    dm(meName, "luna", [
      ["luna", "hey! did you see Ava's new tileset?", 2 * DAY + 18 * HOUR],
      [meName, "yes!! the mushrooms", 2 * DAY + 17 * HOUR],
      ["luna", "we should get her to make custom emoji for the server", 2 * DAY + 17 * HOUR - 3 * MIN],
      ["luna", "also are you coming Saturday? :owl_wave:", 25 * MIN],
    ]);
    dm(meName, "milo", [
      ["milo", "the keyboard arrived 🎉", 4 * DAY],
      [meName, "photos or it didn't happen", 4 * DAY - 10 * MIN],
      ["milo", "", 4 * DAY - 12 * MIN, { stickers: [stGoodNight] }],
    ]);
    dm(meName, "jules", [
      ["jules", `unrelated, but you have to hear this: ${RICKROLL_URL}`, 5 * DAY],
      [meName, "no.", 5 * DAY - MIN],
    ]);
    // A message request from someone who isn't a friend yet.
    dm(meName, "noor", [["noor", "hi! Luna said you run the art channel, could I show you something?", 90 * MIN]], { from_user_id: u.noor, state: "pending" });
    const group = {
      channel_id: newId(now - 10 * DAY), guild_id: null, kind: "group_dm", name: "weekend plans 🏕️", owner_user_id: u.kai,
      recipients: [u[meName], u.kai, u.ava, u.rin], request: null, open: new Set([u[meName], u.kai, u.ava, u.rin]),
    };
    s.channels.set(group.channel_id, group);
    s.channelMessages.set(group.channel_id, []);
    say(group.channel_id, "kai", "camping this weekend??", 3 * DAY);
    say(group.channel_id, "ava", "only if there's a tent that isn't mine", 3 * DAY - 30 * MIN);
    say(group.channel_id, "rin", "I work Saturday night but I'm free Sunday", 2 * DAY);
  }
  dm("you", "guest", [["guest", "hi! just trying out the preview", 1 * DAY]]);

  // --- read state: most things read, a little new stuff waiting -------------------------------------

  for (const meId of [u.you, u.guest]) {
    for (const ch of s.channels.values()) {
      if (ch.kind === "category" || ch.kind === "voice") continue;
      const ids = s.channelMessages.get(ch.channel_id) || [];
      if (!ids.length) continue;
      // Leave the last couple of messages unread in a few places.
      const unread = { [gid]: 3, [memes.channel_id]: 0, [dev.channel_id]: 1, [staffRoom.channel_id]: 1 }[ch.channel_id] ?? (ch.guild_id ? 0 : ch.recipients.includes(u.luna) ? 1 : 0);
      const readTo = ids[Math.max(0, ids.length - 1 - unread)];
      const mentions = ch.channel_id === gid ? 1 : ch.channel_id === staffRoom.channel_id ? 1 : 0;
      s.setRead(meId, ch.channel_id, { last_read_id: unread ? readTo : ids[ids.length - 1], mention_count: meId === u.you ? mentions : 0 });
    }
  }
  s.setRead(u.guest, gid, { mention_count: 0 });

  // --- announcements and server audit -------------------------------------------------------------

  const ann = (author, kind, content, agoMs) => s.announcements.push({
    announcement_id: newId(now - agoMs), author_id: author, kind, content, created_at: iso(now - agoMs), edited_at: null,
  });
  ann(u.you, "post", "## Welcome to the Nightcord preview 🌙\nEverything here is sample data in your browser. Try anything: nothing you do leaves this tab, and a reload puts it all back.", 1 * HOUR);
  ann(null, "legal", "The server's rules were updated.", 30 * DAY);
  s.announcements.sort((a, b) => (BigInt(b.announcement_id) > BigInt(a.announcement_id) ? 1 : -1));

  const audit = (who, action, target, details, agoMs) => s.serverAudit.push({ entry_id: newId(now - agoMs), actor_id: u[who], action, target_id: target, details, created_at: iso(now - agoMs) });
  audit("you", "config.update", null, { keys: ["server_description"] }, 2 * DAY);
  audit("milo", "ip_ban.add", null, { cidr: "203.0.113.0/24" }, 12 * DAY);
  audit("you", "user.badges", u.luna, { badges: [LIMITS.BADGE_VERIFIED, earlyOwl, artist] }, 20 * DAY);
  audit("you", "staff.set", u.milo, { role: "moderator" }, 60 * DAY);
  s.serverAudit.sort((a, b) => (BigInt(b.entry_id) > BigInt(a.entry_id) ? 1 : -1));
  s.ipBans.push({ cidr: "203.0.113.0/24", reason: "Spam wave", by: u.milo, created_at: created(12) });

  // Some uploads nobody used, for the Data tab's tidy-up button.
  for (let i = 0; i < 3; i++) s.addMedia("emoji", { url: EMOJI_ART.sparkles(), size: 12000 + i * 3000 }).created_at = now - DAY;

  s.people = u;
  s.sample = { guild: G, general: gid, memes: memes.channel_id, music: music.channel_id, pixel: pixel.channel_id, dev: dev.channel_id, lounge: lounge.guild_id, garden: PG };
  return s;
}
