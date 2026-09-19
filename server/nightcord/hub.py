"""Live connection registry: who is online, which channel each connection is
looking at, and event fan-out.

Presence and delivery rules from PROTOCOL.md §5 live here, including the
ghost exclusions from §7.
"""

from __future__ import annotations

import collections
import logging
import time
from typing import TYPE_CHECKING, Any, Callable, Iterable

from aiohttp import WSCloseCode

from . import protocol as P

if TYPE_CHECKING:
    from aiohttp import web

    from .db import Database
    from .permissions import PermissionService

log = logging.getLogger("nightcord.hub")

MESSAGE_RATE = 5
MESSAGE_RATE_WINDOW = 5.0
TYPING_INTERVAL = 3.0

# Close code sent when a connection's session is revoked; the client's
# reconnect then fails auth.resume and shows the login screen.
SESSION_REVOKED_CLOSE = 4001
# Close code for connections from a banned IP address or device.
BANNED_CLOSE = 4003


class Connection:
    def __init__(self, ws: "web.WebSocketResponse", remote: str | None, user_agent: str | None = None):
        self.ws = ws
        self.remote = remote or "unknown"
        self.user_agent = user_agent
        self.user: dict | None = None
        self.session_token: str | None = None
        self.channel_id: str | None = None  # focused channel (channel.join)
        self.afk = False
        self.device_id: str | None = None
        self._sent_times: collections.deque[float] = collections.deque()
        self._last_typing: dict[str, float] = {}

    @property
    def user_id(self) -> str | None:
        return self.user["user_id"] if self.user else None

    async def send(self, frame: dict) -> None:
        if self.ws.closed:
            return
        try:
            await self.ws.send_json(frame)
        except (ConnectionResetError, RuntimeError) as e:
            log.debug("send failed to %s: %s", self.remote, e)

    def allow_message(self) -> bool:
        now = time.monotonic()
        q = self._sent_times
        while q and now - q[0] > MESSAGE_RATE_WINDOW:
            q.popleft()
        if len(q) >= MESSAGE_RATE:
            return False
        q.append(now)
        return True

    def allow_typing(self, channel_id: str) -> bool:
        now = time.monotonic()
        if now - self._last_typing.get(channel_id, 0) < TYPING_INTERVAL:
            return False
        self._last_typing[channel_id] = now
        return True


FrameOrFactory = dict | Callable[[str], dict | None]


