# Nightcord Protocol

Version: `0.3`

This document is the single source of truth for the wire format between the
Nightcord client (GitHub Pages, vanilla JS) and a Nightcord server (Python).
Both `client/js/protocol.js` and `server/nightcord/protocol.py` are
implemented directly against this spec — if they disagree, this file wins
and both get fixed to match it.

## History

Each protocol version arrived with one commit on `main`, named in the middle column.

| Version | Commit | What it added |
|---|---|---|
| 0.2 | Chat server and web client | Accounts, guilds, text channels and messages over one WebSocket. |
| 0.3 | Roles, moderation, DMs, profiles and first-run setup | First-run setup, an admin API, profiles, avatars and status, direct messages, roles and permissions with channel overwrites, moderation, message edits, deletes, replies, reactions and mentions, typing, synced read state and notification preferences. |

---

## 1. Terminology

- **Server** — a single running `nightcord_server.py` process, reachable at
  an IP/hostname:port. Equivalent to "an instance," not a Discord server.
- **Guild** — a Discord-server-equivalent space living inside a Server. Has
  its own channels, roles, members, and owner. A Server can host many Guilds.
- **Server owner** — the account created during first-run setup (§8a). It
  manages server-wide settings and accounts, and can ghost-join any guild.
- **Guild owner** — the user who created a given Guild. Has every
  permission in it and can't be kicked, banned or outranked.
- **DM** — a direct-message channel outside any guild: 1:1 (`dm`) or group
  (`group_dm`, up to 10 people).

---

## 2. Transport

- Single persistent WebSocket connection per client, `wss://host:port/ws`.
- All messages, both directions, are UTF-8 JSON text frames.
- Every message is an object with a top-level `type` string and a `payload`
  object. No positional/array-based messages.

```json
{ "type": "message.send", "payload": { "channel_id": "...", "content": "..." } }
```

- A client → server message may include an `id` (string or number, chosen
  by the client). Every direct response to that request echoes the same `id`
  so the client can correlate request/response.
- A request of type `X` is answered with exactly one of:
  - `X.result` — success, payload as documented below, or
  - `X.error` — failure, payload `{ code, message }` (see §9).
  Exception: `auth.register`, `auth.login`, `auth.resume` and `setup.claim`
  answer with `auth.ok` / `auth.error`.
- Every request type in §5 has a matching `X.result`. The tables list the
  result payload in the request's row as "→ …"; `→ {}` means an empty object.
- A frame that isn't valid JSON, lacks `type`/`payload`, or names an unknown
  `type` is answered with type `error` (payload `{ code, message }`, code
  `bad_request` or `unknown_type`).
- Server → client messages without an `id` are unsolicited events.
- Maximum frame size is 64 KB.
- Only `server.info`, `setup.claim` and `auth.*` may be sent before
  authentication; anything else gets `X.error` / `not_authenticated`.
- If a connection's session is revoked (password change, "log out other
  sessions", account disabled), the server closes it with code `4001`.

### HTTP

Besides `/ws`, the server answers:

- `GET /` — a small HTML page. Opening it once lets a browser trust a
  self-signed certificate.
- `GET /avatars/{avatar_id}` — avatar images (§4 User). Immutable: each
  upload gets a new id.

---

## 3. Connection & Auth Flow

1. Client opens the WebSocket and sends `server.info`. If
   `setup_required` is true, it shows the setup wizard (§8a).
2. Client sends `auth.login` or `auth.register` (or `auth.resume` with a
   stored session token).
