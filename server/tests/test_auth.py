import time

from nightcord.db import SESSION_TTL_SECONDS


async def test_bad_frames(connect):
    c = await connect()
    await c.ws.send_str("not json")
    assert (await c.ws.receive_json())["payload"]["code"] == "bad_request"
    await c.ws.send_json({"type": "x.y", "payload": {}, "id": "a"})
    msg = await c.ws.receive_json()
    assert msg == {"type": "error", "id": "a", "payload": {"code": "unknown_type", "message": msg["payload"]["message"]}}
    await c.ws.send_json({"type": "server.info"})  # payload missing -> defaults to {}
    assert (await c.ws.receive_json())["type"] == "server.info.result"


async def test_pre_auth_allowlist(connect):
    c = await connect()
    info = await c.ok("server.info")
    assert info["server_name"] == "Test"
    assert info["account_creation"] == "on"
    assert await c.err("guild.list") == "not_authenticated"


async def test_register_login_resume_logout(connect):
    c = await connect()
    ok = await c.register("alice")
    assert ok["user"]["username"] == "alice"
    assert ok["user"]["is_server_owner"] is False
    token = ok["session_token"]
    assert await c.err("auth.register", {"username": "ALICE", "password": "password123"}) == "username_taken"

    c2 = await connect()
    resumed = await c2.ok("auth.resume", {"session_token": token})
    assert resumed["user"]["user_id"] == ok["user"]["user_id"]
    await c2.ok("guild.list")

    await c2.ok("auth.logout")
    assert await c2.err("guild.list") == "not_authenticated"
    c3 = await connect()
    msg = await c3.request("auth.resume", {"session_token": token})
    assert msg["type"] == "auth.error" and msg["payload"]["code"] == "session_expired"

    await c3.login("alice", "password123")


async def test_login_errors_and_validation(connect):
    c = await connect()
    assert await c.err("auth.login", {"username": "nobody", "password": "password123"}) == "invalid_credentials"
    await c.register("bob")
    c2 = await connect()
    assert await c2.err("auth.login", {"username": "bob", "password": "wrongpass1"}) == "invalid_credentials"
    assert await c2.err("auth.register", {"username": "x", "password": "password123"}) == "invalid_username"
    assert await c2.err("auth.register", {"username": "bad name", "password": "password123"}) == "invalid_username"
    assert await c2.err("auth.register", {"username": "carol", "password": "short"}) == "invalid_password"
    assert await c2.err("auth.register", {"username": "owner", "password": "password123"}) == "username_taken"


async def test_session_expiry(connect, ctx):
    c = await connect()
    token = (await c.register("dave"))["session_token"]
    ctx.db.conn.execute("UPDATE sessions SET expires_at = ?", (time.time() - 1,))
    c2 = await connect()
    assert await c2.err("auth.resume", {"session_token": token}) == "session_expired"


async def test_resume_extends_session(connect, ctx):
    c = await connect()
    token = (await c.register("erin"))["session_token"]
    ctx.db.conn.execute("UPDATE sessions SET expires_at = ?", (time.time() + 10,))
    await (await connect()).ok("auth.resume", {"session_token": token})
    exp = ctx.db.conn.execute("SELECT expires_at FROM sessions").fetchone()[0]
    assert exp > time.time() + SESSION_TTL_SECONDS - 60


async def test_account_policy_off(connect, owner):
    await owner.ok("server.config.update", {"account_creation": "off"})
    c = await connect()
    assert await c.err("auth.register", {"username": "frank", "password": "password123"}) == "registration_closed"
    assert await c.err("auth.request_account", {"username": "frank", "password": "password123"}) == "registration_closed"


async def test_account_policy_on_rejects_request(connect):
    c = await connect()
    assert await c.err("auth.request_account", {"username": "gina", "password": "password123"}) == "bad_request"


async def test_account_policy_request(connect, owner, ctx):
    await owner.ok("server.config.update", {"account_creation": "request"})
    c = await connect()
    assert await c.err("auth.register", {"username": "hank", "password": "password123"}) == "registration_closed"
    assert await c.ok("auth.request_account", {"username": "hank", "password": "password123", "note": "hi"}) == {"status": "pending"}
    assert await c.err("auth.login", {"username": "hank", "password": "password123"}) == "registration_pending_approval"

    ctx.db.set_user_status("hank", "active")
    await c.login("hank", "password123")

    await c.ok("auth.request_account", {"username": "ivy", "password": "password123"})
    ctx.db.set_user_status("ivy", "rejected")
    assert await c.err("auth.login", {"username": "ivy", "password": "password123"}) == "invalid_credentials"


async def test_server_config_owner_only(connect, owner):
    c = await connect()
    await c.register("jack")
    assert await c.err("server.config.update", {"guild_creation": "off"}) == "forbidden"
    assert await owner.err("server.config.update", {"guild_creation": "maybe"}) == "bad_request"
    assert await owner.err("server.config.update", {"server_name": "x"}) == "bad_request"
    res = await owner.ok("server.config.update", {"guild_list_visible": False})
    assert res["config"]["guild_list_visible"] is False


async def test_login_throttle(connect):
    c = await connect()
    for _ in range(10):
        await c.err("auth.login", {"username": "nobody", "password": "password123"})
    assert await c.err("auth.login", {"username": "nobody", "password": "password123"}) == "rate_limited"
