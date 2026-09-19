"""Categories, reorder, permission sync, topics, slowmode, pins, search, jump-to."""

from conftest import types

VIEW = 1


async def test_categories_and_sync(guild):
    gid, cid, (a, b) = await guild("alice", "bob")
    cat = (await a.ok("channel.create", {"guild_id": gid, "name": "Staff Area", "kind": "category"}))["channel"]
    assert cat["kind"] == "category" and cat["name"] == "Staff Area"
    assert await a.err("channel.create", {"guild_id": gid, "name": "x", "kind": "category", "parent_id": cat["channel_id"]}) == "bad_request"
    inner = (await a.ok("channel.create", {"guild_id": gid, "name": "plans", "parent_id": cat["channel_id"]}))["channel"]
    assert inner["parent_id"] == cat["channel_id"] and inner["perms_synced"]
    names = [c["name"] for c in (await b.ok("channel.list", {"guild_id": gid}))["channels"]]
    assert "plans" in names and "Staff Area" in names
    # Making the category private hides the synced child too.
    await b.drain()
    await a.ok("channel.update", {"channel_id": cat["channel_id"], "overwrites": [{"role_id": gid, "allow": 0, "deny": VIEW}]})
    gone = [e["payload"]["channel_id"] for e in await b.drain() if e["type"] == "channel.deleted"]
    assert set(gone) == {cat["channel_id"], inner["channel_id"]}
    assert [c["name"] for c in (await b.ok("channel.list", {"guild_id": gid}))["channels"]] == ["general"]
    # Unsyncing restores the child's own (empty) overwrites: bob sees it, and its category header.
    await a.ok("channel.update", {"channel_id": inner["channel_id"], "perms_synced": False})
    names = [c["name"] for c in (await b.ok("channel.list", {"guild_id": gid}))["channels"]]
    assert names == ["general", "Staff Area", "plans"]
    # Deleting a category keeps its channels at the top level.
    await a.ok("channel.delete", {"channel_id": cat["channel_id"]})
    ch = [c for c in (await a.ok("channel.list", {"guild_id": gid}))["channels"] if c["name"] == "plans"][0]
    assert ch["parent_id"] is None


async def test_reorder(guild):
    gid, cid, (a, b) = await guild("alice", "bob")
    cat = (await a.ok("channel.create", {"guild_id": gid, "name": "Info", "kind": "category"}))["channel"]["channel_id"]
    rules = (await a.ok("channel.create", {"guild_id": gid, "name": "rules"}))["channel"]["channel_id"]
    await b.drain()
    items = [
        {"channel_id": cat, "parent_id": None, "position": 0},
        {"channel_id": rules, "parent_id": cat, "position": 1},
        {"channel_id": cid, "parent_id": None, "position": 2},
    ]
    assert await b.err("channel.reorder", {"guild_id": gid, "channels": items}) == "forbidden"
    chans = (await a.ok("channel.reorder", {"guild_id": gid, "channels": items}))["channels"]
    assert [c["channel_id"] for c in chans] == [cat, rules, cid]
    assert chans[1]["parent_id"] == cat
    assert "channel.updated" in types(await b.drain())
    bad = [{"channel_id": cid, "parent_id": rules, "position": 0}]
    assert await a.err("channel.reorder", {"guild_id": gid, "channels": bad}) == "bad_request"


async def test_topic_and_slowmode(guild):
    gid, cid, (a, b) = await guild("alice", "bob")
    ch = (await a.ok("channel.update", {"channel_id": cid, "topic": "Say hi", "slowmode_seconds": 10}))["channel"]
    assert ch["topic"] == "Say hi" and ch["slowmode_seconds"] == 10
    assert await a.err("channel.update", {"channel_id": cid, "slowmode_seconds": 7}) == "bad_request"
    await b.ok("message.send", {"channel_id": cid, "content": "one"})
    msg = await b.request("message.send", {"channel_id": cid, "content": "two"})
    assert msg["payload"]["code"] == "slowmode" and 0 < msg["payload"]["retry_after"] <= 10
    # Moderators (Manage Messages) bypass it; the owner has everything.
    await a.ok("message.send", {"channel_id": cid, "content": "a"})
    await a.ok("message.send", {"channel_id": cid, "content": "b"})


