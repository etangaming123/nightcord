"""Server staff: admin/moderator tiers, global mute, account deletion, IP and device bans."""

from conftest import OWNER_PASSWORD, types


async def _staff(owner, target, role):
    return await owner.ok("admin.staff.set", {"user_id": target.uid, "role": role})


async def test_staff_tiers(owner, user):
    a, m, u = await user("adam"), await user("mona"), await user("ursula")
    assert await a.err("admin.users.list") == "forbidden"
    await _staff(owner, a, "admin")
    ev = await a.drain()
    assert any(e["type"] == "user.updated" and e["payload"]["server_role"] == "admin" for e in ev)
    # An admin appoints moderators but not admins, and can't touch other admins.
    assert await a.err("admin.staff.set", {"user_id": m.uid, "role": "admin"}) == "forbidden"
    await a.ok("admin.staff.set", {"user_id": m.uid, "role": "moderator"})
    assert await m.err("admin.staff.set", {"user_id": u.uid, "role": "moderator"}) == "forbidden"
    users = {x["username"]: x for x in (await m.ok("admin.users.list"))["users"]}
    assert users["mona"]["server_role"] == "moderator" and users["ursula"]["last_ip"]
    # Moderators can't delete accounts or act on equal/higher staff.
    assert await m.err("admin.users.delete", {"user_id": u.uid}) == "forbidden"
    assert await m.err("admin.users.mute", {"user_id": a.uid, "duration_seconds": 60}) == "forbidden"
    assert await a.err("admin.users.mute", {"user_id": a.uid, "duration_seconds": 60}) == "bad_request"
    owner_id = (await owner.ok("admin.users.list", {"query": "owner"}))["users"][0]["user_id"]
    assert await a.err("admin.users.set_status", {"user_id": owner_id, "status": "disabled"}) == "forbidden"
    # Owner-only config; admins can list guilds.
    assert await a.err("server.config.update", {"voice_enabled": True}) == "forbidden"
    await a.ok("admin.guilds.list")
    assert await m.err("admin.guilds.list") == "forbidden"
    actions = [e["action"] for e in (await m.ok("admin.audit_log"))["entries"]]
    assert actions == ["staff.set", "staff.set"]


async def test_account_requests_reach_moderators(owner, user, connect):
    m = await user("mona")
    await _staff(owner, m, "moderator")
    await owner.ok("server.config.update", {"account_creation": "request"})
    await m.drain()
    c = await connect()
    await c.ok("auth.request_account", {"username": "newbie", "password": "password123"})
    assert "admin.account_requested" in types(await m.drain())


async def test_global_mute(owner, guild):
    gid, cid, (a, b) = await guild("alice", "bob")
    mid = (await a.ok("message.send", {"channel_id": cid, "content": "hi"}))["message_id"]
    dm = (await b.ok("dm.open", {"user_id": a.uid}))["channel"]["channel_id"]
    await owner.ok("admin.users.mute", {"user_id": b.uid, "duration_seconds": 600, "reason": "spam"})
    ev = await b.drain()
    assert any(e["type"] == "user.updated" and e["payload"].get("muted_until") for e in ev)
    assert await b.err("message.send", {"channel_id": cid, "content": "x"}) == "muted"
    assert await b.err("message.send", {"channel_id": dm, "content": "x"}) == "muted"
    assert await b.err("reaction.add", {"message_id": mid, "emoji": "👍"}) == "muted"
    assert await b.err("typing.start", {"channel_id": cid}) == "muted"
    await b.ok("channel.history", {"channel_id": cid})
    await owner.ok("admin.users.mute", {"user_id": b.uid, "permanent": True})
    assert await b.err("message.send", {"channel_id": cid, "content": "x"}) == "muted"
    await owner.ok("admin.users.mute", {"user_id": b.uid})
    await b.ok("message.send", {"channel_id": cid, "content": "back"})


async def test_delete_account(owner, guild, connect):
    gid, cid, (a, b, c) = await guild("alice", "bob", "carol")
    await b.ok("message.send", {"channel_id": cid, "content": "remember me"})
    await owner.ok("admin.users.delete", {"user_id": a.uid})  # alice owns the guild
    # Ownership passes on; alice's message stays but she's a Deleted User.
    g = (await b.ok("guild.list"))["guilds"][0]
    assert g["owner_user_id"] in (b.uid, c.uid)
    msgs = (await b.ok("channel.history", {"channel_id": cid}))["messages"]
    assert msgs[-1]["content"] == "remember me"
    members = [m["user"]["user_id"] for m in (await b.ok("guild.members", {"guild_id": gid}))["members"]]
    assert a.uid not in members
    prof = (await b.ok("user.profile", {"user_id": a.uid}))["user"]
    assert prof["deleted"] and prof["username"] != "alice"
    # The username is free again, and the old password no longer works.
    x = await connect()
    assert await x.err("auth.login", {"username": "alice", "password": "password123"}) == "invalid_credentials"
    await x.register("alice")


async def test_self_delete(user, connect):
    a = await user("alice")
    assert await a.err("user.delete", {"password": "wrong-password"}) == "invalid_current_password"
    await a.ok("user.delete", {"password": "password123"})
    x = await connect()
    assert await x.err("auth.login", {"username": "alice", "password": "password123"}) == "invalid_credentials"


async def test_owner_cant_self_delete(owner):
    assert await owner.err("user.delete", {"password": OWNER_PASSWORD}) == "forbidden"


async def test_ip_ban_with_trusted_proxy(server, ctx, owner, connect):
    ctx.config.trust_proxy = True
    evil = await server.ws_connect("/ws", headers={"X-Forwarded-For": "203.0.113.9"})
    await owner.ok("admin.ip_bans.add", {"cidr": "203.0.113.0/24", "reason": "raid"})
    msg = await evil.receive()
    assert msg.data == 4003  # closed as banned
    again = await server.ws_connect("/ws", headers={"X-Forwarded-For": "203.0.113.50"})
    first = await again.receive_json()
    assert first["payload"]["code"] == "ip_banned"
    # Other addresses are fine; unbanning lets them back in.
    ok = await server.ws_connect("/ws", headers={"X-Forwarded-For": "198.51.100.1"})
    await ok.send_json({"type": "server.info", "payload": {}, "id": 1})
    assert (await ok.receive_json())["type"] == "server.info.result"
    assert await owner.err("admin.ip_bans.add", {"cidr": "not-an-ip"}) == "bad_request"
    bans = (await owner.ok("admin.ip_bans.remove", {"cidr": "203.0.113.0/24"}))["bans"]
    assert bans == []


async def test_device_ban(owner, connect):
    dev = "device-abcdefghijklmnop"
    c = await connect()
    res = await c.ok("auth.register", {"username": "bob", "password": "password123", "device_id": dev})
    await owner.ok("admin.device_bans.add", {"user_id": res["user"]["user_id"]})
    assert (await c.ws.receive()).data == 4003
    c2 = await connect()
    assert await c2.err("auth.login", {"username": "bob", "password": "password123", "device_id": dev}) == "device_banned"
    # A different device still works (device bans are a speed bump, not identity).
    await c2.ok("auth.login", {"username": "bob", "password": "password123", "device_id": "other-device-0000000"})
    bans = (await owner.ok("admin.device_bans.list"))["bans"]
    assert bans[0]["device_id"] == dev and bans[0]["user"]["username"] == "bob"
    await owner.ok("admin.device_bans.remove", {"device_id": dev})
    c3 = await connect()
    await c3.ok("auth.login", {"username": "bob", "password": "password123", "device_id": dev})
