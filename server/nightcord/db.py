"""SQLite storage. All methods return protocol-shaped dicts (PROTOCOL.md §4).

Runs synchronously on the event loop thread: queries are small and local,
and WAL mode lets the admin CLI edit the same file while the server runs.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import secrets
import sqlite3
import time
from pathlib import Path
from typing import Any

from .ids import new_id

SESSION_TTL_SECONDS = 30 * 24 * 3600

DEFAULT_SERVER_CONFIG = {
    "guild_creation": "on",
    "account_creation": "on",
    "guild_list_visible": True,
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    user_id         TEXT PRIMARY KEY,
    username        TEXT NOT NULL,
    username_lower  TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    is_server_owner INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'active',  -- active | pending | rejected
    note            TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    expires_at  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS server_config (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS guilds (
    guild_id       TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    owner_user_id  TEXT NOT NULL REFERENCES users(user_id),
    listed         INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
    guild_id   TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    role       TEXT NOT NULL,  -- owner | member
    ghost      INTEGER NOT NULL DEFAULT 0,
    joined_at  TEXT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS memberships_by_user ON memberships(user_id);
CREATE TABLE IF NOT EXISTS channels (
    channel_id  TEXT PRIMARY KEY,
    guild_id    TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    position    INTEGER NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS channels_by_guild ON channels(guild_id);
CREATE TABLE IF NOT EXISTS messages (
    message_id      INTEGER PRIMARY KEY,
    channel_id      TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
    author_user_id  TEXT NOT NULL REFERENCES users(user_id),
    content         TEXT NOT NULL,
    sent_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_by_channel ON messages(channel_id, message_id);
CREATE TABLE IF NOT EXISTS invites (
    code        TEXT PRIMARY KEY,
    guild_id    TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
    created_by  TEXT NOT NULL REFERENCES users(user_id),
    created_at  TEXT NOT NULL
);
"""

INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _user(row: sqlite3.Row) -> dict:
    return {
        "user_id": row["user_id"],
        "username": row["username"],
        "created_at": row["created_at"],
        "is_server_owner": bool(row["is_server_owner"]),
    }


def _guild(row: sqlite3.Row) -> dict:
    return {
        "guild_id": row["guild_id"],
        "name": row["name"],
        "owner_user_id": row["owner_user_id"],
        "listed": bool(row["listed"]),
        "created_at": row["created_at"],
    }


def _channel(row: sqlite3.Row) -> dict:
    return {
        "channel_id": row["channel_id"],
        "guild_id": row["guild_id"],
        "name": row["name"],
        "position": row["position"],
    }


def _message(row: sqlite3.Row) -> dict:
    return {
        "message_id": str(row["message_id"]),
        "channel_id": row["channel_id"],
        "author_user_id": row["author_user_id"],
        "author_username": row["author_username"],
        "content": row["content"],
        "sent_at": row["sent_at"],
    }


