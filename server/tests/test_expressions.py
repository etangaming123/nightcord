"""Custom emoji and stickers (PROTOCOL.md §5 Emoji and stickers)."""

from nightcord import permissions as perm
from nightcord.handlers import media as M

from conftest import types
from images import gif, media_id, png


async def _emoji(server, c, gid, name="pancake", data=None):
    mid = await media_id(server, c, "emoji", data or png())
    return (await c.ok("emoji.create", {"guild_id": gid, "name": name, "media_id": mid}))["emoji"]


async def test_emoji_crud_and_events(server, guild, ctx):
    gid, cid, (a, b) = await guild("alice", "bob")
    emoji = await _emoji(server, a, gid, data=gif(animated=True))
    assert emoji["name"] == "pancake" and emoji["animated"] and emoji["guild_id"] == gid
    ev = [e for e in await b.drain() if e["type"] == "guild.emojis_updated"]
    assert ev and ev[0]["payload"]["emojis"][0]["emoji_id"] == emoji["emoji_id"]
    # Listed in the guild object.
    guilds = (await b.ok("guild.list"))["guilds"]
    assert guilds[0]["emojis"][0]["name"] == "pancake" and guilds[0]["stickers"] == []
    # Names are unique per guild, case-insensitively, and validated.
    mid = await media_id(server, a, "emoji", png())
    assert await a.err("emoji.create", {"guild_id": gid, "name": "PANCAKE", "media_id": mid}) == "bad_request"
    assert await a.err("emoji.create", {"guild_id": gid, "name": "no spaces", "media_id": mid}) == "bad_request"
    renamed = (await a.ok("emoji.update", {"emoji_id": emoji["emoji_id"], "name": "flapjack"}))["emoji"]
    assert renamed["name"] == "flapjack"
    # Members without MANAGE_EXPRESSIONS can't manage.
    assert await b.err("emoji.delete", {"emoji_id": emoji["emoji_id"]}) == "forbidden"
    await a.ok("emoji.delete", {"emoji_id": emoji["emoji_id"]})
    assert not (M.media_dir(ctx) / emoji["emoji_id"]).exists()
    assert (await b.ok("guild.list"))["guilds"][0]["emojis"] == []


async def test_manage_expressions_permission(server, guild):
    gid, cid, (a, b) = await guild("alice", "bob")
    role = (await a.ok("role.create", {"guild_id": gid, "name": "Artists", "permissions": perm.MANAGE_EXPRESSIONS}))["role"]
    await a.ok("member.roles.set", {"guild_id": gid, "user_id": b.uid, "role_ids": [role["role_id"]]})
    emoji = await _emoji(server, b, gid, name="bobmoji")
    assert emoji["creator_id"] == b.uid


async def test_emoji_limit(server, guild, ctx, monkeypatch):
    from nightcord import protocol as P

    gid, cid, (a,) = await guild("alice")
    monkeypatch.setattr(P, "MAX_GUILD_EMOJI", 1)
    await _emoji(server, a, gid)
    mid = await media_id(server, a, "emoji", png())
    assert await a.err("emoji.create", {"guild_id": gid, "name": "second", "media_id": mid}) == "bad_request"


