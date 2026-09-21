"""Announcements inbox and the v0.6 server settings (PROTOCOL.md §5 Announcements, §4 Server config)."""

from conftest import types


async def test_owner_posts_everyone_reads(owner, user):
    a = await user("alice")
    assert await a.err("announcement.create", {"content": "hi"}) == "forbidden"
    assert await owner.err("announcement.create", {"content": "   "}) == "bad_request"
    item = (await owner.ok("announcement.create", {"content": "**Server update:** we have friends now"}))["announcement"]
    assert item["kind"] == "post" and item["author_id"] is not None
    ev = [e for e in await a.drain() if e["type"] == "announcement.created"]
    assert ev and ev[0]["payload"]["announcement_id"] == item["announcement_id"]
    listing = await a.ok("announcement.list")
    assert listing["unread"] == 1 and [x["announcement_id"] for x in listing["announcements"]] == [item["announcement_id"]]
    # The author's own post is already read.
    assert (await owner.ok("announcement.list"))["unread"] == 0
    state = await a.ok("announcement.ack", {"announcement_id": item["announcement_id"]})
    assert state["unread"] == 0 and state["last_read_id"] == item["announcement_id"]
    edited = (await owner.ok("announcement.update", {"announcement_id": item["announcement_id"], "content": "edited"}))
    assert edited["announcement"]["content"] == "edited" and edited["announcement"]["edited_at"]
    await owner.ok("announcement.delete", {"announcement_id": item["announcement_id"]})
    assert "announcement.deleted" in types(await a.drain())
    assert await owner.err("announcement.delete", {"announcement_id": item["announcement_id"]}) == "not_found"


async def test_admins_can_post_when_allowed(owner, user, db):
    a = await user("alice")
    await owner.ok("admin.staff.set", {"user_id": a.uid, "role": "admin"})
    assert await a.err("announcement.create", {"content": "hi"}) == "forbidden"
    await owner.ok("server.config.update", {"announcements_admins": True})
    await a.ok("announcement.create", {"content": "hi from an admin"})


async def test_legal_change_posts_automatically(owner, user):
    a = await user("alice")
    await owner.ok("admin.legal.set", {"terms": "Be nice."})
    items = (await a.ok("announcement.list"))["announcements"]
    assert items[0]["kind"] == "legal" and items[0]["author_id"] is None and "Terms of Service" in items[0]["content"]
    # Saving the same text again isn't a change.
    await owner.ok("admin.legal.set", {"terms": "Be nice."})
    assert len((await a.ok("announcement.list"))["announcements"]) == 1
    assert await owner.err(
        "announcement.update", {"announcement_id": items[0]["announcement_id"], "content": "x"}
    ) == "forbidden"


async def test_new_server_settings(owner):
    cfg = (await owner.ok("server.info"))
    assert cfg["user_search"] == "off" and cfg["announcements_admins"] is False
    assert await owner.err("server.config.update", {"user_search": "sometimes"}) == "bad_request"
    cfg = (await owner.ok("server.config.update", {"user_search": "on"}))["config"]
    assert cfg["user_search"] == "on"
