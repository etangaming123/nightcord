"""Linking Nightcord accounts to Discord accounts (PROTOCOL.md §5 Discord link).

A server can run one Discord bot of its own (discord_bot.py, which needs
discord.py and a `discord_token`). People add that bot to their Discord
account, and then:

- **link**: the client asks for a one-time code (`discord.link.start`) and
  the person hands it to the bot with `/nightcord link`. That proves both
  sides at once: the code proves the Nightcord account, the slash command
  the Discord one.
- **notifications**: mentions, DMs, message requests, friend requests and
  announcements arrive as DMs from the bot, each kind switchable in the
  client or with `/nightcord notifications`. By default only while they
  aren't on Nightcord, and never while they're on Do Not Disturb.
- **sync**: `/nightcord sync` (or `discord.sync`) copies their Discord
  display name, avatar and banner onto their Nightcord profile, within what
  this server lets them customise (§8d).

This module is the half that knows Nightcord. It never imports discord.py,
so it and its tests work without it; the bot plugs in as a `Bot`.
"""

from __future__ import annotations

import asyncio
import logging
import re
import secrets
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Awaitable, Callable, Iterable, Protocol
from urllib.parse import quote

from . import perks
from . import protocol as P
from .db import iso_in
from .protocol import ProtocolError

if TYPE_CHECKING:
    from .handlers import Ctx

log = logging.getLogger("nightcord.discord")

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I
MAX_CODE_FAILURES = 5  # wrong codes one Discord account may try...
CODE_FAILURE_WINDOW = 600  # ...per ten minutes
FLUSH_DELAY = 2.0  # notifications this close together share one DM
MAX_NOTES_PER_DM = 10  # Discord's limit on embeds in one message
PREVIEW_MAX = 300
COOLDOWN_SECONDS = 10  # between syncs, and between test notifications
APP_URL_RE = re.compile(r"^https?://[^\s?#]+$")
SERVER_ADDRESS_RE = re.compile(r"^(wss?://)?[\w.\-\[\]:]{1,255}$")

_MENTION_RE = re.compile(r"<@(\d{1,20})>")
_CHANNEL_RE = re.compile(r"<#(\d{1,20})>")
_EMOJI_RE = re.compile(r"<a?:(\w{2,32}):\d{1,20}>")


@dataclass
class Note:
    """One notification; the bot shows it as an embed in a DM."""

    kind: str
    title: str
    body: str | None = None
    url: str | None = None
    footer: str | None = None
    timestamp: str | None = None  # ISO8601


@dataclass
class DiscordImage:
    animated: bool
    # read(animated) -> the image bytes: a GIF when animated is true and the
    # image is animated, otherwise a still PNG.
    read: Callable[[bool], Awaitable[bytes]]


@dataclass
class DiscordProfile:
    username: str
    display_name: str
    avatar: DiscordImage | None
    banner: DiscordImage | None


class Bot(Protocol):
    """What discord_bot.py (or a test double) gives this module."""

    online: bool
    name: str | None
    install_url: str | None

    async def send_notes(self, discord_id: str, notes: list[Note], more: int) -> bool:
        """DMs the notes (and "…and `more` more"); False when Discord refuses the DM."""

    async def fetch_profile(self, discord_id: str) -> DiscordProfile | None: ...


class LinkError(Exception):
    """Something the person asked for can't be done. The message is for them;
    `code` says which protocol error it becomes."""

    def __init__(self, message: str, code: str = P.BAD_REQUEST):
        super().__init__(message)
        self.message = message
        self.code = code

    def protocol_error(self) -> ProtocolError:
        return ProtocolError(self.code, self.message)


def display_name(user: dict | None) -> str:
    if not user:
        return "Someone"
    return user.get("display_name") or user.get("username") or "Someone"


def clean_app_url(value) -> str | None:
    """The client's base URL (…/app/), from discord.link.start."""
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > P.DISCORD_APP_URL_MAX or not APP_URL_RE.match(value):
        raise ProtocolError(P.BAD_REQUEST, "'app_url' must be an http(s) URL")
    return value if value.endswith("/") else value + "/"


def clean_server_address(value) -> str | None:
    """The ?server= value that points a client at this server."""
    if value is None:
        return None
    if not isinstance(value, str) or not SERVER_ADDRESS_RE.match(value):
        raise ProtocolError(P.BAD_REQUEST, "'server' must be a host:port")
    return value