3. Server responds `auth.ok` (with session token + the user's own profile)
   or `auth.error`.
4. Client loads `guild.list`, `dm.list`, `read_state.list` and
   `notify.prefs.get`.
5. When the user opens a guild, the client sends `channel.list`,
   `guild.members`, `role.list` and `presence.list` for it.
6. Client sends `channel.join` for the channel in view (its "focus") and
   `channel.history` to load messages.

Message events (`message.*`, `reaction.*`) are delivered to **every** online
connection whose user can view the channel, whether or not it is focused —
that is what drives unread badges. Only `typing.started` depends on focus.

### Session resumption
- On successful auth the server issues a `session_token` (opaque string).
  Client stores it (localStorage, scoped per saved server).
- On reconnect, client sends `auth.resume` with the stored token. If the
  token is invalid/expired, the server responds `auth.error` with
  `code: "session_expired"` and the client falls back to the login screen.
- Sessions expire after 30 days without use (sliding expiry — every
  successful `auth.resume` extends it). `auth.logout` revokes the token.

---

## 4. Data Models

### IDs
All `*_id` values are snowflake-style integers (`ms_since_epoch << 12 | seq`)
serialized as decimal strings. They sort by creation time, so
`before_message_id` pagination is a plain numeric `<` comparison. Clients
must treat them as opaque strings otherwise. Permission bitfields (§5a) are
plain JSON numbers.

### User
`PublicUser` — what everyone sees:
```json
{
  "user_id": "string",
  "username": "string",
  "display_name": "string | null",
  "avatar_id": "string | null",
  "avatar_color": "#rrggbb | null",
  "custom_status": "string | null",
  "is_server_owner": false
}
```
The user's own view (`auth.ok`'s `user`, `user.updated` sent to
themselves) adds `bio`, `created_at` and `presence`
(`online | idle | dnd | invisible`, their chosen status). `user.profile`
returns `PublicUser` plus `bio` and `created_at`.

Clients show `display_name` when set, else `username`. An avatar image is
at `GET /avatars/{avatar_id}`; without one, clients draw initials on
`avatar_color` (or a color derived from the username).

Password is never sent to the client; the server stores only a bcrypt hash.

### Server config
```json
{
  "server_name": "string",
  "guild_creation": "off | on",
  "account_creation": "off | request | on",
  "guild_list_visible": true
}
```
Defaults: `guild_creation: "on"`, `account_creation: "on"`,
`guild_list_visible: true`, `server_name` from the server's config file
until the owner sets one. `guild_list_visible` gates whether a server-wide
"open guild list" can exist at all — a guild's own `listed` flag still needs
to be true for it to appear.

### Guild
```json
{
  "guild_id": "string",
  "name": "string",
  "owner_user_id": "string",
  "listed": false,
  "created_at": "ISO8601"
}
```
Guild objects sent to a member (`guild.list`, `guild.create` and the join
results) also carry `ghost: bool` and `my_permissions` (guild-wide, §5a).
`guild.public_list` entries carry `member_count`.

### Role
```json
{
  "role_id": "string",
  "guild_id": "string",
  "name": "string",
  "color": "#rrggbb | null",
  "permissions": 0,
  "position": 0,
  "is_everyone": false
}
```
Every guild has an `@everyone` role with `role_id == guild_id`, position 0,
which applies to all members. Higher `position` = higher rank.

### Member
```json
{
  "user": "PublicUser",
  "role_ids": ["string"],
  "joined_at": "ISO8601",
  "timed_out_until": "ISO8601 | null",
  "is_owner": false
}
```
`role_ids` never includes `@everyone`. Ghost memberships (§7) are never
returned as Members.

### Channel
Guild text channel:
```json
{
  "channel_id": "string",
  "guild_id": "string",
  "kind": "text",
  "name": "string",
  "position": 0,
  "overwrites": [{ "role_id": "string", "allow": 0, "deny": 0 }],
  "last_message_id": "string | null",
  "my_permissions": 0
}
```
DM channel:
```json
{
  "channel_id": "string",
  "guild_id": null,
  "kind": "dm | group_dm",
  "name": "string | null",
  "owner_user_id": "string | null",
  "recipients": ["PublicUser"],
  "last_message_id": "string | null",
  "my_permissions": 0
}
```
`recipients` includes the requesting user. `name` is only used by group
DMs. `my_permissions` is computed for the receiving user (§5a); a channel is
only ever sent to users who have `VIEW_CHANNEL` in it.

### Message
```json
{
  "message_id": "string",
  "channel_id": "string",
  "author": "PublicUser",
  "content": "string",
  "sent_at": "ISO8601",
  "edited_at": "ISO8601 | null",
  "reply_to_id": "string | null",
  "reply_to": { "message_id": "string", "author": "PublicUser", "content": "string" },
  "mentions": ["user_id"],
  "mention_everyone": false,
  "reactions": [{ "emoji": "string", "user_ids": ["string"] }]
}
```
`reply_to` is null when there's no reply or the original was deleted
(`reply_to_id` is kept either way); its `content` is cut to 120
characters. Message events also carry `guild_id` (null in DMs).

