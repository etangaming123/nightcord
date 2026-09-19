# Nightcord Protocol

Version: `0.5`

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
| 0.4 | Server staff, attachments, invites, categories and search | Server admins and moderators with global mutes, account deletion and IP/device bans; Terms of Service and Privacy Policy documents; file attachments over HTTP; invites with use limits, expiry and vanity links; join/leave messages; categories, topics and slowmode; pins and search; guild icons; nicknames; hoisted roles; a voice-channel placeholder. |
| 0.5 | Custom emoji and stickers, image uploads and customisation | Custom emoji and stickers (per guild, usable everywhere); image uploads over HTTP (`/media`) with animated images; profile banners and colours, guild banners, gradient role colours and role icons; server-wide customisation settings with an allow-list (§8d). |

---

## 1. Terminology

- **Server** — a single running `nightcord_server.py` process, reachable at
  an IP/hostname:port. Equivalent to "an instance," not a Discord server.
- **Guild** — a Discord-server-equivalent space living inside a Server. Has
  its own channels, roles, members, and owner. A Server can host many Guilds.
- **Server owner** — the account created during first-run setup (§8a). It
  manages server-wide settings and accounts, and can ghost-join any guild.
- **Server staff** — server admins and moderators appointed by the owner
  (§8c). Not to be confused with guild roles.
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
- Maximum frame size is 64 KB. Files go over HTTP (below).
- Only `server.info`, `legal.get`, `setup.claim` and `auth.*` may be sent
  before authentication; anything else gets `X.error` / `not_authenticated`.
- If a connection's session is revoked (password change, "log out other
  sessions", account disabled or deleted), the server closes it with code
  `4001`.
- A connection from a banned IP address gets one `error` frame with code
  `ip_banned` and is closed with code `4003`. Connections are also closed
  with `4003` when an IP or device ban is added that matches them (§8c).
- Some error payloads carry extra fields next to `code` and `message`
  (e.g. `retry_after` for `slowmode`).

### HTTP

Besides `/ws`, the server answers:

- `GET /` — a small HTML page. Opening it once lets a browser trust a
  self-signed certificate.
- `GET /avatars/{avatar_id}` — avatar images and guild icons (§4 User,
  Guild). Immutable: each upload gets a new id.
- `POST /upload?channel_id=…&filename=…[&width=…&height=…]` — upload one
  attachment. The request body is the raw file bytes (not multipart) and
  the request needs `Authorization: Bearer <session_token>`. Browsers get
  CORS headers for origins in `allowed_origins`. Requires `VIEW_CHANNEL`,
  `SEND_MESSAGES` and `ATTACH_FILES` in the channel and no server mute. The
  body may be at most `max_upload_bytes` (§4 Server config). The server
  decides the content type from the file's bytes, never from the client.
  `width`/`height` are hints the client measured for images and video.
  Success: `200 { attachment: Attachment }`. Failure: an HTTP error status
  with `{ error: { code, message } }` — `not_authenticated` (401),
  `forbidden` / `muted` / `ip_banned` (403), `not_found` (404),
  `file_too_large` (413), `rate_limited` (429, more than 50 unsent
  uploads). An upload not used by `message.send` within an hour is deleted.
- `GET /files/{attachment_id}/{filename}?exp=…&sig=…` — download. The URL
  comes from the `Attachment` object; it is signed by the server and stops
  working at `exp` (a Unix time about 7 days out; URLs stay the same for a
  whole UTC day so browsers can cache them). Supports `Range`. Images
  (png/jpeg/gif/webp), video (mp4/webm) and audio are served inline with
  their type; text files as `text/plain; charset=utf-8`; everything else
  (including SVG and HTML) as an `application/octet-stream` download.
- `POST /media?kind=…` — upload one image for an emoji, sticker, avatar,
  banner, guild icon, guild banner or role icon. Raw body, `Authorization:
  Bearer <session_token>` and CORS as for `/upload`. PNG (including APNG),
  JPEG, GIF and WebP only, checked from the bytes; size and dimension caps
  depend on `kind` (§4 Limits). Success: `200 { media: Media }`. Failure:
  `not_authenticated` (401), `forbidden` / `ip_banned` (403),
  `file_too_large` (413), `media_invalid` (400/415: wrong type, unreadable
  or too many pixels), `rate_limited` (429, more than 20 unused uploads).
  The image is used by passing its `media_id` to a WebSocket request
  (`emoji.create`, `user.avatar.set`, …) — once; unused uploads are deleted
  after an hour. Uploading needs no customisation perks; using an image
  may (§8d).
- `GET /media/{media_id}` — a stored image. Public and immutable.

---

## 3. Connection & Auth Flow

1. Client opens the WebSocket and sends `server.info`. If
   `setup_required` is true, it shows the setup wizard (§8a). If
   `legal_version` is set, it shows the documents from `legal.get` before
   account creation (§8b).
2. Client sends `auth.login` or `auth.register` (or `auth.resume` with a
   stored session token).
