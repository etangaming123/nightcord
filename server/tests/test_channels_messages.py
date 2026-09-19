from nightcord.hub import MESSAGE_RATE


async def _guild_with_member(connect):
    a = await connect()
    a.user = (await a.register("alice"))["user"]
    b = await connect()
    b.user = (await b.register("bob"))["user"]
    res = await a.ok("guild.create", {"name": "G"})
    gid = res["guild"]["guild_id"]
    code = (await a.ok("guild.invite.create", {"guild_id": gid}))["invite_code"]
    await b.ok("guild.join_by_code", {"invite_code": code})
    await a.drain()
    return a, b, gid, res["channels"][0]["channel_id"]


async def test_send_and_receive(connect):
    a, b, gid, cid = await _guild_with_member(connect)
    await a.ok("channel.join", {"channel_id": cid})
    await b.ok("channel.join", {"channel_id": cid})
    res = await a.ok("message.send", {"channel_id": cid, "content": "  hello  "})
    events_a = await a.drain()
    events_b = await b.drain()
    for events in (events_a, events_b):
        assert len(events) == 1 and events[0]["type"] == "message.new"
        msg = events[0]["payload"]
        assert msg["message_id"] == res["message_id"]
        assert msg["content"] == "hello"
        assert msg["author_username"] == "alice"

    # After leaving, no more live messages.
    await b.ok("channel.leave", {"channel_id": cid})
    await a.ok("message.send", {"channel_id": cid, "content": "again"})
    assert await b.drain() == []


async def test_join_switches_channel(connect):
    a, b, gid, general = await _guild_with_member(connect)
    other = (await a.ok("channel.create", {"guild_id": gid, "name": "other"}))["channel"]["channel_id"]
    await b.drain()
    await b.ok("channel.join", {"channel_id": general})
    await b.ok("channel.join", {"channel_id": other})
    await a.ok("message.send", {"channel_id": general, "content": "x"})
    assert await b.drain() == []


async def test_message_validation_and_access(connect):
    a, b, gid, cid = await _guild_with_member(connect)
    assert await a.err("message.send", {"channel_id": cid, "content": "   "}) == "bad_request"
    assert await a.err("message.send", {"channel_id": cid, "content": "x" * 2001}) == "content_too_long"
    await a.ok("message.send", {"channel_id": cid, "content": "x" * 2000})
    c = await connect()
    await c.register("carol")
    assert await c.err("message.send", {"channel_id": cid, "content": "hi"}) == "not_found"
    assert await c.err("channel.history", {"channel_id": cid}) == "not_found"
    assert await c.err("channel.join", {"channel_id": cid}) == "not_found"
    assert await c.err("channel.list", {"guild_id": gid}) == "not_found"


async def test_rate_limit(connect):
    a, b, gid, cid = await _guild_with_member(connect)
    for i in range(MESSAGE_RATE):
        await a.ok("message.send", {"channel_id": cid, "content": str(i)})
    assert await a.err("message.send", {"channel_id": cid, "content": "too fast"}) == "rate_limited"


async def test_history_pagination(connect, ctx):
    a, b, gid, cid = await _guild_with_member(connect)
    for i in range(7):
        ctx.db.create_message(cid, a.user["user_id"], f"m{i}")
    page = await b.ok("channel.history", {"channel_id": cid, "limit": 3})
    assert [m["content"] for m in page["messages"]] == ["m4", "m5", "m6"]
    assert page["has_more"] is True
    page = await b.ok("channel.history", {"channel_id": cid, "limit": 3, "before_message_id": page["messages"][0]["message_id"]})
    assert [m["content"] for m in page["messages"]] == ["m1", "m2", "m3"]
    assert page["has_more"] is True
    page = await b.ok("channel.history", {"channel_id": cid, "limit": 3, "before_message_id": page["messages"][0]["message_id"]})
    assert [m["content"] for m in page["messages"]] == ["m0"]
    assert page["has_more"] is False
    assert len((await b.ok("channel.history", {"channel_id": cid}))["messages"]) == 7
    assert await b.err("channel.history", {"channel_id": cid, "before_message_id": "abc"}) == "bad_request"
    assert await b.err("channel.history", {"channel_id": cid, "limit": "5"}) == "bad_request"


async def test_channel_crud_and_events(connect):
    a, b, gid, general = await _guild_with_member(connect)
    assert await b.err("channel.create", {"guild_id": gid, "name": "nope"}) == "forbidden"
    assert await a.err("channel.create", {"guild_id": gid, "name": "Bad Name"}) == "bad_request"

    ch = (await a.ok("channel.create", {"guild_id": gid, "name": "random"}))["channel"]
    assert ch["position"] == 1
    ev = await b.drain()
    assert ev == [{"type": "channel.created", "payload": ch}]

    upd = (await a.ok("channel.update", {"channel_id": ch["channel_id"], "name": "memes", "position": 0}))["channel"]
    assert upd["name"] == "memes"
    assert (await b.drain())[0]["type"] == "channel.updated"
    assert await b.err("channel.update", {"channel_id": ch["channel_id"], "name": "x"}) == "forbidden"

    await b.ok("channel.join", {"channel_id": ch["channel_id"]})
    await a.ok("message.send", {"channel_id": ch["channel_id"], "content": "bye"})
    await b.drain()
    assert await b.err("channel.delete", {"channel_id": ch["channel_id"]}) == "forbidden"
    await a.ok("channel.delete", {"channel_id": ch["channel_id"]})
    assert await b.drain() == [
        {"type": "channel.deleted", "payload": {"guild_id": gid, "channel_id": ch["channel_id"]}}
    ]
    names = [c["name"] for c in (await b.ok("channel.list", {"guild_id": gid}))["channels"]]
    assert names == ["general"]
    assert await b.err("channel.history", {"channel_id": ch["channel_id"]}) == "not_found"