Content is plain text with a small markdown subset rendered by clients:
`**bold**`, `*italic*`, `__underline__`, `~~strike~~`, `` `code` ``,
```` ```code blocks``` ````, `> quotes`, `||spoilers||` and links. Mentions
are written `<@user_id>` and `@everyone`. The server never renders HTML.

### Read state
```json
{
  "channel_id": "string",
  "guild_id": "string | null",
  "last_message_id": "string | null",
  "last_read_id": "string | null",
  "mention_count": 0
}
```
A channel is unread when `last_message_id > last_read_id` (numerically) or
`last_read_id` is null and there are messages. Joining a guild marks its
existing history read; your own messages mark the channel read up to them.
Read state is private to its user — there are no read receipts (§10).

### Notification preference
```json
{ "target_id": "string", "level": "all | mentions | none | null", "muted": false }
```
`target_id` is a guild or a channel. `level: null` inherits (channel →
guild → client default: `all`). Muted targets don't show unread badges,
only mention counts.

### Limits
| field | rule |
|---|---|
| username | 3–32 chars, `[A-Za-z0-9_.-]`, unique case-insensitively |
| password | 8–72 bytes UTF-8 (bcrypt limit) |
| message `content` | 1–2000 chars after trimming |
| server `server_name` | 1–64 chars |
| guild `name` | 1–100 chars |
| channel `name` | 1–32 chars, `[a-z0-9_-]` (client lowercases / replaces spaces with `-`) |
| role `name` | 1–32 chars; at most 50 roles per guild |
| `display_name` | up to 32 chars |
| `bio` | up to 190 chars |
| `custom_status` | up to 128 chars |
| avatar | PNG, JPEG or WebP, at most 40 KB (clients downscale to 128×128) |
| reaction `emoji` | one unicode emoji, at most 32 UTF-16 units; at most 20 distinct emoji per message |
| group DM | at most 10 people; name up to 64 chars |
| history `limit` | default 50, max 100 |
| timeout | 1 s – 28 days |

---

## 5. Message Types

### Setup
| type | direction | payload |
|---|---|---|
| `setup.claim` | C→S | `{ setup_code, username, password, server_name?, account_creation?, guild_creation?, guild_list_visible? }` → `auth.ok`. Pre-auth; only while `setup_required` (§8a) |

### Auth
| type | direction | payload |
|---|---|---|
| `auth.register` | C→S | `{ username, password }` |
| `auth.login` | C→S | `{ username, password }` |
| `auth.resume` | C→S | `{ session_token }` |
| `auth.request_account` | C→S | `{ username, password, note? }` — used when `account_creation` is `request` |
| `auth.request_account.result` | S→C | `{ status: "pending" }` |
| `auth.ok` | S→C | `{ session_token, user }` — `user` is the self view (§4 User) |
| `auth.error` | S→C | `{ code, message }` |
| `auth.logout` | C→S | `{}` — revokes the current session token |
| `auth.logout.result` | S→C | `{}` |

### Server info / config
| type | direction | payload |
|---|---|---|
| `server.info` | C→S | `{}` — sendable pre-auth |
| `server.info.result` | S→C | `ServerConfig` plus `protocol_version` and `setup_required` |
| `server.config.update` | C→S | partial `ServerConfig` — **server owner only** |
| `server.config.update.result` | S→C | `{ config: ServerConfig }` |

### Admin (server owner only)
| type | direction | payload |
|---|---|---|
| `admin.users.list` | C→S | `{ status?: "pending"\|"active"\|"rejected"\|"disabled", query? }` |
| `admin.users.list.result` | S→C | `{ users: [AdminUser] }` — `PublicUser` plus `status`, `created_at`, `note` |
| `admin.users.set_status` | C→S | `{ user_id, status: "active"\|"rejected"\|"disabled" }` — approve (pending→active), reject (pending→rejected), disable (active→disabled; closes their connections), enable (disabled→active) |
| `admin.users.set_status.result` | S→C | `{ user: AdminUser }` |
| `admin.users.reset_password` | C→S | `{ user_id }` — sets a random password, revokes sessions |
| `admin.users.reset_password.result` | S→C | `{ password }` — shown to the owner once |
| `admin.guilds.list` | C→S | `{}` |
| `admin.guilds.list.result` | S→C | `{ guilds: [Guild + { member_count, owner: PublicUser }] }` |
| `admin.guilds.delete` | C→S | `{ guild_id }` |
| `admin.guilds.delete.result` | S→C | `{}` |
| `admin.account_requested` | S→C | `{ user: AdminUser }` — event to the server owner when someone requests an account |