3. Server responds `auth.ok` (with session token + the user's own profile)
   or `auth.error`.
4. Client loads `guild.list`, `dm.list`, `read_state.list` and
   `notify.prefs.get`. If `auth.ok` says `legal_update_required`, it asks
   the user to accept the new documents (`legal.accept`).
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
- Every auth request may carry `device_id`: a random 16–64 character id
  (`[A-Za-z0-9_-]`) the client generates once per saved server and keeps
  in local storage. The server records it with the session and the client
  IP for device bans (§8c).

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
  "is_server_owner": false,
  "server_role": "owner | admin | moderator | none",
  "deleted": false,
  "perks": false,
  "banner_id": "string | null",
  "profile_colors": ["#rrggbb", "#rrggbb"]
}
```
`perks` is the customisation allow-list flag (§8d). `banner_id` is the
profile banner image and `profile_colors` (or null) the two colours of a
gradient profile card.
The user's own view (`auth.ok`'s `user`, `user.updated` sent to
themselves) adds `bio`, `created_at`, `presence`
(`online | idle | dnd | invisible`, their chosen status), `muted_until`
(ISO8601, `"permanent"` or null; §8c) and `legal_version` (the documents
they accepted, §8b). `user.profile` returns `PublicUser` plus `bio` and
`created_at`.

A `deleted` user's profile fields are cleared and their `username` is a
placeholder; clients show "Deleted User". Their messages stay.

Clients show a guild member's `nickname` (§4 Member) inside that guild,
else `display_name` when set, else `username`. Without an avatar, clients
draw initials on `avatar_color` (or a color derived from the username).

**Image references.** `avatar_id`, a guild's `icon_id` and `banner_id`, a
user's `banner_id` and a role's `icon_id` name an image:
- `123….png|jpg|webp` (with an extension) — a small v0.4-style upload at
  `GET /avatars/{id}`;
- `123…` (digits) — a `/media` upload at `GET /media/{id}`;
- `a_123…` — the same for an **animated** image: `GET /media/123…`.
Clients show an animated image still (first frame) where the matching
feature is off (§8d) and animate it otherwise.

Password is never sent to the client; the server stores only a bcrypt hash.

### Server config
```json
{
  "server_name": "string",
  "guild_creation": "off | on",
  "account_creation": "off | request | on",
  "guild_list_visible": true,
  "max_upload_bytes": 26214400,
  "voice_enabled": false,
  "customization_mode": "off | allowlist | on",
  "customization_features": {
    "profile_banner": true, "profile_colors": true, "animated_media": true,
    "guild_banner": true, "gradient_roles": true, "role_icons": true,
    "client_themes": true
  }
}
```
Defaults: `guild_creation: "on"`, `account_creation: "on"`,
`guild_list_visible: true`, `max_upload_bytes` 25 MB (1 MB – 1 GB),
`voice_enabled: false`, `customization_mode: "on"` with every feature
on, `server_name` from the server's config file
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
  "created_at": "ISO8601",
  "icon_id": "string | null",
  "system_channel_id": "string | null",
  "system_flags": 0,
  "vanity_code": "string | null",
  "banner_id": "string | null"
}
```
`icon_id` and `banner_id` are image references (§4 User). `system_channel_id` and
`system_flags` control join/leave messages (§5 System messages); new
guilds preselect `#general` with the flags off. `vanity_code` is the
guild's permanent public invite code, if any.
Guild objects sent to a member (`guild.list`, `guild.create` and the join
results) also carry `ghost: bool`, `my_permissions` (guild-wide, §5a),
`emojis: [Emoji]` and `stickers: [Sticker]`. `guild.updated` events don't
repeat the emoji and sticker lists; those change with their own events.
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
  "is_everyone": false,
  "hoist": false,
  "colors": ["#rrggbb", "#rrggbb"],
  "icon_id": "string | null",
  "icon_emoji": "string | null"
}
```
`colors` (2–3 colours, or null) makes a gradient name; `color` is then its
first colour. A role has at most one icon: an image (`icon_id`) or a
unicode emoji (`icon_emoji`); clients show it after member names.
Every guild has an `@everyone` role with `role_id == guild_id`, position 0,
which applies to all members. Higher `position` = higher rank. Clients
group online members under their highest `hoist` role ("display role
members separately"), like Discord.

### Member
```json
{
  "user": "PublicUser",
  "role_ids": ["string"],
  "joined_at": "ISO8601",
  "timed_out_until": "ISO8601 | null",
  "is_owner": false,
  "nickname": "string | null",
  "invited_by": "user_id | null",
  "invite_code": "string | null"
}
```
`invited_by` / `invite_code` record how the member joined (null for the
public list; `invited_by` is null for the vanity link).
`role_ids` never includes `@everyone`. Ghost memberships (§7) are never
returned as Members.

### Channel
Guild channel:
```json
{
  "channel_id": "string",
  "guild_id": "string",
  "kind": "text | voice | category",
  "name": "string",
  "position": 0,
  "parent_id": "string | null",
  "topic": "string | null",
  "slowmode_seconds": 0,
  "perms_synced": false,
  "overwrites": [{ "role_id": "string", "allow": 0, "deny": 0 }],
  "last_message_id": "string | null",
  "my_permissions": 0
}
```
Channels are ordered by `position` across the whole guild; `parent_id`
puts a text or voice channel in a category (categories can't nest). A
channel with `perms_synced: true` uses its category's overwrites instead
of its own (§5a). Only text channels have messages, a `topic` and
`slowmode_seconds`. Voice channels only exist while `voice_enabled` is
true (§5 Voice).
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
  "reactions": [{ "emoji": "string", "user_ids": ["string"] }],
  "type": "default | member_join | member_leave | pin",
  "pinned": false,
  "attachments": ["Attachment"],
  "stickers": [{ "sticker_id": "string", "name": "string", "animated": false, "guild_id": "string" }]
}
```
A sticker deleted since is `{ sticker_id, deleted: true }`.
`reply_to` is null when there's no reply or the original was deleted
(`reply_to_id` is kept either way); its `content` is cut to 120
characters. Message events also carry `guild_id` (null in DMs).

Non-`default` messages are **system messages**, written by the server
with empty `content`; `author` is the user they're about (who joined,
left or pinned). A `pin` message's `reply_to_id` is the pinned message.
System messages can't be edited, pinned or searched; they can be reacted
to and deleted with `MANAGE_MESSAGES`.

