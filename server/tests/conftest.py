from __future__ import annotations

import asyncio
import itertools

import bcrypt
import pytest

from nightcord.app import CTX_KEY, create_app
from nightcord.config import Config
from nightcord.db import Database
from nightcord.handlers.auth import hash_password_sync

OWNER_PASSWORD = "owner-password"


class WsClient:
    """Test client: request/response by id, with unsolicited events buffered."""

    _ids = itertools.count(1)

    def __init__(self, ws):
        self.ws = ws
        self.events: list[dict] = []

    async def request(self, type_: str, payload: dict | None = None) -> dict:
        id_ = next(self._ids)
        await self.ws.send_json({"type": type_, "payload": payload or {}, "id": id_})
        while True:
            msg = await asyncio.wait_for(self.ws.receive_json(), timeout=5)
            if msg.get("id") == id_:
                return msg
            self.events.append(msg)

    async def ok(self, type_: str, payload: dict | None = None) -> dict:
        msg = await self.request(type_, payload)
        assert not msg["type"].endswith("error"), msg
        return msg["payload"]

    async def err(self, type_: str, payload: dict | None = None) -> str:
        msg = await self.request(type_, payload)
        assert msg["type"].endswith("error"), msg
        return msg["payload"]["code"]

    async def drain(self, timeout: float = 0.1) -> list[dict]:
        """Collect pending events, return and clear the buffer."""
        try:
            while True:
                self.events.append(await asyncio.wait_for(self.ws.receive_json(), timeout=timeout))
        except asyncio.TimeoutError:
            pass
        out, self.events = self.events, []
        return out

    async def register(self, username: str, password: str = "password123") -> dict:
        return await self.ok("auth.register", {"username": username, "password": password})

    async def login(self, username: str, password: str) -> dict:
        return await self.ok("auth.login", {"username": username, "password": password})


_gensalt = bcrypt.gensalt


@pytest.fixture(autouse=True)
def fast_bcrypt(monkeypatch):
    monkeypatch.setattr(bcrypt, "gensalt", lambda rounds=4, prefix=b"2b": _gensalt(4, prefix))


@pytest.fixture
def db():
    d = Database(":memory:")
    d.create_user("owner", hash_password_sync(OWNER_PASSWORD), is_server_owner=True)
    return d


@pytest.fixture
async def server(aiohttp_client, db):
    app = create_app(Config(tls=False, server_name="Test"), db)
    return await aiohttp_client(app)


@pytest.fixture
def ctx(server):
    return server.app[CTX_KEY]


@pytest.fixture
def connect(server):
    async def _connect() -> WsClient:
        return WsClient(await server.ws_connect("/ws"))

    return _connect


@pytest.fixture
async def owner(connect):
    c = await connect()
    await c.login("owner", OWNER_PASSWORD)
    return c