The server owner's own account can't be changed through `admin.users.*`.

### Users
| type | direction | payload |
|---|---|---|
| `user.profile` | C→S | `{ user_id }` |
| `user.profile.result` | S→C | `{ user: PublicUser + { bio, created_at }, status }` |
| `user.update` | C→S | `{ display_name?, bio?, avatar_color?, custom_status? }` — `null` or `""` clears a field |
| `user.update.result` | S→C | `{ user }` (self view) |
| `user.avatar.set` | C→S | `{ data_b64 }` — base64 image, or `null` to remove |
| `user.avatar.set.result` | S→C | `{ user }` (self view) |
| `user.password.change` | C→S | `{ current_password, new_password }` — revokes every other session |
| `user.password.change.result` | S→C | `{}` |
| `user.sessions.list` | C→S | `{}` |
| `user.sessions.list.result` | S→C | `{ sessions: [{ session_id, created_at, last_seen, user_agent, current }] }` |
| `user.sessions.revoke` | C→S | `{ session_id }` — or `"others"` for every session but this one |
| `user.sessions.revoke.result` | S→C | `{}` |
| `user.search` | C→S | `{ query }` — active users whose username or display name starts with `query` (max 20) |
| `user.search.result` | S→C | `{ users: [PublicUser] }` |
| `user.updated` | S→C | `PublicUser` — event to everyone who shares a guild or DM with the user; the user's own connections get the self view |

### Presence
| type | direction | payload |
|---|---|---|
| `presence.list` | C→S | `{ guild_id }` or `{ user_ids }` (max 200; only users you share a guild or DM with) |
| `presence.list.result` | S→C | `{ presences: { user_id: "online"\|"idle"\|"dnd" } }` — offline users are omitted |
| `presence.set` | C→S | `{ status?: "online"\|"idle"\|"dnd"\|"invisible", afk?: bool }` — `status` is saved on the account; `afk` is per connection (clients set it after inactivity) |
| `presence.set.result` | S→C | `{ status }` — the status others now see |
| `presence.update` | S→C | `{ user_id, status: "online"\|"idle"\|"dnd"\|"offline" }` |

Others see a user as `offline` without connections or when `invisible`;
`dnd` when chosen; `idle` when chosen or when every connection is `afk`;
otherwise `online`. `presence.update` goes to everyone who shares a guild
(where the user is a visible member) or a DM with the user, whenever that
visible status changes. Ghost memberships never produce presence (§7).