### Attachment
```json
{
  "attachment_id": "string",
  "filename": "string",
  "content_type": "string",
  "size": 0,
  "width": "number | null",
  "height": "number | null",
  "url": "/files/{attachment_id}/{filename}?exp=…&sig=…"
}
```
`url` is relative to the server's https origin (§2 HTTP). Clients show
`image/*` inline, play `video/*` and `audio/*` inline, open `text/plain`
in a viewer, and offer everything else as a download.

### Media
```json
{ "media_id": "string", "kind": "emoji | sticker | avatar | banner | guild_icon | guild_banner | role_icon",
  "content_type": "image/png | image/jpeg | image/gif | image/webp", "size": 0, "width": 0, "height": 0, "animated": false }
```

### Emoji
```json
{ "emoji_id": "string", "guild_id": "string", "name": "string", "animated": false, "creator_id": "string", "created_at": "ISO8601" }
```
A custom emoji. Its image is `GET /media/{emoji_id}`. In message content
it is written `<:name:emoji_id>` (`<a:name:emoji_id>` when animated);
clients render the image, or `:name:` if it fails to load (deleted). A
message made of only emoji (at most 27, no other text) is shown large.

### Sticker
```json
{ "sticker_id": "string", "guild_id": "string", "name": "string", "description": "string | null",
  "tag_emoji": "string | null", "animated": false, "creator_id": "string", "created_at": "ISO8601" }
```
Its image is `GET /media/{sticker_id}`; clients show it at up to 160 px.

### Invite
```json
{
  "code": "string",
  "guild_id": "string",
  "inviter": "PublicUser",
  "uses": 0,
  "max_uses": 0,
  "expires_at": "ISO8601 | null",
  "created_at": "ISO8601"
}
```
`max_uses: 0` means unlimited; `expires_at: null` never expires. Codes
are 8 characters and case-insensitive.

Content is plain text with a small markdown subset rendered by clients:
`**bold**`, `*italic*`, `__underline__`, `~~strike~~`, `` `code` ``,
```` ```code blocks``` ````, `> quotes`, `||spoilers||` and links. Mentions
are written `<@user_id>` and `@everyone`, custom emoji `<:name:id>` (§4
Emoji). The server never renders HTML.

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
| reaction `emoji` | one unicode emoji (at most 32 UTF-16 units) or a custom emoji `<:name:id>`; at most 20 distinct emoji per message |
| group DM | at most 10 people; name up to 64 chars |
| history `limit` | default 50, max 100 |
| timeout | 1 s – 28 days |
| server mute | 1 s – 365 days, or permanent |
| `nickname` | up to 32 chars |
| channel `topic` | up to 1024 chars |
| voice channel / category `name` | 1–32 chars, free text |
| channels per guild | at most 200 |
| attachments | at most 10 per message; each up to `max_upload_bytes`; filename up to 128 chars |
| `slowmode_seconds` | one of 0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600 |
| invite `max_uses` | one of 0 (unlimited), 1, 5, 10, 25, 50, 100 |
| invite `max_age_seconds` | one of 0 (never), 1800, 3600, 21600, 43200, 86400, 604800 |
| `vanity_code` | 3–32 chars, `[a-z0-9-]` (stored lowercase) |
| pins | at most 50 per channel |
| legal documents | each up to 30000 chars of Markdown |
| custom emoji | at most 200 per guild; `name` 2–32 chars `[A-Za-z0-9_]`, unique per guild (case-insensitive); image ≤ 256 KB and ≤ 256×256 |
| stickers | at most 60 per guild; `name` 2–30 chars; `description` up to 100; one per message; image ≤ 512 KB and ≤ 320×320 |
| `/media` images | avatar and guild icon ≤ 1 MB; banner and guild banner ≤ 2 MB; role icon ≤ 256 KB |
| `profile_colors` | exactly 2 colours |
| role `colors` | 2–3 colours |

---

## 5. Message Types

### Setup
| type | direction | payload |
|---|---|---|
| `setup.claim` | C→S | `{ setup_code, username, password, server_name?, account_creation?, guild_creation?, guild_list_visible?, device_id? }` → `auth.ok`. Pre-auth; only while `setup_required` (§8a) |

### Legal documents
| type | direction | payload |
|---|---|---|
| `legal.get` | C→S | `{}` — sendable pre-auth |
| `legal.get.result` | S→C | `{ terms: markdown \| null, privacy: markdown \| null, legal_version }` |
| `legal.accept` | C→S | `{ legal_version }` — must be the current version |
| `legal.accept.result` | S→C | `{ user }` (self view) |

### Auth
| type | direction | payload |
|---|---|---|
| `auth.register` | C→S | `{ username, password, accept_legal_version?, device_id? }` — `accept_legal_version` must equal the current `legal_version` when there is one (§8b) |
| `auth.login` | C→S | `{ username, password, device_id? }` |
| `auth.resume` | C→S | `{ session_token, device_id? }` |
| `auth.request_account` | C→S | `{ username, password, note?, accept_legal_version?, device_id? }` — used when `account_creation` is `request` |
| `auth.request_account.result` | S→C | `{ status: "pending" }` |
| `auth.ok` | S→C | `{ session_token, user, legal_update_required }` — `user` is the self view (§4 User) |
| `auth.error` | S→C | `{ code, message }` |
| `auth.logout` | C→S | `{}` — revokes the current session token |
| `auth.logout.result` | S→C | `{}` |

### Server info / config
| type | direction | payload |
|---|---|---|
| `server.info` | C→S | `{}` — sendable pre-auth |
| `server.info.result` | S→C | `ServerConfig` plus `protocol_version`, `setup_required`, `legal_version`, `has_terms`, `has_privacy` |
| `server.config.update` | C→S | partial `ServerConfig` — **server owner only**. Turning `voice_enabled` off disconnects everyone from voice |
| `server.config.update.result` | S→C | `{ config: ServerConfig }` |
| `server.config.updated` | S→C | `ServerConfig` + `legal_version`, `has_terms`, `has_privacy` — to every logged-in connection after a config or legal change |

