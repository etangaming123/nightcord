# Nightcord

Self-hosted, Discord-style chat. You run a small Python **server**. Friends connect to it from a static web **client**
hosted on GitHub Pages. One server can host many **guilds**, each with its own channels, roles and members, plus
direct messages between anyone on the server.

- `docs/PROTOCOL.md` is the wire protocol and the source of truth. If the code disagrees with it, the code is wrong.
- `server/` holds the Python server: aiohttp, SQLite, and bcrypt.
- `client/` holds the client: vanilla JS modules with no build step.

## What's in it (v4)

- **Chat:** markdown (`**bold**`, `*italic*`, `` `code` ``, code blocks, quotes, `||spoilers||`), replies, emoji
  reactions, edit and delete, pins, @mentions and @everyone, typing indicators, unread and mention badges that sync
  across your devices.
- **Custom emoji and stickers:** every guild can upload its own (200 emoji, 60 stickers). Unlike Discord, anyone in
  the guild can use them in any guild or DM — no Nitro. Type `:name:`, pick from the picker, or react with them.
  Animated GIFs stay animated.
- **Customisation:** profile banners and profile colours, guild banners, gradient role names, role icons, and app
  themes (presets plus a custom gradient of up to five colours). The server owner decides who gets these: everyone,
  an allow-list of people an admin picks, or nobody — and can switch each feature on or off.
- **Files:** upload with the + button, paste, or drag and drop. Images and videos show inline, text files open in a
  viewer, anything else downloads. The server owner sets the size limit.
- **Search:** Ctrl/Cmd+F searches a guild or conversation, with `from:`, `in:`, `has:image|file|video|link` and
  `pinned:true`. Results jump straight to the message. Ctrl/Cmd+K opens a quick switcher.
