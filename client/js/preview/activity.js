// Simulated activity for the preview: the sample people come and go, chat,
// react, vote, and answer when you talk to them. Everything they do goes
// through the same handlers as a real request (server.handleAs), so the client
// sees exactly the events a real server would send.

import { RICKROLL_URL } from "./seed.js";

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const between = (a, b) => a + Math.random() * (b - a);

const CHATTER = {
  general: [
    "anyone else still awake?", "just made tea, this is my third one tonight", "the moon is really bright right now 🌕",
    "ok who changed the server icon, it's cute", "does anyone know a good lo-fi playlist?", "back from a walk, it's freezing out",
    "hot take: cereal is soup", "I should sleep. I will not sleep.", "movie night hype 🍿", ":owl_wave:",
  ],
  memes: ["me: I'll go to bed early\nalso me at 4am:", "this server's sleep schedule is a crime scene", "posting this before I forget it", "😂😂😂"],
  pixel: ["trying out a new palette tonight", "wip: a tiny lighthouse", "how do you all do dithering without it looking noisy?", "finished a 16×16 frog :pixel_heart:"],
  dev: ["pushed a fix for the typing indicator", "anyone know why my bot keeps reconnecting?", "tests are green, shipping it", "note to self: never deploy on a Friday"],
};

const REPLIES = {
  greeting: ["hey!! 👋", "hi hi", "oh hey, you're up late too?", "hello! :owl_wave:"],
  question: ["hmm, good question", "honestly no idea 😅", "I think so? ask @luna, she'd know", "yes. probably. maybe."],
  thanks: ["anytime!", "no worries :pixel_heart:", "of course 🙂"],
  rick: ["I will never stop sending that link", "you clicked it, didn't you", "it's a classic for a reason 🕺"],
  default: ["lol", "that's so real", "wait really?", "haha same", "ooh tell me more", "✨ agreed ✨", "I was literally just thinking that", "noted!"],
};

function replyTo(text) {
  const t = text.toLowerCase();
  if (/\b(hi|hey|hello|yo|sup|hiya)\b/.test(t)) return pick(REPLIES.greeting);
  if (/rick|dqw4w9wgxcq|never gonna/.test(t)) return pick(REPLIES.rick);
  if (/\b(thanks|thank you|thx|ty)\b/.test(t)) return pick(REPLIES.thanks);
  if (t.includes("?")) return pick(REPLIES.question);
  return pick(REPLIES.default);
}

