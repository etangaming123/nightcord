"""Data tab: admin.storage and admin.storage.action (PROTOCOL.md §5 Admin)."""

import time

from nightcord import storage
from nightcord.db import Database


async def test_storage_is_owner_only_and_adds_up(owner, user, ctx):
    alice = await user("alice")
    assert await alice.err("admin.storage") == "forbidden"
    res = await owner.ok("admin.storage")
    keys = [c["key"] for c in res["categories"]]
    assert keys == list(storage.CATEGORIES)
    assert res["total_bytes"] == sum(c["bytes"] for c in res["categories"])
    assert all(c["bytes"] == c["db_bytes"] + c["file_bytes"] for c in res["categories"])


def test_breakdown_estimates_match_the_pages_in_use(tmp_path):
    db = Database(tmp_path / "data" / "nightcord.db")
    db.embed_cache_put("https://a.example", {"title": "x" * 5000}, int(time.time()) + 60)
    res = storage.breakdown(db, tmp_path / "data")
    d = res["database"]
    in_use = d["page_count"] * d["page_size"] - d["free_bytes"]
    db_parts = sum(c["db_bytes"] for c in res["categories"] if c["key"] not in ("free", "other"))
    other_tables = next(c for c in res["categories"] if c["key"] == "other")["db_bytes"] - d["wal_bytes"]
    assert abs(db_parts + other_tables - in_use) <= 64  # rounding only
    previews = next(c for c in res["categories"] if c["key"] == "previews")
    assert previews["db_bytes"] > 0 and res["cached_previews"] == 1
    db.close()


async def test_actions(owner, ctx):
    ctx.db.embed_cache_put("https://a.example", {"kind": "link"}, int(time.time()) + 60)
    folder = ctx.config.data_dir / "proxy-cache"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / ("a" * 64)).write_bytes(b"x" * 100)
    res = await owner.ok("admin.storage.action", {"action": "clear_previews"})
    assert res["cached_previews"] == 0 and not folder.exists()
    assert ctx.db.embed_cache_get("https://a.example") is None
    res = await owner.ok("admin.storage.action", {"action": "vacuum"})
    assert "categories" in res
    await owner.ok("admin.storage.action", {"action": "purge_unclaimed"})
    assert await owner.err("admin.storage.action", {"action": "format c:"}) == "bad_request"
    audit = (await owner.ok("admin.audit_log"))["entries"]
    assert {"storage.clear_previews", "storage.vacuum", "storage.purge_unclaimed"} <= {e["action"] for e in audit}