class DiscordLink:
    def __init__(self, ctx: "Ctx", bot: Bot | None = None):
        self.ctx = ctx
        self.bot = bot
        # code -> (user_id, expires (epoch), app_url, server address)
        self._codes: dict[str, tuple[str, float, str | None, str | None]] = {}
        self._failures: dict[str, list[float]] = {}
        self._queues: dict[str, list[Note]] = {}
        self._flushers: dict[str, asyncio.Task] = {}
        self._cooldowns: dict[tuple[str, str], float] = {}
        # Accounts whose last DM Discord refused (they left every server the
        # bot shares and removed the app, or turned DMs off).
        self.dm_refused: set[str] = set()

    @property
    def db(self):
        return self.ctx.db

    @property
    def online(self) -> bool:
        return self.bot is not None and self.bot.online

    def server_name(self) -> str:
        return self.db.get_server_config()["server_name"] or self.ctx.config.server_name

    # --- views --------------------------------------------------------------

    def status(self) -> dict:
        """The DiscordBot model."""
        bot = self.bot
        return {
            "online": self.online,
            "name": bot.name if bot else None,
            "install_url": bot.install_url if bot else None,
        }

    def view(self, user_id: str) -> dict | None:
        """The DiscordLink model, or None when user_id isn't linked."""
        link = self.db.discord_link(user_id)
        if link is not None:
            link["dm_refused"] = user_id in self.dm_refused
        return link

    async def push(self, user_id: str) -> None:
        await self.ctx.hub.send_to_user(user_id, P.frame(P.DISCORD_LINK_UPDATED, {"link": self.view(user_id)}))

    def _cooldown(self, user_id: str, action: str) -> None:
        now = time.monotonic()
        until = self._cooldowns.get((user_id, action), 0)
        if now < until:
            raise LinkError(f"Slow down; try again in {int(until - now) + 1}s.", P.RATE_LIMITED)
        self._cooldowns[(user_id, action)] = now + COOLDOWN_SECONDS

    # --- linking ------------------------------------------------------------

    def new_code(self, user_id: str, *, app_url: str | None = None, server: str | None = None) -> dict:
        """A fresh one-time code for user_id; any older one stops working."""
        now = time.time()
        self._codes = {c: v for c, v in self._codes.items() if v[0] != user_id and v[1] > now}
        raw = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
        code = f"{raw[:4]}-{raw[4:]}"
        self._codes[code] = (user_id, now + P.DISCORD_CODE_SECONDS, app_url, server)
        return {"code": code, "expires_at": iso_in(P.DISCORD_CODE_SECONDS)}

    async def redeem(self, code: str, discord_id: str, discord_username: str) -> dict:
        """/nightcord link: links the account that asked for `code` to this
        Discord account (unlinking whatever either was linked to before).
        Returns the Nightcord account's PublicUser."""
        now = time.time()
        recent = [t for t in self._failures.get(discord_id, []) if now - t < CODE_FAILURE_WINDOW]
        if len(recent) >= MAX_CODE_FAILURES:
            raise LinkError("That's a lot of wrong codes. Wait a few minutes, then try again.", P.RATE_LIMITED)
        # The last eight letters, so "abcd ef23" and a pasted "code:ABCD-EF23" work too.
        letters = re.sub(r"[^A-Z0-9]", "", code.upper())[-8:]
        entry = self._codes.get(f"{letters[:4]}-{letters[4:]}")
        if entry is None or entry[1] < now:
            self._failures[discord_id] = [*recent, now]
            raise LinkError(
                "That code is wrong or has run out. Get a new one in Nightcord: Settings → Connections.",
                P.NOT_FOUND,
            )
        del self._codes[f"{letters[:4]}-{letters[4:]}"]
        self._failures.pop(discord_id, None)
        user_id, _, app_url, server = entry
        row = self.db.get_user_row(user_id)
        if row is None or row["status"] != "active":
            raise LinkError("That Nightcord account can't be linked right now.", P.FORBIDDEN)
        previous = self.db.user_id_for_discord(discord_id)
        self.db.set_discord_link(user_id, discord_id, discord_username, app_url=app_url, server_address=server)
        self.dm_refused.discard(user_id)
        if previous and previous != user_id:
            self.dm_refused.discard(previous)
            await self.push(previous)
        await self.push(user_id)
        return self.db.public_user(user_id)

    def user_for(self, discord_id: str) -> str:
        """The active Nightcord account linked to discord_id."""
        user_id = self.db.user_id_for_discord(discord_id)
        if user_id is None:
            raise LinkError(
                f"Your Discord account isn't linked to anyone on {self.server_name()}. In Nightcord, open "
                "Settings → Connections → Link Discord and give me the code with `/nightcord link`.",
                P.NOT_FOUND,
            )
        row = self.db.get_user_row(user_id)
        if row is None or row["status"] != "active":
            raise LinkError("The Nightcord account you linked isn't active any more.", P.FORBIDDEN)
        return user_id

    def _require_link(self, user_id: str) -> dict:
        row = self.db.discord_link_row(user_id)
        if row is None:
            raise LinkError("You haven't linked a Discord account.", P.NOT_FOUND)
        return row

    async def unlink(self, user_id: str) -> None:
        if not self.db.delete_discord_link(user_id):
            raise LinkError("You haven't linked a Discord account.", P.NOT_FOUND)
        self.dm_refused.discard(user_id)
        self._queues.pop(user_id, None)
        await self.push(user_id)

    async def update_settings(
        self, user_id: str, *, notify: dict[str, bool] | None = None, only_when_away: bool | None = None,
        include_content: bool | None = None,
    ) -> dict:
        self._require_link(user_id)
        link = self.db.discord_link(user_id)
        settings: dict = {}
        if notify:
            settings["notify"] = {**link["notify"], **notify}
        if only_when_away is not None:
            settings["only_when_away"] = only_when_away
        if include_content is not None:
            settings["include_content"] = include_content
        self.db.update_discord_link(user_id, settings=settings)
        await self.push(user_id)
        return self.view(user_id)

    # --- notifications ------------------------------------------------------

    def _link_for(self, user_id: str, kind: str):
        """user_id's link row when they want a `kind` notification right now."""
        if not self.online:
            return None
        row = self.db.discord_link_row(user_id)
        if row is None:
            return None
        link = self.db.discord_link_of(row)
        if not link["notify"].get(kind):
            return None
        user = self.db.get_user_row(user_id)
        if user is None or user["status"] != "active" or user["presence_pref"] == "dnd":
            return None
        if link["only_when_away"] and self.ctx.hub.is_active(user_id):
            return None
        return row

    def _url(self, row, path: str) -> str | None:
        """A link into the client the person linked from, or None when it
        didn't say where it lives (the standalone file)."""
        if not row["app_url"]:
            return None
        server = row["server_address"]
        return row["app_url"] + path + (f"?server={quote(server, safe=':[]/')}" if server else "")

    def queue(self, user_id: str, note: Note) -> None:
        self._queues.setdefault(user_id, []).append(note)
        if user_id not in self._flushers:
            task = asyncio.create_task(self._flush_later(user_id))
            self._flushers[user_id] = task

    async def _flush_later(self, user_id: str) -> None:
        try:
            await asyncio.sleep(FLUSH_DELAY)
        finally:
            self._flushers.pop(user_id, None)
        await self.flush(user_id)

    async def flush(self, user_id: str) -> None:
        notes = self._queues.pop(user_id, [])
        row = self.db.discord_link_row(user_id)
        if not notes or row is None or not self.online:
            return
        try:
            ok = await self.bot.send_notes(
                row["discord_id"], notes[:MAX_NOTES_PER_DM], max(0, len(notes) - MAX_NOTES_PER_DM)
            )
        except Exception:
            log.exception("couldn't send Discord notifications to %s", user_id)
            return
        await self._delivered(user_id, ok)

    async def _delivered(self, user_id: str, ok: bool) -> None:
        refused_before = user_id in self.dm_refused
        if ok:
            self.dm_refused.discard(user_id)
        else:
            self.dm_refused.add(user_id)
        if refused_before == ok:
            await self.push(user_id)

    def _preview(self, message: dict) -> str:
        """Message text as a Discord embed can show it: mentions, channels
        and custom emoji by name, cut short."""
        text = message.get("content") or ""

        def user(m):
            u = self.db.public_user(m.group(1))
            return f"@{u['username']}" if u else "@unknown"

        def channel(m):
            c = self.db.get_channel(m.group(1))
            return f"#{c['name']}" if c and c.get("name") else "#unknown"

        text = _EMOJI_RE.sub(r":\1:", _CHANNEL_RE.sub(channel, _MENTION_RE.sub(user, text))).strip()
        extras = []
        if message.get("poll"):
            extras.append(f"📊 {message['poll']['question']}")
        if message.get("command"):
            extras.append(f"used /{message['command']['name']}")
        if message.get("forward"):
            extras.append("↪ forwarded a message")
        if message.get("stickers"):
            extras.append("sent a sticker")
        if message.get("attachments"):
            n = len(message["attachments"])
            extras.append(f"📎 {n} attachment" + ("s" if n != 1 else ""))
        text = "\n".join([t for t in [text, *extras] if t])
        return text if len(text) <= PREVIEW_MAX else text[: PREVIEW_MAX - 1].rstrip() + "…"

    def _message_note(self, row, kind: str, channel: dict, message: dict, user_id: str) -> Note:
        author = display_name(message.get("author"))
        server = self.server_name()
        if channel["guild_id"] is not None:
            guild = self.db.get_guild(channel["guild_id"])
            replied = (message.get("reply_to") or {}).get("author", {}).get("user_id") == user_id
            verb = "replied to you" if replied and user_id not in _MENTION_RE.findall(message["content"] or "") else "mentioned you"
            title = f"{author} {verb} in #{channel['name']}"
            footer = f"{guild['name']} · {server}" if guild else server
            path = f"servers/{channel['guild_id']}/{channel['channel_id']}/{message['message_id']}"
        else:
            footer = server
            if kind == "message_requests":
                title = f"Message request from {author}"
                path = "requests"
            elif channel["kind"] == "group_dm":
                group = channel.get("name") or "your group"
                title = f"{author} in {group}"
                path = f"groups/{channel['channel_id']}/{message['message_id']}"
            else:
                title = author
                path = f"dms/{channel['channel_id']}/{message['message_id']}"
        include = self.db.discord_link_of(row)["include_content"]
        return Note(
            kind, title, body=self._preview(message) if include else None, url=self._url(row, path), footer=footer,
            timestamp=message.get("sent_at"),
        )

    def _notify_level(self, user_id: str, channel: dict) -> tuple[str, bool]:
        """(level, muted) as the client works it out: the channel's pref, then the guild's."""
        prefs = {p["target_id"]: p for p in self.db.notify_prefs(user_id)}
        mine = prefs.get(channel["channel_id"], {})
        guild = prefs.get(channel["guild_id"], {}) if channel["guild_id"] else {}
        level = mine.get("level") or guild.get("level") or "all"
        return level, bool(mine.get("muted") or guild.get("muted"))

    def on_message(self, channel: dict, message: dict, pinged: Iterable[str]) -> None:
        """After message.send / message.forward: DMs and group DMs notify every
        other recipient, guild messages whoever they mention (or reply to)."""
        if not self.online:
            return
        author_id = (message.get("author") or {}).get("user_id")
        if channel["guild_id"] is None:
            request = channel.get("request") or {}
            pending = request.get("state") == "pending"
            for uid in self.db.dm_recipient_ids(channel["channel_id"]):
                if uid == author_id:
                    continue
                kind = "message_requests" if pending else "dms"
                if not pending:
                    level, muted = self._notify_level(uid, channel)
                    if muted or level == "none":
                        continue
                row = self._link_for(uid, kind)
                if row is not None:
                    self.queue(uid, self._message_note(row, kind, channel, message, uid))
            return
        for uid in pinged:
            if uid == author_id or self.db.relationship(uid, author_id) == "blocked":
                continue
            if self._notify_level(uid, channel)[0] == "none":
                continue
            row = self._link_for(uid, "mentions")
            if row is not None:
                self.queue(uid, self._message_note(row, "mentions", channel, message, uid))

    def on_friend_request(self, from_id: str, to_id: str) -> None:
        row = self._link_for(to_id, "friend_requests")
        if row is None:
            return
        who = self.db.public_user(from_id)
        self.queue(to_id, Note(
            "friend_requests", f"{display_name(who)} sent you a friend request",
            body=f"@{who['username']}" if who else None, url=self._url(row, "friends/pending"),
            footer=self.server_name(),
        ))

    def on_announcement(self, item: dict) -> None:
        if not self.online:
            return
        title = "The server's rules changed" if item["kind"] == "legal" else "New announcement"
        for uid in self.db.discord_linked_user_ids():
            if uid == item.get("author_id"):
                continue
            row = self._link_for(uid, "announcements")
            if row is None:
                continue
            include = self.db.discord_link_of(row)["include_content"]
            body = item["content"] if len(item["content"]) <= PREVIEW_MAX else item["content"][: PREVIEW_MAX - 1] + "…"
            self.queue(uid, Note(
                "announcements", title, body=body if include else None, url=self._url(row, "inbox"),
                footer=self.server_name(), timestamp=item.get("created_at"),
            ))

    async def send_test(self, user_id: str) -> bool:
        """A test DM, straight away. True when Discord delivered it."""
        row = self._require_link(user_id)
        if not self.online:
            raise LinkError("The Discord bot is offline right now.", P.DISCORD_UNAVAILABLE)
        self._cooldown(user_id, "test")
        note = Note(
            "test", "Notifications from Nightcord work!",
            body=f"This is where I'll tell you about things happening on {self.server_name()}.",
            url=self._url(row, "settings/connections"), footer=self.server_name(),
        )
        ok = await self.bot.send_notes(row["discord_id"], [note], 0)
        await self._delivered(user_id, ok)
        return ok

    # --- profile sync -------------------------------------------------------

    async def _image(self, user_id: str, image: DiscordImage | None, kind: str, feature: str | None, owner: dict) -> str | None:
        """Stores a Discord image as user_id's `kind` and returns the reference
        to put on the profile (None when Discord has none: match it)."""
        from .handlers.media import image_problem, save_media
        from .handlers.users import claim_image

        if image is None:
            return None
        if feature:
            perks.require(self.ctx, feature, owner)
        animated = image.animated and perks.can(self.ctx, "animated_media", owner)
        data = await image.read(animated)
        problem = image_problem(data, kind)
        if problem is not None and animated:
            data = await image.read(False)  # a big GIF: the still frame will do
            problem = image_problem(data, kind)
        if problem is not None:
            raise ProtocolError(problem[1], problem[2])
        media = save_media(self.ctx, user_id, kind, data)
        return claim_image(self.ctx, user_id, media["media_id"], kind, feature, owner)

    async def sync_profile(self, user_id: str, fields: Iterable[str] = P.DISCORD_SYNC_FIELDS) -> dict:
        """Makes user_id's profile match their Discord one. Returns
        { user, synced: [field], skipped: {field: reason} }."""
        from .handlers.users import broadcast_user, drop_image

        row = self._require_link(user_id)
        if not self.online:
            raise LinkError("The Discord bot is offline right now.", P.DISCORD_UNAVAILABLE)
        self._cooldown(user_id, "sync")
        profile = await self.bot.fetch_profile(row["discord_id"])
        if profile is None:
            raise LinkError("Discord couldn't find your account.", P.NOT_FOUND)
        self.db.update_discord_link(user_id, discord_username=profile.username)
        owner = self.db.public_user(user_id)
        before = self.db.get_user(user_id)
        fields = [f for f in P.DISCORD_SYNC_FIELDS if f in set(fields)]
        updates: dict = {}
        skipped: dict[str, str] = {}
        if "display_name" in fields:
            updates["display_name"] = profile.display_name.strip()[: P.DISPLAY_NAME_MAX] or None
        for field, kind, feature, image in (
            ("avatar", "avatar", None, profile.avatar),
            ("banner", "banner", "profile_banner", profile.banner),
        ):
            if field not in fields:
                continue
            try:
                updates[f"{field}_id"] = await self._image(user_id, image, kind, feature if image else None, owner)
            except ProtocolError as e:
                skipped[field] = e.message
            except Exception:
                log.exception("couldn't copy the Discord %s of %s", field, user_id)
                skipped[field] = "Discord didn't send the image"
        user = self.db.update_profile(user_id, updates) if updates else before
        for field in ("avatar", "banner"):
            if f"{field}_id" in updates and before[f"{field}_id"] != updates[f"{field}_id"]:
                drop_image(self.ctx, before[f"{field}_id"])
        if updates:
            await broadcast_user(self.ctx, user)
        await self.push(user_id)
        synced = [f for f in fields if f not in skipped]
        return {"user": user, "synced": synced, "skipped": skipped}

    # --- lifecycle ----------------------------------------------------------

    async def close(self) -> None:
        for task in list(self._flushers.values()):
            task.cancel()
        self._flushers.clear()
        self._queues.clear()
