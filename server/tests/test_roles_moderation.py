"""Roles, hierarchy, kick/ban/timeout, audit log (PROTOCOL.md §5 Roles, Members)."""

from conftest import types

MANAGE_ROLES, KICK, BAN, TIMEOUT, AUDIT = 128, 1024, 2048, 4096, 8192
MANAGE_CHANNELS = 64


async def test_role_crud_and_permissions(guild):
    gid, cid, (a, b) = await guild("alice", "bob")
    roles = (await b.ok("role.list", {"guild_id": gid}))["roles"]
    assert [r["name"] for r in roles] == ["@everyone"] and roles[0]["role_id"] == gid

    assert await b.err("role.create", {"guild_id": gid, "name": "x"}) == "forbidden"
    mod = (await a.ok("role.create", {"guild_id": gid, "name": "mod", "color": "#FF0000", "permissions": MANAGE_CHANNELS}))["role"]
    assert mod["color"] == "#ff0000" and mod["position"] == 1
    assert "role.created" in types(await b.drain())

    await a.ok("member.roles.set", {"guild_id": gid, "user_id": b.uid, "role_ids": [mod["role_id"]]})
    ev = await b.drain()
    assert "guild.member_updated" in types(ev) and "guild.permissions_changed" in types(ev)
    g = [g for g in (await b.ok("guild.list"))["guilds"] if g["guild_id"] == gid][0]
    assert g["my_permissions"] & MANAGE_CHANNELS
    await b.ok("channel.create", {"guild_id": gid, "name": "bobs"})

    await a.ok("role.update", {"role_id": mod["role_id"], "permissions": 0})
    assert await b.err("channel.create", {"guild_id": gid, "name": "nope"}) == "forbidden"

    await a.ok("role.delete", {"role_id": mod["role_id"]})
    assert (await b.ok("guild.members", {"guild_id": gid}))["members"][1]["role_ids"] == []
    assert await a.err("role.delete", {"role_id": gid}) == "bad_request"
    assert await a.err("role.update", {"role_id": gid, "name": "all"}) == "bad_request"


async def test_hierarchy(guild):
    gid, cid, (a, b, c) = await guild("alice", "bob", "carol")
    admin = (await a.ok("role.create", {"guild_id": gid, "name": "admin", "permissions": MANAGE_ROLES | KICK}))["role"]
    await a.ok("member.roles.set", {"guild_id": gid, "user_id": b.uid, "role_ids": [admin["role_id"]]})

    # bob's new role is placed below his own.
    helper = (await b.ok("role.create", {"guild_id": gid, "name": "helper"}))["role"]
    roles = {r["name"]: r["position"] for r in (await a.ok("role.list", {"guild_id": gid}))["roles"]}
    assert roles["admin"] > roles["helper"] > roles["@everyone"]
    # Can't grant what you don't have, can't touch your own top role or the owner.
    assert await b.err("role.update", {"role_id": helper["role_id"], "permissions": BAN}) == "forbidden"
    assert await b.err("role.update", {"role_id": admin["role_id"], "name": "x"}) == "forbidden"
    assert await b.err("member.kick", {"guild_id": gid, "user_id": a.uid}) == "forbidden"
    assert await b.err("member.kick", {"guild_id": gid, "user_id": b.uid}) == "bad_request"
    await b.ok("member.roles.set", {"guild_id": gid, "user_id": c.uid, "role_ids": [helper["role_id"]]})
    assert await b.err("member.roles.set", {"guild_id": gid, "user_id": c.uid, "role_ids": [admin["role_id"]]}) == "forbidden"

    # Reorder: owner can move anything, bob only below himself.
    await a.ok("role.reorder", {"guild_id": gid, "role_ids": [helper["role_id"], admin["role_id"]]})
    assert await b.err("role.reorder", {"guild_id": gid, "role_ids": [admin["role_id"], helper["role_id"]]}) == "forbidden"
    await a.ok("role.reorder", {"guild_id": gid, "role_ids": [admin["role_id"], helper["role_id"]]})
    assert await a.err("role.reorder", {"guild_id": gid, "role_ids": [admin["role_id"]]}) == "bad_request"

    # Kick carol (below bob).
    await c.drain()
    await a.drain()
    await b.ok("member.kick", {"guild_id": gid, "user_id": c.uid})
    assert (await c.drain()) == [{"type": "guild.removed", "payload": {"guild_id": gid, "reason": "kicked"}}]
    left = [e for e in await a.drain() if e["type"] == "guild.member_left"]
    assert left[0]["payload"] == {"guild_id": gid, "user_id": c.uid, "reason": "kicked"}
    assert (await c.ok("guild.list"))["guilds"] == []


async def test_ban_and_unban(guild):
    gid, cid, (a, b) = await guild("alice", "bob")
    code = (await a.ok("guild.invite.create", {"guild_id": gid}))["invite_code"]
    await b.ok("message.send", {"channel_id": cid, "content": "bad words"})
    await a.drain()
    await a.ok("member.ban", {"guild_id": gid, "user_id": b.uid, "reason": "rude", "delete_seconds": 3600})
    ev = await a.drain()
    assert set(types(ev)) == {"guild.member_left", "message.deleted"}
    assert (await a.ok("channel.history", {"channel_id": cid}))["messages"] == []
    assert await b.err("guild.join_by_code", {"invite_code": code}) == "banned"
    bans = (await a.ok("guild.bans.list", {"guild_id": gid}))["bans"]
    assert bans[0]["user"]["user_id"] == b.uid and bans[0]["reason"] == "rude"
    await a.ok("member.unban", {"guild_id": gid, "user_id": b.uid})
    assert await a.err("member.unban", {"guild_id": gid, "user_id": b.uid}) == "not_found"
    await b.ok("guild.join_by_code", {"invite_code": code})
    actions = [e["action"] for e in (await a.ok("guild.audit_log", {"guild_id": gid}))["entries"]]
    assert actions[:2] == ["member.unban", "member.ban"]
    assert await b.err("guild.audit_log", {"guild_id": gid}) == "forbidden"


async def test_timeout(guild):
    gid, cid, (a, b) = await guild("alice", "bob")
    mid = (await a.ok("message.send", {"channel_id": cid, "content": "hi"}))["message_id"]
    res = await a.ok("member.timeout", {"guild_id": gid, "user_id": b.uid, "duration_seconds": 600})
    assert res["member"]["timed_out_until"]
    assert await b.err("message.send", {"channel_id": cid, "content": "x"}) == "timed_out"
    assert await b.err("reaction.add", {"message_id": mid, "emoji": "👍"}) == "timed_out"
    assert await b.err("guild.invite.create", {"guild_id": gid}) == "timed_out"
    await b.ok("channel.history", {"channel_id": cid})  # can still read
    await a.ok("member.timeout", {"guild_id": gid, "user_id": b.uid, "duration_seconds": None})
    await b.ok("message.send", {"channel_id": cid, "content": "back"})
    assert await a.err("member.timeout", {"guild_id": gid, "user_id": b.uid, "duration_seconds": 0}) == "bad_request"


async def test_guild_delete(guild, owner):
    gid, cid, (a, b) = await guild("alice", "bob")
    assert await b.err("guild.delete", {"guild_id": gid}) == "forbidden"
    await a.ok("guild.delete", {"guild_id": gid})
    assert await b.drain() == [{"type": "guild.removed", "payload": {"guild_id": gid, "reason": "deleted"}}]
    assert (await b.ok("guild.list"))["guilds"] == []
