"""Saved messages and private notes (PROTOCOL.md §4 Saved message, User note)."""

from __future__ import annotations

from conftest import types


async def test_save_and_list(guild):
    gid, cid, (alice,) = await guild("alice")
    mid = (await alice.ok("message.send", {"channel_id": cid, "content": "keep me"}))["message_id"]
    out = await alice.ok("saved.add", {"message_id": mid})
    assert out["saved"] is True and out["count"] == 1
    page = await alice.ok("saved.list")
    assert [m["message_id"] for m in page["messages"]] == [mid]
    assert page["messages"][0]["content"] == "keep me"
    assert page["messages"][0]["saved_at"] and page["messages"][0]["guild_id"] == gid
    assert page["has_more"] is False and page["next"]


async def test_saving_twice_is_harmless(guild):
    gid, cid, (alice,) = await guild("alice")
    mid = (await alice.ok("message.send", {"channel_id": cid, "content": "x"}))["message_id"]
    await alice.ok("saved.add", {"message_id": mid})
    assert (await alice.ok("saved.add", {"message_id": mid}))["count"] == 1


async def test_unsave(guild):
    gid, cid, (alice,) = await guild("alice")
    mid = (await alice.ok("message.send", {"channel_id": cid, "content": "x"}))["message_id"]
    await alice.ok("saved.add", {"message_id": mid})
    out = await alice.ok("saved.remove", {"message_id": mid})
    assert out["saved"] is False and out["count"] == 0
    assert (await alice.ok("saved.list"))["messages"] == []
    # Removing something that isn't saved is fine.
    await alice.ok("saved.remove", {"message_id": mid})


async def test_saving_is_private(guild):
    gid, cid, (alice, bob) = await guild("alice", "bob")
    mid = (await alice.ok("message.send", {"channel_id": cid, "content": "x"}))["message_id"]
    await bob.drain()
    await alice.ok("saved.add", {"message_id": mid})
    assert types(await bob.drain(0.2)) == []
    assert (await bob.ok("saved.list"))["messages"] == []


async def test_other_windows_of_the_same_account_are_told(guild, connect):
    gid, cid, (alice,) = await guild("alice")
    other = await connect()
    await other.ok("auth.resume", {"session_token": alice.token})
    await other.drain()
    mid = (await alice.ok("message.send", {"channel_id": cid, "content": "x"}))["message_id"]
    await other.drain()
    await alice.ok("saved.add", {"message_id": mid})
    events = [e for e in await other.drain(0.3) if e["type"] == "saved.updated"]
    assert events and events[0]["payload"] == {"message_id": mid, "saved": True, "count": 1}


async def test_cant_save_a_message_you_cant_see(guild, user):
    gid, cid, (alice,) = await guild("alice")
    mid = (await alice.ok("message.send", {"channel_id": cid, "content": "secret"}))["message_id"]
    outsider = await user("mallory")
    assert await outsider.err("saved.add", {"message_id": mid}) == "not_found"


async def test_losing_access_drops_it_from_the_list(guild, ctx):
    gid, cid, (alice, bob) = await guild("alice", "bob")
    mid = (await alice.ok("message.send", {"channel_id": cid, "content": "x"}))["message_id"]
    await bob.ok("saved.add", {"message_id": mid})
    assert len((await bob.ok("saved.list"))["messages"]) == 1
    # Take VIEW_CHANNEL away from @everyone in that channel.
    await alice.ok("channel.update", {
        "channel_id": cid,
        "overwrites": [{"role_id": gid, "allow": 0, "deny": 1}],
    })
    page = await bob.ok("saved.list")
    assert page["messages"] == []
    assert page["count"] == 1  # still saved, just not readable
    # It can still be taken off the list.
    assert (await bob.ok("saved.remove", {"message_id": mid}))["count"] == 0


async def test_deleting_the_message_unsaves_it(guild, ctx):
    gid, cid, (alice,) = await guild("alice")
    mid = (await alice.ok("message.send", {"channel_id": cid, "content": "x"}))["message_id"]
    await alice.ok("saved.add", {"message_id": mid})
    await alice.ok("message.delete", {"message_id": mid})
    assert (await alice.ok("saved.list"))["count"] == 0