### Admin (server staff, §8c)
The column "who" is the lowest server role allowed: **mod** (moderator),
**admin** or **owner**. Every action that targets a user needs the
target's server role to be strictly below the actor's.

| type | direction | payload |
|---|---|---|
| `admin.users.list` | C→S | `{ status?: "pending"\|"active"\|"rejected"\|"disabled", query? }` — mod. Deleted accounts are left out |
| `admin.users.list.result` | S→C | `{ users: [AdminUser] }` — `PublicUser` plus `status`, `created_at`, `note`, `muted_until`, `last_ip`, `last_seen`, `device_count` |
| `admin.users.set_status` | C→S | `{ user_id, status: "active"\|"rejected"\|"disabled" }` — mod. Approve (pending→active), reject (pending→rejected), disable (active→disabled; closes their connections), enable (disabled→active) |
| `admin.users.set_status.result` | S→C | `{ user: AdminUser }` |
| `admin.users.reset_password` | C→S | `{ user_id }` — admin. Sets a random password, revokes sessions |
| `admin.users.reset_password.result` | S→C | `{ password }` — shown once |
| `admin.users.mute` | C→S | `{ user_id, duration_seconds?, permanent?, reason? }` — mod. Server-wide mute; neither field lifts it |
| `admin.users.mute.result` | S→C | `{ user: AdminUser }` |
| `admin.users.delete` | C→S | `{ user_id }` — admin. Deletes the account (see `user.delete`) |
| `admin.users.delete.result` | S→C | `{}` |
| `admin.staff.set` | C→S | `{ user_id, role: "admin"\|"moderator"\|"none" }` — admin; only the owner can make admins |
| `admin.staff.set.result` | S→C | `{ user: AdminUser }` |
| `admin.ip_bans.list` | C→S | `{}` — mod |
| `admin.ip_bans.list.result` | S→C | `{ bans: [{ cidr, reason, banned_by: PublicUser, created_at }] }` |
| `admin.ip_bans.add` | C→S | `{ cidr, reason? }` — mod. An address (`203.0.113.7`) or range (`203.0.113.0/24`). Can't include your own address or a connected staff member at or above you |
| `admin.ip_bans.add.result` | S→C | `{ bans }` |
| `admin.ip_bans.remove` | C→S | `{ cidr }` — mod |
| `admin.ip_bans.remove.result` | S→C | `{ bans }` |
| `admin.device_bans.list` | C→S | `{}` — mod |
| `admin.device_bans.list.result` | S→C | `{ bans: [{ device_id, user: PublicUser \| null, reason, banned_by, created_at }] }` |
| `admin.device_bans.add` | C→S | `{ user_id, reason? }` — mod. Bans every device the user has a session on |
| `admin.device_bans.add.result` | S→C | `{ bans }` |
| `admin.device_bans.remove` | C→S | `{ device_id }` — mod |
| `admin.device_bans.remove.result` | S→C | `{ bans }` |
| `admin.audit_log` | C→S | `{ before?, limit? }` — mod. Server-wide actions, newest first |
| `admin.audit_log.result` | S→C | `{ entries: [{ entry_id, actor: PublicUser, action, target_id, details, created_at }], has_more }` |
| `admin.stats` | C→S | `{}` — admin |
| `admin.stats.result` | S→C | `{ users, guilds, messages, attachments: { count, bytes }, media: { count, bytes } }` |
| `admin.legal.set` | C→S | `{ terms?: markdown \| null, privacy?: markdown \| null }` — owner. Empty or null removes a document |
| `admin.legal.set.result` | S→C | `{ legal_version, has_terms, has_privacy }` |
| `admin.guilds.list` | C→S | `{}` — admin |
| `admin.guilds.list.result` | S→C | `{ guilds: [Guild + { member_count, owner: PublicUser }] }` |
| `admin.guilds.delete` | C→S | `{ guild_id }` — admin |
| `admin.guilds.delete.result` | S→C | `{}` |
| `admin.users.set_perks` | C→S | `{ user_id, perks: bool }` — admin. The customisation allow-list (§8d) |
| `admin.users.set_perks.result` | S→C | `{ user: AdminUser }` |
| `admin.account_requested` | S→C | `{ user: AdminUser }` — event to every moderator and above when someone requests an account |

Server audit `action` values: `user.status`, `user.reset_password`,
`user.mute`, `user.delete`, `user.delete_self`, `staff.set`,
`ip_ban.add`, `ip_ban.remove`, `device_ban.add`, `device_ban.remove`,
`guild.delete`, `config.update`, `legal.update`, `user.perks`.

