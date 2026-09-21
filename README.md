# Nightcord

A web-based messaging app, built for selfhosting. A parody of Discord.

[Website](https://nightcord.etangaming.xyz/) · [Open the client](https://nightcord.etangaming.xyz/app/) · [Protocol spec](docs/PROTOCOL.md)

> [!WARNING]
> **This is vibecoded by Claude, have fun :)**
> It works and it has tests, but nobody has audited it. Don't put anything on it you'd be upset to lose or leak.

> [!WARNING]
> **Whoever runs a server can see your IP address and read everything on it.** Only join servers run by people you
> trust. The client warns about this before it connects anywhere new.

> [!NOTE]
> Nightcord is built for **personal use**: a few friends, a big friend group at most. It's one small Python process
> and one SQLite file, not a public service that scales to thousands of strangers. It isn't affiliated with Discord.

## Features

### Chat
- Guilds with text channels, categories, topics, slowmode and (placeholder) voice channels
- Markdown, replies, reactions, pins, edits, @mentions, typing indicators, unread badges synced across devices
- Search with `from:`, `in:`, `has:` and `pinned:` filters; Ctrl/Cmd+K quick switcher
- File uploads with inline images and video
- Custom emoji and stickers per guild, usable **everywhere by everyone**. No Nitro required, or even possible.

### People
- **Friends:** add people by exact username, accept or decline requests, block people
- **Message requests:** strangers get one message that waits in your Message Requests until you say yes. You pick
  who can DM you: everyone, friends plus requests (the default), or friends only.
- 1:1 and group DMs. Only your friends can add you to a group.
- **Inbox:** announcements from the server owner, plus automatic notices when the rules change
- **Account switcher:** keep several accounts on several servers and hop between them
- Profiles with avatars, banners, gradient profile colours, bios and custom statuses

### Running a server
- Roles and permissions with per-channel overrides, kicks, bans, timeouts and audit logs
- Server staff (admins and moderators), account approval, IP and device bans
- Terms of Service and Privacy Policy pages that people accept before joining
- Server-wide switches for who can customise their profile, whether user search exists, and more
- One-command backups

## Screenshots

| Guilds | Friends | Inbox |
|---|---|---|
| ![A guild channel](site/screenshots/chat.png) | ![The Friends page](site/screenshots/friends.png) | ![The announcements inbox](site/screenshots/inbox.png) |

## Quickstart

