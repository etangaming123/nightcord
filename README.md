# Nightcord

Self-hosted, Discord-style chat. You run a small Python **server**. Friends connect to it from a static web **client**
hosted on GitHub Pages. One server can host many **guilds**, each with its own channels, roles and members, plus
direct messages between anyone on the server.

- `docs/PROTOCOL.md` is the wire protocol and the source of truth. If the code disagrees with it, the code is wrong.
- `server/` holds the Python server: aiohttp, SQLite, and bcrypt.
- `client/` holds the client: vanilla JS modules with no build step.

## What's in it (v2)

- **Chat:** markdown (`**bold**`, `*italic*`, `` `code` ``, code blocks, quotes, `||spoilers||`), replies, emoji
  reactions, edit and delete, @mentions and @everyone, typing indicators, unread and mention badges that sync across
  your devices.
- **Direct messages:** 1:1 and group DMs (up to 10 people) with anyone on the server.
- **Profiles:** display name, avatar image, profile color, bio, custom status, and online / idle / do not disturb /
  invisible status (idle kicks in after 10 minutes away).
- **User settings:** account and password, profile editor with live preview, logged-in devices, dark/light theme, font
  size, compact mode, desktop notifications and sound. Per-guild and per-channel mute and notification levels live in
  the guild and channel menus.
- **Roles and permissions:** colored roles with 15 permissions, role hierarchy, and per-channel overrides for private
  and read-only channels.
- **Moderation:** kick, ban (optionally deleting recent messages), timeouts, and an audit log.
- **Server owner:** first-run setup in the browser, an Admin panel for account requests, users and guilds, and read-only
  "ghost" joins into any guild.

Deferred (see PROTOCOL.md §10): friend and message requests, attachments, search, channel categories and topics, guild
icons, expiring invites, voice.

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

Databases from Nightcord v1 aren't compatible; the server refuses to open one. Move or delete the old `data/` folder.

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

Most admin work happens in the client: log in as the server owner and open **User settings (⚙) → Server admin**. You
get a live badge when someone asks for an account. The CLI works too, and is safe to run while the server is up:

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
python nightcord_server.py guilds                       # every guild + ID
python nightcord_server.py owner reset-password         # locked out? prints a new owner password
```

## Use the client

- **Hosted:** push to `main` and the `Deploy client to GitHub Pages` workflow publishes `client/`. To enable it, go to
  *Settings → Pages → Source: GitHub Actions*.
- **Share a direct link:** `https://you.github.io/nightcord/?server=chat.example.com:8765` opens the client already
  pointed at that server.
- **Address format:** enter `host:port` and the client uses `wss://`. You can also give a full `ws://` or `wss://` URL.
- **Tips:** right-click guilds, channels and members for menus; ↑ in an empty message box edits your last message;
  Shift-click the delete button to skip the confirmation.

## Local development

```sh
# terminal 1: server without TLS
cd server && python nightcord_server.py --no-tls --port 8765 --data-dir data-dev

# terminal 2: client
python client/localhost.py
```

Open http://127.0.0.1:8000/?server=localhost:8765. The default allowed origins already include `localhost:8000` and
`127.0.0.1:8000`.

Run the tests:

```sh
cd server && pip install -r requirements-dev.txt && pytest
node client/tests/markdown.test.mjs
```

`client/js/protocol.js` is generated from `server/nightcord/protocol.py`; after changing message types, error codes or
limits, run `python server/tools/gen_client_protocol.py`. `server/tests/test_protocol_sync.py` fails whenever
`docs/PROTOCOL.md`, `protocol.py` and `protocol.js` disagree on message types, error codes or permission bits.
