"""How much space the server uses, and on what (PROTOCOL.md §5 Admin,
admin.storage): the database broken down by what its tables hold, plus the
upload folders on disk.

SQLite builds with the dbstat table report exact per-table sizes. Most
don't (Python's bundled SQLite usually doesn't), so otherwise each table's
share is estimated from the length of what's stored in it and scaled so the
parts add up to the pages actually in use.
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

# Which slice of the chart a table belongs to. Anything unlisted is "other".
TABLE_CATEGORY = {
    "messages": "messages", "reactions": "messages", "polls": "messages", "poll_answers": "messages",
    "poll_votes": "messages", "saved_messages": "messages", "attachments": "messages",
    "users": "users", "sessions": "users", "relationships": "users", "user_notes": "users",
    "user_badges": "users", "badges": "users", "read_states": "users", "notify_prefs": "users",
    "dm_recipients": "users",
    "guilds": "servers", "memberships": "servers", "roles": "servers", "member_roles": "servers",
    "channels": "servers", "channel_overwrites": "servers", "invites": "servers", "bans": "servers",
    "emojis": "servers", "stickers": "servers",
    "embed_cache": "previews",
    "audit_log": "logs", "server_audit_log": "logs", "announcements": "logs", "ip_bans": "logs",
    "device_bans": "logs",
}
# Media kinds (PROTOCOL.md §4 media) -> slice.
MEDIA_CATEGORY = {"emoji": "emoji", "sticker": "emoji"}
CATEGORIES = ("messages", "attachments", "emoji", "images", "previews", "users", "servers", "logs", "other", "free")


def category_of(table: str) -> str:
    if table.startswith("messages_fts"):
        return "messages"  # the search index is part of what messages cost
    return TABLE_CATEGORY.get(table, "other")


def _tables(conn: sqlite3.Connection) -> dict[str, str]:
    """name -> owning table, for every table and index (FTS shadow tables included)."""
    rows = conn.execute(
        "SELECT name, tbl_name, type, sql FROM sqlite_master WHERE type IN ('table', 'index')"
    ).fetchall()
    out = {}
    for name, tbl, kind, sql in rows:
        if kind == "table" and sql and sql.upper().startswith("CREATE VIRTUAL"):
            continue  # a virtual table holds nothing itself; its shadow tables do
        out[name] = tbl if kind == "index" else name
    return out


def _exact_sizes(conn: sqlite3.Connection) -> dict[str, int] | None:
    try:
        rows = conn.execute("SELECT name, SUM(pgsize) FROM dbstat GROUP BY name").fetchall()
    except sqlite3.OperationalError:
        return None  # no dbstat in this build
    owner = _tables(conn)
    out: dict[str, int] = {}
    for name, size in rows:
        table = owner.get(name, name)
        out[table] = out.get(table, 0) + (size or 0)
    return out


def _estimated_sizes(conn: sqlite3.Connection, used: int) -> dict[str, int]:
    """Bytes stored per table, scaled to `used` (the pages in use)."""
    raw: dict[str, int] = {}
    for name, owner in _tables(conn).items():
        if name != owner or name.startswith("sqlite_"):
            continue
        cols = [r[1] for r in conn.execute(f'PRAGMA table_info("{name}")').fetchall()]
        if not cols:
            continue
        lengths = " + ".join(f'COALESCE(length("{c}"), 0)' for c in cols)
        # A few bytes of per-row overhead on top of the data, so tables of
        # many small rows don't read as free.
        total, count = conn.execute(f'SELECT COALESCE(SUM({lengths}), 0), COUNT(*) FROM "{name}"').fetchone()
        raw[name] = int(total) + int(count) * 12
    stored = sum(raw.values())
    if not stored:
        return {name: 0 for name in raw}
    return {name: round(size * used / stored) for name, size in raw.items()}


def _folder_bytes(folder: Path) -> tuple[int, int]:
    """(bytes, files) under folder, recursively; (0, 0) if it's missing."""
    total = files = 0
    if not folder.is_dir():
        return 0, 0
    for root, _dirs, names in os.walk(folder):
        for n in names:
            try:
                total += os.stat(os.path.join(root, n)).st_size
                files += 1
            except OSError:
                pass
    return total, files


def breakdown(db, data_dir: Path) -> dict:
    """The admin.storage result (PROTOCOL.md §5 Admin)."""
    conn = db.conn
    page_size = conn.execute("PRAGMA page_size").fetchone()[0]
    page_count = conn.execute("PRAGMA page_count").fetchone()[0]
    free_pages = conn.execute("PRAGMA freelist_count").fetchone()[0]
    used = (page_count - free_pages) * page_size
    exact = _exact_sizes(conn)
    tables = exact if exact is not None else _estimated_sizes(conn, used)

    path = db.path
    file_bytes = path.stat().st_size if path and path.exists() else page_count * page_size
    wal_bytes = sum(
        p.stat().st_size for p in (Path(f"{path}-wal"), Path(f"{path}-shm")) if path and p.exists()
    )

    slices = {key: {"key": key, "bytes": 0, "db_bytes": 0, "file_bytes": 0, "files": 0} for key in CATEGORIES}
    for table, size in tables.items():
        slices[category_of(table)]["db_bytes"] += size
    slices["free"]["db_bytes"] = free_pages * page_size
    slices["other"]["db_bytes"] += wal_bytes

    attachments, n = _folder_bytes(data_dir / "files")
    slices["attachments"]["file_bytes"], slices["attachments"]["files"] = attachments, n
    for kind, size, count in conn.execute(
        "SELECT kind, COALESCE(SUM(size), 0), COUNT(*) FROM media GROUP BY kind"
    ).fetchall():
        s = slices[MEDIA_CATEGORY.get(kind, "images")]
        s["file_bytes"] += size
        s["files"] += count
    legacy, n = _folder_bytes(data_dir / "avatars")  # older base64 avatar uploads
    slices["images"]["file_bytes"] += legacy
    slices["images"]["files"] += n
    proxied, n = _folder_bytes(data_dir / "proxy-cache")
    slices["previews"]["file_bytes"] += proxied
    slices["previews"]["files"] += n // 2  # each cached file has a .type sidecar
    rules, n = _folder_bytes(data_dir / "legal")
    slices["other"]["file_bytes"] += rules
    slices["other"]["files"] += n

    for s in slices.values():
        s["bytes"] = s["db_bytes"] + s["file_bytes"]
    unclaimed = conn.execute("SELECT COUNT(*), COALESCE(SUM(size), 0) FROM media WHERE claimed = 0").fetchone()
    previews = conn.execute("SELECT COUNT(*) FROM embed_cache").fetchone()[0]
    return {
        "total_bytes": sum(s["bytes"] for s in slices.values()),
        "database": {
            "file_bytes": file_bytes, "wal_bytes": wal_bytes, "page_size": page_size,
            "page_count": page_count, "free_bytes": free_pages * page_size, "exact": exact is not None,
        },
        "categories": [slices[k] for k in CATEGORIES],
        "unclaimed_media": {"count": unclaimed[0], "bytes": unclaimed[1]},
        "cached_previews": previews,
    }
