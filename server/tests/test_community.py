"""Invites, system messages, guild icons, nicknames and hoisted roles."""

import base64

from conftest import types

PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32).decode()
MANAGE_GUILD = 256
MANAGE_NICKNAMES = 1 << 18


async def test_invite_limits_and_tracking(guild, user):
    gid, cid, (a,) = await guild("alice")
    b, c = await user("bob"), await user("carol")
    res = await a.ok("guild.invite.create", {"guild_id": gid, "max_uses": 1, "max_age_seconds": 3600})
    inv = res["invite"]
    assert inv["max_uses"] == 1 and inv["expires_at"] and inv["inviter"]["user_id"] == a.uid
    preview = await b.ok("guild.invite.resolve", {"invite_code": inv["code"]})
    assert preview["guild"]["name"] == "G" and preview["member_count"] == 1 and preview["inviter"]["username"] == "alice"
    await b.ok("guild.join_by_code", {"invite_code": inv["code"].lower()})
    assert await c.err("guild.join_by_code", {"invite_code": inv["code"]}) == "invite_expired"
    member = [m for m in (await a.ok("guild.members", {"guild_id": gid}))["members"] if m["user"]["user_id"] == b.uid][0]
    assert member["invited_by"] == a.uid and member["invite_code"] == inv["code"]
    # Used-up invites drop out of the active list.
    active = [i["code"] for i in (await a.ok("guild.invite.list", {"guild_id": gid}))["invites"]]
    assert inv["code"] not in active
    assert await a.err("guild.invite.create", {"guild_id": gid, "max_uses": 7}) == "bad_request"


async def test_invite_list_and_revoke(guild):
    gid, cid, (a, b, c) = await guild("alice", "bob", "carol")
    mine = (await b.ok("guild.invite.create", {"guild_id": gid}))["invite"]["code"]
    theirs = (await c.ok("guild.invite.create", {"guild_id": gid}))["invite"]["code"]
    # Without Manage Guild you see your own; the owner sees all (including the fixture's).
    assert [i["code"] for i in (await b.ok("guild.invite.list", {"guild_id": gid}))["invites"]] == [mine]
    assert {mine, theirs} <= {i["code"] for i in (await a.ok("guild.invite.list", {"guild_id": gid}))["invites"]}
    assert await b.err("guild.invite.revoke", {"invite_code": theirs}) == "forbidden"
    await b.ok("guild.invite.revoke", {"invite_code": mine})
    await a.ok("guild.invite.revoke", {"invite_code": theirs})
    assert await b.err("guild.invite.resolve", {"invite_code": theirs}) == "invite_invalid"


async def test_vanity_invite(guild, user):
    gid, cid, (a, b) = await guild("alice", "bob")
    assert await b.err("guild.config.update", {"guild_id": gid, "vanity_code": "night"}) == "forbidden"
    assert await a.err("guild.config.update", {"guild_id": gid, "vanity_code": "No Spaces"}) == "bad_request"
    g = (await a.ok("guild.config.update", {"guild_id": gid, "vanity_code": "Night-Owls"}))["guild"]
    assert g["vanity_code"] == "night-owls"
    c = await user("carol")
    preview = await c.ok("guild.invite.resolve", {"invite_code": "night-owls"})
    assert preview["inviter"] is None and preview["expires_at"] is None
    await c.ok("guild.join_by_code", {"invite_code": "NIGHT-OWLS"})
    gid2 = (await c.ok("guild.create", {"name": "Other"}))["guild"]["guild_id"]
    assert await c.err("guild.config.update", {"guild_id": gid2, "vanity_code": "night-owls"}) == "bad_request"