### Guilds
| type | direction | payload |
|---|---|---|
| `guild.list` | C→S | `{}` — guilds the user belongs to (ghost memberships included) |
| `guild.list.result` | S→C | `{ guilds: [Guild] }` |
| `guild.create` | C→S | `{ name }` — `guild_creation_disabled` if `guild_creation` is off (unless server owner) |
| `guild.create.result` | S→C | `{ guild: Guild, channels: [Channel] }` — starts with `#general` and `@everyone` |
| `guild.public_list` | C→S | `{}` — only guilds with `listed: true` while `guild_list_visible: true` |
| `guild.public_list.result` | S→C | `{ guilds: [Guild] }` |
| `guild.join_by_code` | C→S | `{ invite_code }` |
| `guild.join_by_code.result` | S→C | `{ guild: Guild }` |
| `guild.join_by_id` | C→S | `{ guild_id }` — only for guilds in the public list |
| `guild.join_by_id.result` | S→C | `{ guild: Guild }` |
| `guild.owner_override_join` | C→S | `{ guild_id }` — **server owner only**; joins silently as a ghost (§7) |
| `guild.owner_override_join.result` | S→C | `{ guild: Guild }` |
| `guild.leave` | C→S | `{ guild_id }` — not allowed for the guild owner |
| `guild.leave.result` | S→C | `{}` |
| `guild.delete` | C→S | `{ guild_id }` — **guild owner only** |
| `guild.delete.result` | S→C | `{}` |
| `guild.members` | C→S | `{ guild_id }` |
| `guild.members.result` | S→C | `{ members: [Member] }` |
| `guild.config.update` | C→S | `{ guild_id, name?, listed? }` — needs `MANAGE_GUILD` |
| `guild.config.update.result` | S→C | `{ guild: Guild }` |
| `guild.invite.create` | C→S | `{ guild_id }` — needs `CREATE_INVITE` |
| `guild.invite.create.result` | S→C | `{ invite_code }` |
| `guild.bans.list` | C→S | `{ guild_id }` — needs `BAN_MEMBERS` |
| `guild.bans.list.result` | S→C | `{ bans: [{ user: PublicUser, reason, created_at }] }` |
| `guild.audit_log` | C→S | `{ guild_id, before?, limit? }` — needs `VIEW_AUDIT_LOG`; newest first, `limit` ≤ 100 |
| `guild.audit_log.result` | S→C | `{ entries: [{ entry_id, actor: PublicUser, action, target_id, details, created_at }], has_more }` |
| `guild.updated` | S→C | `Guild` — event to members after `guild.config.update` |
| `guild.removed` | S→C | `{ guild_id, reason: "kicked"\|"banned"\|"deleted" }` — event to a user who lost access |
| `guild.member_joined` | S→C | `{ guild_id, member: Member }` — never sent for ghost joins |
| `guild.member_left` | S→C | `{ guild_id, user_id, reason: "left"\|"kicked"\|"banned" }` — never sent for ghosts |
| `guild.member_updated` | S→C | `{ guild_id, member: Member }` — roles or timeout changed |
| `guild.permissions_changed` | S→C | `{ guild_id }` — roles or overwrites changed; refetch `guild.list` / `channel.list` for fresh `my_permissions` |

