async def _user(connect, name):
    c = await connect()
    c.user = (await c.register(name))["user"]
    return c


def _types(events):
    return [e["type"] for e in events]


async def test_create_guild_has_general(connect):
    a = await _user(connect, "alice")
    res = await a.ok("guild.create", {"name": "  My Guild  "})
    assert res["guild"]["name"] == "My Guild"
    assert res["guild"]["owner_user_id"] == a.user["user_id"]
    assert res["guild"]["listed"] is False
    assert [c["name"] for c in res["channels"]] == ["general"]
    guilds = (await a.ok("guild.list"))["guilds"]
    assert [g["guild_id"] for g in guilds] == [res["guild"]["guild_id"]]
    assert guilds[0]["ghost"] is False
    assert await a.err("guild.create", {"name": "   "}) == "bad_request"


async def test_guild_creation_policy(connect, owner):
    await owner.ok("server.config.update", {"guild_creation": "off"})
    a = await _user(connect, "alice")
    assert await a.err("guild.create", {"name": "G"}) == "guild_creation_disabled"
    await owner.ok("guild.create", {"name": "Owner's guild"})  # server owner bypasses


async def test_join_by_invite_code(connect):
    a = await _user(connect, "alice")
    b = await _user(connect, "bob")
    gid = (await a.ok("guild.create", {"name": "G"}))["guild"]["guild_id"]
    assert await b.err("guild.invite.create", {"guild_id": gid}) == "not_found"
    code = (await a.ok("guild.invite.create", {"guild_id": gid}))["invite_code"]
    assert await b.err("guild.join_by_code", {"invite_code": "NOPE1234"}) == "invite_invalid"
    await a.drain()
    joined = await b.ok("guild.join_by_code", {"invite_code": code.lower()})
    assert joined["guild"]["guild_id"] == gid
    assert await b.err("guild.join_by_code", {"invite_code": code}) == "already_member"
    events = await a.drain()
    assert _types(events) == ["guild.member_joined", "presence.update"]
    member = events[0]["payload"]["member"]
    assert member["user"]["username"] == "bob" and member["role_ids"] == [] and member["is_owner"] is False
    assert events[1]["payload"] == {"user_id": b.user["user_id"], "status": "online"}
    # Members may invite by default (@everyone has CREATE_INVITE).
    await b.ok("guild.invite.create", {"guild_id": gid})


async def test_public_list_and_join_by_id(connect, owner):
    a = await _user(connect, "alice")
    b = await _user(connect, "bob")
    gid = (await a.ok("guild.create", {"name": "G"}))["guild"]["guild_id"]
    assert (await b.ok("guild.public_list"))["guilds"] == []
    assert await b.err("guild.join_by_id", {"guild_id": gid}) == "not_found"

    await a.ok("guild.config.update", {"guild_id": gid, "listed": True})
    assert [g["guild_id"] for g in (await b.ok("guild.public_list"))["guilds"]] == [gid]

    # Server-wide switch hides everything even if the guild is listed.
    await owner.ok("server.config.update", {"guild_list_visible": False})
    assert (await b.ok("guild.public_list"))["guilds"] == []
    assert await b.err("guild.join_by_id", {"guild_id": gid}) == "not_found"

    await owner.ok("server.config.update", {"guild_list_visible": True})
    await b.ok("guild.join_by_id", {"guild_id": gid})


async def test_guild_config_update(connect):
    a = await _user(connect, "alice")
    b = await _user(connect, "bob")
    gid = (await a.ok("guild.create", {"name": "G"}))["guild"]["guild_id"]
    code = (await a.ok("guild.invite.create", {"guild_id": gid}))["invite_code"]
    await b.ok("guild.join_by_code", {"invite_code": code})
    assert await b.err("guild.config.update", {"guild_id": gid, "name": "Mine"}) == "forbidden"
    await b.drain()
    res = await a.ok("guild.config.update", {"guild_id": gid, "name": "Renamed"})
    assert res["guild"]["name"] == "Renamed"
    events = await b.drain()
    assert _types(events) == ["guild.updated"]
    assert events[0]["payload"]["name"] == "Renamed"
    assert await a.err("guild.config.update", {"guild_id": gid, "listed": "yes"}) == "bad_request"


async def test_members_and_leave(connect):
    a = await _user(connect, "alice")
    b = await _user(connect, "bob")
    gid = (await a.ok("guild.create", {"name": "G"}))["guild"]["guild_id"]
    code = (await a.ok("guild.invite.create", {"guild_id": gid}))["invite_code"]
    await b.ok("guild.join_by_code", {"invite_code": code})
    members = (await b.ok("guild.members", {"guild_id": gid}))["members"]
    assert [(m["user"]["username"], m["is_owner"]) for m in members] == [("alice", True), ("bob", False)]

    assert await a.err("guild.leave", {"guild_id": gid}) == "forbidden"
    await a.drain()
    await b.ok("guild.leave", {"guild_id": gid})
    assert _types(await a.drain()) == ["guild.member_left"]
    assert await b.err("guild.members", {"guild_id": gid}) == "not_found"
    assert (await b.ok("guild.list"))["guilds"] == []


async def test_presence(connect, server):
    a = await _user(connect, "alice")
    b = await _user(connect, "bob")
    gid = (await a.ok("guild.create", {"name": "G"}))["guild"]["guild_id"]
    code = (await a.ok("guild.invite.create", {"guild_id": gid}))["invite_code"]
    await b.ok("guild.join_by_code", {"invite_code": code})
    online = (await a.ok("presence.list", {"guild_id": gid}))["presences"]
    assert online == {a.user["user_id"]: "online", b.user["user_id"]: "online"}

    await a.drain()
    await b.ws.close()
    events = await a.drain(0.3)
    assert {"type": "presence.update", "payload": {"user_id": b.user["user_id"], "status": "offline"}} in events
    assert (await a.ok("presence.list", {"guild_id": gid}))["presences"] == {a.user["user_id"]: "online"}

    # A second connection for the same user doesn't re-announce; the first one does.
    b2 = await connect()
    await b2.login("bob", "password123")
    events = await a.drain()
    assert [e["payload"]["status"] for e in events if e["type"] == "presence.update"] == ["online"]
    b3 = await connect()
    await b3.login("bob", "password123")
    assert await a.drain() == []
    await b3.ws.close()
    assert await a.drain(0.3) == []  # b2 still online
