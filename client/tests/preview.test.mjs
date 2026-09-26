// node client/tests/preview.test.mjs — the preview's pretend server
// (client/js/preview) answers every request the protocol has, behaves like the
// real one for the common paths, and refuses a member what it refuses them.
import assert from "node:assert/strict";
import { T } from "../js/protocol.js";
import { createPreview } from "../js/preview/index.js";

const preview = createPreview();
const s = preview.server;
let events = [];
s.sink = (type, payload) => events.push({ type, payload });
const take = () => { const out = events; events = []; return out; };
const types = (list) => list.map((e) => e.type);
const rejects = (fn, code) => assert.throws(fn, (e) => e.code === code, `expected ${code}`);

// 1. Every request type (anything with a .result, plus the auth requests) has a handler.
const values = new Set(Object.values(T));
const requests = [...values].filter((v) => values.has(`${v}.result`));
requests.push(T.AUTH_LOGIN, T.AUTH_REGISTER, T.AUTH_RESUME, T.SETUP_CLAIM);
const missing = requests.filter((type) => !s.handlers.has(type));
assert.deepEqual(missing, [], `no preview handler for: ${missing.join(", ")}`);

// 2. Logging in as the owner and loading what the client loads.
rejects(() => s.handle(T.GUILD_LIST), "not_authenticated");
rejects(() => s.handle(T.AUTH_LOGIN, { username: "you", password: "nope" }), "invalid_credentials");
const ok = s.handle(T.AUTH_LOGIN, { username: "you", password: "preview-owner" });
assert.equal(ok.user.is_server_owner, true);
const me = ok.user.user_id;
const { guilds } = s.handle(T.GUILD_LIST);
assert.ok(guilds.length >= 2);
for (const g of guilds) {
  assert.ok(typeof g.my_permissions === "number" && Array.isArray(g.emojis));
  const { channels } = s.handle(T.CHANNEL_LIST, { guild_id: g.guild_id });
  for (const ch of channels.filter((c) => c.kind === "text")) {
    const page = s.handle(T.CHANNEL_HISTORY, { channel_id: ch.channel_id });
    const ids = page.messages.map((m) => m.message_id);
    assert.deepEqual(ids, [...ids].sort((a, b) => (a.length - b.length) || (a < b ? -1 : 1)), "history is oldest first");
  }
}
const { channels: dms } = s.handle(T.DM_LIST);
assert.ok(dms.some((c) => c.kind === "group_dm") && dms.some((c) => c.request?.state === "pending"));
for (const t of [T.READ_STATE_LIST, T.NOTIFY_PREFS_GET, T.FRIEND_LIST, T.ANNOUNCEMENT_LIST, T.SAVED_LIST, T.ADMIN_STORAGE, T.ADMIN_STATS, T.BADGE_LIST]) {
  s.handle(t, {});
}
const ids = new Set();
for (const m of s.messages.values()) {
  assert.ok(!ids.has(m.message_id), "message ids are unique");
  ids.add(m.message_id);
}
take();

// 3. The everyday things, with the events a real server would send.
const general = s.sample.general;
const sent = s.handle(T.MESSAGE_SEND, { channel_id: general, content: `hi <@${s.people.luna}>` });
assert.deepEqual(sent.message.mentions, [s.people.luna]);
assert.deepEqual(types(take()), ["message.new"]);
s.handle(T.MESSAGE_EDIT, { message_id: sent.message_id, content: "edited" });
assert.equal(take()[0].payload.content, "edited");
s.handle(T.REACTION_ADD, { message_id: sent.message_id, emoji: "🦉" });
assert.deepEqual(types(take()), ["reaction.added"]);
s.handle(T.MESSAGE_PIN, { message_id: sent.message_id });
assert.deepEqual(types(take()), ["message.updated", "message.new"]);
const poll = s.handle(T.MESSAGE_SEND, { channel_id: general, content: "", poll: { question: "Tea?", answers: [{ text: "yes" }, { text: "no" }] } });
take();
assert.equal(s.handle(T.POLL_VOTE, { message_id: poll.message_id, answer_ids: [1] }).poll.total_votes, 1);
const roll = s.handle(T.MESSAGE_SEND, { channel_id: general, content: "", command: { name: "roll", args: "2d6" } });
assert.equal(roll.message.command.result.rolls.length, 2);
take();
const made = s.handle(T.GUILD_CREATE, { name: "My Place" });
assert.equal(made.channels[0].name, "general");
const ch = s.handle(T.CHANNEL_CREATE, { guild_id: made.guild.guild_id, name: "Cool Stuff" });
assert.equal(ch.channel.name, "cool-stuff");
const inv = s.handle(T.GUILD_INVITE_CREATE, { guild_id: made.guild.guild_id });
assert.equal(s.handle(T.GUILD_INVITE_RESOLVE, { invite_code: inv.invite_code }).is_member, true);
s.handle(T.FRIEND_ACCEPT, { user_id: s.people.theo });
assert.equal(s.relation(me, s.people.theo), "friend");
s.handle(T.SAVED_ADD, { message_id: sent.message_id });
assert.equal(s.handle(T.SAVED_LIST, {}).count, 1);
s.handle(T.MESSAGE_DELETE, { message_id: sent.message_id });
assert.equal(s.handle(T.SAVED_LIST, {}).count, 0);
const lounge = s.handle(T.GUILD_JOIN_BY_ID, { guild_id: s.sample.lounge });
assert.equal(lounge.guild.ghost, false);
take();

// A link the preview knows gets its canned card a moment later.
s.handle(T.MESSAGE_SEND, { channel_id: general, content: "https://youtu.be/dQw4w9WgXcQ" });
await new Promise((r) => setTimeout(r, 500));
const updated = take().find((e) => e.type === "message.updated");
assert.equal(updated.payload.embeds[0].youtube_id, "dQw4w9WgXcQ");

// 4. A regular member gets refused what a real server refuses them.
const guest = preview.sessionFor("member");
s.handle(T.AUTH_RESUME, { session_token: guest.token });
const lunaMessage = [...s.messages.values()].find((m) => m.author_id === s.people.luna && m.channel_id === general);
rejects(() => s.handle(T.MESSAGE_DELETE, { message_id: lunaMessage.message_id }), "forbidden");
rejects(() => s.handle(T.SERVER_CONFIG_UPDATE, { server_name: "mine now" }), "forbidden");
rejects(() => s.handle(T.ADMIN_STORAGE), "forbidden");
rejects(() => s.handle(T.CHANNEL_CREATE, { guild_id: s.sample.guild, name: "nope" }), "forbidden");
const welcome = [...s.channels.values()].find((c) => c.name === "welcome");
rejects(() => s.handle(T.MESSAGE_SEND, { channel_id: welcome.channel_id, content: "hi" }), "forbidden");
const { channels: visible } = s.handle(T.CHANNEL_LIST, { guild_id: s.sample.guild });
assert.ok(!visible.some((c) => c.name === "staff-room"), "members don't see private channels");

// 5. Simulated activity: every kind of event runs without throwing.
s.handle(T.AUTH_RESUME, { session_token: preview.sessionFor("owner").token });
for (const kind of ["chatter", "presence", "react", "vote", "dm", "join", "rickroll", "status"]) preview.activity.tick(kind);
preview.activity.stop();

console.log("preview tests passed");
