"""Friends, blocking and message requests (PROTOCOL.md §5 Friends and blocking, Message requests)."""

from conftest import befriend, types


def _kinds(result: dict) -> dict[str, str]:
    return {r["user"]["username"]: r["kind"] for r in result["relationships"]}


async def test_friend_request_flow(user):
    a, b = await user("alice"), await user("bob")
    assert await a.err("friend.request", {"username": "nobody"}) == "not_found"
    assert await a.err("friend.request", {"username": "alice"}) == "bad_request"
    rel = (await a.ok("friend.request", {"username": "BOB"}))["relationship"]
    assert rel["kind"] == "outgoing" and rel["user"]["username"] == "bob"
    ev = [e for e in await b.drain() if e["type"] == "relationship.updated"]
    assert ev[-1]["payload"]["kind"] == "incoming"
    assert _kinds(await b.ok("friend.list")) == {"alice": "incoming"}
    # Asking twice is harmless; accepting your own request isn't possible.
    await a.ok("friend.request", {"user_id": b.uid})
    assert await a.err("friend.accept", {"user_id": b.uid}) == "not_found"
    await b.ok("friend.accept", {"user_id": a.uid})
    assert _kinds(await a.ok("friend.list")) == {"bob": "friend"}
    assert await a.err("friend.request", {"user_id": b.uid}) == "already_friends"
    # Friends see each other's presence.
    assert (await a.ok("presence.list", {"user_ids": [b.uid]}))["presences"] == {b.uid: "online"}
    await a.ok("friend.remove", {"user_id": b.uid})
    assert (await b.ok("friend.list"))["relationships"] == []
    assert "relationship.removed" in types(await b.drain())


async def test_unfriend_sends_offline_when_nothing_shared(user):
    a, b = await user("alice"), await user("bob")
    await befriend(a, b)
    await a.drain(), await b.drain()
    await a.ok("friend.remove", {"user_id": b.uid})
    for me, other in ((a, b), (b, a)):
        ev = [e["payload"] for e in await me.drain() if e["type"] == "presence.update"]
        assert {"user_id": other.uid, "status": "offline"} in ev


async def test_crossing_requests_make_friends(user):
    a, b = await user("alice"), await user("bob")
    await a.ok("friend.request", {"user_id": b.uid})
    rel = (await b.ok("friend.request", {"user_id": a.uid}))["relationship"]
    assert rel["kind"] == "friend"


async def test_decline_and_cancel(user):
    a, b = await user("alice"), await user("bob")
    await a.ok("friend.request", {"user_id": b.uid})
    await b.ok("friend.remove", {"user_id": a.uid})  # decline
    assert (await a.ok("friend.list"))["relationships"] == []
    await a.ok("friend.request", {"user_id": b.uid})
    await a.ok("friend.remove", {"user_id": b.uid})  # cancel
    assert (await b.ok("friend.list"))["relationships"] == []
    assert await a.err("friend.remove", {"user_id": b.uid}) == "not_found"


async def test_blocking(user):
    a, b = await user("alice"), await user("bob")
    await befriend(a, b)
    await b.ok("user.update", {"dm_privacy": "everyone"})
    dm = (await a.ok("dm.open", {"user_id": b.uid}))["channel"]
    await b.ok("user.block", {"user_id": a.uid})
    # Silent for alice: the friendship just goes away.
    assert (await a.ok("friend.list"))["relationships"] == []
    assert _kinds(await b.ok("friend.list")) == {"alice": "blocked"}
    assert await a.err("friend.request", {"user_id": b.uid}) == "blocked"
    assert await a.err("message.send", {"channel_id": dm["channel_id"], "content": "hi"}) == "blocked"
    assert await b.err("message.send", {"channel_id": dm["channel_id"], "content": "hi"}) == "blocked"
    assert await a.err("dm.open", {"user_id": b.uid}) == "blocked"
    assert await b.err("friend.request", {"user_id": a.uid}) == "blocked"  # unblock first
    await b.ok("user.unblock", {"user_id": a.uid})
    assert await b.err("user.unblock", {"user_id": a.uid}) == "not_found"
    await a.ok("message.send", {"channel_id": dm["channel_id"], "content": "hi again"})


async def test_message_request_accept(user):
    a, b = await user("alice"), await user("bob")
    assert (await b.ok("friend.list")) == {"relationships": []}
    dm = (await a.ok("dm.open", {"user_id": b.uid}))["channel"]
    await b.drain()
    await a.ok("message.send", {"channel_id": dm["channel_id"], "content": "hi, it's alice"})
    ev = await b.drain()
    created = next(e for e in ev if e["type"] == "dm.created")["payload"]
    assert created["request"] == {"from_user_id": a.uid, "state": "pending"}
    # One message until bob says yes.
    assert await a.err("message.send", {"channel_id": dm["channel_id"], "content": "hello??"}) == "request_pending"
    # Reopening a pending request is fine.
    await a.ok("dm.open", {"user_id": b.uid})
    assert await a.err("dm.request.accept", {"channel_id": dm["channel_id"]}) == "not_found"  # not yours to accept
    ch = (await b.ok("dm.request.accept", {"channel_id": dm["channel_id"]}))["channel"]
    assert ch["request"]["state"] == "accepted"
    await a.ok("message.send", {"channel_id": dm["channel_id"], "content": "thanks"})


async def test_message_request_reply_accepts(user):
    a, b = await user("alice"), await user("bob")
    dm = (await a.ok("dm.open", {"user_id": b.uid}))["channel"]
    await a.ok("message.send", {"channel_id": dm["channel_id"], "content": "hi"})
    await b.ok("message.send", {"channel_id": dm["channel_id"], "content": "oh hey"})
    await a.ok("message.send", {"channel_id": dm["channel_id"], "content": "great"})
    assert (await a.ok("dm.list"))["channels"][0]["request"]["state"] == "accepted"


async def test_message_request_decline(user):
    a, b = await user("alice"), await user("bob")
    dm = (await a.ok("dm.open", {"user_id": b.uid}))["channel"]
    await a.ok("message.send", {"channel_id": dm["channel_id"], "content": "buy my mixtape"})
    await b.ok("dm.request.decline", {"channel_id": dm["channel_id"]})
    assert (await b.ok("dm.list"))["channels"] == []
    assert await a.err("message.send", {"channel_id": dm["channel_id"], "content": "pls"}) == "dm_not_allowed"
    # Becoming friends later lets them talk.
    await befriend(a, b)
    await a.ok("message.send", {"channel_id": dm["channel_id"], "content": "ok now?"})


async def test_friends_only_privacy(user):
    a, b = await user("alice"), await user("bob")
    await b.ok("user.update", {"dm_privacy": "friends"})
    assert (await b.ok("user.update", {"display_name": "Bob"}))["user"]["dm_privacy"] == "friends"
    assert await b.err("user.update", {"dm_privacy": "nobody"}) == "bad_request"
    assert await a.err("dm.open", {"user_id": b.uid}) == "dm_not_allowed"
    await befriend(a, b)
    dm = (await a.ok("dm.open", {"user_id": b.uid}))["channel"]
    await a.ok("message.send", {"channel_id": dm["channel_id"], "content": "hi friend"})
    assert dm["request"] is None