async def test_pins(guild):
    gid, cid, (a, b) = await guild("alice", "bob")
    mid = (await b.ok("message.send", {"channel_id": cid, "content": "important"}))["message_id"]
    assert await b.err("message.pin", {"message_id": mid}) == "forbidden"
    await a.drain()
    await a.ok("message.pin", {"message_id": mid})
    ev = await a.drain()
    upd = [e["payload"] for e in ev if e["type"] == "message.updated"]
    assert upd[0]["pinned"] is True
    sys_msg = [e["payload"] for e in ev if e["type"] == "message.new"][0]
    assert sys_msg["type"] == "pin" and sys_msg["reply_to_id"] == mid
    pins = (await b.ok("channel.pins", {"channel_id": cid}))["messages"]
    assert [p["message_id"] for p in pins] == [mid]
    await a.ok("message.unpin", {"message_id": mid})
    assert (await b.ok("channel.pins", {"channel_id": cid}))["messages"] == []
    assert await a.err("message.pin", {"message_id": sys_msg["message_id"]}) == "bad_request"
    # Anyone can pin in a DM.
    dm = (await a.ok("dm.open", {"user_id": b.uid}))["channel"]["channel_id"]
    dmid = (await a.ok("message.send", {"channel_id": dm, "content": "x"}))["message_id"]
    await b.ok("message.pin", {"message_id": dmid})


async def test_search_and_jump(guild, ctx):
    gid, cid, (a, b) = await guild("alice", "bob")
    secret = (await a.ok("channel.create", {"guild_id": gid, "name": "secret", "overwrites": [{"role_id": gid, "allow": 0, "deny": VIEW}]}))["channel"]["channel_id"]
    for i in range(30):  # straight into the DB: message.send is rate-limited
        ctx.db.create_message(cid, a.uid, f"message number {i} about pancakes" if i == 15 else f"chat {i}")
    await a.ok("message.send", {"channel_id": secret, "content": "pancakes are secret"})
    await b.ok("message.send", {"channel_id": cid, "content": "I like https://example.com pancakes"})
    res = await b.ok("message.search", {"guild_id": gid, "query": "pancake"})
    contents = [m["content"] for m in res["messages"]]
    assert res["total"] == 2 and "pancakes are secret" not in contents  # permission-filtered
    assert all(m["guild_id"] == gid for m in res["messages"])
    res = await a.ok("message.search", {"guild_id": gid, "query": "pancakes"})
    assert res["total"] == 3
    res = await a.ok("message.search", {"guild_id": gid, "query": "pancakes", "author_id": b.uid, "has": "link"})
    assert res["total"] == 1
    assert await a.err("message.search", {"guild_id": gid}) == "bad_request"
    # Jump to a result: history around it.
    target = [m for m in (await a.ok("message.search", {"channel_id": cid, "query": "number"}))["messages"]][0]
    around = await a.ok("channel.history", {"channel_id": cid, "around_message_id": target["message_id"], "limit": 10})
    got = [m["message_id"] for m in around["messages"]]
    assert target["message_id"] in got and len(got) == 10 and around["has_more"] and around["has_more_after"]
    after = await a.ok("channel.history", {"channel_id": cid, "after_message_id": got[-1], "limit": 100})
    assert not after["has_more_after"] and int(after["messages"][0]["message_id"]) > int(got[-1])


async def test_dm_search(user):
    a, b = await user("alice"), await user("bob")
    dm = (await a.ok("dm.open", {"user_id": b.uid}))["channel"]["channel_id"]
    await a.ok("message.send", {"channel_id": dm, "content": "the secret handshake"})
    res = await b.ok("message.search", {"channel_id": dm, "query": "handshake"})
    assert res["total"] == 1
    c = await user("carol")
    assert await c.err("message.search", {"channel_id": dm, "query": "x"}) == "not_found"
