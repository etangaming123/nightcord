"""First-run setup and the admin API (PROTOCOL.md §8, §8a, §5 Admin)."""

import pytest

from nightcord.app import CTX_KEY, create_app
from nightcord.config import Config
from nightcord.db import Database
from conftest import WsClient


@pytest.fixture
async def fresh(aiohttp_client, tmp_path):
    app = create_app(Config(tls=False, server_name="Fresh", data_dir=tmp_path), Database(":memory:"), setup_code="ABCD-EFGH-JKLM")
    client = await aiohttp_client(app)

    async def connect():
        return WsClient(await client.ws_connect("/ws"))

    return connect


async def test_setup_claim(fresh):
    c = await fresh()
    info = await c.ok("server.info")
    assert info["setup_required"] is True and info["server_name"] == "Fresh"
    assert await c.err("auth.register", {"username": "alice", "password": "password123"}) == "setup_required"
    assert await c.err("auth.login", {"username": "alice", "password": "password123"}) == "setup_required"
    claim = {"username": "boss", "password": "password123", "server_name": "Nightclub", "account_creation": "request"}
    assert await c.err("setup.claim", {**claim, "setup_code": "WRONG"}) == "invalid_setup_code"
    assert await c.err("setup.claim", {**claim, "setup_code": "abcdefghjklm", "account_creation": "sometimes"}) == "bad_request"
    ok = await c.ok("setup.claim", {**claim, "setup_code": "abcd efgh jklm"})
    assert ok["user"]["username"] == "boss" and ok["user"]["is_server_owner"] is True
    info = await c.ok("server.info")
    assert info["setup_required"] is False and info["server_name"] == "Nightclub"
    assert info["account_creation"] == "request"
    c2 = await fresh()
    assert await c2.err("setup.claim", {**claim, "username": "boss2", "setup_code": "ABCD-EFGH-JKLM"}) == "setup_already_done"


async def test_admin_users(connect, owner, user, ctx):
    await owner.ok("server.config.update", {"account_creation": "request"})
    await owner.drain()
    c = await connect()
    await c.ok("auth.request_account", {"username": "newbie", "password": "password123", "note": "pls"})
    ev = await owner.drain()
    assert ev[0]["type"] == "admin.account_requested" and ev[0]["payload"]["user"]["note"] == "pls"
    pending = (await owner.ok("admin.users.list", {"status": "pending"}))["users"]
    assert [u["username"] for u in pending] == ["newbie"]
    uid = pending[0]["user_id"]
    assert await owner.err("admin.users.set_status", {"user_id": uid, "status": "disabled"}) == "bad_request"
    await owner.ok("admin.users.set_status", {"user_id": uid, "status": "active"})
    newbie = await connect()
    await newbie.login("newbie", "password123")

    # Disable closes their connections and blocks login.
    await owner.ok("admin.users.set_status", {"user_id": uid, "status": "disabled"})
    assert (await newbie.ws.receive()).data == 4001
    c3 = await connect()
    assert await c3.err("auth.login", {"username": "newbie", "password": "password123"}) == "account_disabled"
    await owner.ok("admin.users.set_status", {"user_id": uid, "status": "active"})

    pw = (await owner.ok("admin.users.reset_password", {"user_id": uid}))["password"]
    await c3.login("newbie", pw)

    owner_id = ctx.db.get_server_owner_row()["user_id"]
    assert await owner.err("admin.users.set_status", {"user_id": owner_id, "status": "disabled"}) == "bad_request"  # yourself
    assert await c3.err("admin.users.list") == "forbidden"
    found = (await owner.ok("admin.users.list", {"query": "NEW"}))["users"]
    assert [u["username"] for u in found] == ["newbie"]


async def test_admin_guilds(guild, owner):
    gid, cid, (a, b) = await guild("alice", "bob")
    guilds = (await owner.ok("admin.guilds.list"))["guilds"]
    assert guilds[0]["guild_id"] == gid and guilds[0]["member_count"] == 2
    assert guilds[0]["owner"]["username"] == "alice"
    assert await a.err("admin.guilds.delete", {"guild_id": gid}) == "forbidden"
    await owner.ok("admin.guilds.delete", {"guild_id": gid})
    assert await b.drain() == [{"type": "guild.removed", "payload": {"guild_id": gid, "reason": "deleted"}}]
    assert (await owner.ok("admin.guilds.list"))["guilds"] == []