Audit log `action` values: `guild.update`, `channel.create`,
`channel.update`, `channel.delete`, `role.create`, `role.update`,
`role.reorder`, `role.delete`, `member.roles`, `member.kick`, `member.ban`,
`member.unban`, `member.timeout`, `message.delete` (someone else's message).

### Roles
| type | direction | payload |
|---|---|---|
| `role.list` | C→S | `{ guild_id }` |
| `role.list.result` | S→C | `{ roles: [Role] }` — highest first, `@everyone` last |
| `role.create` | C→S | `{ guild_id, name?, color?, permissions? }` — needs `MANAGE_ROLES`; placed just below the creator's highest role |
| `role.create.result` | S→C | `{ role: Role }` |
| `role.update` | C→S | `{ role_id, name?, color?, permissions? }` — needs `MANAGE_ROLES` and the role below your highest (any member may edit `@everyone`'s permissions with `MANAGE_ROLES`) |
| `role.update.result` | S→C | `{ role: Role }` |
| `role.reorder` | C→S | `{ guild_id, role_ids }` — every role except `@everyone`, highest first; only roles below yours may move |
| `role.reorder.result` | S→C | `{ roles: [Role] }` |
| `role.delete` | C→S | `{ role_id }` — not `@everyone` |
| `role.delete.result` | S→C | `{}` |
| `role.created` | S→C | `Role` — event to guild members |
| `role.updated` | S→C | `Role` — event to guild members (also sent when positions shift) |
| `role.deleted` | S→C | `{ guild_id, role_id }` |

You can't grant permissions you don't have yourself.

### Members / moderation
| type | direction | payload |
|---|---|---|
| `member.roles.set` | C→S | `{ guild_id, user_id, role_ids }` — needs `MANAGE_ROLES`; every added or removed role must be below your highest |
| `member.roles.set.result` | S→C | `{ member: Member }` |
| `member.kick` | C→S | `{ guild_id, user_id, reason? }` — needs `KICK_MEMBERS` |
| `member.kick.result` | S→C | `{}` |
| `member.ban` | C→S | `{ guild_id, user_id, reason?, delete_seconds? }` — needs `BAN_MEMBERS`; also deletes their messages from the last `delete_seconds` (≤ 7 days). Works on non-members too |
| `member.ban.result` | S→C | `{}` |
| `member.unban` | C→S | `{ guild_id, user_id }` — needs `BAN_MEMBERS` |
| `member.unban.result` | S→C | `{}` |
| `member.timeout` | C→S | `{ guild_id, user_id, duration_seconds \| null, reason? }` — needs `MODERATE_MEMBERS`; `null` lifts it |
| `member.timeout.result` | S→C | `{ member: Member }` |

Moderation targets must be visible members ranked strictly below you (the
guild owner outranks everyone). Nobody can target themselves or the owner.
A banned user can't rejoin by invite or public list (`banned`).

### Channels
| type | direction | payload |
|---|---|---|
| `channel.list` | C→S | `{ guild_id }` — channels you can view |
| `channel.list.result` | S→C | `{ channels: [Channel] }` |
| `channel.join` | C→S | `{ channel_id }` — focus this channel (guild or DM); one per connection |
| `channel.join.result` | S→C | `{}` |
| `channel.leave` | C→S | `{ channel_id }` — drop focus |
| `channel.leave.result` | S→C | `{}` |
| `channel.history` | C→S | `{ channel_id, before_message_id?, limit? }` — needs `READ_HISTORY` |
| `channel.history.result` | S→C | `{ messages: [Message], has_more }` — oldest-first |
| `channel.create` | C→S | `{ guild_id, name, overwrites? }` — needs `MANAGE_CHANNELS` (and `MANAGE_ROLES` for overwrites) |
| `channel.create.result` | S→C | `{ channel: Channel }` |
| `channel.update` | C→S | `{ channel_id, name?, position?, overwrites? }` — needs `MANAGE_CHANNELS` in the channel; `overwrites` replaces the whole list and needs `MANAGE_ROLES` |
| `channel.update.result` | S→C | `{ channel: Channel }` |
| `channel.delete` | C→S | `{ channel_id }` — needs `MANAGE_CHANNELS`; deletes its messages too |
| `channel.delete.result` | S→C | `{}` |
| `channel.ack` | C→S | `{ channel_id, message_id }` — mark read up to `message_id` and clear mentions |
| `channel.ack.result` | S→C | `{ read_state: ReadState }` |
| `channel.created` | S→C | `Channel` — event to users who can view it |
| `channel.updated` | S→C | `Channel` — event to users who can view it |
| `channel.deleted` | S→C | `{ guild_id, channel_id }` — event to guild members; also sent to users who just lost `VIEW_CHANNEL` through an overwrite change |

### Read state
| type | direction | payload |
|---|---|---|
| `read_state.list` | C→S | `{}` — every channel and open DM you can view |
| `read_state.list.result` | S→C | `{ read_states: [ReadState] }` |
| `read_state.updated` | S→C | `ReadState` — to your other connections after `channel.ack` |

### Notification preferences
| type | direction | payload |
|---|---|---|
| `notify.prefs.get` | C→S | `{}` |
| `notify.prefs.get.result` | S→C | `{ prefs: [NotifyPref] }` |
| `notify.prefs.set` | C→S | `{ target_id, level?, muted? }` — omitted `level` means inherit; inherit + unmuted deletes the pref |
| `notify.prefs.set.result` | S→C | `{ pref: NotifyPref }` |
| `notify.prefs.updated` | S→C | `NotifyPref` — to your other connections |

Desktop notifications and sounds are a client feature; the server only
stores these preferences.

### Direct messages
| type | direction | payload |
|---|---|---|
| `dm.list` | C→S | `{}` — your open DMs, most recent activity first |
| `dm.list.result` | S→C | `{ channels: [Channel] }` |
| `dm.open` | C→S | `{ user_id }` — open (or reopen) the 1:1 DM with any active user |
| `dm.open.result` | S→C | `{ channel: Channel }` |
| `dm.create_group` | C→S | `{ user_ids }` — 1–9 other users |
| `dm.create_group.result` | S→C | `{ channel: Channel }` |
| `dm.update` | C→S | `{ channel_id, name }` — group DMs only; any member may rename |
| `dm.update.result` | S→C | `{ channel: Channel }` |
| `dm.add_recipient` | C→S | `{ channel_id, user_id }` — group DMs only |
| `dm.add_recipient.result` | S→C | `{ channel: Channel }` |
| `dm.leave` | C→S | `{ channel_id }` — closes a 1:1 DM (it reopens on the next message) or leaves a group |
| `dm.leave.result` | S→C | `{}` |
| `dm.created` | S→C | `Channel` — a DM appeared for you (new group, added to one, or a closed 1:1 got a message) |
| `dm.updated` | S→C | `Channel` — name or recipients changed |

A 1:1 DM appears for the other person with its first message. Friend
requests and message requests are deferred (§10).

### Messaging
| type | direction | payload |
|---|---|---|
| `message.send` | C→S | `{ channel_id, content, reply_to_id?, mention_reply? }` — needs `SEND_MESSAGES`; rate-limited to 5 per 5 s per connection (shared with edits). Replying mentions the original author unless `mention_reply: false` |
| `message.send.result` | S→C | `{ message_id, message: Message }` |
| `message.edit` | C→S | `{ message_id, content }` — your own messages only |
| `message.edit.result` | S→C | `{ message: Message }` |
| `message.delete` | C→S | `{ message_id }` — your own, or anyone's with `MANAGE_MESSAGES` |
| `message.delete.result` | S→C | `{}` |
| `message.new` | S→C | `Message` + `guild_id` — to everyone who can view the channel (including the sender) |
| `message.updated` | S→C | `Message` + `guild_id` |
| `message.deleted` | S→C | `{ channel_id, guild_id, message_id }` |

Sending a message with mentions increments `mention_count` in the
mentioned users' read state (everyone who can view the channel for
`@everyone`, which needs `MENTION_EVERYONE`; never in DMs).

### Reactions
| type | direction | payload |
|---|---|---|
| `reaction.add` | C→S | `{ message_id, emoji }` — needs `ADD_REACTIONS` |
| `reaction.add.result` | S→C | `{}` |
| `reaction.remove` | C→S | `{ message_id, emoji }` — your own reaction |
| `reaction.remove.result` | S→C | `{}` |
| `reaction.added` | S→C | `{ channel_id, guild_id, message_id, emoji, user_id }` |
| `reaction.removed` | S→C | `{ channel_id, guild_id, message_id, emoji, user_id }` |

### Typing
| type | direction | payload |
|---|---|---|
| `typing.start` | C→S | `{ channel_id }` — needs `SEND_MESSAGES`; clients send it at most every few seconds while typing |
| `typing.start.result` | S→C | `{}` |
| `typing.started` | S→C | `{ channel_id, guild_id, user_id }` — to other users' connections focused on that channel; show for ~8 s or until their message arrives |

---

## 5a. Permissions

| flag | bit | meaning |
|---|---|---|
| `VIEW_CHANNEL` | 1 | see the channel and its live messages |
| `SEND_MESSAGES` | 2 | send messages, typing |
| `READ_HISTORY` | 4 | `channel.history` |
| `ADD_REACTIONS` | 8 | add reactions |
| `MENTION_EVERYONE` | 16 | `@everyone` pings |
| `MANAGE_MESSAGES` | 32 | delete others' messages |
| `MANAGE_CHANNELS` | 64 | create, edit, reorder, delete channels |
| `MANAGE_ROLES` | 128 | edit roles below yours, assign them, edit channel overwrites |
| `MANAGE_GUILD` | 256 | guild name and listing |
| `CREATE_INVITE` | 512 | create invite codes |
| `KICK_MEMBERS` | 1024 | kick |
| `BAN_MEMBERS` | 2048 | ban, unban, list bans |
| `MODERATE_MEMBERS` | 4096 | time members out |
| `VIEW_AUDIT_LOG` | 8192 | read the audit log |
| `ADMINISTRATOR` | 16384 | every permission, ignoring overwrites |

`@everyone` starts with `VIEW_CHANNEL | SEND_MESSAGES | READ_HISTORY |
ADD_REACTIONS | CREATE_INVITE` (527).

Computation for a member in a channel:
1. The guild owner has every permission.
2. `base` = `@everyone` | each of the member's roles. `ADMINISTRATOR` →
   every permission (overwrites ignored).
3. Apply the channel's `@everyone` overwrite: `base = (base & ~deny) | allow`.
4. Apply the union of the member's role overwrites the same way (all
   denies, then all allows).
