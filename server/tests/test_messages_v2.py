"""Edit/delete, replies, reactions, mentions, read state (PROTOCOL.md §5 Messaging)."""

from conftest import types

V, S = 1, 2


async def test_edit_and_delete(guild):
    gid, cid, (a, b) = await guild("alice", "bob")
    mid = (await a.ok("message.send", {"channel_id": cid, "content": "helo"}))["message_id"]
    await b.drain()
    assert await b.err("message.edit", {"message_id": mid, "content": "x"}) == "forbidden"
    edited = (await a.ok("message.edit", {"message_id": mid, "content": "hello"}))["message"]
    assert edited["content"] == "hello" and edited["edited_at"]
    ev = await b.drain()
    assert types(ev) == ["message.updated"] and ev[0]["payload"]["content"] == "hello"

    assert await b.err("message.delete", {"message_id": mid}) == "forbidden"
    await a.ok("message.delete", {"message_id": mid})
    assert (await b.drain())[0] == {
        "type": "message.deleted", "payload": {"channel_id": cid, "guild_id": gid, "message_id": mid}
    }
    assert (await b.ok("channel.history", {"channel_id": cid}))["messages"] == []
    assert await a.err("message.delete", {"message_id": mid}) == "not_found"


async def test_moderator_delete_is_audited(guild):
    gid, cid, (a, b) = await guild("alice", "bob")
    mid = (await b.ok("message.send", {"channel_id": cid, "content": "spam"}))["message_id"]
    await a.ok("message.delete", {"message_id": mid})  # owner has MANAGE_MESSAGES
    log = (await a.ok("guild.audit_log", {"guild_id": gid}))["entries"]
    assert log[0]["action"] == "message.delete" and log[0]["target_id"] == b.uid


async def test_reply_mentions_author(guild):
    gid, cid, (a, b) = await guild("alice", "bob")
    first = (await a.ok("message.send", {"channel_id": cid, "content": "question?"}))["message_id"]
    reply = (await b.ok("message.send", {"channel_id": cid, "content": "answer", "reply_to_id": first}))["message"]
    assert reply["reply_to"]["message_id"] == first
    assert reply["reply_to"]["author"]["username"] == "alice"
    assert reply["mentions"] == [a.uid]
    quiet = (await b.ok("message.send", {"channel_id": cid, "content": "x", "reply_to_id": first, "mention_reply": False}))["message"]
    assert quiet["mentions"] == []
    assert await b.err("message.send", {"channel_id": cid, "content": "x", "reply_to_id": "123"}) == "bad_request"
    # Deleting the original leaves the reply with reply_to = null.
    await a.ok("message.delete", {"message_id": first})
    hist = (await a.ok("channel.history", {"channel_id": cid}))["messages"]
    assert hist[0]["reply_to_id"] == first and hist[0]["reply_to"] is None


async def test_reactions(guild):
    gid, cid, (a, b) = await guild("alice", "bob")
    mid = (await a.ok("message.send", {"channel_id": cid, "content": "react"}))["message_id"]
    await b.drain()
    await b.ok("reaction.add", {"message_id": mid, "emoji": "👍"})
    await b.ok("reaction.add", {"message_id": mid, "emoji": "👍"})  # idempotent, no second event
    await a.ok("reaction.add", {"message_id": mid, "emoji": "👍"})
    await a.ok("reaction.add", {"message_id": mid, "emoji": "1️⃣"})
    ev = await b.drain()
    assert types(ev) == ["reaction.added"] * 3
    assert ev[0]["payload"] == {"channel_id": cid, "guild_id": gid, "message_id": mid, "emoji": "👍", "user_id": b.uid}
    msg = (await a.ok("channel.history", {"channel_id": cid}))["messages"][0]
    assert msg["reactions"] == [
        {"emoji": "👍", "user_ids": [b.uid, a.uid]},
        {"emoji": "1️⃣", "user_ids": [a.uid]},
    ]
    await a.drain()
    await b.ok("reaction.remove", {"message_id": mid, "emoji": "👍"})
    assert types(await a.drain()) == ["reaction.removed"]
    for bad in ("", "abc", "a b", "😀" * 20):
        assert await a.err("reaction.add", {"message_id": mid, "emoji": bad}) == "bad_request"


async def test_reaction_limit(guild):
    gid, cid, (a,) = await guild("alice")
    mid = (await a.ok("message.send", {"channel_id": cid, "content": "x"}))["message_id"]
    emoji = [chr(0x1F600 + i) for i in range(21)]
    for e in emoji[:20]:
        await a.ok("reaction.add", {"message_id": mid, "emoji": e})
    assert await a.err("reaction.add", {"message_id": mid, "emoji": emoji[20]}) == "too_many_reactions"