async def test_paging(guild, ctx):
    gid, cid, (alice,) = await guild("alice")
    ids = []
    for i in range(6):
        # Straight to the database: message.send is rate limited to 5 per 5 s.
        mid = ctx.db.create_message(cid, alice.uid, f"m{i}")["message_id"]
        await alice.ok("saved.add", {"message_id": mid})
        ids.append(mid)
    page = await alice.ok("saved.list", {"limit": 4})
    assert len(page["messages"]) == 4
    assert [m["message_id"] for m in page["messages"]] == list(reversed(ids))[:4]
    rest = await alice.ok("saved.list", {"limit": 4, "before": page["next"]})
    assert [m["message_id"] for m in rest["messages"]] == list(reversed(ids))[4:]


async def test_a_page_short_on_readable_rows_still_pages_on(guild, ctx):
    """Filtered-out rows must not end the list early, or cost a page."""
    gid, cid, (alice, bob) = await guild("alice", "bob")
    private = (await alice.ok("channel.create", {
        "guild_id": gid, "name": "private", "kind": "text",
        "overwrites": [{"role_id": gid, "allow": 0, "deny": 1}],
    }))["channel"]["channel_id"]
    readable, hidden = [], []
    for i in range(4):
        hidden.append(ctx.db.create_message(private, alice.uid, f"h{i}")["message_id"])
        readable.append(ctx.db.create_message(cid, alice.uid, f"r{i}")["message_id"])
    for mid in hidden + readable:
        ctx.db.save_message(bob.uid, int(mid))
    seen, cursor = [], None
    for _ in range(6):
        page = await bob.ok("saved.list", {"limit": 2, **({"before": cursor} if cursor else {})})
        seen += [m["message_id"] for m in page["messages"]]
        cursor = page["next"]
        if not page["has_more"]:
            break
    assert sorted(seen) == sorted(readable)


async def test_deleting_the_account_clears_its_saves(guild, ctx):
    gid, cid, (alice, bob) = await guild("alice", "bob")
    mid = (await alice.ok("message.send", {"channel_id": cid, "content": "x"}))["message_id"]
    await bob.ok("saved.add", {"message_id": mid})
    ctx.db.anonymize_user(bob.uid)
    assert ctx.db.saved_count(bob.uid) == 0


# --- notes ---------------------------------------------------------------------


async def test_note_round_trip(user):
    alice = await user("alice")
    bob = await user("bob")
    assert (await alice.ok("user.profile", {"user_id": bob.uid}))["note"] is None
    out = await alice.ok("user.note.set", {"user_id": bob.uid, "note": "  met at the thing  "})
    assert out["note"] == "met at the thing"
    assert (await alice.ok("user.profile", {"user_id": bob.uid}))["note"] == "met at the thing"


async def test_notes_are_one_sided(user):
    alice = await user("alice")
    bob = await user("bob")
    await alice.ok("user.note.set", {"user_id": bob.uid, "note": "owes me a fiver"})
    assert (await bob.ok("user.profile", {"user_id": alice.uid}))["note"] is None
    assert (await bob.ok("user.profile", {"user_id": bob.uid}))["note"] is None


async def test_clearing_a_note(user):
    alice = await user("alice")
    bob = await user("bob")
    await alice.ok("user.note.set", {"user_id": bob.uid, "note": "x"})
    assert (await alice.ok("user.note.set", {"user_id": bob.uid, "note": ""}))["note"] is None
    assert (await alice.ok("user.profile", {"user_id": bob.uid}))["note"] is None


async def test_note_length_and_unknown_user(user):
    alice = await user("alice")
    bob = await user("bob")
    assert await alice.err("user.note.set", {"user_id": bob.uid, "note": "x" * 257}) == "bad_request"
    assert await alice.err("user.note.set", {"user_id": "123", "note": "x"}) == "not_found"


async def test_note_reaches_your_other_windows(user, connect):
    alice = await user("alice")
    bob = await user("bob")
    other = await connect()
    await other.ok("auth.resume", {"session_token": alice.token})
    await other.drain()
    await alice.ok("user.note.set", {"user_id": bob.uid, "note": "hello"})
    events = [e for e in await other.drain(0.3) if e["type"] == "user.note.updated"]
    assert events and events[0]["payload"] == {"user_id": bob.uid, "note": "hello"}


async def test_deleting_an_account_clears_notes_both_ways(user, ctx):
    alice = await user("alice")
    bob = await user("bob")
    await alice.ok("user.note.set", {"user_id": bob.uid, "note": "about bob"})
    await bob.ok("user.note.set", {"user_id": alice.uid, "note": "about alice"})
    ctx.db.anonymize_user(bob.uid)
    assert ctx.db.get_user_note(alice.uid, bob.uid) is None
    assert ctx.db.get_user_note(bob.uid, alice.uid) is None
