"""SQLite storage. Methods return protocol-shaped dicts (PROTOCOL.md §4).

Runs synchronously on the event loop thread: queries are small and local,
and WAL mode lets the admin CLI edit the same file while the server runs.

Schema changes go in MIGRATIONS; PRAGMA user_version records how many have
been applied.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import secrets
import sqlite3
import time
from pathlib import Path
from typing import Any, Iterable

from .ids import new_id
from .permissions import DEFAULT_EVERYONE

SESSION_TTL_SECONDS = 30 * 24 * 3600

DEFAULT_SERVER_CONFIG = {
    "server_name": None,  # None: use the config file's server_name
    "guild_creation": "on",
    "account_creation": "on",
    "guild_list_visible": True,
}

MIGRATIONS: list[str] = [
    # 1 — Nightcord v2 schema.
    """
    CREATE TABLE users (
        user_id         TEXT PRIMARY KEY,
        username        TEXT NOT NULL,
        username_lower  TEXT NOT NULL UNIQUE,
        password_hash   TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        is_server_owner INTEGER NOT NULL DEFAULT 0,
        status          TEXT NOT NULL DEFAULT 'active',  -- active | pending | rejected | disabled
        note            TEXT,
        display_name    TEXT,
        bio             TEXT,
        avatar_id       TEXT,
        avatar_color    TEXT,
        custom_status   TEXT,
        presence_pref   TEXT NOT NULL DEFAULT 'online'
    );
    CREATE TABLE sessions (
        session_id  TEXT PRIMARY KEY,
        token_hash  TEXT NOT NULL UNIQUE,
        user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        created_at  TEXT NOT NULL,
        last_seen   TEXT NOT NULL,
        expires_at  REAL NOT NULL,
        user_agent  TEXT
    );
    CREATE INDEX sessions_by_user ON sessions(user_id);
    CREATE TABLE server_config (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL
    );
    CREATE TABLE guilds (
        guild_id       TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        owner_user_id  TEXT NOT NULL REFERENCES users(user_id),
        listed         INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL
    );
    CREATE TABLE memberships (
        guild_id         TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
        user_id          TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        role             TEXT NOT NULL,  -- owner | member
        ghost            INTEGER NOT NULL DEFAULT 0,
        joined_at        TEXT NOT NULL,
        timed_out_until  TEXT,
        PRIMARY KEY (guild_id, user_id)
    );
    CREATE INDEX memberships_by_user ON memberships(user_id);
    -- The @everyone role has role_id = guild_id and position 0.
    CREATE TABLE roles (
        role_id      TEXT PRIMARY KEY,
        guild_id     TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        color        TEXT,
        permissions  INTEGER NOT NULL,
        position     INTEGER NOT NULL,
        created_at   TEXT NOT NULL
    );
    CREATE INDEX roles_by_guild ON roles(guild_id);
    CREATE TABLE member_roles (
        guild_id  TEXT NOT NULL,
        user_id   TEXT NOT NULL,
        role_id   TEXT NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, role_id),
        FOREIGN KEY (guild_id, user_id) REFERENCES memberships(guild_id, user_id) ON DELETE CASCADE
    );
    CREATE INDEX member_roles_by_guild ON member_roles(guild_id, user_id);
    CREATE TABLE channels (
        channel_id       TEXT PRIMARY KEY,
        guild_id         TEXT REFERENCES guilds(guild_id) ON DELETE CASCADE,  -- NULL for DMs
        kind             TEXT NOT NULL,  -- text | dm | group_dm
        name             TEXT,
        position         INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL,
        last_message_id  INTEGER,
        dm_key           TEXT UNIQUE,  -- "lowid:highid" for 1:1 DMs
        owner_user_id    TEXT
    );
    CREATE INDEX channels_by_guild ON channels(guild_id);
    CREATE TABLE channel_overwrites (
        channel_id  TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
        role_id     TEXT NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
        allow       INTEGER NOT NULL,
        deny        INTEGER NOT NULL,
        PRIMARY KEY (channel_id, role_id)
    );
    CREATE TABLE dm_recipients (
        channel_id  TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
        user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        hidden      INTEGER NOT NULL DEFAULT 0,
        joined_at   TEXT NOT NULL,
        PRIMARY KEY (channel_id, user_id)
    );
    CREATE INDEX dm_recipients_by_user ON dm_recipients(user_id);
    CREATE TABLE messages (
        message_id        INTEGER PRIMARY KEY,
        channel_id        TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
        author_user_id    TEXT NOT NULL REFERENCES users(user_id),
        content           TEXT NOT NULL,
        sent_at           TEXT NOT NULL,
        edited_at         TEXT,
        reply_to_id       INTEGER,
        mentions          TEXT NOT NULL DEFAULT '[]',
        mention_everyone  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX messages_by_channel ON messages(channel_id, message_id);
    CREATE INDEX messages_by_author ON messages(author_user_id, message_id);
    CREATE TABLE reactions (
        message_id  INTEGER NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
        user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        emoji       TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (message_id, emoji, user_id)
    );
    CREATE TABLE invites (
        code        TEXT PRIMARY KEY,
        guild_id    TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
        created_by  TEXT NOT NULL REFERENCES users(user_id),
        created_at  TEXT NOT NULL
    );
    CREATE TABLE bans (
        guild_id    TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
        user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        reason      TEXT,
        banned_by   TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE audit_log (
        entry_id       INTEGER PRIMARY KEY,
        guild_id       TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
        actor_user_id  TEXT NOT NULL,
        action         TEXT NOT NULL,
        target_id      TEXT,
        details        TEXT NOT NULL DEFAULT '{}',
        created_at     TEXT NOT NULL
    );
    CREATE INDEX audit_by_guild ON audit_log(guild_id, entry_id);
    CREATE TABLE read_states (
        user_id        TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        channel_id     TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
        last_read_id   INTEGER NOT NULL DEFAULT 0,
        mention_count  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, channel_id)
    );
    CREATE TABLE notify_prefs (
        user_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        target_id  TEXT NOT NULL,
        level      TEXT,
        muted      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, target_id)
    );
    """,
]

INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I
REPLY_PREVIEW_CHARS = 120


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def iso_in(seconds: float) -> str:
    t = dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=seconds)
    return t.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _sid(v: int | None) -> str | None:
    return None if v is None else str(v)


def _public_user(row: sqlite3.Row) -> dict:
    return {
        "user_id": row["user_id"],
        "username": row["username"],
        "display_name": row["display_name"],
        "avatar_id": row["avatar_id"],
        "avatar_color": row["avatar_color"],
        "custom_status": row["custom_status"],
        "is_server_owner": bool(row["is_server_owner"]),
    }


def _self_user(row: sqlite3.Row) -> dict:
    return {
        **_public_user(row),
        "bio": row["bio"],
        "created_at": row["created_at"],
        "presence": row["presence_pref"],
    }


def _guild(row: sqlite3.Row) -> dict:
    return {
        "guild_id": row["guild_id"],
        "name": row["name"],
        "owner_user_id": row["owner_user_id"],
        "listed": bool(row["listed"]),
        "created_at": row["created_at"],
    }


def _role(row: sqlite3.Row) -> dict:
    return {
        "role_id": row["role_id"],
        "guild_id": row["guild_id"],
        "name": row["name"],
        "color": row["color"],
        "permissions": row["permissions"],
        "position": row["position"],
        "is_everyone": row["role_id"] == row["guild_id"],
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
        self._migrate()

    def _migrate(self) -> None:
        version = self.conn.execute("PRAGMA user_version").fetchone()[0]
        if version == 0 and self._one("SELECT 1 FROM sqlite_master WHERE name = 'users'"):
            raise RuntimeError(
                "This database was created by Nightcord v1 and can't be upgraded. "
                "Move or delete the data directory and start again."
            )
        for i, sql in enumerate(MIGRATIONS[version:], start=version + 1):
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                for stmt in sql.split(";"):
                    if stmt.strip():
                        self.conn.execute(stmt)
                self.conn.execute(f"PRAGMA user_version = {i}")
                self.conn.execute("COMMIT")
            except Exception:
                self.conn.execute("ROLLBACK")
                raise

    def close(self) -> None:
        self.conn.close()

    def _one(self, sql: str, *args: Any) -> sqlite3.Row | None:
        return self.conn.execute(sql, args).fetchone()

    def _all(self, sql: str, *args: Any) -> list[sqlite3.Row]:
        return self.conn.execute(sql, args).fetchall()

    def _exec(self, sql: str, *args: Any) -> sqlite3.Cursor:
        return self.conn.execute(sql, args)

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
                self._exec(
                    "INSERT INTO server_config(key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    key, json.dumps(val),
                )
        return self.get_server_config()

    # --- users ---------------------------------------------------------------

    def get_user_row(self, user_id: str) -> sqlite3.Row | None:
        return self._one("SELECT * FROM users WHERE user_id = ?", user_id)

    def get_user_row_by_name(self, username: str) -> sqlite3.Row | None:
        return self._one("SELECT * FROM users WHERE username_lower = ?", username.lower())

    def get_user(self, user_id: str) -> dict | None:
        """The user's own view of their account (auth.ok `user`)."""
        row = self.get_user_row(user_id)
        return _self_user(row) if row else None

    def public_user(self, user_id: str) -> dict | None:
        row = self.get_user_row(user_id)
        return _public_user(row) if row else None

    def public_users(self, user_ids: Iterable[str]) -> dict[str, dict]:
        ids = list(set(user_ids))
        out: dict[str, dict] = {}
        for i in range(0, len(ids), 500):
            chunk = ids[i : i + 500]
            marks = ",".join("?" * len(chunk))
            for row in self._all(f"SELECT * FROM users WHERE user_id IN ({marks})", *chunk):
                out[row["user_id"]] = _public_user(row)
        return out

    def profile(self, user_id: str) -> dict | None:
        row = self.get_user_row(user_id)
        if row is None:
            return None
        return {**_public_user(row), "bio": row["bio"], "created_at": row["created_at"]}

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
            self._exec(
                "INSERT INTO users(user_id, username, username_lower, password_hash, "
                "created_at, is_server_owner, status, note) VALUES (?,?,?,?,?,?,?,?)",
                user_id, username, username.lower(), password_hash, now_iso(),
                int(is_server_owner), status, note,
            )
        except sqlite3.IntegrityError:
            return None
        return self.get_user(user_id)

    def set_password_hash(self, user_id: str, password_hash: str, *, keep_token: str | None = None) -> None:
        """Changes the password and revokes every session except keep_token's."""
        with self._tx():
            self._exec("UPDATE users SET password_hash = ? WHERE user_id = ?", password_hash, user_id)
            self._exec(
                "DELETE FROM sessions WHERE user_id = ? AND token_hash != ?",
                user_id, hash_token(keep_token) if keep_token else "",
            )

    def update_profile(self, user_id: str, fields: dict) -> dict:
        allowed = {"display_name", "bio", "avatar_color", "custom_status", "avatar_id", "presence_pref"}
        with self._tx():
            for key, val in fields.items():
                assert key in allowed, key
                self._exec(f"UPDATE users SET {key} = ? WHERE user_id = ?", val, user_id)
        return self.get_user(user_id)

    def get_server_owner_row(self) -> sqlite3.Row | None:
        return self._one("SELECT * FROM users WHERE is_server_owner = 1")

    def list_users(self, *, status: str | None = None, query: str | None = None, limit: int = 200) -> list[dict]:
        sql = "SELECT * FROM users WHERE 1=1"
        args: list[Any] = []
        if status:
            sql += " AND status = ?"
            args.append(status)
        if query:
            sql += " AND (username_lower LIKE ? ESCAPE '\\' OR lower(display_name) LIKE ? ESCAPE '\\')"
            like = "%" + _like_escape(query.lower()) + "%"
            args += [like, like]
        sql += " ORDER BY created_at LIMIT ?"
        args.append(limit)
        return [
            {**_public_user(r), "status": r["status"], "created_at": r["created_at"], "note": r["note"]}
            for r in self._all(sql, *args)
        ]

    def admin_user(self, user_id: str) -> dict | None:
        r = self.get_user_row(user_id)
        if r is None:
            return None
        return {**_public_user(r), "status": r["status"], "created_at": r["created_at"], "note": r["note"]}

    def search_users(self, query: str, *, exclude: str, limit: int = 20) -> list[dict]:
        like = _like_escape(query.lower()) + "%"
        rows = self._all(
            "SELECT * FROM users WHERE status = 'active' AND user_id != ? AND "
            "(username_lower LIKE ? ESCAPE '\\' OR lower(display_name) LIKE ? ESCAPE '\\') "
            "ORDER BY username_lower LIMIT ?",
            exclude, like, like, limit,
        )
        return [_public_user(r) for r in rows]

    def set_user_status(self, user_id: str, status: str) -> bool:
        cur = self._exec(
            "UPDATE users SET status = ? WHERE user_id = ? AND is_server_owner = 0", status, user_id
        )
        if status in ("disabled", "rejected"):
            self._exec("DELETE FROM sessions WHERE user_id = ?", user_id)
        return cur.rowcount > 0

    # --- sessions ------------------------------------------------------------

    def create_session(self, user_id: str, user_agent: str | None = None) -> str:
        token = secrets.token_urlsafe(32)
        ts = now_iso()
        self._exec(
            "INSERT INTO sessions(session_id, token_hash, user_id, created_at, last_seen, expires_at, user_agent) "
            "VALUES (?,?,?,?,?,?,?)",
            new_id(), hash_token(token), user_id, ts, ts, time.time() + SESSION_TTL_SECONDS,
            (user_agent or "")[:300] or None,
        )
        return token

    def resume_session(self, token: str, user_agent: str | None = None) -> str | None:
        """Returns user_id and extends expiry, or None if invalid/expired."""
        th = hash_token(token)
        row = self._one("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?", th)
        if row is None:
            return None
        if row["expires_at"] < time.time():
            self._exec("DELETE FROM sessions WHERE token_hash = ?", th)
            return None
        self._exec(
            "UPDATE sessions SET expires_at = ?, last_seen = ?, user_agent = COALESCE(?, user_agent) "
            "WHERE token_hash = ?",
            time.time() + SESSION_TTL_SECONDS, now_iso(), (user_agent or "")[:300] or None, th,
        )
        return row["user_id"]

    def session_exists(self, token: str) -> bool:
        return self._one("SELECT 1 FROM sessions WHERE token_hash = ?", hash_token(token)) is not None

    def delete_session(self, token: str) -> None:
        self._exec("DELETE FROM sessions WHERE token_hash = ?", hash_token(token))

    def list_sessions(self, user_id: str, current_token: str | None) -> list[dict]:
        cur = hash_token(current_token) if current_token else None
        rows = self._all(
            "SELECT * FROM sessions WHERE user_id = ? AND expires_at >= ? ORDER BY last_seen DESC",
            user_id, time.time(),
        )
        return [
            {
                "session_id": r["session_id"],
                "created_at": r["created_at"],
                "last_seen": r["last_seen"],
                "user_agent": r["user_agent"],
                "current": r["token_hash"] == cur,
            }
            for r in rows
        ]

    def delete_session_by_id(self, user_id: str, session_id: str) -> bool:
        cur = self._exec(
            "DELETE FROM sessions WHERE user_id = ? AND session_id = ?", user_id, session_id
        )
        return cur.rowcount > 0

    def delete_other_sessions(self, user_id: str, keep_token: str | None) -> None:
        self._exec(
            "DELETE FROM sessions WHERE user_id = ? AND token_hash != ?",
            user_id, hash_token(keep_token) if keep_token else "",
        )

    def purge_expired_sessions(self) -> None:
        self._exec("DELETE FROM sessions WHERE expires_at < ?", time.time())

    # --- guilds --------------------------------------------------------------

    def get_guild(self, guild_id: str) -> dict | None:
        row = self._one("SELECT * FROM guilds WHERE guild_id = ?", guild_id)
        return _guild(row) if row else None

    def create_guild(self, name: str, owner_user_id: str) -> tuple[dict, list[dict]]:
        guild_id = new_id()
        ts = now_iso()
        with self._tx():
            self._exec(
                "INSERT INTO guilds(guild_id, name, owner_user_id, listed, created_at) VALUES (?,?,?,0,?)",
                guild_id, name, owner_user_id, ts,
            )
            self._exec(
                "INSERT INTO roles(role_id, guild_id, name, color, permissions, position, created_at) "
                "VALUES (?,?,'@everyone',NULL,?,0,?)",
                guild_id, guild_id, DEFAULT_EVERYONE, ts,
            )
            self._exec(
                "INSERT INTO memberships(guild_id, user_id, role, ghost, joined_at) VALUES (?,?,'owner',0,?)",
                guild_id, owner_user_id, ts,
            )
            self._exec(
                "INSERT INTO channels(channel_id, guild_id, kind, name, position, created_at) "
                "VALUES (?,?,'text','general',0,?)",
                new_id(), guild_id, ts,
            )
        return self.get_guild(guild_id), self.list_channels(guild_id)

    def update_guild(self, guild_id: str, *, name: str | None, listed: bool | None) -> dict:
        with self._tx():
            if name is not None:
                self._exec("UPDATE guilds SET name = ? WHERE guild_id = ?", name, guild_id)
            if listed is not None:
                self._exec("UPDATE guilds SET listed = ? WHERE guild_id = ?", int(listed), guild_id)
        return self.get_guild(guild_id)

    def delete_guild(self, guild_id: str) -> None:
        with self._tx():
            # member_roles' composite FK cascades from memberships, which cascade from guilds.
            self._exec("DELETE FROM guilds WHERE guild_id = ?", guild_id)
            self._exec("DELETE FROM notify_prefs WHERE target_id = ?", guild_id)

    def list_user_guilds(self, user_id: str) -> list[dict]:
        rows = self._all(
            "SELECT g.*, m.ghost FROM guilds g JOIN memberships m ON m.guild_id = g.guild_id "
            "WHERE m.user_id = ? ORDER BY m.joined_at",
            user_id,
        )
        return [{**_guild(r), "ghost": bool(r["ghost"])} for r in rows]

    def list_public_guilds(self) -> list[dict]:
        rows = self._all(
            "SELECT g.*, (SELECT COUNT(*) FROM memberships m WHERE m.guild_id = g.guild_id AND m.ghost = 0) AS n "
            "FROM guilds g WHERE listed = 1 ORDER BY name COLLATE NOCASE"
        )
        return [{**_guild(r), "member_count": r["n"]} for r in rows]

    def admin_list_guilds(self) -> list[dict]:
        """Every guild, with owner and non-ghost member count."""
        rows = self._all(
            "SELECT g.*, (SELECT COUNT(*) FROM memberships m WHERE m.guild_id = g.guild_id AND m.ghost = 0) AS n "
            "FROM guilds g ORDER BY g.created_at"
        )
        owners = self.public_users(r["owner_user_id"] for r in rows)
        return [
            {**_guild(r), "member_count": r["n"], "owner": owners.get(r["owner_user_id"])}
            for r in rows
        ]

    # --- memberships ---------------------------------------------------------

    def membership_row(self, guild_id: str, user_id: str) -> sqlite3.Row | None:
        return self._one(
            "SELECT * FROM memberships WHERE guild_id = ? AND user_id = ?", guild_id, user_id
        )

    def get_membership(self, guild_id: str, user_id: str) -> dict | None:
        row = self.membership_row(guild_id, user_id)
        if row is None:
            return None
        return {
            "guild_id": row["guild_id"],
            "user_id": row["user_id"],
            "role": row["role"],
            "ghost": bool(row["ghost"]),
            "timed_out_until": row["timed_out_until"],
        }

    def add_membership(self, guild_id: str, user_id: str, *, ghost: bool = False) -> None:
        with self._tx():
            self._exec(
                "INSERT INTO memberships(guild_id, user_id, role, ghost, joined_at) VALUES (?,?,'member',?,?)",
                guild_id, user_id, int(ghost), now_iso(),
            )
            # Existing history starts out read; only new messages are unread.
            self._exec(
                "INSERT OR REPLACE INTO read_states(user_id, channel_id, last_read_id, mention_count) "
                "SELECT ?, channel_id, COALESCE(last_message_id, 0), 0 FROM channels WHERE guild_id = ?",
                user_id, guild_id,
            )

    def remove_membership(self, guild_id: str, user_id: str) -> None:
        with self._tx():
            self._exec("DELETE FROM memberships WHERE guild_id = ? AND user_id = ?", guild_id, user_id)
            self._exec(
                "DELETE FROM read_states WHERE user_id = ? AND channel_id IN "
                "(SELECT channel_id FROM channels WHERE guild_id = ?)",
                user_id, guild_id,
            )

    def set_timeout(self, guild_id: str, user_id: str, until: str | None) -> None:
        self._exec(
            "UPDATE memberships SET timed_out_until = ? WHERE guild_id = ? AND user_id = ?",
            until, guild_id, user_id,
        )

    def _members(self, guild_id: str, user_id: str | None = None) -> list[dict]:
        sql = "SELECT * FROM memberships WHERE guild_id = ? AND ghost = 0"
        args: list[Any] = [guild_id]
        if user_id is not None:
            sql += " AND user_id = ?"
            args.append(user_id)
        rows = self._all(sql, *args)
        users = self.public_users(r["user_id"] for r in rows)
        roles: dict[str, list[str]] = {}
        role_sql = "SELECT user_id, role_id FROM member_roles WHERE guild_id = ?"
        for r in self._all(role_sql, guild_id):
            roles.setdefault(r["user_id"], []).append(r["role_id"])
        out = [
            {
                "user": users[r["user_id"]],
                "role_ids": roles.get(r["user_id"], []),
                "joined_at": r["joined_at"],
                "timed_out_until": r["timed_out_until"],
                "is_owner": r["role"] == "owner",
            }
            for r in rows
            if r["user_id"] in users
        ]
        out.sort(key=lambda m: m["user"]["username"].lower())
        return out

    def list_members(self, guild_id: str) -> list[dict]:
        """Non-ghost members only (PROTOCOL.md §7)."""
        return self._members(guild_id)

    def member(self, guild_id: str, user_id: str) -> dict | None:
        found = self._members(guild_id, user_id)
        return found[0] if found else None

    def non_ghost_guild_ids(self, user_id: str) -> list[str]:
        return [
            r["guild_id"]
            for r in self._all("SELECT guild_id FROM memberships WHERE user_id = ? AND ghost = 0", user_id)
        ]

    def non_ghost_member_ids(self, guild_id: str) -> list[str]:
        return [
            r["user_id"]
            for r in self._all("SELECT user_id FROM memberships WHERE guild_id = ? AND ghost = 0", guild_id)
        ]

    def all_member_ids(self, guild_id: str) -> list[str]:
        """Includes ghosts — used for choosing event recipients, never for display."""
        return [
            r["user_id"]
            for r in self._all("SELECT user_id FROM memberships WHERE guild_id = ?", guild_id)
        ]

    def audience_of(self, user_id: str) -> set[str]:
        """Users who can see user_id's presence/profile: everyone (ghosts
        included) in guilds where user_id is a visible member, plus DM partners."""
        rows = self._all(
            "SELECT DISTINCT m2.user_id FROM memberships m1 JOIN memberships m2 ON m2.guild_id = m1.guild_id "
            "WHERE m1.user_id = ? AND m1.ghost = 0",
            user_id,
        )
        out = {r["user_id"] for r in rows}
        out |= set(self.dm_partner_ids(user_id))
        out.discard(user_id)
        return out

    # --- roles ---------------------------------------------------------------

    def list_roles(self, guild_id: str) -> list[dict]:
        rows = self._all(
            "SELECT * FROM roles WHERE guild_id = ? ORDER BY position DESC, role_id", guild_id
        )
        return [_role(r) for r in rows]

    def get_role(self, role_id: str) -> dict | None:
        row = self._one("SELECT * FROM roles WHERE role_id = ?", role_id)
        return _role(row) if row else None

    def everyone_permissions(self, guild_id: str) -> int:
        row = self._one("SELECT permissions FROM roles WHERE role_id = ?", guild_id)
        return row["permissions"] if row else 0

    def roles_for_member(self, guild_id: str, user_id: str) -> list[sqlite3.Row]:
        return self._all(
            "SELECT r.role_id, r.permissions, r.position FROM member_roles mr "
            "JOIN roles r ON r.role_id = mr.role_id WHERE mr.guild_id = ? AND mr.user_id = ?",
            guild_id, user_id,
        )

    def count_roles(self, guild_id: str) -> int:
        return self._one("SELECT COUNT(*) AS n FROM roles WHERE guild_id = ?", guild_id)["n"]

    def create_role(self, guild_id: str, *, name: str, color: str | None, permissions: int, position: int | None = None) -> dict:
        role_id = new_id()
        with self._tx():
            top = self._one("SELECT MAX(position) AS p FROM roles WHERE guild_id = ?", guild_id)["p"] or 0
            pos = top + 1 if position is None else max(1, min(position, top + 1))
            self._exec(
                "UPDATE roles SET position = position + 1 WHERE guild_id = ? AND position >= ?",
                guild_id, pos,
            )
            self._exec(
                "INSERT INTO roles(role_id, guild_id, name, color, permissions, position, created_at) "
                "VALUES (?,?,?,?,?,?,?)",
                role_id, guild_id, name, color, permissions, pos, now_iso(),
            )
        return self.get_role(role_id)

    def update_role(self, role_id: str, fields: dict) -> dict:
        with self._tx():
            for key, val in fields.items():
                assert key in ("name", "color", "permissions"), key
                self._exec(f"UPDATE roles SET {key} = ? WHERE role_id = ?", val, role_id)
        return self.get_role(role_id)

    def set_role_positions(self, guild_id: str, ordered_bottom_up: list[str]) -> None:
        with self._tx():
            for pos, role_id in enumerate(ordered_bottom_up, start=1):
                self._exec(
                    "UPDATE roles SET position = ? WHERE role_id = ? AND guild_id = ?", pos, role_id, guild_id
                )

    def delete_role(self, role_id: str) -> None:
        role = self.get_role(role_id)
        with self._tx():
            self._exec("DELETE FROM roles WHERE role_id = ?", role_id)
            self._exec(
                "UPDATE roles SET position = position - 1 WHERE guild_id = ? AND position > ?",
                role["guild_id"], role["position"],
            )

    def member_role_ids(self, guild_id: str, user_id: str) -> list[str]:
        return [
            r["role_id"]
            for r in self._all(
                "SELECT role_id FROM member_roles WHERE guild_id = ? AND user_id = ?", guild_id, user_id
            )
        ]

    def set_member_roles(self, guild_id: str, user_id: str, role_ids: list[str]) -> None:
        with self._tx():
            self._exec("DELETE FROM member_roles WHERE guild_id = ? AND user_id = ?", guild_id, user_id)
            for role_id in role_ids:
                self._exec(
                    "INSERT INTO member_roles(guild_id, user_id, role_id) VALUES (?,?,?)",
                    guild_id, user_id, role_id,
                )

    # --- channels ------------------------------------------------------------

    def _channel(self, row: sqlite3.Row) -> dict:
        base = {
            "channel_id": row["channel_id"],
            "guild_id": row["guild_id"],
            "kind": row["kind"],
            "name": row["name"],
            "last_message_id": _sid(row["last_message_id"]),
        }
        if row["guild_id"] is not None:
            base["position"] = row["position"]
            base["overwrites"] = self.list_overwrites(row["channel_id"])
        else:
            base["owner_user_id"] = row["owner_user_id"]
            ids = self.dm_recipient_ids(row["channel_id"])
            users = self.public_users(ids)
            base["recipients"] = [users[i] for i in ids if i in users]
        return base

    def get_channel(self, channel_id: str) -> dict | None:
        row = self._one("SELECT * FROM channels WHERE channel_id = ?", channel_id)
        return self._channel(row) if row else None

    def channel_row(self, channel_id: str) -> sqlite3.Row | None:
        return self._one("SELECT * FROM channels WHERE channel_id = ?", channel_id)

    def list_channels(self, guild_id: str) -> list[dict]:
        rows = self._all(
            "SELECT * FROM channels WHERE guild_id = ? ORDER BY position, channel_id", guild_id
        )
        return [self._channel(r) for r in rows]

    def create_channel(self, guild_id: str, name: str, overwrites: list[dict] | None = None) -> dict:
        channel_id = new_id()
        with self._tx():
            pos = self._one(
                "SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM channels WHERE guild_id = ?", guild_id
            )["pos"]
            self._exec(
                "INSERT INTO channels(channel_id, guild_id, kind, name, position, created_at) "
                "VALUES (?,?,'text',?,?,?)",
                channel_id, guild_id, name, pos, now_iso(),
            )
            for o in overwrites or []:
                self._exec(
                    "INSERT INTO channel_overwrites(channel_id, role_id, allow, deny) VALUES (?,?,?,?)",
                    channel_id, o["role_id"], o["allow"], o["deny"],
                )
        return self.get_channel(channel_id)

    def update_channel(self, channel_id: str, *, name: str | None, position: int | None) -> dict:
        with self._tx():
            if name is not None:
                self._exec("UPDATE channels SET name = ? WHERE channel_id = ?", name, channel_id)
            if position is not None:
                self._exec("UPDATE channels SET position = ? WHERE channel_id = ?", position, channel_id)
        return self.get_channel(channel_id)

    def list_overwrites(self, channel_id: str) -> list[dict]:
        return [
            {"role_id": r["role_id"], "allow": r["allow"], "deny": r["deny"]}
            for r in self._all(
                "SELECT * FROM channel_overwrites WHERE channel_id = ? ORDER BY role_id", channel_id
            )
        ]

    def set_overwrites(self, channel_id: str, overwrites: list[dict]) -> None:
        with self._tx():
            self._exec("DELETE FROM channel_overwrites WHERE channel_id = ?", channel_id)
            for o in overwrites:
                if o["allow"] or o["deny"]:
                    self._exec(
                        "INSERT INTO channel_overwrites(channel_id, role_id, allow, deny) VALUES (?,?,?,?)",
                        channel_id, o["role_id"], o["allow"], o["deny"],
                    )

    def delete_channel(self, channel_id: str) -> None:
        with self._tx():
            self._exec("DELETE FROM channels WHERE channel_id = ?", channel_id)
            self._exec("DELETE FROM notify_prefs WHERE target_id = ?", channel_id)

    # --- direct messages -----------------------------------------------------

    def dm_recipient_ids(self, channel_id: str) -> list[str]:
        return [
            r["user_id"]
            for r in self._all(
                "SELECT user_id FROM dm_recipients WHERE channel_id = ? ORDER BY joined_at, user_id", channel_id
            )
        ]

    def is_dm_recipient(self, channel_id: str, user_id: str) -> bool:
        return self._one(
            "SELECT 1 FROM dm_recipients WHERE channel_id = ? AND user_id = ?", channel_id, user_id
        ) is not None

    def hidden_dm_recipients(self, channel_id: str) -> list[str]:
        return [
            r["user_id"]
            for r in self._all(
                "SELECT user_id FROM dm_recipients WHERE channel_id = ? AND hidden = 1", channel_id
            )
        ]

    def set_dm_hidden(self, channel_id: str, user_id: str, hidden: bool) -> None:
        self._exec(
            "UPDATE dm_recipients SET hidden = ? WHERE channel_id = ? AND user_id = ?",
            int(hidden), channel_id, user_id,
        )

    def find_dm(self, a: str, b: str) -> str | None:
        row = self._one("SELECT channel_id FROM channels WHERE dm_key = ?", _dm_key(a, b))
        return row["channel_id"] if row else None

    def create_dm(self, opener: str, other: str) -> dict:
        channel_id = new_id()
        ts = now_iso()
        with self._tx():
            self._exec(
                "INSERT INTO channels(channel_id, guild_id, kind, created_at, dm_key) VALUES (?,NULL,'dm',?,?)",
                channel_id, ts, _dm_key(opener, other),
            )
            self._exec(
                "INSERT INTO dm_recipients(channel_id, user_id, hidden, joined_at) VALUES (?,?,0,?), (?,?,1,?)",
                channel_id, opener, ts, channel_id, other, ts,
            )
        return self.get_channel(channel_id)

    def create_group_dm(self, owner: str, others: list[str]) -> dict:
        channel_id = new_id()
        ts = now_iso()
        with self._tx():
            self._exec(
                "INSERT INTO channels(channel_id, guild_id, kind, created_at, owner_user_id) "
                "VALUES (?,NULL,'group_dm',?,?)",
                channel_id, ts, owner,
            )
            for uid in [owner, *others]:
                self._exec(
                    "INSERT INTO dm_recipients(channel_id, user_id, hidden, joined_at) VALUES (?,?,0,?)",
                    channel_id, uid, ts,
                )
        return self.get_channel(channel_id)

    def add_dm_recipient(self, channel_id: str, user_id: str) -> None:
        self._exec(
            "INSERT INTO dm_recipients(channel_id, user_id, hidden, joined_at) VALUES (?,?,0,?)",
            channel_id, user_id, now_iso(),
        )
        row = self.channel_row(channel_id)
        self._exec(
            "INSERT OR REPLACE INTO read_states(user_id, channel_id, last_read_id, mention_count) VALUES (?,?,?,0)",
            user_id, channel_id, row["last_message_id"] or 0,
        )

    def remove_dm_recipient(self, channel_id: str, user_id: str) -> None:
        with self._tx():
            self._exec("DELETE FROM dm_recipients WHERE channel_id = ? AND user_id = ?", channel_id, user_id)
            self._exec("DELETE FROM read_states WHERE channel_id = ? AND user_id = ?", channel_id, user_id)
            left = self._one("SELECT COUNT(*) AS n FROM dm_recipients WHERE channel_id = ?", channel_id)["n"]
            if left == 0:
                self._exec("DELETE FROM channels WHERE channel_id = ?", channel_id)
            else:
                owner = self._one("SELECT owner_user_id FROM channels WHERE channel_id = ?", channel_id)
                if owner and owner["owner_user_id"] == user_id:
                    self._exec(
                        "UPDATE channels SET owner_user_id = (SELECT user_id FROM dm_recipients "
                        "WHERE channel_id = ? ORDER BY joined_at LIMIT 1) WHERE channel_id = ?",
                        channel_id, channel_id,
                    )

    def set_dm_name(self, channel_id: str, name: str | None) -> None:
        self._exec("UPDATE channels SET name = ? WHERE channel_id = ?", name, channel_id)

    def list_dms(self, user_id: str) -> list[dict]:
        rows = self._all(
            "SELECT c.* FROM channels c JOIN dm_recipients r ON r.channel_id = c.channel_id "
            "WHERE r.user_id = ? AND r.hidden = 0 "
            "ORDER BY COALESCE(c.last_message_id, 0) DESC, c.channel_id DESC",
            user_id,
        )
        return [self._channel(r) for r in rows]

    def dm_channel_ids(self, user_id: str) -> list[str]:
        return [
            r["channel_id"]
            for r in self._all("SELECT channel_id FROM dm_recipients WHERE user_id = ?", user_id)
        ]

    def dm_partner_ids(self, user_id: str) -> list[str]:
        return [
            r["user_id"]
            for r in self._all(
                "SELECT DISTINCT r2.user_id FROM dm_recipients r1 JOIN dm_recipients r2 "
                "ON r2.channel_id = r1.channel_id WHERE r1.user_id = ? AND r2.user_id != ?",
                user_id, user_id,
            )
        ]

    # --- messages ------------------------------------------------------------

    def _messages(self, rows: list[sqlite3.Row]) -> list[dict]:
        if not rows:
            return []
        ids = [r["message_id"] for r in rows]
        marks = ",".join("?" * len(ids))
        reactions: dict[int, list[dict]] = {}
        for r in self._all(
            f"SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN ({marks}) "
            "ORDER BY created_at, user_id",
            *ids,
        ):
            lst = reactions.setdefault(r["message_id"], [])
            for item in lst:
                if item["emoji"] == r["emoji"]:
                    item["user_ids"].append(r["user_id"])
                    break
            else:
                lst.append({"emoji": r["emoji"], "user_ids": [r["user_id"]]})
        reply_ids = [r["reply_to_id"] for r in rows if r["reply_to_id"] is not None]
        replies: dict[int, sqlite3.Row] = {}
        if reply_ids:
            rmarks = ",".join("?" * len(reply_ids))
            for r in self._all(
                f"SELECT message_id, author_user_id, content FROM messages WHERE message_id IN ({rmarks})",
                *reply_ids,
            ):
                replies[r["message_id"]] = r
        users = self.public_users(
            [r["author_user_id"] for r in rows] + [r["author_user_id"] for r in replies.values()]
        )
        out = []
        for r in rows:
            reply = replies.get(r["reply_to_id"]) if r["reply_to_id"] is not None else None
            out.append({
                "message_id": str(r["message_id"]),
                "channel_id": r["channel_id"],
                "author": users.get(r["author_user_id"]),
                "content": r["content"],
                "sent_at": r["sent_at"],
                "edited_at": r["edited_at"],
                "reply_to_id": _sid(r["reply_to_id"]),
                "reply_to": {
                    "message_id": str(reply["message_id"]),
                    "author": users.get(reply["author_user_id"]),
                    "content": reply["content"][:REPLY_PREVIEW_CHARS],
                } if reply else None,
                "mentions": json.loads(r["mentions"]),
                "mention_everyone": bool(r["mention_everyone"]),
                "reactions": reactions.get(r["message_id"], []),
            })
        return out

    def create_message(
        self,
        channel_id: str,
        author_user_id: str,
        content: str,
        *,
        reply_to_id: int | None = None,
        mentions: list[str] | None = None,
        mention_everyone: bool = False,
    ) -> dict:
        message_id = int(new_id())
        with self._tx():
            self._exec(
                "INSERT INTO messages(message_id, channel_id, author_user_id, content, sent_at, "
                "reply_to_id, mentions, mention_everyone) VALUES (?,?,?,?,?,?,?,?)",
                message_id, channel_id, author_user_id, content, now_iso(),
                reply_to_id, json.dumps(mentions or []), int(mention_everyone),
            )
            self._exec("UPDATE channels SET last_message_id = ? WHERE channel_id = ?", message_id, channel_id)
            # Your own message is never unread.
            self._exec(
                "INSERT INTO read_states(user_id, channel_id, last_read_id, mention_count) VALUES (?,?,?,0) "
                "ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = excluded.last_read_id, mention_count = 0",
                author_user_id, channel_id, message_id,
            )
        return self.get_message(message_id)

    def message_row(self, message_id: int) -> sqlite3.Row | None:
        return self._one("SELECT * FROM messages WHERE message_id = ?", message_id)

    def get_message(self, message_id: int) -> dict | None:
        row = self.message_row(message_id)
        return self._messages([row])[0] if row else None

    def edit_message(self, message_id: int, content: str, mentions: list[str], mention_everyone: bool) -> dict:
        self._exec(
            "UPDATE messages SET content = ?, edited_at = ?, mentions = ?, mention_everyone = ? "
            "WHERE message_id = ?",
            content, now_iso(), json.dumps(mentions), int(mention_everyone), message_id,
        )
        return self.get_message(message_id)

    def delete_message(self, message_id: int) -> None:
        row = self.message_row(message_id)
        if row is None:
            return
        with self._tx():
            self._exec("DELETE FROM messages WHERE message_id = ?", message_id)
            self._exec(
                "UPDATE channels SET last_message_id = (SELECT MAX(message_id) FROM messages "
                "WHERE channel_id = ?) WHERE channel_id = ?",
                row["channel_id"], row["channel_id"],
            )

    def recent_message_ids_by(self, guild_id: str, user_id: str, since_iso: str) -> list[tuple[str, int]]:
        rows = self._all(
            "SELECT m.channel_id, m.message_id FROM messages m JOIN channels c ON c.channel_id = m.channel_id "
            "WHERE c.guild_id = ? AND m.author_user_id = ? AND m.sent_at >= ?",
            guild_id, user_id, since_iso,
        )
        return [(r["channel_id"], r["message_id"]) for r in rows]

    def history(
        self, channel_id: str, before_message_id: int | None, limit: int
    ) -> tuple[list[dict], bool]:
        """Newest `limit` messages before the cursor, returned oldest-first."""
        sql = "SELECT * FROM messages WHERE channel_id = ?"
        args: list[Any] = [channel_id]
        if before_message_id is not None:
            sql += " AND message_id < ?"
            args.append(before_message_id)
        sql += " ORDER BY message_id DESC LIMIT ?"
        args.append(limit + 1)
        rows = self._all(sql, *args)
        has_more = len(rows) > limit
        rows = rows[:limit]
        rows.reverse()
        return self._messages(rows), has_more

    # --- reactions -----------------------------------------------------------

    def reaction_emoji(self, message_id: int) -> set[str]:
        return {
            r["emoji"] for r in self._all("SELECT DISTINCT emoji FROM reactions WHERE message_id = ?", message_id)
        }

    def add_reaction(self, message_id: int, user_id: str, emoji: str) -> bool:
        cur = self._exec(
            "INSERT OR IGNORE INTO reactions(message_id, user_id, emoji, created_at) VALUES (?,?,?,?)",
            message_id, user_id, emoji, now_iso(),
        )
        return cur.rowcount > 0

    def remove_reaction(self, message_id: int, user_id: str, emoji: str) -> bool:
        cur = self._exec(
            "DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?", message_id, user_id, emoji
        )
        return cur.rowcount > 0

    # --- read state ----------------------------------------------------------

    def ack(self, user_id: str, channel_id: str, message_id: int) -> dict:
        self._exec(
            "INSERT INTO read_states(user_id, channel_id, last_read_id, mention_count) VALUES (?,?,?,0) "
            "ON CONFLICT(user_id, channel_id) DO UPDATE SET "
            "last_read_id = MAX(last_read_id, excluded.last_read_id), mention_count = 0",
            user_id, channel_id, message_id,
        )
        return self.read_state(user_id, channel_id)

    def bump_mentions(self, channel_id: str, user_ids: Iterable[str]) -> None:
        for uid in user_ids:
            self._exec(
                "INSERT INTO read_states(user_id, channel_id, last_read_id, mention_count) VALUES (?,?,0,1) "
                "ON CONFLICT(user_id, channel_id) DO UPDATE SET mention_count = mention_count + 1",
                uid, channel_id,
            )

    def read_state(self, user_id: str, channel_id: str) -> dict:
        c = self.channel_row(channel_id)
        rs = self._one(
            "SELECT * FROM read_states WHERE user_id = ? AND channel_id = ?", user_id, channel_id
        )
        return {
            "channel_id": channel_id,
            "guild_id": c["guild_id"] if c else None,
            "last_message_id": _sid(c["last_message_id"]) if c else None,
            "last_read_id": _sid(rs["last_read_id"]) if rs and rs["last_read_id"] else None,
            "mention_count": rs["mention_count"] if rs else 0,
        }

    def read_states(self, user_id: str, channel_ids: list[str]) -> list[dict]:
        if not channel_ids:
            return []
        out = []
        for i in range(0, len(channel_ids), 500):
            chunk = channel_ids[i : i + 500]
            marks = ",".join("?" * len(chunk))
            rows = self._all(
                f"SELECT c.channel_id, c.guild_id, c.last_message_id, rs.last_read_id, rs.mention_count "
                f"FROM channels c LEFT JOIN read_states rs ON rs.channel_id = c.channel_id AND rs.user_id = ? "
                f"WHERE c.channel_id IN ({marks})",
                user_id, *chunk,
            )
            out += [
                {
                    "channel_id": r["channel_id"],
                    "guild_id": r["guild_id"],
                    "last_message_id": _sid(r["last_message_id"]),
                    "last_read_id": _sid(r["last_read_id"]) if r["last_read_id"] else None,
                    "mention_count": r["mention_count"] or 0,
                }
                for r in rows
            ]
        return out

    # --- notification preferences -------------------------------------------

    def notify_prefs(self, user_id: str) -> list[dict]:
        return [
            {"target_id": r["target_id"], "level": r["level"], "muted": bool(r["muted"])}
            for r in self._all("SELECT * FROM notify_prefs WHERE user_id = ?", user_id)
        ]

    def set_notify_pref(self, user_id: str, target_id: str, level: str | None, muted: bool) -> dict:
        if level is None and not muted:
            self._exec("DELETE FROM notify_prefs WHERE user_id = ? AND target_id = ?", user_id, target_id)
        else:
            self._exec(
                "INSERT INTO notify_prefs(user_id, target_id, level, muted) VALUES (?,?,?,?) "
                "ON CONFLICT(user_id, target_id) DO UPDATE SET level = excluded.level, muted = excluded.muted",
                user_id, target_id, level, int(muted),
            )
        return {"target_id": target_id, "level": level, "muted": muted}

    # --- invites -------------------------------------------------------------

    def create_invite(self, guild_id: str, created_by: str) -> str:
        while True:
            code = "".join(secrets.choice(INVITE_ALPHABET) for _ in range(8))
            try:
                self._exec(
                    "INSERT INTO invites(code, guild_id, created_by, created_at) VALUES (?,?,?,?)",
                    code, guild_id, created_by, now_iso(),
                )
                return code
            except sqlite3.IntegrityError:
                continue

    def resolve_invite(self, code: str) -> str | None:
        row = self._one("SELECT guild_id FROM invites WHERE code = ?", code.strip().upper())
        return row["guild_id"] if row else None

    # --- bans ----------------------------------------------------------------

    def is_banned(self, guild_id: str, user_id: str) -> bool:
        return self._one("SELECT 1 FROM bans WHERE guild_id = ? AND user_id = ?", guild_id, user_id) is not None

    def add_ban(self, guild_id: str, user_id: str, reason: str | None, banned_by: str) -> None:
        self._exec(
            "INSERT OR REPLACE INTO bans(guild_id, user_id, reason, banned_by, created_at) VALUES (?,?,?,?,?)",
            guild_id, user_id, reason, banned_by, now_iso(),
        )

    def remove_ban(self, guild_id: str, user_id: str) -> bool:
        cur = self._exec("DELETE FROM bans WHERE guild_id = ? AND user_id = ?", guild_id, user_id)
        return cur.rowcount > 0

    def list_bans(self, guild_id: str) -> list[dict]:
        rows = self._all("SELECT * FROM bans WHERE guild_id = ? ORDER BY created_at DESC", guild_id)
        users = self.public_users(r["user_id"] for r in rows)
        return [
            {"user": users.get(r["user_id"]), "reason": r["reason"], "created_at": r["created_at"]}
            for r in rows
            if r["user_id"] in users
        ]

    # --- audit log -----------------------------------------------------------

    def add_audit(
        self, guild_id: str, actor: str, action: str, target_id: str | None = None, details: dict | None = None
    ) -> None:
        self._exec(
            "INSERT INTO audit_log(entry_id, guild_id, actor_user_id, action, target_id, details, created_at) "
            "VALUES (?,?,?,?,?,?,?)",
            int(new_id()), guild_id, actor, action, target_id, json.dumps(details or {}), now_iso(),
        )

    def list_audit(self, guild_id: str, before: int | None, limit: int) -> tuple[list[dict], bool]:
        sql = "SELECT * FROM audit_log WHERE guild_id = ?"
        args: list[Any] = [guild_id]
        if before is not None:
            sql += " AND entry_id < ?"
            args.append(before)
        sql += " ORDER BY entry_id DESC LIMIT ?"
        args.append(limit + 1)
        rows = self._all(sql, *args)
        has_more = len(rows) > limit
        rows = rows[:limit]
        users = self.public_users(r["actor_user_id"] for r in rows)
        entries = [
            {
                "entry_id": str(r["entry_id"]),
                "actor": users.get(r["actor_user_id"]),
                "action": r["action"],
                "target_id": r["target_id"],
                "details": json.loads(r["details"]),
                "created_at": r["created_at"],
            }
            for r in rows
        ]
        return entries, has_more


def _dm_key(a: str, b: str) -> str:
    lo, hi = sorted((a, b), key=int)
    return f"{lo}:{hi}"


def _like_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


class _Tx:
    """BEGIN IMMEDIATE … COMMIT; nests by becoming a no-op inside an open transaction."""

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn
        self.owner = False

    def __enter__(self):
        if not self.conn.in_transaction:
            self.conn.execute("BEGIN IMMEDIATE")
            self.owner = True
        return self.conn

    def __exit__(self, exc_type, exc, tb):
        if self.owner:
            self.conn.execute("ROLLBACK" if exc_type else "COMMIT")
        return False