async def test_system_messages(guild, user):
    gid, cid, (a, b) = await guild("alice", "bob")
    g = (await a.ok("guild.list"))["guilds"][0]
    assert g["system_channel_id"] == cid and g["system_flags"] == 0
    code = (await a.ok("guild.invite.create", {"guild_id": gid}))["invite_code"]
    c = await user("carol")
    await c.ok("guild.join_by_code", {"invite_code": code})
    assert (await a.ok("channel.history", {"channel_id": cid}))["messages"] == []  # off by default
    await a.ok("guild.config.update", {"guild_id": gid, "system_flags": 3})
    d = await user("dave")
    await a.drain()
    await d.ok("guild.join_by_code", {"invite_code": code})
    news = [e["payload"] for e in await a.drain() if e["type"] == "message.new"]
    assert news[0]["type"] == "member_join" and news[0]["author"]["user_id"] == d.uid
    await d.ok("guild.leave", {"guild_id": gid})
    await a.ok("member.kick", {"guild_id": gid, "user_id": c.uid})
    kinds = [m["type"] for m in (await a.ok("channel.history", {"channel_id": cid}))["messages"]]
    assert kinds == ["member_join", "member_leave", "member_leave"]
    # System messages can't be edited but can be deleted by moderators.
    join = (await a.ok("channel.history", {"channel_id": cid}))["messages"][0]
    assert await d.err("message.edit", {"message_id": join["message_id"], "content": "x"}) in ("forbidden", "not_found")
    await a.ok("message.delete", {"message_id": join["message_id"]})
    # Only joins: leave off.
    await a.ok("guild.config.update", {"guild_id": gid, "system_flags": 1})
    await b.ok("guild.leave", {"guild_id": gid})
    assert len((await a.ok("channel.history", {"channel_id": cid}))["messages"]) == 2
    # No channel -> nothing.
    await a.ok("guild.config.update", {"guild_id": gid, "system_channel_id": None, "system_flags": 3})
    e = await user("erin")
    await e.ok("guild.join_by_code", {"invite_code": code})
    assert len((await a.ok("channel.history", {"channel_id": cid}))["messages"]) == 2


async def test_guild_icon(guild):
    gid, cid, (a, b) = await guild("alice", "bob")
    assert await b.err("guild.icon.set", {"guild_id": gid, "data_b64": PNG}) == "forbidden"
    g = (await a.ok("guild.icon.set", {"guild_id": gid, "data_b64": PNG}))["guild"]
    assert g["icon_id"].endswith(".png")
    assert "guild.updated" in types(await b.drain())
    g = (await a.ok("guild.icon.set", {"guild_id": gid, "data_b64": None}))["guild"]
    assert g["icon_id"] is None


async def test_nicknames(guild):
    gid, cid, (a, b, c) = await guild("alice", "bob", "carol")
    m = (await b.ok("member.nickname.set", {"guild_id": gid, "user_id": b.uid, "nickname": " Bobby "}))["member"]
    assert m["nickname"] == "Bobby"
    ev = [e for e in await c.drain() if e["type"] == "guild.member_updated"]
    assert ev[0]["payload"]["member"]["nickname"] == "Bobby"
    assert await b.err("member.nickname.set", {"guild_id": gid, "user_id": c.uid, "nickname": "x"}) == "forbidden"
    await a.ok("member.nickname.set", {"guild_id": gid, "user_id": b.uid, "nickname": None})
    # @everyone can lose CHANGE_NICKNAME.
    await a.ok("role.update", {"role_id": gid, "permissions": 229903 & ~(1 << 17)})
    assert await b.err("member.nickname.set", {"guild_id": gid, "user_id": b.uid, "nickname": "x"}) == "forbidden"
    mod = (await a.ok("role.create", {"guild_id": gid, "name": "mod", "permissions": MANAGE_NICKNAMES}))["role"]
    await a.ok("member.roles.set", {"guild_id": gid, "user_id": b.uid, "role_ids": [mod["role_id"]]})
    await b.ok("member.nickname.set", {"guild_id": gid, "user_id": c.uid, "nickname": "Caz"})
    assert await b.err("member.nickname.set", {"guild_id": gid, "user_id": a.uid, "nickname": "x"}) == "forbidden"


async def test_hoisted_roles(guild):
    gid, cid, (a,) = await guild("alice")
    r = (await a.ok("role.create", {"guild_id": gid, "name": "mods", "hoist": True}))["role"]
    assert r["hoist"] is True
    r = (await a.ok("role.update", {"role_id": r["role_id"], "hoist": False}))["role"]
    assert r["hoist"] is False
    assert await a.err("role.update", {"role_id": gid, "hoist": True}) == "bad_request"