async def test_custom_reactions_need_membership(server, guild, user):
    gid, cid, (a, b) = await guild("alice", "bob")
    emoji = await _emoji(server, a, gid)
    key = f"<:pancake:{emoji['emoji_id']}>"
    # A second guild bob owns, where carol (not in alice's guild) is.
    carol = await user("carol")
    g2 = (await b.ok("guild.create", {"name": "Other"}))
    gid2, cid2 = g2["guild"]["guild_id"], g2["channels"][0]["channel_id"]
    code = (await b.ok("guild.invite.create", {"guild_id": gid2}))["invite_code"]
    await carol.ok("guild.join_by_code", {"invite_code": code})
    msg = (await carol.ok("message.send", {"channel_id": cid2, "content": "hi"}))["message_id"]
    # carol isn't in alice's guild: can't use its emoji.
    assert await carol.err("reaction.add", {"message_id": msg, "emoji": key}) == "forbidden"
    # bob is: usable in another guild, stored under the current name even if sent with an old one.
    await b.ok("reaction.add", {"message_id": msg, "emoji": f"<:oldname:{emoji['emoji_id']}>"})
    reactions = (await carol.ok("channel.history", {"channel_id": cid2}))["messages"][-1]["reactions"]
    assert reactions == [{"emoji": key, "user_ids": [b.uid]}]
    # Joining an existing reaction always works, and reuses its key.
    await carol.ok("reaction.add", {"message_id": msg, "emoji": key})
    reactions = (await carol.ok("channel.history", {"channel_id": cid2}))["messages"][-1]["reactions"]
    assert reactions[0]["user_ids"] == [b.uid, carol.uid]
    # Unknown emoji ids fail.
    assert await b.err("reaction.add", {"message_id": msg, "emoji": "<:ghost:123>"}) == "not_found"
    # Custom emoji in content are just text.
    sent = (await b.ok("message.send", {"channel_id": cid2, "content": key}))["message"]
    assert sent["content"] == key


async def test_emoji_info(server, guild, user):
    gid, cid, (a,) = await guild("alice")
    emoji = await _emoji(server, a, gid)
    stranger = await user("zed")
    info = await stranger.ok("emoji.info", {"emoji_id": emoji["emoji_id"]})
    assert info["guild"] is None and not info["is_member"] and info["emoji"]["name"] == "pancake"
    await a.ok("guild.config.update", {"guild_id": gid, "listed": True})
    info = await stranger.ok("emoji.info", {"emoji_id": emoji["emoji_id"]})
    assert info["guild"]["name"] == "G"
    assert (await a.ok("emoji.info", {"emoji_id": emoji["emoji_id"]}))["is_member"]


async def test_stickers(server, guild, user, ctx):
    gid, cid, (a, b) = await guild("alice", "bob")
    mid = await media_id(server, a, "sticker", png(320, 320))
    sticker = (await a.ok("sticker.create", {
        "guild_id": gid, "name": "Wave", "description": "hello!", "tag_emoji": "👋", "media_id": mid,
    }))["sticker"]
    assert sticker["sticker_id"] == mid and sticker["tag_emoji"] == "👋"
    assert "guild.stickers_updated" in types(await b.drain())
    # Send a sticker alone.
    msg = (await b.ok("message.send", {"channel_id": cid, "content": "", "sticker_ids": [mid]}))["message"]
    assert msg["content"] == "" and msg["stickers"][0]["name"] == "Wave"
    assert await b.err("message.send", {"channel_id": cid, "content": "", "sticker_ids": [mid, mid + "1"]}) == "bad_request"
    assert await b.err("message.send", {"channel_id": cid, "content": ""}) == "bad_request"
    # Outsiders can't send it.
    zed = await user("zed")
    dm = (await zed.ok("dm.open", {"user_id": b.uid}))["channel"]["channel_id"]
    assert await zed.err("message.send", {"channel_id": dm, "content": "", "sticker_ids": [mid]}) == "forbidden"
    # Members can, anywhere.
    await b.ok("message.send", {"channel_id": dm, "content": "", "sticker_ids": [mid]})
    await a.ok("sticker.update", {"sticker_id": mid, "name": "Big wave"})
    await a.ok("sticker.delete", {"sticker_id": mid})
    assert not (M.media_dir(ctx) / mid).exists()
    last = (await a.ok("channel.history", {"channel_id": cid}))["messages"][-1]
    assert last["stickers"] == [{"sticker_id": mid, "deleted": True}]


async def test_guild_delete_removes_media(server, guild, ctx):
    gid, cid, (a,) = await guild("alice")
    emoji = await _emoji(server, a, gid)
    await a.ok("guild.delete", {"guild_id": gid})
    assert not (M.media_dir(ctx) / emoji["emoji_id"]).exists()
