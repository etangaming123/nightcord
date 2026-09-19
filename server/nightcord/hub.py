"""Live connection registry: who is online, who is subscribed to which channel.

Also owns presence broadcasting, which is where the ghost exclusions from
PROTOCOL.md §7 are enforced for live events.
"""

from __future__ import annotations

import collections
import logging
import time
from typing import TYPE_CHECKING, Any, Iterable

from . import protocol as P

if TYPE_CHECKING:
    from aiohttp import web

    from .db import Database

log = logging.getLogger("nightcord.hub")

MESSAGE_RATE = 5
MESSAGE_RATE_WINDOW = 5.0


class Connection:
    def __init__(self, ws: "web.WebSocketResponse", remote: str | None):
        self.ws = ws
        self.remote = remote or "unknown"
        self.user: dict | None = None
        self.session_token: str | None = None
        self.channel_id: str | None = None
        self._sent_times: collections.deque[float] = collections.deque()

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


class Hub:
    def __init__(self, db: "Database"):
        self.db = db
        self.conns_by_user: dict[str, set[Connection]] = collections.defaultdict(set)
        self.subs: dict[str, set[Connection]] = collections.defaultdict(set)
        self.all_conns: set[Connection] = set()

    # --- connection lifecycle -----------------------------------------------

    def add(self, conn: Connection) -> None:
        self.all_conns.add(conn)

    async def authenticated(self, conn: Connection, user: dict) -> None:
        """Mark conn as logged in as user. Broadcasts presence if first conn."""
        if conn.user is not None:
            await self.deauthenticate(conn)
        conn.user = user
        conns = self.conns_by_user[user["user_id"]]
        first = not conns
        conns.add(conn)
        if first:
            await self._broadcast_presence(user["user_id"], "online")

    async def deauthenticate(self, conn: Connection) -> None:
        self.unsubscribe(conn)
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
            await self._broadcast_presence(user_id, "offline")

    async def remove(self, conn: Connection) -> None:
        self.all_conns.discard(conn)
        await self.deauthenticate(conn)

    # --- presence ------------------------------------------------------------

    def is_online(self, user_id: str) -> bool:
        return bool(self.conns_by_user.get(user_id))

    def online_member_ids(self, guild_id: str) -> list[str]:
        """Online users with a non-ghost membership."""
        return [u for u in self.db.non_ghost_member_ids(guild_id) if self.is_online(u)]

    async def _broadcast_presence(self, user_id: str, status: str) -> None:
        # Only non-ghost memberships produce presence (ghosts are never broadcast).
        for guild_id in self.db.non_ghost_guild_ids(user_id):
            await self.send_to_guild(
                guild_id,
                P.frame(P.PRESENCE_UPDATE, {"guild_id": guild_id, "user_id": user_id, "status": status}),
                exclude_user=user_id,
            )

    # --- subscriptions -------------------------------------------------------

    def subscribe(self, conn: Connection, channel_id: str) -> None:
        self.unsubscribe(conn)
        conn.channel_id = channel_id
        self.subs[channel_id].add(conn)

    def unsubscribe(self, conn: Connection) -> None:
        if conn.channel_id is None:
            return
        subs = self.subs.get(conn.channel_id)
        if subs is not None:
            subs.discard(conn)
            if not subs:
                del self.subs[conn.channel_id]
        conn.channel_id = None

    def drop_channel(self, channel_id: str) -> None:
        for conn in list(self.subs.get(channel_id, ())):
            self.unsubscribe(conn)

    def unsubscribe_user_from(self, user_id: str, channel_ids: Iterable[str]) -> None:
        ids = set(channel_ids)
        for conn in list(self.conns_by_user.get(user_id, ())):
            if conn.channel_id in ids:
                self.unsubscribe(conn)

    # --- fan-out -------------------------------------------------------------

    async def send_to_channel(self, channel_id: str, frame: dict) -> None:
        for conn in list(self.subs.get(channel_id, ())):
            await conn.send(frame)

    async def send_to_guild(
        self, guild_id: str, frame: dict, *, exclude_user: str | None = None
    ) -> None:
        """Send to every online connection of every member (ghosts included as recipients)."""
        for uid in self.db.all_member_ids(guild_id):
            if uid == exclude_user:
                continue
            for conn in list(self.conns_by_user.get(uid, ())):
                await conn.send(frame)

    async def send_to_user(self, user_id: str, frame: dict[str, Any]) -> None:
        for conn in list(self.conns_by_user.get(user_id, ())):
            await conn.send(frame)