### Users
| type | direction | payload |
|---|---|---|
| `user.profile` | C→S | `{ user_id }` |
| `user.profile.result` | S→C | `{ user: PublicUser + { bio, created_at }, status }` |
| `user.update` | C→S | `{ display_name?, bio?, avatar_color?, custom_status?, banner_media_id?, profile_colors? }` — `null` or `""` clears a field. `banner_media_id` is a `banner` upload (needs `profile_banner`, and `animated_media` if animated); `profile_colors` needs `profile_colors` (§8d) |
| `user.update.result` | S→C | `{ user }` (self view) |
| `user.avatar.set` | C→S | `{ data_b64 }` — base64 image, or `null` to remove; or `{ media_id }` — an `avatar` upload (animated needs `animated_media`, §8d) |
| `user.avatar.set.result` | S→C | `{ user }` (self view) |
| `user.password.change` | C→S | `{ current_password, new_password }` — revokes every other session |
| `user.password.change.result` | S→C | `{}` |
| `user.sessions.list` | C→S | `{}` |
| `user.sessions.list.result` | S→C | `{ sessions: [{ session_id, created_at, last_seen, user_agent, current }] }` |
| `user.sessions.revoke` | C→S | `{ session_id }` — or `"others"` for every session but this one |
| `user.sessions.revoke.result` | S→C | `{}` |
| `user.search` | C→S | `{ query }` — active users whose username or display name starts with `query` (max 20) |
| `user.search.result` | S→C | `{ users: [PublicUser] }` |
| `user.delete` | C→S | `{ password }` — delete your own account (not the server owner). Guilds you own pass to their highest-ranked member (or are deleted if empty); you leave every guild and group DM; your messages stay, shown as "Deleted User"; your avatar and uploads are deleted; your username is freed |
| `user.delete.result` | S→C | `{}` — the connection stays open but logged out |
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
| `guild.join_by_code` | C→S | `{ invite_code }` — an invite code or a vanity code; `invite_expired` when expired or used up |
| `guild.join_by_code.result` | S→C | `{ guild: Guild }` |
| `guild.join_by_id` | C→S | `{ guild_id }` — only for guilds in the public list |
| `guild.join_by_id.result` | S→C | `{ guild: Guild }` |
| `guild.owner_override_join` | C→S | `{ guild_id }` — **server admins and the owner**; joins silently as a ghost (§7) |
| `guild.owner_override_join.result` | S→C | `{ guild: Guild }` |
| `guild.leave` | C→S | `{ guild_id }` — not allowed for the guild owner |
| `guild.leave.result` | S→C | `{}` |
| `guild.delete` | C→S | `{ guild_id }` — **guild owner only** |
| `guild.delete.result` | S→C | `{}` |
| `guild.members` | C→S | `{ guild_id }` |
| `guild.members.result` | S→C | `{ members: [Member] }` |
| `guild.config.update` | C→S | `{ guild_id, name?, listed?, system_channel_id?, system_flags?, vanity_code?, banner_media_id? }` — needs `MANAGE_GUILD`. `system_channel_id` must be a text channel (or null); `vanity_code` null removes it; `banner_media_id` is a `guild_banner` upload (the guild owner needs `guild_banner`, §8d), null removes it |
| `guild.config.update.result` | S→C | `{ guild: Guild }` |
| `guild.icon.set` | C→S | `{ guild_id, data_b64 }` or `{ guild_id, media_id }` — needs `MANAGE_GUILD`; same rules as `user.avatar.set` (a `guild_icon` upload; animated needs the guild owner to have `animated_media`); `data_b64: null` removes |
| `guild.icon.set.result` | S→C | `{ guild: Guild }` |
| `guild.invite.create` | C→S | `{ guild_id, max_uses?, max_age_seconds? }` — needs `CREATE_INVITE` |
| `guild.invite.create.result` | S→C | `{ invite_code, invite: Invite }` |
| `guild.invite.list` | C→S | `{ guild_id }` — active invites (not revoked, expired or used up): all of them with `MANAGE_GUILD`, else your own |
| `guild.invite.list.result` | S→C | `{ invites: [Invite] }` |
| `guild.invite.revoke` | C→S | `{ invite_code }` — your own invites, or any with `MANAGE_GUILD` |
| `guild.invite.revoke.result` | S→C | `{}` |
| `guild.invite.resolve` | C→S | `{ invite_code }` — preview before joining |
| `guild.invite.resolve.result` | S→C | `{ guild: { guild_id, name, icon_id, banner_id }, member_count, online_count, inviter: PublicUser \| null, expires_at, is_member }` |
| `guild.bans.list` | C→S | `{ guild_id }` — needs `BAN_MEMBERS` |
| `guild.bans.list.result` | S→C | `{ bans: [{ user: PublicUser, reason, created_at }] }` |
| `guild.audit_log` | C→S | `{ guild_id, before?, limit? }` — needs `VIEW_AUDIT_LOG`; newest first, `limit` ≤ 100 |
| `guild.audit_log.result` | S→C | `{ entries: [{ entry_id, actor: PublicUser, action, target_id, details, created_at }], has_more }` |
| `guild.updated` | S→C | `Guild` — event to members after `guild.config.update`, `guild.icon.set` or an ownership change |
| `guild.removed` | S→C | `{ guild_id, reason: "kicked"\|"banned"\|"deleted" }` — event to a user who lost access |
| `guild.member_joined` | S→C | `{ guild_id, member: Member }` — never sent for ghost joins |
| `guild.member_left` | S→C | `{ guild_id, user_id, reason: "left"\|"kicked"\|"banned" }` — never sent for ghosts |
| `guild.member_updated` | S→C | `{ guild_id, member: Member }` — roles or timeout changed |
| `guild.permissions_changed` | S→C | `{ guild_id }` — roles or overwrites changed; refetch `guild.list` / `channel.list` for fresh `my_permissions` |
| `guild.emojis_updated` | S→C | `{ guild_id, emojis: [Emoji] }` — to guild members after any emoji change |
| `guild.stickers_updated` | S→C | `{ guild_id, stickers: [Sticker] }` — to guild members after any sticker change |

