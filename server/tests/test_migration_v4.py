"""A v3 (migration 2) database upgrades to v4 in place."""

import sqlite3

from nightcord import db as dbmod
from nightcord.db import Database, _migration_2


def test_v3_database_upgrades(tmp_path):
    path = tmp_path / "v3.db"
    conn = sqlite3.connect(path)
    for stmt in dbmod.MIGRATIONS[0].split(";"):
        if stmt.strip():
            conn.execute(stmt)
    _migration_2(conn)
    conn.execute("PRAGMA user_version = 2")
    conn.execute("INSERT INTO users(user_id, username, username_lower, password_hash, created_at) VALUES ('1','a','a','x','x')")
    conn.execute("INSERT INTO guilds(guild_id, name, owner_user_id, created_at) VALUES ('10','G','1','x')")
    conn.execute("INSERT INTO roles(role_id, guild_id, name, permissions, position, created_at) VALUES ('10','10','@everyone',1,0,'x')")
    conn.execute("INSERT INTO channels(channel_id, guild_id, kind, name, created_at) VALUES ('20','10','text','general','x')")
    conn.execute("INSERT INTO messages(message_id, channel_id, author_user_id, content, sent_at) VALUES (30,'20','1','hi','x')")
    conn.commit()
    conn.close()

    d = Database(path)
    assert d.conn.execute("PRAGMA user_version").fetchone()[0] == len(dbmod.MIGRATIONS) == 12
    user = d.public_user("1")
    assert user["perks"] is False and user["banner_id"] is None and user["profile_colors"] is None
    assert d.get_guild("10")["banner_id"] is None
    role = d.get_role("10")
    assert role["colors"] is None and role["icon_id"] is None and role["icon_emoji"] is None
    msg = d.get_message(30)
    assert msg["content"] == "hi" and msg["stickers"] == []
    assert d.list_emojis("10") == [] and d.list_stickers("10") == []
    d.close()


def test_v11_database_gets_the_embed_cache(tmp_path):
    """Migration 12 adds embed_cache; what was already there stays."""
    path = tmp_path / "v11.db"
    d = Database(path)
    uid = d.create_user("keeper", "x")["user_id"]
    d.conn.execute("DROP TABLE embed_cache")
    d.conn.execute("PRAGMA user_version = 11")
    d.close()
    d = Database(path)
    assert d.conn.execute("PRAGMA user_version").fetchone()[0] == 12
    assert d.public_user(uid)["username"] == "keeper"
    d.embed_cache_put("https://a.example", {"kind": "link"}, 2**31)
    assert d.embed_cache_get("https://a.example")[0] == {"kind": "link"}
    d.close()
