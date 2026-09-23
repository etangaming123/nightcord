"""Forwarding (PROTOCOL.md §4 Forward) and marking a channel unread."""

from __future__ import annotations

from conftest import types


async def test_forward_carries_a_snapshot(guild):
    gid, cid, (alice, bob) = await guild("alice", "bob")
    other = (await alice.ok("channel.create", {"guild_id": gid, "name": "other", "kind": "text"}))["channel"]
    src = await bob.ok("message.send", {"channel_id": cid, "content": "worth repeating"})
    await alice.drain()
    res = await alice.ok("message.forward", {"message_id": src["message_id"], "channel_id": other["channel_id"]})
    fwd = res["message"]["forward"]
    assert fwd["content"] == "worth repeating"
    assert fwd["author"]["user_id"] == bob.uid
    assert fwd["message_id"] == src["message_id"] and fwd["channel_id"] == cid
    assert fwd["source"] == "#general · G"
    assert res["message"]["content"] == ""


async def test_forward_with_a_note(guild):
    gid, cid, (alice,) = await guild("alice")
    src = await alice.ok("message.send", {"channel_id": cid, "content": "original"})
    res = await alice.ok("message.forward", {
        "message_id": src["message_id"], "channel_id": cid, "content": "look at this",
    })
    assert res["message"]["content"] == "look at this"
    assert res["message"]["forward"]["content"] == "original"


async def test_the_snapshot_doesnt_follow_edits_or_deletes(guild):
    gid, cid, (alice,) = await guild("alice")
    src = await alice.ok("message.send", {"channel_id": cid, "content": "before"})
    res = await alice.ok("message.forward", {"message_id": src["message_id"], "channel_id": cid})
    await alice.ok("message.edit", {"message_id": src["message_id"], "content": "after"})
    await alice.ok("message.delete", {"message_id": src["message_id"]})
    page = await alice.ok("channel.history", {"channel_id": cid})
    copy = next(m for m in page["messages"] if m["message_id"] == res["message_id"])
    assert copy["forward"]["content"] == "before"


async def test_attachments_are_listed_without_urls(guild, ctx):
    gid, cid, (alice,) = await guild("alice")
    aid = "999000111"
    ctx.db.create_attachment(
        aid, uploader_id=alice.uid, channel_id=cid, filename="cat.png",
        content_type="image/png", size=1234, width=10, height=10,
    )
    src = await alice.ok("message.send", {"channel_id": cid, "content": "pic", "attachment_ids": [aid]})
    res = await alice.ok("message.forward", {"message_id": src["message_id"], "channel_id": cid})
    files = res["message"]["forward"]["attachments"]
    assert files == [{"filename": "cat.png", "content_type": "image/png", "size": 1234}]


async def test_forwarding_needs_to_see_the_source(guild, user):
    gid, cid, (alice,) = await guild("alice")
    src = await alice.ok("message.send", {"channel_id": cid, "content": "secret"})
    mallory = await user("mallory")
    mgid, mcid, _ = "", "", None
    res = await mallory.ok("guild.create", {"name": "M"})
    target = res["channels"][0]["channel_id"]
    assert await mallory.err("message.forward", {
        "message_id": src["message_id"], "channel_id": target,
    }) == "not_found"


async def test_forwarding_needs_to_send_in_the_target(guild, user):
    gid, cid, (alice, bob) = await guild("alice", "bob")
    src = await alice.ok("message.send", {"channel_id": cid, "content": "x"})
    locked = (await alice.ok("channel.create", {
        "guild_id": gid, "name": "locked", "kind": "text",
        "overwrites": [{"role_id": gid, "allow": 1, "deny": 2}],  # view, no send
    }))["channel"]["channel_id"]
    await bob.drain()
    assert await bob.err("message.forward", {"message_id": src["message_id"], "channel_id": locked}) == "forbidden"


async def test_forward_reaches_the_target_channel(guild):
    gid, cid, (alice, bob) = await guild("alice", "bob")
    src = await alice.ok("message.send", {"channel_id": cid, "content": "x"})
    await bob.drain()
    await alice.ok("message.forward", {"message_id": src["message_id"], "channel_id": cid})
    events = [e for e in await bob.drain(0.3) if e["type"] == "message.new"]
    assert events and events[-1]["payload"]["forward"]["content"] == "x"


async def test_forwarding_into_a_dm_goes_through_the_same_gate(user):
    alice = await user("alice")
    bob = await user("bob")
    ch = (await alice.ok("dm.open", {"user_id": bob.uid}))["channel"]["channel_id"]
    src = await alice.ok("message.send", {"channel_id": ch, "content": "hello"})
    # bob's default privacy turns that first message into a request, and a
    # forward is no way around waiting for it.
    assert (await alice.ok("dm.list"))["channels"][0]["request"]["state"] == "pending"
    assert await alice.err("message.forward", {
        "message_id": src["message_id"], "channel_id": ch,
    }) == "request_pending"
    await bob.ok("dm.request.accept", {"channel_id": ch})
    res = await alice.ok("message.forward", {"message_id": src["message_id"], "channel_id": ch})
    assert res["message"]["forward"]["content"] == "hello"


async def test_forwarding_to_someone_who_blocked_you_is_refused(user):
    alice = await user("alice")
    bob = await user("bob")
    ch = (await alice.ok("dm.open", {"user_id": bob.uid}))["channel"]["channel_id"]
    src = await alice.ok("message.send", {"channel_id": ch, "content": "hello"})
    await bob.ok("user.block", {"user_id": alice.uid})
    assert await alice.err("message.forward", {"message_id": src["message_id"], "channel_id": ch}) == "blocked"


# --- mark unread ----------------------------------------------------------------


async def test_mark_unread_moves_the_marker_back(guild, ctx):
    gid, cid, (alice,) = await guild("alice")
    ids = [ctx.db.create_message(cid, alice.uid, f"m{i}")["message_id"] for i in range(4)]
    await alice.ok("channel.ack", {"channel_id": cid, "message_id": ids[-1]})
    rs = (await alice.ok("channel.ack", {"channel_id": cid, "message_id": ids[1], "unread": True}))["read_state"]
    # Just before m1, so m1 onwards read as new.
    assert rs["last_read_id"] == str(int(ids[1]) - 1)
    assert rs["last_message_id"] == ids[-1]


async def test_a_normal_ack_never_moves_backwards(guild, ctx):
    gid, cid, (alice,) = await guild("alice")
    ids = [ctx.db.create_message(cid, alice.uid, f"m{i}")["message_id"] for i in range(3)]
    await alice.ok("channel.ack", {"channel_id": cid, "message_id": ids[-1]})
    rs = (await alice.ok("channel.ack", {"channel_id": cid, "message_id": ids[0]}))["read_state"]
    assert rs["last_read_id"] == ids[-1]


async def test_mark_unread_reaches_your_other_windows(guild, connect, ctx):
    gid, cid, (alice,) = await guild("alice")
    ids = [ctx.db.create_message(cid, alice.uid, f"m{i}")["message_id"] for i in range(2)]
    other = await connect()
    await other.ok("auth.resume", {"session_token": alice.token})
    await other.drain()
    await alice.ok("channel.ack", {"channel_id": cid, "message_id": ids[0], "unread": True})
    assert "read_state.updated" in types(await other.drain(0.3))