Audit log `action` values: `guild.update`, `channel.create`,
`channel.update`, `channel.delete`, `role.create`, `role.update`,
`role.reorder`, `role.delete`, `member.roles`, `member.kick`, `member.ban`,
`member.unban`, `member.timeout`, `member.nickname` (someone else's),
`message.delete` (someone else's message), `message.pin`, `invite.revoke`,
`channel.reorder`, `guild.transfer` (ownership passed on after account
deletion), `emoji.create`, `emoji.update`, `emoji.delete`,
`sticker.create`, `sticker.update`, `sticker.delete`.

### Emoji and stickers
| type | direction | payload |
|---|---|---|
| `emoji.create` | C→S | `{ guild_id, name, media_id }` — needs `MANAGE_EXPRESSIONS`; `media_id` is an `emoji` upload and becomes the `emoji_id` |
| `emoji.create.result` | S→C | `{ emoji: Emoji }` |
| `emoji.update` | C→S | `{ emoji_id, name }` — needs `MANAGE_EXPRESSIONS` |
| `emoji.update.result` | S→C | `{ emoji: Emoji }` |
| `emoji.delete` | C→S | `{ emoji_id }` — needs `MANAGE_EXPRESSIONS`; deletes the image |
| `emoji.delete.result` | S→C | `{}` |
| `emoji.info` | C→S | `{ emoji_id }` — any user; where an emoji seen in a message comes from |
| `emoji.info.result` | S→C | `{ emoji: Emoji, guild: { guild_id, name, icon_id } \| null, is_member }` — `guild` is null unless you're in it or it's in the public list |
| `sticker.create` | C→S | `{ guild_id, name, description?, tag_emoji?, media_id }` — needs `MANAGE_EXPRESSIONS`; `media_id` is a `sticker` upload and becomes the `sticker_id`; `tag_emoji` is a unicode emoji |
| `sticker.create.result` | S→C | `{ sticker: Sticker }` |
| `sticker.update` | C→S | `{ sticker_id, name?, description?, tag_emoji? }` — needs `MANAGE_EXPRESSIONS` |
| `sticker.update.result` | S→C | `{ sticker: Sticker }` |
| `sticker.delete` | C→S | `{ sticker_id }` — needs `MANAGE_EXPRESSIONS`; messages that used it show it as deleted |
| `sticker.delete.result` | S→C | `{}` |

Unlike Discord, anyone may use a guild's emoji and stickers in any guild
or DM — as long as they are a (non-ghost) member of the guild they come
from. Reacting with a custom emoji or sending a sticker from a guild you
aren't in fails with `forbidden`; adding yourself to an existing reaction
always works.

### System messages
With `system_channel_id` set, the server posts `member_join` when someone
joins (flag `1`) and `member_leave` when someone leaves, is kicked or is
banned (flag `2`), as ordinary `message.new` events in that channel.
Ghost joins never post. Pinning posts a `pin` message in the pinned
message's channel regardless of the flags.

### Roles
| type | direction | payload |
|---|---|---|
| `role.list` | C→S | `{ guild_id }` |
| `role.list.result` | S→C | `{ roles: [Role] }` — highest first, `@everyone` last |
| `role.create` | C→S | `{ guild_id, name?, color?, permissions?, hoist?, colors?, icon_media_id?, icon_emoji? }` — needs `MANAGE_ROLES`; placed just below the creator's highest role |
| `role.create.result` | S→C | `{ role: Role }` |
| `role.update` | C→S | `{ role_id, name?, color?, permissions?, hoist?, colors?, icon_media_id?, icon_emoji? }` — needs `MANAGE_ROLES` and the role below your highest (any member may edit `@everyone`'s permissions with `MANAGE_ROLES`). `color` alone removes a gradient; `colors` (2–3, or null) needs the guild owner to have `gradient_roles`; `icon_media_id` (a `role_icon` upload) or `icon_emoji` need `role_icons` (§8d); setting one icon clears the other, null removes |
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
| `member.nickname.set` | C→S | `{ guild_id, user_id, nickname \| null }` — your own needs `CHANGE_NICKNAME`; others' need `MANAGE_NICKNAMES` and to rank above them. Sends `guild.member_updated` |
| `member.nickname.set.result` | S→C | `{ member: Member }` |

Moderation targets must be visible members ranked strictly below you (the
guild owner outranks everyone). Nobody can target themselves or the owner.
A banned user can't rejoin by invite or public list (`banned`).

### Channels
| type | direction | payload |
|---|---|---|
| `channel.list` | C→S | `{ guild_id }` — channels you can view |
| `channel.list.result` | S→C | `{ channels: [Channel], voice_states: [VoiceState] }` — categories are included when you can view them or a channel in them; voice channels only while voice is enabled |
| `channel.join` | C→S | `{ channel_id }` — focus this channel (guild or DM); one per connection |
| `channel.join.result` | S→C | `{}` |
| `channel.leave` | C→S | `{ channel_id }` — drop focus |
| `channel.leave.result` | S→C | `{}` |
| `channel.history` | C→S | `{ channel_id, before_message_id?, after_message_id?, around_message_id?, limit? }` — needs `READ_HISTORY`; at most one cursor. `around` centers on a message (for jumping to search results, pins and replies) |
| `channel.history.result` | S→C | `{ messages: [Message], has_more, has_more_after }` — oldest-first; `has_more` = older messages exist, `has_more_after` = newer ones do |
| `channel.create` | C→S | `{ guild_id, name, kind?, parent_id?, topic?, overwrites? }` — needs `MANAGE_CHANNELS` (and `MANAGE_ROLES` for overwrites). `kind` defaults to `text`; `voice` needs `voice_enabled` (`voice_disabled`). A channel created in a category without overwrites is synced with it |
| `channel.create.result` | S→C | `{ channel: Channel }` |
| `channel.update` | C→S | `{ channel_id, name?, position?, topic?, slowmode_seconds?, perms_synced?, overwrites? }` — needs `MANAGE_CHANNELS` in the channel; `overwrites` replaces the whole list (and unsyncs the channel), `overwrites` and `perms_synced` need `MANAGE_ROLES` |
| `channel.update.result` | S→C | `{ channel: Channel }` |
| `channel.reorder` | C→S | `{ guild_id, channels: [{ channel_id, parent_id, position }] }` — needs `MANAGE_CHANNELS`; sends `channel.updated` for each moved channel. Moving a channel out of its category unsyncs it |
| `channel.reorder.result` | S→C | `{ channels: [Channel] }` |
| `channel.pins` | C→S | `{ channel_id }` — needs `READ_HISTORY` |
| `channel.pins.result` | S→C | `{ messages: [Message] }` — most recently pinned first |
| `channel.delete` | C→S | `{ channel_id }` — needs `MANAGE_CHANNELS`; deletes its messages too. Deleting a category moves its channels to the top level (synced ones keep the category's overwrites) |
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
| `message.send` | C→S | `{ channel_id, content, reply_to_id?, mention_reply?, attachment_ids?, sticker_ids? }` — needs `SEND_MESSAGES` (and `ATTACH_FILES` with attachments); text channels and DMs only. `sticker_ids`: at most one sticker from a guild you're a member of; `content` may then be empty. Rate-limited to 5 per 5 s per connection (shared with edits). Replying mentions the original author unless `mention_reply: false`. `content` may be empty when there are attachments (up to 10, from your own `/upload`s to this channel, each usable once). Slowmode: `slowmode` with `retry_after` seconds; `MANAGE_MESSAGES` or `MANAGE_CHANNELS` bypass it |
| `message.send.result` | S→C | `{ message_id, message: Message }` |
| `message.edit` | C→S | `{ message_id, content }` — your own messages only |
| `message.edit.result` | S→C | `{ message: Message }` |
| `message.delete` | C→S | `{ message_id }` — your own, or anyone's with `MANAGE_MESSAGES`; deletes its attachments |
| `message.delete.result` | S→C | `{}` |
| `message.pin` | C→S | `{ message_id }` — needs `MANAGE_MESSAGES` (anyone in a DM); `pin_limit` past 50. Sends `message.updated` and a `pin` system message |
| `message.pin.result` | S→C | `{}` |
| `message.unpin` | C→S | `{ message_id }` — same permission; sends `message.updated` |
| `message.unpin.result` | S→C | `{}` |
| `message.search` | C→S | `{ guild_id \| channel_id, query?, author_id?, has?: "file"\|"image"\|"video"\|"link", pinned?, before?, after?, offset? }` — at least one filter. Searches text channels where you have `READ_HISTORY` (or one channel / DM); words match as prefixes, newest first, 25 per page |
| `message.search.result` | S→C | `{ messages: [Message + guild_id], total }` |
| `message.new` | S→C | `Message` + `guild_id` — to everyone who can view the channel (including the sender) |
| `message.updated` | S→C | `Message` + `guild_id` |
| `message.deleted` | S→C | `{ channel_id, guild_id, message_id }` |

Sending a message with mentions increments `mention_count` in the
mentioned users' read state (everyone who can view the channel for
`@everyone`, which needs `MENTION_EVERYONE`; never in DMs).

### Reactions
| type | direction | payload |
|---|---|---|
| `reaction.add` | C→S | `{ message_id, emoji }` — needs `ADD_REACTIONS`. A custom emoji `<:name:id>` must exist and come from a guild you're in; the stored reaction uses its current name (or the key already on the message for that emoji id) |
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

### Voice (placeholder)
Voice channels exist so guilds can be laid out like Discord; there is no
audio yet. Joining only shows you as "in" the channel.

```json
{ "guild_id": "string", "channel_id": "string | null", "user_id": "string", "self_mute": false, "self_deaf": false }
```
That is a `VoiceState`; `channel_id: null` in an event means the user left.

| type | direction | payload |
|---|---|---|
| `voice.join` | C→S | `{ channel_id }` — a voice channel; needs `CONNECT`, voice enabled (`voice_disabled`) and no server mute. Leaves any other voice channel |
| `voice.join.result` | S→C | `{ voice_state: VoiceState }` |
| `voice.leave` | C→S | `{}` |
| `voice.leave.result` | S→C | `{}` |
| `voice.state.set` | C→S | `{ self_mute?, self_deaf? }` — cosmetic for now |
| `voice.state.set.result` | S→C | `{ voice_state }` |
| `voice.state_updated` | S→C | `VoiceState` — to online guild members |

A user is in at most one voice channel, tied to the connection that
joined; closing it leaves the channel.

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
| `ATTACH_FILES` | 32768 | upload attachments |
| `CONNECT` | 65536 | join voice channels |
| `CHANGE_NICKNAME` | 131072 | set your own nickname |
| `MANAGE_NICKNAMES` | 262144 | set other members' nicknames |
| `MANAGE_EXPRESSIONS` | 524288 | add, rename and delete the guild's custom emoji and stickers |

`@everyone` starts with `VIEW_CHANNEL | SEND_MESSAGES | READ_HISTORY |
ADD_REACTIONS | CREATE_INVITE | ATTACH_FILES | CONNECT | CHANGE_NICKNAME`
(229903). Upgrading from v0.3 adds the three new bits to every existing
`@everyone` role.

Computation for a member in a channel:
1. The guild owner has every permission.
2. `base` = `@everyone` | each of the member's roles. `ADMINISTRATOR` →
   every permission (overwrites ignored).
3. Apply the channel's `@everyone` overwrite: `base = (base & ~deny) | allow`.
   A channel with `perms_synced` in a category uses the category's
   overwrites here and in step 4.
4. Apply the union of the member's role overwrites the same way (all
   denies, then all allows).
5. Without `VIEW_CHANNEL`, the member has no channel permissions.
6. A timed-out member keeps only `VIEW_CHANNEL` and `READ_HISTORY`.
7. A ghost membership (§7) has `VIEW_CHANNEL | READ_HISTORY` in every
   channel and nothing else.

Overwrites may only use the channel flags — `VIEW_CHANNEL` …
`MANAGE_CHANNELS`, `ATTACH_FILES` and `CONNECT` — and can't both allow and
deny the same flag. A private
channel is one that denies `VIEW_CHANNEL` to `@everyone` and allows it to
some roles; a read-only channel denies `SEND_MESSAGES`.

In DMs every recipient has `VIEW_CHANNEL | SEND_MESSAGES | READ_HISTORY |
ADD_REACTIONS | ATTACH_FILES`.

A server-wide mute (§8c) is separate from guild permissions: it blocks
sending, reacting, typing, uploading and joining voice everywhere,
including DMs, with `muted`.

A member's **rank** is the highest `position` among their roles (0 with
none); the owner outranks everyone.

---

## 6. Guild Discovery & Joining — decision table

| Path | Requirement |
|---|---|
| Invite code | Always available regardless of listing settings |
| Open list | Requires **both** `server.guild_list_visible: true` **and** the guild's `listed: true` |
| Server-owner override | Server owner and server admins, via `guild.owner_override_join`; results in a `ghost` membership |

Banned users get `banned` from the invite and open-list paths.

---

## 7. Server-owner override behavior

- The server owner (and server admins, §8c) may call `guild.owner_override_join` for **any** guild
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

## 8b. Terms of Service and Privacy Policy

A server may publish two Markdown documents, stored as
`data/legal/terms.md` and `data/legal/privacy.md`. The owner edits them in
the client (`admin.legal.set`) or puts the files there by hand.

- `legal_version` is a hash of both documents, or null when there are
  none. It changes whenever either document changes.
- Clients show the documents (headings, paragraphs, lists, links, and the
  chat markdown subset) before creating an account, and send
  `accept_legal_version` with `auth.register` / `auth.request_account`;
  without it those fail with `legal_required`.
- When the documents change, `auth.ok` has `legal_update_required: true`
  for users who accepted an older version (never for the server owner).
  Clients block the app until the user accepts with `legal.accept` (or
  logs out).

Before a client connects to a server it hasn't saved yet, it warns the
user that the server's owner and staff can see their IP address, and to
only connect to servers they trust. This is a client rule; the protocol
can't help, since connecting reveals the address.

## 8c. Server staff

Server roles, lowest to highest: `none`, `moderator`, `admin`, `owner`.
There is exactly one owner (the account from §8a).

| | moderator | admin | owner |
|---|---|---|---|
| See accounts, IPs and the server audit log | ✓ | ✓ | ✓ |
| Approve / reject requests, disable / enable accounts | ✓ | ✓ | ✓ |
| Server mute, IP bans, device bans | ✓ | ✓ | ✓ |
| Delete accounts, reset passwords | | ✓ | ✓ |
| List / delete / ghost-join guilds | | ✓ | ✓ |
| Appoint moderators | | ✓ | ✓ |
| Appoint admins; server config; legal documents | | | ✓ |

Staff can only act on users whose server role is strictly below their
own, and never on themselves.

- **Server mute** — `muted_until` is a time or `"permanent"`. Muted users
  can read but not send, react, type, upload or join voice anywhere.
- **IP ban** — addresses or CIDR ranges. Banned addresses can't open a
  WebSocket, upload or download (§2). Behind a reverse proxy the server
  must be configured with `trust_proxy` so it sees the real address.
- **Device ban** — bans the `device_id`s the user's sessions reported.
  Auth requests with a banned `device_id` fail with `device_banned`. This
  is a speed bump, not an identity check: clearing browser storage makes a
  new device id. It only applies to this server.
- **Account deletion** — see `user.delete`.

## 8d. Customisation

Profile banners and colours, animated images, guild banners, gradient role
colours, role icons and client themes are **perks** the server owner
controls with two `ServerConfig` settings:

- `customization_mode` — `off` (nobody), `allowlist` (users an admin gave
  `perks` with `admin.users.set_perks`, plus all server staff), or `on`
  (everyone).
- `customization_features` — each feature on or off, for everyone
  (`server.config.update` may send just the features that change).

A user can use a feature when it is on and the mode lets them. Personal
features (`profile_banner`, `profile_colors`, `animated_media` for
avatars and banners, `client_themes`) check the user; guild features
(`guild_banner`, `gradient_roles`, `role_icons`, and `animated_media` for
a guild's icon, banner and role icons) check the **guild owner**, like a
boosted server.

Setting a perk field without the right fails with `feature_disabled`;
clearing one always works. Stored cosmetics are kept when a feature is
switched off or a user loses perks: clients stop showing them (they know
the config, and each `PublicUser`'s `perks` and `server_role`) and show
them again if it's switched back on. Themes live in the client only, so
their gating is a client rule.

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
`invalid_current_password`, `file_too_large`, `muted` (server mute,
§8c), `ip_banned`, `device_banned`, `slowmode` (the payload also has `retry_after` seconds),
`invite_expired`, `legal_required`, `voice_disabled`, `pin_limit`,
`feature_disabled` (customisation isn't allowed, §8d), `media_invalid`
(an image upload that isn't a usable image, or an unknown or used media id).
This list will grow — append here rather than inventing undocumented codes.

---

## 10. Explicitly deferred

Documented so the schema leaves room, without being built yet:

- Friend requests, blocking, and DM message requests
- Link embeds / previews
- Per-member channel overwrites
- Voice/video audio (voice channels are placeholders, §5 Voice)
- Server-wide emoji packs (emoji belong to guilds)
- Guild ownership transfer by hand
- Read receipts — **permanently out of scope** (read state in §4 is
  private to each user)
- Choice of TLS strategy (self-signed vs. Cloudflare Tunnel) at setup time
