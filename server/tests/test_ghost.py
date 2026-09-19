"""Server-owner override joins (PROTOCOL.md §7)."""


async def _setup(connect):
    a = await connect()
    a.user = (await a.register("alice"))["user"]
    res = await a.ok("guild.create", {"name": "Private"})
    return a, res["guild"]["guild_id"], res["channels"][0]["channel_id"]


async def test_override_join_is_invisible(connect, owner):
    a, gid, cid = await _setup(connect)
    await a.drain()
    assert await a.err("guild.owner_override_join", {"guild_id": gid}) == "forbidden"

    res = await owner.ok("guild.owner_override_join", {"guild_id": gid})
    assert res["guild"]["ghost"] is True
    assert await owner.err("guild.owner_override_join", {"guild_id": gid}) == "already_member"
    assert await a.drain() == []  # no member_joined / presence

    owner_id = (await owner.ok("guild.list"))["guilds"][0]
    assert owner_id["ghost"] is True
    members = (await a.ok("guild.members", {"guild_id": gid}))["members"]
    assert [m["user"]["username"] for m in members] == ["alice"]
    assert (await owner.ok("guild.members", {"guild_id": gid}))["members"] == members
    online = (await a.ok("presence.list", {"guild_id": gid}))["presences"]
    assert online == {a.user["user_id"]: "online"}


async def test_ghost_presence_never_broadcast(connect, owner):
    a, gid, cid = await _setup(connect)
    await owner.ok("guild.owner_override_join", {"guild_id": gid})
    await a.drain()
    await owner.ws.close()
    assert await a.drain(0.3) == []


async def test_ghost_is_read_only(connect, owner, ctx):
    a, gid, cid = await _setup(connect)
    await owner.ok("guild.owner_override_join", {"guild_id": gid})
    await a.ok("message.send", {"channel_id": cid, "content": "secret"})

    # Can read and subscribe.
    hist = (await owner.ok("channel.history", {"channel_id": cid}))["messages"]
    assert [m["content"] for m in hist] == ["secret"]
    await owner.drain()
    await a.ok("message.send", {"channel_id": cid, "content": "live"})
    assert [e["payload"]["content"] for e in await owner.drain() if e["type"] == "message.new"] == ["live"]

    # Can't write anything.
    assert await owner.err("message.send", {"channel_id": cid, "content": "hi"}) == "forbidden"
    assert await owner.err("channel.create", {"guild_id": gid, "name": "x"}) == "forbidden"
    assert await owner.err("channel.update", {"channel_id": cid, "name": "x"}) == "forbidden"
    assert await owner.err("channel.delete", {"channel_id": cid}) == "forbidden"
    assert await owner.err("guild.config.update", {"guild_id": gid, "name": "x"}) == "forbidden"
    assert await owner.err("guild.invite.create", {"guild_id": gid}) == "forbidden"

    # Leaving is silent.
    await a.drain()
    await owner.ok("guild.leave", {"guild_id": gid})
    assert await a.drain() == []


async def test_ghost_upgrades_via_invite(connect, owner):
    a, gid, cid = await _setup(connect)
    await owner.ok("guild.owner_override_join", {"guild_id": gid})
    code = (await a.ok("guild.invite.create", {"guild_id": gid}))["invite_code"]
    await a.drain()
    res = await owner.ok("guild.join_by_code", {"invite_code": code})
    assert res["guild"]["ghost"] is False
    assert [e["type"] for e in await a.drain()] == ["guild.member_joined", "presence.update"]
    await owner.ok("message.send", {"channel_id": cid, "content": "hello, I'm the admin"})