To **join** a server, open [the client](https://nightcord.etangaming.xyz/app/), type in the server's
address (`host:port`) and make an account. That's it.

To **host** one, keep reading.

## Selfhosting

### You will need
- Python 3.11 or newer
- A machine that stays on (a spare PC, a Raspberry Pi, a cheap VPS)
- A port your friends can reach (8765 by default), or a tunnel or reverse proxy

### Steps
1. Get the server running:
   ```sh
   cd server
   python -m venv .venv && . .venv/bin/activate
   pip install -r requirements.txt
   cp nightcord.example.toml nightcord.toml   # set server_name, public_hostnames, allowed_origins
   python nightcord_server.py --config nightcord.toml
   ```
2. The first start prints a **setup code** and makes a self-signed TLS certificate in `data/`.
3. Open the client, connect to your server and enter the setup code. You'll pick the owner account, the server name
   and who may create accounts and guilds.
4. Send your friends the link. `https://nightcord.etangaming.xyz/app/?server=your-host:8765` opens the
   client already pointed at your server.

### Updating
Pull the new code and restart the server. The database upgrades itself on start; run a [backup](#backups) first if
you're nervous. (Databases from the very first commit, protocol 0.2, can't be upgraded; the server says so and won't start.)

### Certificates
The hosted client runs over https, so it has to use `wss://`. Browsers reject self-signed certificates until you
accept them once. Each person opens `https://your-host:8765/`, accepts the warning, then goes back and connects. The
client shows this link when a connection fails. A real certificate (or Cloudflare Tunnel, Caddy and so on) skips this
step.

### Allowed origins
The server only accepts browsers from the origins in `allowed_origins`. Add wherever the client is hosted, e.g.
`https://etangaming123.github.io`. Behind a reverse proxy, set `trust_proxy = true` so IP bans see real addresses.
Leave it off otherwise, or anyone can fake theirs.

### Hosting the client yourself
Fork this repo, then go to *Settings → Pages → Source: GitHub Actions*. Every push to `main` publishes the homepage
at `/` and the client at `/app/`. The client is plain files with no build step, so any static host works too:
serve `site/` at the root and `client/` at `/app/`.

## Customising

Everything here is a plain file you can replace. Keep the name and format.

| What | Where |
|---|---|
| Logo (favicon, home button, homepage) | `client/assets/logo.png`, a square PNG (512×512 recommended) |
| Message sound | `client/assets/sounds/message.wav` (also used for friend requests, message requests and announcements) |
| Mention sound | `client/assets/sounds/mention.wav` |
| Voice join / leave | `client/assets/sounds/voice-join.wav`, `voice-leave.wav` |
| Every piece of UI text | `client/lang/en/**/*.json` |
| Homepage | `site/index.html`, `site/style.css` |

`python tools/gen_assets.py` regenerates the default logo and sounds. It overwrites your replacements, so only run
it to get the defaults back.

## Server admin

Most of this lives in the client under **User settings (⚙) → Server admin**. The same things work from the command
line, even while the server is running:

```sh
python nightcord_server.py pending list|approve|reject <username>   # account requests
python nightcord_server.py users list|disable|enable <username>
python nightcord_server.py staff list|set <username> admin|moderator|none
python nightcord_server.py perks list|add|remove <username>         # customisation allow-list
python nightcord_server.py ipban list|add|remove <ip-or-cidr>
python nightcord_server.py guilds                                   # every guild and its ID
python nightcord_server.py owner reset-password                     # locked out? prints a new password
python nightcord_server.py config show
python nightcord_server.py config set <key> <value>
```

Settings you can `config set`:

| Key | Values |
|---|---|
| `server_name` | any name |
| `account_creation` | `on`, `request` (staff approve), `off` |
| `guild_creation` | `on`, `off` (owner only) |
| `guild_list_visible` | `true`, `false` |
| `max_upload_mb` | 1–1024 |
| `voice_enabled` | `true`, `false` (voice has no audio yet) |
| `customization_mode` | `on`, `allowlist`, `off` |
| `user_search` | `off` (default: add friends by exact username), `staff`, `on` |
| `announcements_admins` | `true`, `false` (the owner can always post) |
| `max_accounts_per_client` | 0 (no limit) to 20. A courtesy limit for the account switcher, not enforced. |

## Backups

```sh
python nightcord_server.py backup            # writes backups/nightcord-backup-<date>.zip
python nightcord_server.py backup --out /somewhere/safe
```

The zip has a consistent snapshot of the database plus uploads, emoji, avatars and the rules pages. It's safe to run
while the server is up. To restore, stop the server, unzip into an empty `data/` folder and start it again. TLS keys
aren't included; the server makes a new certificate.

## Development

```sh
# terminal 1: the server, without TLS
python server/nightcord_server.py --no-tls --port 8765 --data-dir data-dev

# terminal 2: homepage at / and client at /app/
python tools/localhost.py
```

Open <http://127.0.0.1:8000/app/?server=http://localhost:8765>.

Tests:
```sh
cd server && pip install -r requirements-dev.txt && pytest
node client/tests/markdown.test.mjs
```

[`docs/PROTOCOL.md`](docs/PROTOCOL.md) is the source of truth for the wire protocol. `client/js/protocol.js` is
generated from `server/nightcord/protocol.py` by `python server/tools/gen_client_protocol.py`, and
`server/tests/test_protocol_sync.py` fails if the three disagree.

## Work in progress

Things that might happen one day:
- Slash commands (`/shrug`, `/roll`, `/8ball`…)
- Polls
- Saved messages
- Private notes on people's profiles
- A keyboard shortcut cheat sheet
- Voice and video that actually carry audio
- Link previews

## License

[MIT](LICENSE). Nightcord is a parody and isn't affiliated with or endorsed by Discord.