- **Guild layout:** channel categories (collapsible, drag to reorder, permissions that sync like Discord's), channel
  topics, slowmode, a guild icon, per-guild nicknames, and optional join/leave messages.
- **Invites:** expiry and use limits, a list of active invites with who made them, revoking, a permanent public
  link, "invited by" on every member, and share links that open straight into an invite card.
- **Voice channels (preview):** you can join a voice channel and everyone sees who's in it, but there's no audio
  yet. The server owner turns them on.
- **Direct messages:** 1:1 and group DMs (up to 10 people) with anyone on the server.
- **Profiles:** display name, avatar image (animated allowed), banner, profile colours, bio, custom status, and online / idle / do not disturb /
  invisible status (idle kicks in after 10 minutes away). Avatars, banners and guild images go through a built-in cropper —
  drag to move, scroll or drag the slider to zoom.
- **User settings:** account and password, profile editor with live preview, logged-in devices, dark/light theme, font
  size, compact mode, desktop notifications and sound. Per-guild and per-channel mute and notification levels live in
  the guild and channel menus.
- **Roles and permissions:** colored roles with 20 permissions, role hierarchy, roles displayed separately in the
  member list, and per-channel overrides for private and read-only channels.
- **Moderation:** kick, ban (optionally deleting recent messages), timeouts, and an audit log.
- **Server staff:** the owner can appoint server **admins** and **moderators**. Moderators handle account requests,
  mute people server-wide, and ban IP addresses and devices. Admins can also delete accounts, reset passwords and
  manage every guild. Everything staff do is in a server audit log.
- **Server owner:** first-run setup in the browser, server settings (upload limit, voice), Terms of Service and
  Privacy Policy pages, and read-only "ghost" joins into any guild.
- **Safety prompts:** before connecting to a new server the client warns that its owner can see your IP address, and
  if the server has rules, people read and accept them before creating an account (and again when they change).

Deferred (see PROTOCOL.md §10): voice audio, link embeds, server-wide emoji packs.

## Run a server

Requires Python 3.11+.

```sh
cd server
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp nightcord.example.toml nightcord.toml   # edit server_name, public_hostnames, allowed_origins
python nightcord_server.py --config nightcord.toml
```

On first start the server does two things:

- It prints a one-time **setup code**. Open the client, connect to the server, and it walks you through setup: enter
  the code, choose the server-owner username and password, and pick the server name and account/guild policies. Until
  then nobody can register or log in. A new code is printed on every start until setup is done.
- It generates a **self-signed TLS certificate** in `data/`. The cert includes `localhost`, `127.0.0.1`, and every
  entry in `public_hostnames`.

Databases from Nightcord v2 and v3 upgrade in place the first time v4 starts. Databases from v1 aren't compatible;
the server refuses to open one. Move or delete the old `data/` folder.

Uploaded files are stored in `data/files/`, emoji, stickers, avatars and banners in `data/media/` (and older small
avatars in `data/avatars/`), and the rules pages in `data/legal/terms.md` and `data/legal/privacy.md`. You can edit
those two files by hand or in the client.

### Behind a reverse proxy

If people reach the server through nginx, Caddy or a tunnel, set `trust_proxy = true` in `nightcord.toml` so the
server sees real client IPs (for IP bans and the Accounts list). Leave it off when clients connect directly;
otherwise anyone could fake their address.

### Letting browsers trust the certificate

The client is served over https from GitHub Pages, so it must connect with `wss://`. Browsers refuse self-signed
certificates until the user accepts them. Each user needs to do this once per server:

1. Open `https://your-host:8765/` in the browser.
2. Accept the certificate warning. You'll then see a "Nightcord server" page.
3. Go back to the client and connect.

If connecting fails, the client shows this link automatically.

### Allowed origins

The server rejects WebSocket connections from browser origins that aren't in `allowed_origins`. Add your Pages origin
(e.g. `https://you.github.io`). Using `--allow-origin '*'` disables the check.

### Admin

Most admin work happens in the client: log in as the server owner (or a staff member) and open **User settings (⚙) →
Server admin**. Staff get a live badge when someone asks for an account, and staff actions are also in each person's
profile and right-click menu. The CLI works too, and is safe to run while the server is up:

```sh
python nightcord_server.py pending list                 # account requests (account_creation = request)
python nightcord_server.py pending approve <username>
python nightcord_server.py pending reject <username>
python nightcord_server.py users list [--status disabled]
python nightcord_server.py users disable <username>     # or: users enable <username>
python nightcord_server.py config show
python nightcord_server.py config set account_creation request   # off | request | on
python nightcord_server.py config set guild_creation off         # off | on
python nightcord_server.py config set guild_list_visible false
python nightcord_server.py config set server_name "Night Owls"
python nightcord_server.py config set max_upload_mb 50             # per-file upload limit
python nightcord_server.py config set voice_enabled true           # voice channels (preview, no audio)
python nightcord_server.py staff list                   # server admins and moderators
python nightcord_server.py staff set <username> moderator        # or: admin | none
python nightcord_server.py ipban list                   # or: ipban add|remove 203.0.113.0/24
python nightcord_server.py config set customization_mode allowlist   # off | allowlist | on
python nightcord_server.py perks list                   # who may use banners, gradients and themes
python nightcord_server.py perks add <username>         # or: perks remove <username>
python nightcord_server.py guilds                       # every guild + ID
python nightcord_server.py owner reset-password         # locked out? prints a new owner password
```

## Use the client

- **Hosted:** push to `main` and the `Deploy homepage and client to GitHub Pages` workflow publishes the homepage
  (`site/`) at the root and the client (`client/`) under `/app/`. To enable it, go to
  *Settings → Pages → Source: GitHub Actions*.
- **Share a direct link:** `https://you.github.io/nightcord/?server=chat.example.com:8765` opens the client already
  pointed at that server. Invite links from the client add `&invite=CODE` and open the invite card.
- **Address format:** enter `host:port` (the field already shows `https://`) and the client uses `wss://`. You can
  also paste a full `ws://` or `wss://` URL. The `localhost:8765` chip fills in a server on your own computer.
- **Tips:** right-click guilds, channels and members for menus; ↑ in an empty message box edits your last message;
  Shift-click the delete button to skip the confirmation; Ctrl/Cmd+K jumps anywhere; drag channels to reorder them; type `:name:`
  for custom emoji and 🗒 for stickers.

Guild emoji and stickers live in **Server settings → Emoji / Stickers** (needs the Manage expressions permission).
Banners, profile colours, gradient roles and themes are in **User settings → Profile / Appearance** and the role
editor; if they're greyed out, the server has them off or limited to an allow-list (**Server admin → Customisation**).

## Local development

```sh
# terminal 1: server without TLS
cd server && python nightcord_server.py --no-tls --port 8765 --data-dir data-dev

# terminal 2: homepage at / and client at /app/
python tools/localhost.py
```

Open http://127.0.0.1:8000/app/?server=localhost:8765. The default allowed origins already include `localhost:8000` and
`127.0.0.1:8000`.

Run the tests:

```sh
cd server && pip install -r requirements-dev.txt && pytest
node client/tests/markdown.test.mjs
```

`client/js/protocol.js` is generated from `server/nightcord/protocol.py`; after changing message types, error codes or
limits, run `python server/tools/gen_client_protocol.py`. `server/tests/test_protocol_sync.py` fails whenever
`docs/PROTOCOL.md`, `protocol.py` and `protocol.js` disagree on message types, error codes or permission bits.