5. Without `VIEW_CHANNEL`, the member has no channel permissions.
6. A timed-out member keeps only `VIEW_CHANNEL` and `READ_HISTORY`.
7. A ghost membership (§7) has `VIEW_CHANNEL | READ_HISTORY` in every
   channel and nothing else.

Overwrites may only use the first seven flags (`VIEW_CHANNEL` …
`MANAGE_CHANNELS`) and can't both allow and deny the same flag. A private
channel is one that denies `VIEW_CHANNEL` to `@everyone` and allows it to
some roles; a read-only channel denies `SEND_MESSAGES`.

In DMs every recipient has `VIEW_CHANNEL | SEND_MESSAGES | READ_HISTORY |
ADD_REACTIONS`.

A member's **rank** is the highest `position` among their roles (0 with
none); the owner outranks everyone.

---

## 6. Guild Discovery & Joining — decision table

| Path | Requirement |
|---|---|
| Invite code | Always available regardless of listing settings |
| Open list | Requires **both** `server.guild_list_visible: true` **and** the guild's `listed: true` |
| Server-owner override | Server owner only, via `guild.owner_override_join`; results in a `ghost` membership |

Banned users get `banned` from the invite and open-list paths.

---

## 7. Server-owner override behavior

- The server owner may call `guild.owner_override_join` for **any** guild
  at any time, bypassing invite codes, listing and bans.
