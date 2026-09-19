# Nightcord

Self-hosted, Discord-style chat. You run a small Python **server**. Friends connect to it from a static web **client**
hosted on GitHub Pages. One server can host many **guilds**, each with its own text channels and members.

- `docs/PROTOCOL.md` is the wire protocol and the source of truth. If the code disagrees with it, the code is wrong.
- `server/` holds the Python server: aiohttp, SQLite, and bcrypt.
- `client/` holds the client: vanilla JS modules with no build step.

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

- It creates the **server-owner** account (`owner`) and prints its password **once**. Save it.
  To get a new password, run `python nightcord_server.py owner reset-password`.
- It generates a **self-signed TLS certificate** in `data/`. The cert includes `localhost`, `127.0.0.1`, and every
  entry in `public_hostnames`.

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

### Admin CLI

Admin commands are safe to run while the server is up.

```sh
python nightcord_server.py pending list                 # account requests (account_creation = request)
python nightcord_server.py pending approve <username>
python nightcord_server.py pending reject <username>
python nightcord_server.py config show
python nightcord_server.py config set account_creation request   # off | request | on
python nightcord_server.py config set guild_creation off         # off | on
python nightcord_server.py config set guild_list_visible false
python nightcord_server.py guilds                       # every guild + ID (for ghost joins)
python nightcord_server.py owner reset-password
```

The same settings are also editable in the client. Log in as `owner` and click ⚙ in the user panel. That panel also
has **ghost join**: the owner can read any guild by its ID. Ghost joins are read-only and invisible to the guild's
members.

## Use the client

- **Hosted:** push to `main` and the `Deploy client to GitHub Pages` workflow publishes `client/`. To enable it, go to
  *Settings → Pages → Source: GitHub Actions*.
- **Share a direct link:** `https://you.github.io/nightcord/?server=chat.example.com:8765` opens the client already
  pointed at that server.
- **Address format:** enter `host:port` and the client uses `wss://`. You can also give a full `ws://` or `wss://` URL.

## Local development

```sh
# terminal 1: server without TLS
cd server && python nightcord_server.py --no-tls --port 8765 --data-dir data-dev

# terminal 2: client
python -m http.server -d client 8000
```

Open http://localhost:8000/?server=localhost:8765. The default allowed origins already include `localhost:8000` and
`127.0.0.1:8000`.

Run the tests:

```sh
cd server && pip install -r requirements-dev.txt && pytest
```

`tests/test_protocol_sync.py` fails whenever `docs/PROTOCOL.md`, `server/nightcord/protocol.py` and
`client/js/protocol.js` disagree on message types or error codes.

## Scope (v1)

v1 includes:

- accounts, with open, by-request, or closed registration
- guilds, with invites and a public directory
- text channels
- live messages and history scroll-back
- presence
- server-owner ghost joins

Deferred features are listed in PROTOCOL.md §10: roles, moderation, edits and deletes, attachments, DMs, and voice.