async def test_mentions_and_read_state(guild, connect):
    gid, cid, (a, b, c) = await guild("alice", "bob", "carol")
    states = {s["channel_id"]: s for s in (await b.ok("read_state.list"))["read_states"]}
    assert states[cid]["mention_count"] == 0

    m1 = (await a.ok("message.send", {"channel_id": cid, "content": f"hi <@{b.uid}> and <@999>"}))["message"]
    assert m1["mentions"] == [b.uid]
    s = {s["channel_id"]: s for s in (await b.ok("read_state.list"))["read_states"]}[cid]
    assert s["mention_count"] == 1 and s["last_message_id"] == m1["message_id"]
    assert int(s["last_message_id"]) > int(s["last_read_id"] or 0)
    # Sender's own message is read.
    sa = {s["channel_id"]: s for s in (await a.ok("read_state.list"))["read_states"]}[cid]
    assert sa["last_read_id"] == m1["message_id"]

    # @everyone: the owner has MENTION_EVERYONE; plain members don't.
    m2 = (await a.ok("message.send", {"channel_id": cid, "content": "@everyone meeting"}))["message"]
    assert m2["mention_everyone"] is True
    m3 = (await b.ok("message.send", {"channel_id": cid, "content": "@everyone lol"}))["message"]
    assert m3["mention_everyone"] is False
    sc = {s["channel_id"]: s for s in (await c.ok("read_state.list"))["read_states"]}[cid]
    assert sc["mention_count"] == 1

    # Ack clears mentions and syncs to the user's other connections.
    b2 = await connect()
    await b2.login("bob", "password123")
    await b2.drain()
    res = await b.ok("channel.ack", {"channel_id": cid, "message_id": m3["message_id"]})
    assert res["read_state"]["mention_count"] == 0
    assert res["read_state"]["last_read_id"] == m3["message_id"]
    ev = await b2.drain()
    assert types(ev) == ["read_state.updated"]
    # Acks never move backwards.
    res = await b.ok("channel.ack", {"channel_id": cid, "message_id": m1["message_id"]})
    assert res["read_state"]["last_read_id"] == m3["message_id"]




async def test_private_channel_delivery(guild):
    gid, general, (a, b, c) = await guild("alice", "bob", "carol")
    role = (await a.ok("role.create", {"guild_id": gid, "name": "mods"}))["role"]
    await a.ok("member.roles.set", {"guild_id": gid, "user_id": b.uid, "role_ids": [role["role_id"]]})
    private = (await a.ok("channel.create", {
        "guild_id": gid, "name": "mods",
        "overwrites": [{"role_id": gid, "deny": V}, {"role_id": role["role_id"], "allow": V}],
    }))["channel"]
    pid = private["channel_id"]
    ev_b, ev_c = await b.drain(), await c.drain()
    assert "channel.created" in types(ev_b) and "channel.created" not in types(ev_c)

    assert [ch["name"] for ch in (await c.ok("channel.list", {"guild_id": gid}))["channels"]] == ["general"]
    assert await c.err("channel.history", {"channel_id": pid}) == "not_found"
    assert await c.err("message.send", {"channel_id": pid, "content": "x"}) == "not_found"

    await b.ok("message.send", {"channel_id": pid, "content": f"secret <@{c.uid}>"})
    assert "message.new" in types(await a.drain())
    assert await c.drain() == []

    # Opening it up: carol gains access and hears about it.
    await a.ok("channel.update", {"channel_id": pid, "overwrites": []})
    assert "channel.updated" in types(await c.drain())
    # Closing it again: carol gets channel.deleted.
    await a.ok("channel.update", {"channel_id": pid, "overwrites": [{"role_id": gid, "deny": V}, {"role_id": role["role_id"], "allow": V}]})
    ev = await c.drain()
    assert {"type": "channel.deleted", "payload": {"guild_id": gid, "channel_id": pid}} in ev


async def test_read_only_channel(guild):
    gid, cid, (a, b) = await guild("alice", "bob")
    ann = (await a.ok("channel.create", {"guild_id": gid, "name": "news", "overwrites": [{"role_id": gid, "deny": S}]}))["channel"]
    await a.ok("message.send", {"channel_id": ann["channel_id"], "content": "news!"})
    assert await b.err("message.send", {"channel_id": ann["channel_id"], "content": "hi"}) == "forbidden"
    assert await b.err("typing.start", {"channel_id": ann["channel_id"]}) == "forbidden"
    theirs = [ch for ch in (await b.ok("channel.list", {"guild_id": gid}))["channels"] if ch["name"] == "news"][0]
    assert theirs["my_permissions"] & S == 0
    assert len((await b.ok("channel.history", {"channel_id": ann["channel_id"]}))["messages"]) == 1


async def test_bad_overwrites(guild):
    gid, cid, (a, b) = await guild("alice", "bob")
    bad = [
        [{"role_id": "123", "deny": V}],  # unknown role
        [{"role_id": gid, "allow": V, "deny": V}],  # both
        [{"role_id": gid, "deny": 1 << 8}],  # not a channel permission
        "nope",
    ]
    for ow in bad:
        assert await a.err("channel.create", {"guild_id": gid, "name": "x", "overwrites": ow}) == "bad_request"
