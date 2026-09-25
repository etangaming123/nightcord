"""admin.users.list sorting and filters, and last_seen tracking
(PROTOCOL.md §5 Admin)."""




async def _names(owner, **payload):
    return [u["username"] for u in (await owner.ok("admin.users.list", payload))["users"]]


async def test_sorting(owner, user, ctx):
    a, b, c = await user("alice"), await user("bob"), await user("carol")
    await ctx.hub.close_where(lambda conn: conn.user_id == c.uid)
    ctx.db.conn.execute("UPDATE users SET display_name = 'Zed' WHERE username = 'alice'")
    assert await _names(owner) == ["owner", "alice", "bob", "carol"]  # joined, oldest first
    assert await _names(owner, sort="joined", order="desc") == ["carol", "bob", "alice", "owner"]
    assert await _names(owner, sort="name") == ["bob", "carol", "owner", "alice"]  # "Zed" last
    assert await owner.err("admin.users.list", {"sort": "shoe size"}) == "bad_request"


async def test_flags_and_windows(owner, user, ctx):
    a, b = await user("alice"), await user("bob")
    await owner.ok("admin.staff.set", {"user_id": a.uid, "role": "moderator"})
    ctx.db.conn.execute("UPDATE users SET perks = 1 WHERE username = 'bob'")
    assert await _names(owner, flags=["staff"]) == ["owner", "alice"]
    assert await _names(owner, flags=["perks"]) == ["bob"]
    assert await _names(owner, flags=["staff", "perks"]) == []
    assert set(await _names(owner, flags=["online"])) == {"owner", "alice", "bob"}
    users = (await owner.ok("admin.users.list", {}))["users"]
    assert all(u["online"] for u in users)
    assert await _names(owner, seen="7d") == ["owner", "alice", "bob"]
    assert await _names(owner, seen="never") == []
    ctx.db.conn.execute("UPDATE sessions SET last_seen = '2000-01-01T00:00:00.000Z' WHERE user_id = ?", (b.uid,))
    assert await _names(owner, seen="inactive30") == ["bob"]
    ctx.db.conn.execute("UPDATE users SET created_at = '2000-01-01T00:00:00.000Z' WHERE username = 'owner'")
    assert await _names(owner, joined="30d") == ["alice", "bob"]
    assert await owner.err("admin.users.list", {"flags": ["nope"]}) == "bad_request"
    assert await owner.err("admin.users.list", {"flags": "staff"}) == "bad_request"


async def test_last_seen_moves_on_disconnect(owner, user, ctx):
    alice = await user("alice")
    ctx.db.conn.execute("UPDATE sessions SET last_seen = '2000-01-01T00:00:00.000Z' WHERE user_id = ?", (alice.uid,))
    await ctx.hub.close_where(lambda conn: conn.user_id == alice.uid)
    (row,) = [u for u in (await owner.ok("admin.users.list", {"query": "alice"}))["users"]]
    assert row["last_seen"] > "2020" and row["online"] is False