export class Activity {
  constructor(server) {
    this.s = server;
    this.on = false;
    this.timer = null;
    this.pending = new Set();
    this.joins = 0;
    this.rickrolls = [];
    // Replies and accepted friend requests run even while the loop is paused
    // between ticks, but only while activity is switched on.
    server.afterMessage = (m, uid) => { if (this.on && uid === server.me) this.#answer(m); };
    server.afterFriendRequest = (uid, other) => {
      if (!this.on || uid !== server.me || server.relation(other, uid) !== "incoming") return;
      this.#later(between(3000, 8000), () => server.handleAs(other, "friend.accept", { user_id: uid }));
    };
  }

  start() {
    if (this.on) return;
    this.on = true;
    this.#schedule(between(2500, 5000));
  }

  stop() {
    this.on = false;
    clearTimeout(this.timer);
    for (const t of this.pending) clearTimeout(t);
    this.pending.clear();
  }

  // --- the loop ----------------------------------------------------------------------------

  #schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.on) return;
      // Nothing piles up while nobody's watching: a hidden tab or an idle
      // viewer (the client reports afk after a few quiet minutes) pauses it.
      if (this.s.me && !globalThis.document?.hidden && !this.s.users.get(this.s.me)?.afk) {
        try { this.tick(); } catch (e) { console.debug("[preview] activity skipped:", e.message); }
      }
      this.#schedule(between(8000, 22000));
    }, ms);
  }

  #later(ms, fn) {
    const t = setTimeout(() => {
      this.pending.delete(t);
      if (!this.on || !this.s.me) return;
      try { fn(); } catch (e) { console.debug("[preview] activity skipped:", e.message); }
    }, ms);
    this.pending.add(t);
  }

  // One random thing happens. Exposed for tests.
  tick(kind = null) {
    const choices = [
      ["chatter", 34], ["presence", 22], ["react", 16], ["vote", 6], ["dm", 7], ["join", 5], ["rickroll", 5], ["status", 5],
    ];
    if (!kind) {
      let r = Math.random() * choices.reduce((n, [, w]) => n + w, 0);
      kind = choices.find(([, w]) => (r -= w) < 0)?.[0] || "chatter";
    }
    this[`do_${kind}`]();
    return kind;
  }

  // Someone in a guild channel the viewer is in.
  #guildChannel(name) {
    const s = this.s;
    const id = s.sample[name] || s.sample.general;
    const ch = s.channels.get(id);
    return ch && s.canView(s.me, ch) ? ch : null;
  }

  #speakers(ch) {
    const s = this.s;
    return Object.values(s.people).filter((id) => id !== s.me && s.users.get(id)?.status === "active" && !s.users.get(id).deleted
      && s.member(ch.guild_id, id) && s.canView(id, ch) && s.visibleStatus(id) !== "offline");
  }

  // Typing for a moment, then the message.
  #say(userId, channelId, content, extra = {}) {
    this.s.handleAs(userId, "typing.start", { channel_id: channelId });
    this.#later(between(1800, 4200), () => {
      const text = content.replace(/:([a-z_]+):/g, (m, name) => {
        const e = [...this.s.emojis.values()].find((x) => x.name === name && this.s.member(x.guild_id, userId));
        return e ? `<${e.animated ? "a" : ""}:${e.name}:${e.emoji_id}>` : m;
      }).replace(/@luna\b/, `<@${this.s.people.luna}>`);
      this.s.handleAs(userId, "message.send", { channel_id: channelId, content: text, ...extra });
    });
  }

  do_chatter() {
    const where = pick(["general", "general", "memes", "pixel", "dev"]);
    const ch = this.#guildChannel(where);
    if (!ch) return;
    const who = this.#speakers(ch);
    if (!who.length) return;
    this.#say(pick(who), ch.channel_id, pick(CHATTER[where] || CHATTER.general));
  }

  do_presence() {
    const s = this.s;
    const ids = Object.values(s.people).filter((id) => id !== s.people.you && id !== s.people.guest);
    const id = pick(ids);
    const now = s.visibleStatus(id);
    const next = now === "offline" ? pick(["online", "online", "idle"]) : pick(["online", "idle", "dnd", "offline"]);
    if (next !== now) s.setPresence(id, next);
  }

  do_status() {
    const s = this.s;
    const id = pick(Object.values(s.people).filter((x) => x !== s.people.you && x !== s.people.guest && s.visibleStatus(x) !== "offline"));
    if (!id) return;
    s.users.get(id).custom_status = pick(["listening to lo-fi 🎧", "can't sleep", "drawing owls", null, "🌙", "back in 5"]);
    s.userUpdated(id);
  }

  do_react() {
    const s = this.s;
    const ch = this.#guildChannel("general");
    if (!ch) return;
    const ids = (s.channelMessages.get(ch.channel_id) || []).slice(-8);
    const msg = s.messages.get(pick(ids) || "");
    if (!msg || msg.type !== "default") return;
    const who = this.#speakers(ch).filter((id) => id !== msg.author_id);
    if (!who.length) return;
    const custom = [...s.emojis.values()].filter((e) => e.guild_id === ch.guild_id);
    const emoji = Math.random() < 0.3 && custom.length
      ? (() => { const e = pick(custom); return `<${e.animated ? "a" : ""}:${e.name}:${e.emoji_id}>`; })()
      : pick(["😂", "❤️", "👀", "🦉", "🔥", "✨", "😭", "👍"]);
    s.handleAs(pick(who), "reaction.add", { message_id: msg.message_id, emoji });
  }

  do_vote() {
    const s = this.s;
    const msg = [...s.messages.values()].find((m) => m.poll && !m.poll.ended_at && s.canView(s.me, s.channels.get(m.channel_id)));
    if (!msg) return;
    const ch = s.channels.get(msg.channel_id);
    const voted = new Set(msg.poll.answers.flatMap((a) => a.user_ids));
    const who = this.#speakers(ch).filter((id) => !voted.has(id));
    if (!who.length) return;
    s.handleAs(pick(who), "poll.vote", { message_id: msg.message_id, answer_ids: [pick(msg.poll.answers).answer_id] });
  }

  do_dm() {
    const s = this.s;
    const friends = [...s.relations.entries()].filter(([k, r]) => k.startsWith(`${s.me}:`) && r.kind === "friend")
      .map(([k]) => k.split(":")[1]).filter((id) => s.visibleStatus(id) !== "offline" && !s.users.get(id).deleted);
    if (!friends.length) return;
    const from = pick(friends);
    const { channel } = s.handleAs(from, "dm.open", { user_id: s.me });
    this.#say(from, channel.channel_id, pick(["you around?", "random thought: owls are just cats with wings", "did you see the new emoji?", "movie night still on?", "how's your night going?"]));
  }

  do_join() {
    const s = this.s;
    if (this.joins >= 3) return;
    const g = s.guilds.get(s.sample.guild);
    if (!g || !s.member(g.guild_id, s.me)) return;
    this.joins += 1;
    const names = ["moth", "comet", "willow", "pebble", "nova"];
    const name = `${pick(names)}_${Math.floor(between(10, 99))}`;
    if (s.userByName(name)) return;
    const user = s.addUser({ username: name, avatar_color: pick(["#884499", "#bb6688", "#8888cc", "#3f8f6b"]), created_at: new Date().toISOString() });
    s.people[name] = user.user_id;
    s.presence.set(user.user_id, "online");
    s.addMember(g.guild_id, user.user_id, { invite_code: g.vanity_code });
    s.announceJoin(g.guild_id, user.user_id);
    this.#later(between(4000, 9000), () => {
      const ch = this.#guildChannel("general");
      if (ch) this.#say(user.user_id, ch.channel_id, pick(["hi everyone! 👋", "heard this place is cozy", "hello from the other side of the world 🌏"]));
    });
  }

  // A running joke, not spam: at most every ten minutes, three times a visit.
  do_rickroll() {
    const s = this.s;
    if (this.rickrolls.length >= 3 || Date.now() - (this.rickrolls.at(-1) || 0) < 10 * 60e3) return this.do_chatter();
    this.rickrolls.push(Date.now());
    const ch = this.#guildChannel(Math.random() < 0.5 ? "music" : "general");
    const jules = s.people.jules;
    if (!ch || !s.member(ch.guild_id, jules) || s.users.get(jules).deleted) return;
    if (s.visibleStatus(jules) === "offline") s.setPresence(jules, "online");
    this.#say(jules, ch.channel_id, pick([
      `new song just dropped, genuinely amazing ${RICKROLL_URL}`,
      `ok last one I promise, you HAVE to hear this ${RICKROLL_URL}`,
      `found the perfect movie night intro ${RICKROLL_URL}`,
    ]));
  }

  // --- answering the viewer ------------------------------------------------------------------------

  #answer(m) {
    const s = this.s;
    const ch = s.channels.get(m.channel_id);
    if (!ch || m.type !== "default") return;
    let who = null;
    if (!ch.guild_id) {
      const others = ch.recipients.filter((id) => id !== s.me && !s.users.get(id)?.deleted);
      who = pick(others) || null;
    } else {
      const reply = m.reply_to_id && s.messages.get(m.reply_to_id);
      who = m.mentions.find((id) => id !== s.me && s.member(ch.guild_id, id))
        || (reply && reply.author_id !== s.me ? reply.author_id : null);
    }
    if (!who || who === s.people.you || who === s.people.guest) return;
    if (s.visibleStatus(who) === "offline") this.#later(between(1500, 3000), () => s.setPresence(who, "online"));
    this.#later(between(1200, 3000), () => {
      if (!s.channels.has(ch.channel_id)) return;
      const extra = ch.guild_id ? { reply_to_id: m.message_id, mention_reply: true } : {};
      this.#say(who, ch.channel_id, replyTo(m.content), extra);
    });
  }
}
