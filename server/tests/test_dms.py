"""Direct messages (PROTOCOL.md §5 Direct messages)."""

from conftest import types


async def test_one_to_one(user):
    a, b = await user("alice"), await user("bob")
    assert await a.err("dm.open", {"user_id": a.uid}) == "bad_request"
    assert await a.err("dm.open", {"user_id": "12345"}) == "not_found"
    ch = (await a.ok("dm.open", {"user_id": b.uid}))["channel"]
    assert ch["kind"] == "dm" and ch["guild_id"] is None
    assert {u["username"] for u in ch["recipients"]} == {"alice", "bob"}
    assert (await a.ok("dm.open", {"user_id": b.uid}))["channel"]["channel_id"] == ch["channel_id"]
    # Bob doesn't see it until the first message.
    assert (await b.ok("dm.list"))["channels"] == []
    await b.drain()
    await a.ok("message.send", {"channel_id": ch["channel_id"], "content": "hey"})
    ev = await b.drain()
    assert types(ev) == ["dm.created", "message.new"]
    assert [c["channel_id"] for c in (await b.ok("dm.list"))["channels"]] == [ch["channel_id"]]
    states = {s["channel_id"]: s for s in (await b.ok("read_state.list"))["read_states"]}
    assert states[ch["channel_id"]]["last_read_id"] is None

    # Presence flows between DM partners.
    assert (await a.ok("presence.list", {"user_ids": [b.uid]}))["presences"] == {b.uid: "online"}

    # Closing hides it; a new message brings it back.
    await b.ok("dm.leave", {"channel_id": ch["channel_id"]})
    assert (await b.ok("dm.list"))["channels"] == []
    await a.ok("message.send", {"channel_id": ch["channel_id"], "content": "hello?"})
    assert types(await b.drain()) == ["dm.created", "message.new"]

    c = await user("carol")
    assert await c.err("channel.history", {"channel_id": ch["channel_id"]}) == "not_found"
    assert await c.err("message.send", {"channel_id": ch["channel_id"], "content": "x"}) == "not_found"


async def test_group(user):
    a, b, c, d = [await user(n) for n in ("alice", "bob", "carol", "dave")]
    assert await a.err("dm.create_group", {"user_ids": []}) == "bad_request"
    ch = (await a.ok("dm.create_group", {"user_ids": [b.uid, c.uid]}))["channel"]
    assert ch["kind"] == "group_dm" and ch["owner_user_id"] == a.uid
    assert "dm.created" in types(await b.drain())
    await b.ok("dm.update", {"channel_id": ch["channel_id"], "name": "Friends"})
    ev = [e for e in await c.drain() if e["type"] == "dm.updated"]
    assert ev[-1]["payload"]["name"] == "Friends"
    await c.ok("dm.add_recipient", {"channel_id": ch["channel_id"], "user_id": d.uid})
    assert "dm.created" in types(await d.drain())
    assert await c.err("dm.add_recipient", {"channel_id": ch["channel_id"], "user_id": d.uid}) == "already_member"
    await a.ok("dm.leave", {"channel_id": ch["channel_id"]})
    left = (await b.ok("dm.list"))["channels"][0]
    assert {u["username"] for u in left["recipients"]} == {"bob", "carol", "dave"}
    assert left["owner_user_id"] == b.uid
    assert await a.err("message.send", {"channel_id": ch["channel_id"], "content": "x"}) == "not_found"
    # No @everyone in DMs.
    m = (await b.ok("message.send", {"channel_id": ch["channel_id"], "content": "@everyone hi"}))["message"]
    assert m["mention_everyone"] is False


async def test_group_limit(user, ctx):
    ctx.login_throttle.attempts = 100  # 11 registrations from one IP
    a = await user("alice")
    others = [await user(f"user{i}") for i in range(10)]
    assert await a.err("dm.create_group", {"user_ids": [o.uid for o in others]}) == "dm_limit"
    ch = (await a.ok("dm.create_group", {"user_ids": [o.uid for o in others[:9]]}))["channel"]
    assert await a.err("dm.add_recipient", {"channel_id": ch["channel_id"], "user_id": others[9].uid}) == "dm_limit"


async def test_user_search(user):
    a = await user("alice")
    await user("bob")
    await user("bobby")
    names = [u["username"] for u in (await a.ok("user.search", {"query": "BO"}))["users"]]
    assert names == ["bob", "bobby"]
    assert (await a.ok("user.search", {"query": "ali"}))["users"] == []  # never yourself
    assert (await a.ok("user.search", {"query": "%"}))["users"] == []