class Hub:
    def __init__(self, db: "Database", perms: "PermissionService"):
        self.db = db
        self.perms = perms
        self.conns_by_user: dict[str, set[Connection]] = collections.defaultdict(set)
        self.all_conns: set[Connection] = set()
        self._shown_status: dict[str, str] = {}  # last status others were told
        # Voice placeholder: user_id -> state. Audio isn't implemented yet;
        # this only tracks who sits in which voice channel.
        self.voice: dict[str, dict] = {}
        self._voice_conn: dict[str, Connection] = {}

    # --- connection lifecycle -----------------------------------------------

    def add(self, conn: Connection) -> None:
        self.all_conns.add(conn)

    async def authenticated(self, conn: Connection, user: dict) -> None:
        """Mark conn as logged in as user; broadcasts presence if it changed."""
        if conn.user is not None:
            await self.deauthenticate(conn)
        conn.user = user
        conn.afk = False
        self.conns_by_user[user["user_id"]].add(conn)
        await self.refresh_presence(user["user_id"])

    async def deauthenticate(self, conn: Connection) -> None:
        conn.channel_id = None
        user_id = conn.user_id
        conn.user = None
        conn.session_token = None
        if user_id is None:
            return
        conns = self.conns_by_user.get(user_id)
        if conns is None:
            return
        conns.discard(conn)
        if not conns:
            del self.conns_by_user[user_id]
        await self.refresh_presence(user_id)

    async def remove(self, conn: Connection) -> None:
        self.all_conns.discard(conn)
        if conn.user_id and self._voice_conn.get(conn.user_id) is conn:
            await self.voice_leave(conn.user_id)
        await self.deauthenticate(conn)

    async def close_where(self, pred: Callable[[Connection], bool], *, message: bytes = b"Banned") -> int:
        n = 0
        for conn in list(self.all_conns):
            if pred(conn):
                n += 1
                if conn.user_id and self._voice_conn.get(conn.user_id) is conn:
                    await self.voice_leave(conn.user_id)
                await self.deauthenticate(conn)
                await conn.ws.close(code=BANNED_CLOSE, message=message)
        return n

    # --- voice (placeholder) -------------------------------------------------

    def voice_states(self, guild_id: str) -> list[dict]:
        return [v for v in self.voice.values() if v["guild_id"] == guild_id]

    async def _voice_event(self, guild_id: str, state: dict) -> None:
        await self.send_to_guild(guild_id, P.frame(P.VOICE_STATE_UPDATED, state))

    async def voice_join(self, conn: Connection, channel: dict) -> dict:
        user_id = conn.user_id
        old = self.voice.get(user_id)
        if old and old["channel_id"] != channel["channel_id"]:
            await self.voice_leave(user_id)
            old = None
        state = {
            "guild_id": channel["guild_id"], "channel_id": channel["channel_id"], "user_id": user_id,
            "self_mute": old["self_mute"] if old else False, "self_deaf": old["self_deaf"] if old else False,
        }
        self.voice[user_id] = state
        self._voice_conn[user_id] = conn
        await self._voice_event(channel["guild_id"], state)
        return state

    async def voice_leave(self, user_id: str) -> None:
        state = self.voice.pop(user_id, None)
        self._voice_conn.pop(user_id, None)
        if state:
            await self._voice_event(state["guild_id"], {**state, "channel_id": None})

    async def voice_set(self, user_id: str, **flags: bool) -> dict | None:
        state = self.voice.get(user_id)
        if state is None:
            return None
        state.update(flags)
        await self._voice_event(state["guild_id"], state)
        return state

    async def voice_drop_where(self, pred: Callable[[dict], bool]) -> None:
        for uid, state in list(self.voice.items()):
            if pred(state):
                await self.voice_leave(uid)

    async def close_user(self, user_id: str, *, keep: Connection | None = None, only_revoked: bool = False) -> None:
        """Close a user's connections (all, or those whose session no longer exists)."""
        for conn in list(self.conns_by_user.get(user_id, ())):
            if conn is keep:
                continue
            if only_revoked and conn.session_token and self.db.session_exists(conn.session_token):
                continue
            await self.deauthenticate(conn)
            await conn.ws.close(code=SESSION_REVOKED_CLOSE, message=b"Session ended")

    def update_user(self, user: dict) -> None:
        """Refresh the cached user dict on every connection of that user."""
        for conn in self.conns_by_user.get(user["user_id"], ()):
            conn.user = user

    # --- presence ------------------------------------------------------------

    def is_online(self, user_id: str) -> bool:
        return bool(self.conns_by_user.get(user_id))

    def status_of(self, user_id: str) -> str:
        """Status as others see it: online | idle | dnd | offline."""
        conns = self.conns_by_user.get(user_id)
        if not conns:
            return "offline"
        pref = next(iter(conns)).user.get("presence", "online")
        if pref == "invisible":
            return "offline"
        if pref == "dnd":
            return "dnd"
        if pref == "idle" or all(c.afk for c in conns):
            return "idle"
        return "online"

    def presences(self, user_ids: Iterable[str]) -> dict[str, str]:
        out = {}
        for uid in user_ids:
            status = self.status_of(uid)
            if status != "offline":
                out[uid] = status
        return out

    async def refresh_presence(self, user_id: str) -> None:
        status = self.status_of(user_id)
        if self._shown_status.get(user_id, "offline") == status:
            return
        if status == "offline":
            self._shown_status.pop(user_id, None)
        else:
            self._shown_status[user_id] = status
        # Ghost memberships never produce presence (audience_of only counts
        # guilds where the user is a visible member).
        await self.send_to_users(
            self.db.audience_of(user_id), P.frame(P.PRESENCE_UPDATE, {"user_id": user_id, "status": status})
        )

    # --- focus ---------------------------------------------------------------

    def focus(self, conn: Connection, channel_id: str | None) -> None:
        conn.channel_id = channel_id

    def unfocus_channel(self, channel_id: str) -> None:
        for conn in self.all_conns:
            if conn.channel_id == channel_id:
                conn.channel_id = None

    # --- fan-out -------------------------------------------------------------

    async def send_to_user(self, user_id: str, frame: dict[str, Any], *, exclude: Connection | None = None) -> None:
        for conn in list(self.conns_by_user.get(user_id, ())):
            if conn is not exclude:
                await conn.send(frame)

    async def send_to_everyone(self, frame: dict) -> None:
        for conn in list(self.all_conns):
            if conn.user is not None:
                await conn.send(frame)

    async def send_to_staff(self, frame: dict, min_level: int = 1) -> None:
        await self.send_to_users(self.db.staff_ids(min_level), frame)

    async def send_to_users(self, user_ids: Iterable[str], frame: dict) -> None:
        for uid in set(user_ids):
            await self.send_to_user(uid, frame)

    async def send_to_guild(
        self, guild_id: str, frame: FrameOrFactory, *, exclude_user: str | None = None
    ) -> None:
        """Send to every online member (ghosts included as recipients).
        `frame` may be a function of user_id returning a per-user frame or None."""
        for uid in self.db.all_member_ids(guild_id):
            if uid == exclude_user or not self.is_online(uid):
                continue
            f = frame(uid) if callable(frame) else frame
            if f is not None:
                await self.send_to_user(uid, f)

    def viewer_ids(self, channel: dict) -> list[str]:
        """Online users who can see channel (guild channel or DM)."""
        if channel["guild_id"] is None:
            ids = self.db.dm_recipient_ids(channel["channel_id"])
        else:
            ids = self.db.all_member_ids(channel["guild_id"])
        return [u for u in ids if self.is_online(u) and self.perms.can_view(channel, u)]

    async def send_to_channel_viewers(
        self, channel: dict, frame: FrameOrFactory, *, exclude_user: str | None = None
    ) -> None:
        for uid in self.viewer_ids(channel):
            if uid == exclude_user:
                continue
            f = frame(uid) if callable(frame) else frame
            if f is not None:
                await self.send_to_user(uid, f)

    async def send_to_focused(self, channel: dict, frame: dict, *, exclude_user: str | None = None) -> None:
        for uid in self.viewer_ids(channel):
            if uid == exclude_user:
                continue
            for conn in list(self.conns_by_user.get(uid, ())):
                if conn.channel_id == channel["channel_id"]:
                    await conn.send(frame)

    async def close_all(self) -> None:
        for conn in list(self.all_conns):
            await conn.ws.close(code=WSCloseCode.GOING_AWAY, message=b"Server shutting down")