- The resulting membership has `ghost: true`. It is read-only: it has
  `VIEW_CHANNEL | READ_HISTORY` in every channel (overwrites don't apply)
  and nothing else, so every write returns `forbidden`.
- Ghost memberships are excluded from `guild.members`, `presence.list`,
  `presence.update`, `guild.member_joined` / `guild.member_left`, and can't
  be targeted by moderation.
- Ghosts still receive the guild's events (messages, channel and role
  changes) like any viewer.
- A ghost membership may be dropped with `guild.leave`; no event is sent.
  Joining normally (invite or public list) upgrades it to a regular,
  visible membership.

---

## 8. Account creation policy

Server-wide, owner-toggled via `server.config.update`:

- **off** — `auth.register` always fails with `registration_closed`.
- **request** — `auth.register` fails with `registration_closed`; clients
  use `auth.request_account`, which creates a `pending` account and sends
  `admin.account_requested` to the server owner. The owner approves or
  rejects with `admin.users.set_status` (or the CLI). Until approved,
  `auth.login` fails with `registration_pending_approval`; a rejected
  request fails with `invalid_credentials`.
- **on** — `auth.register` works normally.

`auth.request_account` is only accepted in `request` mode; in `off` mode it
fails with `registration_closed`, in `on` mode with `bad_request`.
A disabled account fails `auth.login` with `account_disabled`.

## 8a. First-run setup

A server with no server-owner account is in setup mode:

- `server.info.result` has `setup_required: true`.
- The server prints a one-time **setup code** on its console at startup
  (a new code on every start until setup is done). Case, spaces and dashes
  don't matter when entering it.
- `auth.register`, `auth.login` and `auth.request_account` fail with
  `setup_required`.
- `setup.claim` with the right code creates the server-owner account with
  the chosen username and password, applies any given settings, and logs
  in (`auth.ok`). Wrong code → `invalid_setup_code`; after setup →
  `setup_already_done`. Attempts are rate-limited per IP.

---

## 9. Errors

Any `*.error` response uses:
```json
{ "code": "snake_case_machine_code", "message": "human-readable string" }
```
Known codes: `invalid_credentials`, `session_expired`,
`registration_closed`, `registration_pending_approval`, `invite_invalid`,
`not_found`, `forbidden` (missing permission, rank too low, ghost, or
owner-only action), `bad_request` (malformed frame or payload),
`unknown_type`, `not_authenticated`, `username_taken`, `invalid_username`,
`invalid_password`, `content_too_long`, `rate_limited`,
`guild_creation_disabled`, `already_member`, `internal_error` (unexpected
server-side failure; safe to retry), `setup_required`,
`invalid_setup_code`, `setup_already_done`, `account_disabled`, `banned`,
`timed_out`, `avatar_invalid`, `too_many_reactions`, `dm_limit`,
`invalid_current_password`.
This list will grow — append here rather than inventing undocumented codes.

---

## 10. Explicitly deferred

Documented so the schema leaves room, without being built yet:

- Friend requests, blocking, and DM message requests
- File/image attachments and link embeds
- Message search
- Channel categories and topics
- Guild icons; invites that expire or have use limits; invite management
- Per-guild nicknames; per-member channel overwrites
- Voice/video
- Read receipts — **permanently out of scope** (read state in §4 is
  private to each user)
- Choice of TLS strategy (self-signed vs. Cloudflare Tunnel) at setup time
