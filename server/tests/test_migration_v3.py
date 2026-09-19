"""A v2 database (user_version 1) upgrades to v3 in place."""

import sqlite3

from nightcord import db as dbmod
from nightcord.db import Database


def test_v2_database_upgrades(tmp_path):
    path = tmp_path / "nightcord.db"
    conn = sqlite3.connect(path)
    for stmt in dbmod.MIGRATIONS[0].split(";"):
        if stmt.strip():
            conn.execute(stmt)
    conn.execute("PRAGMA user_version = 1")
    conn.execute(
        "INSERT INTO users(user_id, username, username_lower, password_hash, created_at) "
        "VALUES ('1', 'alice', 'alice', 'x', '2026-01-01T00:00:00.000Z')"
    )
    conn.execute("INSERT INTO guilds VALUES ('10', 'G', '1', 0, '2026-01-01T00:00:00.000Z')")
    conn.execute("INSERT INTO roles VALUES ('10', '10', '@everyone', NULL, 527, 0, '2026-01-01T00:00:00.000Z')")
    conn.execute("INSERT INTO channels(channel_id, guild_id, kind, name, created_at) VALUES ('20', '10', 'text', 'general', 'x')")
    conn.execute("INSERT INTO messages(message_id, channel_id, author_user_id, content, sent_at) VALUES (30, '20', '1', 'old pancakes', 'x')")
    conn.execute("INSERT INTO invites VALUES ('ABCDEFGH', '10', '1', 'x')")
    conn.commit()
    conn.close()

    d = Database(path)
    assert d.conn.execute("PRAGMA user_version").fetchone()[0] == len(dbmod.MIGRATIONS)
    assert d.everyone_permissions("10") == 527 | (1 << 15) | (1 << 16) | (1 << 17)
    assert d.get_message(30)["content"] == "old pancakes" and d.get_message(30)["type"] == "default"
    assert d.get_user("1")["server_role"] == "none"
    assert d.invite_state("ABCDEFGH")[0] == "ok"
    msgs, total = d.search(["20"], query="pancake", author_id=None, has=None, pinned=None, before=None, after=None, offset=0, limit=10)
    assert total == 1  # the FTS index was built from existing messages
    d.close()