class Database:
    def __init__(self, path: Path | str):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(path), isolation_level=None, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.execute("PRAGMA journal_mode = WAL")
        self.conn.execute("PRAGMA busy_timeout = 5000")
        self.conn.executescript(SCHEMA)

    def close(self) -> None:
        self.conn.close()

    def _one(self, sql: str, *args: Any) -> sqlite3.Row | None:
        return self.conn.execute(sql, args).fetchone()

    def _all(self, sql: str, *args: Any) -> list[sqlite3.Row]:
        return self.conn.execute(sql, args).fetchall()

    def _tx(self):
        """Context manager for an explicit write transaction."""
        return _Tx(self.conn)

    # --- server config -----------------------------------------------------

    def get_server_config(self) -> dict:
        cfg = dict(DEFAULT_SERVER_CONFIG)
        for row in self._all("SELECT key, value FROM server_config"):
            if row["key"] in cfg:
                cfg[row["key"]] = json.loads(row["value"])
        return cfg

    def set_server_config(self, updates: dict) -> dict:
        with self._tx():
            for key, val in updates.items():
                self.conn.execute(
                    "INSERT INTO server_config(key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (key, json.dumps(val)),
                )
        return self.get_server_config()

    # --- users ---------------------------------------------------------------

    def get_user_row(self, user_id: str) -> sqlite3.Row | None:
        return self._one("SELECT * FROM users WHERE user_id = ?", user_id)

    def get_user_row_by_name(self, username: str) -> sqlite3.Row | None:
        return self._one("SELECT * FROM users WHERE username_lower = ?", username.lower())

    def get_user(self, user_id: str) -> dict | None:
        row = self.get_user_row(user_id)
        return _user(row) if row else None

    def create_user(
        self,
        username: str,
        password_hash: str,
        *,
        status: str = "active",
        is_server_owner: bool = False,
        note: str | None = None,
    ) -> dict | None:
        """Returns the user, or None if the username is taken."""
        user_id = new_id()
        try:
            self.conn.execute(
                "INSERT INTO users(user_id, username, username_lower, password_hash, "
                "created_at, is_server_owner, status, note) VALUES (?,?,?,?,?,?,?,?)",
                (
                    user_id, username, username.lower(), password_hash, now_iso(),
                    int(is_server_owner), status, note,
                ),
            )
        except sqlite3.IntegrityError:
            return None
        return self.get_user(user_id)

    def set_password_hash(self, user_id: str, password_hash: str) -> None:
        with self._tx():
            self.conn.execute(
                "UPDATE users SET password_hash = ? WHERE user_id = ?", (password_hash, user_id)
            )
            self.conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))

    def get_server_owner_row(self) -> sqlite3.Row | None:
        return self._one("SELECT * FROM users WHERE is_server_owner = 1")

    def list_users_by_status(self, status: str) -> list[sqlite3.Row]:
        return self._all(
            "SELECT * FROM users WHERE status = ? ORDER BY created_at", status
        )

    def set_user_status(self, username: str, status: str) -> bool:
        cur = self.conn.execute(
            "UPDATE users SET status = ? WHERE username_lower = ? AND is_server_owner = 0",
            (status, username.lower()),
        )
        return cur.rowcount > 0

    # --- sessions ------------------------------------------------------------

    def create_session(self, user_id: str) -> str:
        token = secrets.token_urlsafe(32)
        self.conn.execute(
            "INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)",
            (hash_token(token), user_id, now_iso(), time.time() + SESSION_TTL_SECONDS),
        )
        return token

    def resume_session(self, token: str) -> str | None:
        """Returns user_id and extends expiry, or None if invalid/expired."""
        th = hash_token(token)
        row = self._one("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?", th)
        if row is None:
            return None
        if row["expires_at"] < time.time():
            self.conn.execute("DELETE FROM sessions WHERE token_hash = ?", (th,))
            return None
        self.conn.execute(
            "UPDATE sessions SET expires_at = ? WHERE token_hash = ?",
            (time.time() + SESSION_TTL_SECONDS, th),
        )
        return row["user_id"]

    def delete_session(self, token: str) -> None:
        self.conn.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_token(token),))

    def purge_expired_sessions(self) -> None:
        self.conn.execute("DELETE FROM sessions WHERE expires_at < ?", (time.time(),))

    # --- guilds --------------------------------------------------------------

    def get_guild(self, guild_id: str) -> dict | None:
        row = self._one("SELECT * FROM guilds WHERE guild_id = ?", guild_id)
        return _guild(row) if row else None

    def create_guild(self, name: str, owner_user_id: str) -> tuple[dict, list[dict]]:
        guild_id = new_id()
        ts = now_iso()
        with self._tx():
            self.conn.execute(
                "INSERT INTO guilds(guild_id, name, owner_user_id, listed, created_at) "
                "VALUES (?,?,?,0,?)",
                (guild_id, name, owner_user_id, ts),
            )
            self.conn.execute(
                "INSERT INTO memberships(guild_id, user_id, role, ghost, joined_at) "
                "VALUES (?,?,'owner',0,?)",
                (guild_id, owner_user_id, ts),
            )
            self.conn.execute(
                "INSERT INTO channels(channel_id, guild_id, name, position, created_at) "
                "VALUES (?,?,'general',0,?)",
                (new_id(), guild_id, ts),
            )
        return self.get_guild(guild_id), self.list_channels(guild_id)

    def update_guild(self, guild_id: str, *, name: str | None, listed: bool | None) -> dict:
        with self._tx():
            if name is not None:
                self.conn.execute("UPDATE guilds SET name = ? WHERE guild_id = ?", (name, guild_id))
            if listed is not None:
                self.conn.execute(
                    "UPDATE guilds SET listed = ? WHERE guild_id = ?", (int(listed), guild_id)
                )
        return self.get_guild(guild_id)

    def list_user_guilds(self, user_id: str) -> list[dict]:
        rows = self._all(
            "SELECT g.*, m.ghost FROM guilds g JOIN memberships m ON m.guild_id = g.guild_id "
            "WHERE m.user_id = ? ORDER BY m.joined_at",
            user_id,
        )
        return [{**_guild(r), "ghost": bool(r["ghost"])} for r in rows]

    def list_public_guilds(self) -> list[dict]:
        rows = self._all("SELECT * FROM guilds WHERE listed = 1 ORDER BY name COLLATE NOCASE")
        return [_guild(r) for r in rows]

    def admin_list_guilds(self) -> list[sqlite3.Row]:
        """Every guild, for the admin CLI. Member counts exclude ghosts."""
        return self._all(
            "SELECT g.guild_id, g.name, g.listed, u.username AS owner, "
            "(SELECT COUNT(*) FROM memberships m WHERE m.guild_id = g.guild_id AND m.ghost = 0) AS members "
            "FROM guilds g JOIN users u ON u.user_id = g.owner_user_id ORDER BY g.created_at"
        )

    # --- memberships ---------------------------------------------------------

    def get_membership(self, guild_id: str, user_id: str) -> dict | None:
        row = self._one(
            "SELECT * FROM memberships WHERE guild_id = ? AND user_id = ?", guild_id, user_id
        )
        if row is None:
            return None
        return {
            "guild_id": row["guild_id"],
            "user_id": row["user_id"],
            "role": row["role"],
            "ghost": bool(row["ghost"]),
        }

    def add_membership(self, guild_id: str, user_id: str, *, ghost: bool = False) -> None:
        self.conn.execute(
            "INSERT INTO memberships(guild_id, user_id, role, ghost, joined_at) "
            "VALUES (?,?,'member',?,?)",
            (guild_id, user_id, int(ghost), now_iso()),
        )

    def remove_membership(self, guild_id: str, user_id: str) -> None:
        self.conn.execute(
            "DELETE FROM memberships WHERE guild_id = ? AND user_id = ?", (guild_id, user_id)
        )

    def list_members(self, guild_id: str) -> list[dict]:
        """Non-ghost members only (PROTOCOL.md §7)."""
        rows = self._all(
            "SELECT u.user_id, u.username, m.role FROM memberships m "
            "JOIN users u ON u.user_id = m.user_id "
            "WHERE m.guild_id = ? AND m.ghost = 0 ORDER BY u.username_lower",
            guild_id,
        )
        return [{"user_id": r["user_id"], "username": r["username"], "role": r["role"]} for r in rows]

    def member(self, guild_id: str, user_id: str) -> dict | None:
        row = self._one(
            "SELECT u.user_id, u.username, m.role FROM memberships m "
            "JOIN users u ON u.user_id = m.user_id WHERE m.guild_id = ? AND m.user_id = ?",
            guild_id, user_id,
        )
        return dict(row) if row else None

    def non_ghost_guild_ids(self, user_id: str) -> list[str]:
        return [
            r["guild_id"]
            for r in self._all(
                "SELECT guild_id FROM memberships WHERE user_id = ? AND ghost = 0", user_id
            )
        ]

    def non_ghost_member_ids(self, guild_id: str) -> list[str]:
        return [
            r["user_id"]
            for r in self._all(
                "SELECT user_id FROM memberships WHERE guild_id = ? AND ghost = 0", guild_id
            )
        ]

    def all_member_ids(self, guild_id: str) -> list[str]:
        """Includes ghosts — used for choosing event recipients, never for display."""
        return [
            r["user_id"]
            for r in self._all("SELECT user_id FROM memberships WHERE guild_id = ?", guild_id)
        ]

    # --- invites -------------------------------------------------------------

    def create_invite(self, guild_id: str, created_by: str) -> str:
        while True:
            code = "".join(secrets.choice(INVITE_ALPHABET) for _ in range(8))
            try:
                self.conn.execute(
                    "INSERT INTO invites(code, guild_id, created_by, created_at) VALUES (?,?,?,?)",
                    (code, guild_id, created_by, now_iso()),
                )
                return code
            except sqlite3.IntegrityError:
                continue

    def resolve_invite(self, code: str) -> str | None:
        row = self._one("SELECT guild_id FROM invites WHERE code = ?", code.strip().upper())
        return row["guild_id"] if row else None

    # --- channels ------------------------------------------------------------

    def get_channel(self, channel_id: str) -> dict | None:
        row = self._one("SELECT * FROM channels WHERE channel_id = ?", channel_id)
        return _channel(row) if row else None

    def list_channels(self, guild_id: str) -> list[dict]:
        rows = self._all(
            "SELECT * FROM channels WHERE guild_id = ? ORDER BY position, channel_id", guild_id
        )
        return [_channel(r) for r in rows]

    def create_channel(self, guild_id: str, name: str) -> dict:
        row = self._one(
            "SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM channels WHERE guild_id = ?",
            guild_id,
        )
        channel_id = new_id()
        self.conn.execute(
            "INSERT INTO channels(channel_id, guild_id, name, position, created_at) "
            "VALUES (?,?,?,?,?)",
            (channel_id, guild_id, name, row["pos"], now_iso()),
        )
        return self.get_channel(channel_id)

    def update_channel(self, channel_id: str, *, name: str | None, position: int | None) -> dict:
        with self._tx():
            if name is not None:
                self.conn.execute(
                    "UPDATE channels SET name = ? WHERE channel_id = ?", (name, channel_id)
                )
            if position is not None:
                self.conn.execute(
                    "UPDATE channels SET position = ? WHERE channel_id = ?", (position, channel_id)
                )
        return self.get_channel(channel_id)

    def delete_channel(self, channel_id: str) -> None:
        self.conn.execute("DELETE FROM channels WHERE channel_id = ?", (channel_id,))

    # --- messages ------------------------------------------------------------

    def create_message(self, channel_id: str, author_user_id: str, content: str) -> dict:
        message_id = int(new_id())
        self.conn.execute(
            "INSERT INTO messages(message_id, channel_id, author_user_id, content, sent_at) "
            "VALUES (?,?,?,?,?)",
            (message_id, channel_id, author_user_id, content, now_iso()),
        )
        return self.get_message(message_id)

    def get_message(self, message_id: int) -> dict | None:
        row = self._one(
            "SELECT m.*, u.username AS author_username FROM messages m "
            "JOIN users u ON u.user_id = m.author_user_id WHERE m.message_id = ?",
            message_id,
        )
        return _message(row) if row else None

    def history(
        self, channel_id: str, before_message_id: int | None, limit: int
    ) -> tuple[list[dict], bool]:
        """Newest `limit` messages before the cursor, returned oldest-first."""
        sql = (
            "SELECT m.*, u.username AS author_username FROM messages m "
            "JOIN users u ON u.user_id = m.author_user_id WHERE m.channel_id = ?"
        )
        args: list[Any] = [channel_id]
        if before_message_id is not None:
            sql += " AND m.message_id < ?"
            args.append(before_message_id)
        sql += " ORDER BY m.message_id DESC LIMIT ?"
        args.append(limit + 1)
        rows = self._all(sql, *args)
        has_more = len(rows) > limit
        rows = rows[:limit]
        rows.reverse()
        return [_message(r) for r in rows], has_more


class _Tx:
    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    def __enter__(self):
        self.conn.execute("BEGIN IMMEDIATE")
        return self.conn

    def __exit__(self, exc_type, exc, tb):
        self.conn.execute("ROLLBACK" if exc_type else "COMMIT")
        return False
