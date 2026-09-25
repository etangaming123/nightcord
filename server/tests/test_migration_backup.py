"""Opening an older database snapshots it before migrating (db.py
_backup_before_migrating); fresh and up-to-date databases aren't copied."""

import sqlite3

from nightcord import db as dbmod
from nightcord.db import Database


def _old_db(path, version=1):
    conn = sqlite3.connect(path)
    for stmt in dbmod.MIGRATIONS[0].split(";"):
        if stmt.strip():
            conn.execute(stmt)
    conn.execute(f"PRAGMA user_version = {version}")
    conn.execute("INSERT INTO users(user_id, username, username_lower, password_hash, created_at) VALUES ('1','old','old','x','x')")
    conn.commit()
    conn.close()


def test_old_database_is_copied_before_migrating(tmp_path):
    path = tmp_path / "data" / "nightcord.db"
    path.parent.mkdir()
    _old_db(path)
    backups = tmp_path / "backups"
    d = Database(path, backup_dir=backups)
    assert d.conn.execute("PRAGMA user_version").fetchone()[0] == len(dbmod.MIGRATIONS)
    d.close()
    (copy,) = backups.glob("pre-migrate-v1-to-v*.db")
    old = sqlite3.connect(copy)
    assert old.execute("PRAGMA user_version").fetchone()[0] == 1
    assert old.execute("SELECT username FROM users").fetchall() == [("old",)]
    old.close()
    # Already current: nothing new is copied.
    Database(path, backup_dir=backups).close()
    assert len(list(backups.glob("pre-migrate-*.db"))) == 1


def test_fresh_database_is_not_copied(tmp_path):
    Database(tmp_path / "n.db").close()
    assert not (tmp_path / "backups").exists()


def test_only_the_newest_copies_are_kept(tmp_path):
    backups = tmp_path / "backups"
    for i in range(dbmod.PRE_MIGRATE_KEEP + 2):
        path = tmp_path / f"db{i}.db"
        _old_db(path)
        Database(path, backup_dir=backups).close()
    assert len(list(backups.glob("pre-migrate-*.db"))) == dbmod.PRE_MIGRATE_KEEP
