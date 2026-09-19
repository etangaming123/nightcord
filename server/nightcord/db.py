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

from . import files as F
from .ids import new_id
from .permissions import DEFAULT_EVERYONE, OWNER_RANK

SESSION_TTL_SECONDS = 30 * 24 * 3600

DEFAULT_SERVER_CONFIG = {
    "server_name": None,  # None: use the config file's server_name
    "guild_creation": "on",
    "account_creation": "on",
    "guild_list_visible": True,
    "max_upload_bytes": 25 * 1024 * 1024,
    "voice_enabled": False,
    "customization_mode": "on",
    "customization_features": {
        "profile_banner": True,
        "profile_colors": True,
        "animated_media": True,
        "guild_banner": True,
        "gradient_roles": True,
        "role_icons": True,
        "client_themes": True,
    },
}

STAFF_LEVELS = {"none": 0, "moderator": 1, "admin": 2, "owner": 3}

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
    # 2 — Nightcord v3 (see _migration_2).
    "_migration_2",
    # 3 — Nightcord v4: uploaded media, custom emoji, stickers and customisation.
    """
    ALTER TABLE users ADD COLUMN perks INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN banner_id TEXT;
    ALTER TABLE users ADD COLUMN profile_colors TEXT;
    ALTER TABLE guilds ADD COLUMN banner_id TEXT;
    ALTER TABLE roles ADD COLUMN colors TEXT;
    ALTER TABLE roles ADD COLUMN icon_id TEXT;
    ALTER TABLE roles ADD COLUMN icon_emoji TEXT;
    ALTER TABLE messages ADD COLUMN sticker_ids TEXT NOT NULL DEFAULT '[]';
    CREATE TABLE media (
        media_id      TEXT PRIMARY KEY,
        uploader_id   TEXT NOT NULL,
        kind          TEXT NOT NULL,
        content_type  TEXT NOT NULL,
        size          INTEGER NOT NULL,
        width         INTEGER NOT NULL,
        height        INTEGER NOT NULL,
        animated      INTEGER NOT NULL DEFAULT 0,
        claimed       INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL
    );
    -- emoji_id / sticker_id are the media_id of their image.
    CREATE TABLE emojis (
        emoji_id    TEXT PRIMARY KEY,
        guild_id    TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        animated    INTEGER NOT NULL DEFAULT 0,
        creator_id  TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        UNIQUE (guild_id, name)
    );
    CREATE TABLE stickers (
        sticker_id   TEXT PRIMARY KEY,
        guild_id     TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        description  TEXT,
        tag_emoji    TEXT,
        animated     INTEGER NOT NULL DEFAULT 0,
        creator_id   TEXT NOT NULL,
        created_at   TEXT NOT NULL
    );
    CREATE INDEX stickers_by_guild ON stickers(guild_id)
    """,
]

MIGRATION_2 = """
    ALTER TABLE users ADD COLUMN server_role TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE users ADD COLUMN muted_until TEXT;
    ALTER TABLE users ADD COLUMN deleted_at TEXT;
    ALTER TABLE users ADD COLUMN legal_version TEXT;
    ALTER TABLE sessions ADD COLUMN last_ip TEXT;
    ALTER TABLE sessions ADD COLUMN device_id TEXT;
    ALTER TABLE guilds ADD COLUMN icon_id TEXT;
    ALTER TABLE guilds ADD COLUMN system_channel_id TEXT;
    ALTER TABLE guilds ADD COLUMN system_flags INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE guilds ADD COLUMN vanity_code TEXT;
    CREATE UNIQUE INDEX guilds_vanity ON guilds(vanity_code) WHERE vanity_code IS NOT NULL;
    ALTER TABLE channels ADD COLUMN parent_id TEXT;
    ALTER TABLE channels ADD COLUMN topic TEXT;
    ALTER TABLE channels ADD COLUMN slowmode_seconds INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE channels ADD COLUMN perms_synced INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE memberships ADD COLUMN nickname TEXT;
    ALTER TABLE memberships ADD COLUMN invited_by TEXT;
    ALTER TABLE memberships ADD COLUMN invite_code TEXT;
    ALTER TABLE roles ADD COLUMN hoist INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE messages ADD COLUMN pinned_at TEXT;
    ALTER TABLE messages ADD COLUMN pinned_by TEXT;
    CREATE INDEX messages_pinned ON messages(channel_id, pinned_at) WHERE pinned_at IS NOT NULL;
    ALTER TABLE invites ADD COLUMN max_uses INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE invites ADD COLUMN uses INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE invites ADD COLUMN expires_at TEXT;
    ALTER TABLE invites ADD COLUMN revoked_at TEXT;
    CREATE INDEX invites_by_guild ON invites(guild_id);
    CREATE TABLE attachments (
        attachment_id  TEXT PRIMARY KEY,
        uploader_id    TEXT NOT NULL,
        channel_id     TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
        message_id     INTEGER REFERENCES messages(message_id) ON DELETE CASCADE,
        filename       TEXT NOT NULL,
        content_type   TEXT NOT NULL,
        size           INTEGER NOT NULL,
        width          INTEGER,
        height         INTEGER,
        created_at     TEXT NOT NULL
    );
    CREATE INDEX attachments_by_message ON attachments(message_id);
    CREATE TABLE ip_bans (
        cidr        TEXT PRIMARY KEY,
        reason      TEXT,
        banned_by   TEXT NOT NULL,
        created_at  TEXT NOT NULL
    );
    CREATE TABLE device_bans (
        device_id   TEXT PRIMARY KEY,
        user_id     TEXT,
        reason      TEXT,
        banned_by   TEXT NOT NULL,
        created_at  TEXT NOT NULL
    );
    CREATE TABLE server_audit_log (
        entry_id       INTEGER PRIMARY KEY,
        actor_user_id  TEXT NOT NULL,
        action         TEXT NOT NULL,
        target_id      TEXT,
        details        TEXT NOT NULL DEFAULT '{}',
        created_at     TEXT NOT NULL
    )
"""

# Full-text search over message content; kept in sync by triggers.
FTS_SQL = [
    "CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='message_id', "
    "tokenize='unicode61 remove_diacritics 2')",
    "CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN "
    "INSERT INTO messages_fts(rowid, content) VALUES (new.message_id, new.content); END",
    "CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN "
    "INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.message_id, old.content); END",
    "CREATE TRIGGER messages_fts_au AFTER UPDATE OF content ON messages BEGIN "
    "INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.message_id, old.content); "
    "INSERT INTO messages_fts(rowid, content) VALUES (new.message_id, new.content); END",
    "INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')",
]

# Permission bits added to @everyone by migration 2: ATTACH_FILES | CONNECT | CHANGE_NICKNAME.
_V3_EVERYONE_BITS = (1 << 15) | (1 << 16) | (1 << 17)


def _migration_2(conn: sqlite3.Connection) -> None:
    for stmt in MIGRATION_2.split(";"):
        if stmt.strip():
            conn.execute(stmt)
    conn.execute("UPDATE roles SET permissions = permissions | ? WHERE role_id = guild_id", (_V3_EVERYONE_BITS,))
    try:
        conn.execute("SAVEPOINT fts")
        for stmt in FTS_SQL:
            conn.execute(stmt)
        conn.execute("RELEASE fts")
    except sqlite3.OperationalError:
        # SQLite built without FTS5: search falls back to LIKE.
        conn.execute("ROLLBACK TO fts")
        conn.execute("RELEASE fts")

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


def staff_role(row: sqlite3.Row) -> str:
    """owner | admin | moderator | none."""
    return "owner" if row["is_server_owner"] else (row["server_role"] or "none")


def staff_level(row: sqlite3.Row) -> int:
    return STAFF_LEVELS[staff_role(row)]


def _public_user(row: sqlite3.Row) -> dict:
    return {
        "user_id": row["user_id"],
        "username": row["username"],
        "display_name": row["display_name"],
        "avatar_id": row["avatar_id"],
        "avatar_color": row["avatar_color"],
        "custom_status": row["custom_status"],
        "is_server_owner": bool(row["is_server_owner"]),
        "server_role": staff_role(row),
        "deleted": row["deleted_at"] is not None,
        "perks": bool(row["perks"]),
        "banner_id": row["banner_id"],
        "profile_colors": json.loads(row["profile_colors"]) if row["profile_colors"] else None,
    }


def _self_user(row: sqlite3.Row) -> dict:
    return {
        **_public_user(row),
        "bio": row["bio"],
        "created_at": row["created_at"],
        "presence": row["presence_pref"],
        "muted_until": row["muted_until"],
        "legal_version": row["legal_version"],
    }


def _guild(row: sqlite3.Row) -> dict:
    return {
        "guild_id": row["guild_id"],
        "name": row["name"],
        "owner_user_id": row["owner_user_id"],
        "listed": bool(row["listed"]),
        "created_at": row["created_at"],
        "icon_id": row["icon_id"],
        "system_channel_id": row["system_channel_id"],
        "system_flags": row["system_flags"],
        "vanity_code": row["vanity_code"],
        "banner_id": row["banner_id"],
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
        "hoist": bool(row["hoist"]),
        "colors": json.loads(row["colors"]) if row["colors"] else None,
        "icon_id": row["icon_id"],
        "icon_emoji": row["icon_emoji"],
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
        self._file_secret: str | None = None

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
                if sql == "_migration_2":
                    _migration_2(self.conn)
                    sql = ""
                for stmt in sql.split(";"):
                    if stmt.strip():
                        self.conn.execute(stmt)
                self.conn.execute(f"PRAGMA user_version = {i}")
                self.conn.execute("COMMIT")
            except Exception:
                self.conn.execute("ROLLBACK")
                raise
        self.has_fts = self._one("SELECT 1 FROM sqlite_master WHERE name = 'messages_fts'") is not None

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
        cfg = {**DEFAULT_SERVER_CONFIG, "customization_features": dict(DEFAULT_SERVER_CONFIG["customization_features"])}
        for row in self._all("SELECT key, value FROM server_config"):
            if row["key"] == "customization_features":
                cfg["customization_features"] = {**cfg["customization_features"], **json.loads(row["value"])}
            elif row["key"] in cfg:
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

    def file_secret(self) -> str:
        """Per-server key for signing attachment URLs (never sent to clients)."""
        if self._file_secret is None:
            row = self._one("SELECT value FROM server_config WHERE key = 'file_secret'")
            if row is None:
                secret = secrets.token_hex(32)
                self._exec(
                    "INSERT OR IGNORE INTO server_config(key, value) VALUES ('file_secret', ?)", json.dumps(secret)
                )
                row = self._one("SELECT value FROM server_config WHERE key = 'file_secret'")
            self._file_secret = json.loads(row["value"])
        return self._file_secret

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
        allowed = {
            "display_name", "bio", "avatar_color", "custom_status", "avatar_id", "presence_pref",
            "server_role", "muted_until", "legal_version", "perks", "banner_id", "profile_colors",
        }
        with self._tx():
            for key, val in fields.items():
                assert key in allowed, key
                if key == "profile_colors" and val is not None:
                    val = json.dumps(val)
                elif key == "perks":
                    val = int(val)
                self._exec(f"UPDATE users SET {key} = ? WHERE user_id = ?", val, user_id)
        return self.get_user(user_id)

    def get_server_owner_row(self) -> sqlite3.Row | None:
        return self._one("SELECT * FROM users WHERE is_server_owner = 1")

    def _admin_user(self, r: sqlite3.Row) -> dict:
        last = self._one(
            "SELECT last_ip, last_seen FROM sessions WHERE user_id = ? AND last_ip IS NOT NULL "
            "ORDER BY last_seen DESC LIMIT 1",
            r["user_id"],
        )
        devices = self._one(
            "SELECT COUNT(DISTINCT device_id) AS n FROM sessions WHERE user_id = ? AND device_id IS NOT NULL",
            r["user_id"],
        )["n"]
        return {
            **_public_user(r),
            "status": r["status"],
            "created_at": r["created_at"],
            "note": r["note"],
            "muted_until": r["muted_until"],
            "last_ip": last["last_ip"] if last else None,
            "last_seen": last["last_seen"] if last else None,
            "device_count": devices,
        }

    def list_users(self, *, status: str | None = None, query: str | None = None, limit: int = 200) -> list[dict]:
        sql = "SELECT * FROM users WHERE 1=1"
        args: list[Any] = []
        if status:
            sql += " AND status = ?"
            args.append(status)
        else:
            sql += " AND status != 'deleted'"
        if query:
            sql += " AND (username_lower LIKE ? ESCAPE '\\' OR lower(display_name) LIKE ? ESCAPE '\\')"
            like = "%" + _like_escape(query.lower()) + "%"
            args += [like, like]
        sql += " ORDER BY created_at LIMIT ?"
        args.append(limit)
        return [self._admin_user(r) for r in self._all(sql, *args)]

    def admin_user(self, user_id: str) -> dict | None:
        r = self.get_user_row(user_id)
        return self._admin_user(r) if r else None

    def staff_ids(self, min_level: int = 1) -> list[str]:
        return [
            r["user_id"]
            for r in self._all("SELECT * FROM users WHERE is_server_owner = 1 OR server_role != 'none'")
            if staff_level(r) >= min_level and r["status"] == "active"
        ]

    def anonymize_user(self, user_id: str) -> dict:
        """Account deletion: keeps messages (shown as Deleted User), frees the
        username and drops everything else. Returns what the caller must clean
        up on disk: {avatar_id, banner_id, attachment_ids}."""
        row = self.get_user_row(user_id)
        attachment_ids = [
            r["attachment_id"] for r in self._all("SELECT attachment_id FROM attachments WHERE uploader_id = ?", user_id)
        ]
        with self._tx():
            self._exec(
                "UPDATE users SET username = ?, username_lower = ?, password_hash = '!', status = 'deleted', "
                "deleted_at = ?, display_name = NULL, bio = NULL, avatar_id = NULL, avatar_color = NULL, "
                "custom_status = NULL, note = NULL, server_role = 'none', muted_until = NULL, perks = 0, banner_id = NULL, "
                "profile_colors = NULL WHERE user_id = ?",
                f"deleted-{user_id}", f"deleted-{user_id}", now_iso(), user_id,
            )
            self._exec("DELETE FROM sessions WHERE user_id = ?", user_id)
            self._exec("DELETE FROM attachments WHERE uploader_id = ?", user_id)
            self._exec("DELETE FROM reactions WHERE user_id = ?", user_id)
            self._exec("DELETE FROM notify_prefs WHERE user_id = ?", user_id)
            self._exec("DELETE FROM read_states WHERE user_id = ?", user_id)
        return {"avatar_id": row["avatar_id"], "banner_id": row["banner_id"], "attachment_ids": attachment_ids}

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

    def create_session(
        self, user_id: str, user_agent: str | None = None, *, ip: str | None = None, device_id: str | None = None
    ) -> str:
        token = secrets.token_urlsafe(32)
        ts = now_iso()
        self._exec(
            "INSERT INTO sessions(session_id, token_hash, user_id, created_at, last_seen, expires_at, user_agent, "
            "last_ip, device_id) VALUES (?,?,?,?,?,?,?,?,?)",
            new_id(), hash_token(token), user_id, ts, ts, time.time() + SESSION_TTL_SECONDS,
            (user_agent or "")[:300] or None, ip, device_id,
        )
        return token

    def session_user_id(self, token: str) -> str | None:
        """user_id for a valid session token, without extending it."""
        row = self._one(
            "SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at >= ?", hash_token(token), time.time()
        )
        return row["user_id"] if row else None

    def note_session(self, token: str, *, ip: str | None, device_id: str | None) -> None:
        self._exec(
            "UPDATE sessions SET last_ip = COALESCE(?, last_ip), device_id = COALESCE(?, device_id) "
            "WHERE token_hash = ?",
            ip, device_id, hash_token(token),
        )

    def device_ids_of(self, user_id: str) -> list[str]:
        return [
            r["device_id"]
            for r in self._all(
                "SELECT DISTINCT device_id FROM sessions WHERE user_id = ? AND device_id IS NOT NULL", user_id
            )
        ]

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
            general = new_id()
            self._exec(
                "INSERT INTO channels(channel_id, guild_id, kind, name, position, created_at) "
                "VALUES (?,?,'text','general',0,?)",
                general, guild_id, ts,
            )
            # #general is preselected for join/leave messages; they start switched off.
            self._exec("UPDATE guilds SET system_channel_id = ? WHERE guild_id = ?", general, guild_id)
        return self.get_guild(guild_id), self.list_channels(guild_id)

    def update_guild(self, guild_id: str, fields: dict) -> dict:
        allowed = {
            "name", "listed", "icon_id", "system_channel_id", "system_flags", "vanity_code", "owner_user_id", "banner_id",
        }
        with self._tx():
            for key, val in fields.items():
                assert key in allowed, key
                if key == "listed":
                    val = int(val)
                self._exec(f"UPDATE guilds SET {key} = ? WHERE guild_id = ?", val, guild_id)
        return self.get_guild(guild_id)

    def vanity_taken(self, code: str, guild_id: str) -> bool:
        return self._one(
            "SELECT 1 FROM guilds WHERE vanity_code = ? AND guild_id != ?", code, guild_id
        ) is not None

    def transfer_guild(self, guild_id: str, new_owner: str) -> None:
        with self._tx():
            self._exec("UPDATE memberships SET role = 'member' WHERE guild_id = ? AND role = 'owner'", guild_id)
            self._exec(
                "UPDATE memberships SET role = 'owner', ghost = 0 WHERE guild_id = ? AND user_id = ?", guild_id, new_owner
            )
            self._exec("UPDATE guilds SET owner_user_id = ? WHERE guild_id = ?", new_owner, guild_id)

    def owned_guild_ids(self, user_id: str) -> list[str]:
        return [r["guild_id"] for r in self._all("SELECT guild_id FROM guilds WHERE owner_user_id = ?", user_id)]

    def successor(self, guild_id: str, leaving: str) -> str | None:
        """Highest-ranked remaining visible member (earliest joined on ties)."""
        rows = self._all(
            "SELECT m.user_id, m.joined_at, COALESCE(MAX(r.position), 0) AS rank FROM memberships m "
            "LEFT JOIN member_roles mr ON mr.guild_id = m.guild_id AND mr.user_id = m.user_id "
            "LEFT JOIN roles r ON r.role_id = mr.role_id "
            "WHERE m.guild_id = ? AND m.ghost = 0 AND m.user_id != ? GROUP BY m.user_id "
            "ORDER BY rank DESC, m.joined_at LIMIT 1",
            guild_id, leaving,
        )
        return rows[0]["user_id"] if rows else None

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

    def member_count(self, guild_id: str) -> int:
        return self._one(
            "SELECT COUNT(*) AS n FROM memberships WHERE guild_id = ? AND ghost = 0", guild_id
        )["n"]

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

    def add_membership(
        self, guild_id: str, user_id: str, *, ghost: bool = False,
        invited_by: str | None = None, invite_code: str | None = None,
    ) -> None:
        with self._tx():
            self._exec(
                "INSERT INTO memberships(guild_id, user_id, role, ghost, joined_at, invited_by, invite_code) "
                "VALUES (?,?,'member',?,?,?,?)",
                guild_id, user_id, int(ghost), now_iso(), invited_by, invite_code,
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

    def set_nickname(self, guild_id: str, user_id: str, nickname: str | None) -> None:
        self._exec(
            "UPDATE memberships SET nickname = ? WHERE guild_id = ? AND user_id = ?", nickname, guild_id, user_id
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
                "nickname": r["nickname"],
                "invited_by": r["invited_by"],
                "invite_code": r["invite_code"],
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

    def create_role(
        self, guild_id: str, *, name: str, color: str | None, permissions: int,
        position: int | None = None, hoist: bool = False, extra: dict | None = None,
    ) -> dict:
        role_id = new_id()
        with self._tx():
            top = self._one("SELECT MAX(position) AS p FROM roles WHERE guild_id = ?", guild_id)["p"] or 0
            pos = top + 1 if position is None else max(1, min(position, top + 1))
            self._exec(
                "UPDATE roles SET position = position + 1 WHERE guild_id = ? AND position >= ?",
                guild_id, pos,
            )
            self._exec(
                "INSERT INTO roles(role_id, guild_id, name, color, permissions, position, created_at, hoist) "
                "VALUES (?,?,?,?,?,?,?,?)",
                role_id, guild_id, name, color, permissions, pos, now_iso(), int(hoist),
            )
        if extra:
            return self.update_role(role_id, extra)
        return self.get_role(role_id)

    def update_role(self, role_id: str, fields: dict) -> dict:
        with self._tx():
            for key, val in fields.items():
                assert key in ("name", "color", "permissions", "hoist", "colors", "icon_id", "icon_emoji"), key
                if key == "hoist":
                    val = int(val)
                elif key == "colors" and val is not None:
                    val = json.dumps(val)
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
            base["parent_id"] = row["parent_id"]
            base["topic"] = row["topic"]
            base["slowmode_seconds"] = row["slowmode_seconds"]
            base["perms_synced"] = bool(row["perms_synced"])
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

    def count_channels(self, guild_id: str) -> int:
        return self._one("SELECT COUNT(*) AS n FROM channels WHERE guild_id = ?", guild_id)["n"]

    def create_channel(
        self, guild_id: str, name: str, overwrites: list[dict] | None = None, *,
        kind: str = "text", parent_id: str | None = None, topic: str | None = None, perms_synced: bool = False,
    ) -> dict:
        channel_id = new_id()
        with self._tx():
            pos = self._one(
                "SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM channels WHERE guild_id = ?", guild_id
            )["pos"]
            self._exec(
                "INSERT INTO channels(channel_id, guild_id, kind, name, position, created_at, parent_id, topic, "
                "perms_synced) VALUES (?,?,?,?,?,?,?,?,?)",
                channel_id, guild_id, kind, name, pos, now_iso(), parent_id, topic, int(perms_synced),
            )
            for o in overwrites or []:
                self._exec(
                    "INSERT INTO channel_overwrites(channel_id, role_id, allow, deny) VALUES (?,?,?,?)",
                    channel_id, o["role_id"], o["allow"], o["deny"],
                )
        return self.get_channel(channel_id)

    def update_channel(self, channel_id: str, fields: dict) -> dict:
        allowed = {"name", "position", "topic", "slowmode_seconds", "perms_synced", "parent_id"}
        with self._tx():
            for key, val in fields.items():
                assert key in allowed, key
                if key == "perms_synced":
                    val = int(val)
                self._exec(f"UPDATE channels SET {key} = ? WHERE channel_id = ?", val, channel_id)
        return self.get_channel(channel_id)

    def reorder_channels(self, items: list[dict]) -> None:
        with self._tx():
            for it in items:
                self._exec(
                    "UPDATE channels SET position = ?, parent_id = ?, "
                    "perms_synced = CASE WHEN ? IS NULL THEN 0 ELSE perms_synced END WHERE channel_id = ?",
                    it["position"], it["parent_id"], it["parent_id"], it["channel_id"],
                )

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

    def delete_channel(self, channel_id: str) -> list[str]:
        """Deletes a channel; a category's children move to the top level.
        Returns the ids of those children."""
        with self._tx():
            children = [
                r["channel_id"] for r in self._all("SELECT channel_id FROM channels WHERE parent_id = ?", channel_id)
            ]
            # Children keep the category's permissions by copying its overwrites.
            for cid in children:
                row = self.channel_row(cid)
                if row["perms_synced"]:
                    self._exec("DELETE FROM channel_overwrites WHERE channel_id = ?", cid)
                    self._exec(
                        "INSERT INTO channel_overwrites(channel_id, role_id, allow, deny) "
                        "SELECT ?, role_id, allow, deny FROM channel_overwrites WHERE channel_id = ?",
                        cid, channel_id,
                    )
            self._exec("UPDATE channels SET parent_id = NULL, perms_synced = 0 WHERE parent_id = ?", channel_id)
            self._exec("UPDATE guilds SET system_channel_id = NULL WHERE system_channel_id = ?", channel_id)
            self._exec("DELETE FROM channels WHERE channel_id = ?", channel_id)
            self._exec("DELETE FROM notify_prefs WHERE target_id = ?", channel_id)
        return children

    def attachment_ids_in_channel(self, channel_id: str) -> list[str]:
        return [
            r["attachment_id"]
            for r in self._all("SELECT attachment_id FROM attachments WHERE channel_id = ?", channel_id)
        ]

    def attachment_ids_in_guild(self, guild_id: str) -> list[str]:
        return [
            r["attachment_id"]
            for r in self._all(
                "SELECT a.attachment_id FROM attachments a JOIN channels c ON c.channel_id = a.channel_id "
                "WHERE c.guild_id = ?",
                guild_id,
            )
        ]

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
            # rowid keeps reactions added in the same millisecond in the order they arrived.
            "ORDER BY created_at, rowid",
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
        sticker_ids = {r["message_id"]: json.loads(r["sticker_ids"] or "[]") for r in rows}
        stickers = self.stickers_by_id({sid for ids_ in sticker_ids.values() for sid in ids_})
        attachments: dict[int, list[dict]] = {}
        for a in self._all(
            f"SELECT * FROM attachments WHERE message_id IN ({marks}) ORDER BY attachment_id", *ids
        ):
            attachments.setdefault(a["message_id"], []).append(self._attachment(a))
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
                "type": r["type"],
                "pinned": r["pinned_at"] is not None,
                "attachments": attachments.get(r["message_id"], []),
                "stickers": [
                    stickers.get(sid) or {"sticker_id": sid, "deleted": True} for sid in sticker_ids[r["message_id"]]
                ],
            })
        return out

    # --- attachments ---------------------------------------------------------

    def _attachment(self, a: sqlite3.Row) -> dict:
        return {
            "attachment_id": a["attachment_id"],
            "filename": a["filename"],
            "content_type": a["content_type"],
            "size": a["size"],
            "width": a["width"],
            "height": a["height"],
            "url": F.signed_url(self.file_secret(), a["attachment_id"], a["filename"]),
        }

    def create_attachment(
        self, attachment_id: str, *, uploader_id: str, channel_id: str, filename: str, content_type: str,
        size: int, width: int | None, height: int | None,
    ) -> dict:
        self._exec(
            "INSERT INTO attachments(attachment_id, uploader_id, channel_id, message_id, filename, content_type, "
            "size, width, height, created_at) VALUES (?,?,?,NULL,?,?,?,?,?,?)",
            attachment_id, uploader_id, channel_id, filename, content_type, size, width, height, now_iso(),
        )
        return self._attachment(self.attachment_row(attachment_id))

    def attachment_row(self, attachment_id: str) -> sqlite3.Row | None:
        return self._one("SELECT * FROM attachments WHERE attachment_id = ?", attachment_id)

    def pending_attachment_count(self, user_id: str) -> int:
        return self._one(
            "SELECT COUNT(*) AS n FROM attachments WHERE uploader_id = ? AND message_id IS NULL", user_id
        )["n"]

    def claimable_attachments(self, ids: list[str], user_id: str, channel_id: str) -> bool:
        if not ids:
            return True
        marks = ",".join("?" * len(ids))
        n = self._one(
            f"SELECT COUNT(*) AS n FROM attachments WHERE attachment_id IN ({marks}) AND uploader_id = ? "
            f"AND channel_id = ? AND message_id IS NULL",
            *ids, user_id, channel_id,
        )["n"]
        return n == len(ids)

    def message_attachment_ids(self, message_id: int) -> list[str]:
        return [
            r["attachment_id"]
            for r in self._all("SELECT attachment_id FROM attachments WHERE message_id = ?", message_id)
        ]

    def stale_attachment_ids(self, older_than_iso: str) -> list[str]:
        rows = self._all(
            "SELECT attachment_id FROM attachments WHERE message_id IS NULL AND created_at < ?", older_than_iso
        )
        ids = [r["attachment_id"] for r in rows]
        if ids:
            with self._tx():
                for aid in ids:
                    self._exec("DELETE FROM attachments WHERE attachment_id = ?", aid)
        return ids

    def all_attachment_ids(self) -> set[str]:
        return {r["attachment_id"] for r in self._all("SELECT attachment_id FROM attachments")}

    def storage_stats(self) -> dict:
        r = self._one("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM attachments")
        return {"count": r["n"], "bytes": r["bytes"]}

    def create_message(
        self,
        channel_id: str,
        author_user_id: str,
        content: str,
        *,
        reply_to_id: int | None = None,
        mentions: list[str] | None = None,
        mention_everyone: bool = False,
        type_: str = "default",
        attachment_ids: list[str] | None = None,
        sticker_ids: list[str] | None = None,
    ) -> dict:
        message_id = int(new_id())
        with self._tx():
            self._exec(
                "INSERT INTO messages(message_id, channel_id, author_user_id, content, sent_at, "
                "reply_to_id, mentions, mention_everyone, type, sticker_ids) VALUES (?,?,?,?,?,?,?,?,?,?)",
                message_id, channel_id, author_user_id, content, now_iso(),
                reply_to_id, json.dumps(mentions or []), int(mention_everyone), type_, json.dumps(sticker_ids or []),
            )
            for aid in attachment_ids or []:
                self._exec("UPDATE attachments SET message_id = ? WHERE attachment_id = ?", message_id, aid)
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

    def last_sent_at(self, channel_id: str, user_id: str) -> str | None:
        row = self._one(
            "SELECT MAX(sent_at) AS t FROM messages WHERE channel_id = ? AND author_user_id = ? AND type = 'default'",
            channel_id, user_id,
        )
        return row["t"] if row else None

    def around(self, channel_id: str, message_id: int, limit: int) -> tuple[list[dict], bool, bool]:
        """Messages centered on message_id, oldest-first: (messages, has_more_before, has_more_after)."""
        half = limit // 2
        before = self._all(
            "SELECT * FROM messages WHERE channel_id = ? AND message_id < ? ORDER BY message_id DESC LIMIT ?",
            channel_id, message_id, half + 1,
        )
        after = self._all(
            "SELECT * FROM messages WHERE channel_id = ? AND message_id >= ? ORDER BY message_id LIMIT ?",
            channel_id, message_id, limit - half + 1,
        )
        more_before = len(before) > half
        more_after = len(after) > limit - half
        rows = list(reversed(before[:half])) + after[: limit - half]
        return self._messages(rows), more_before, more_after

    def history_after(self, channel_id: str, after_message_id: int, limit: int) -> tuple[list[dict], bool]:
        rows = self._all(
            "SELECT * FROM messages WHERE channel_id = ? AND message_id > ? ORDER BY message_id LIMIT ?",
            channel_id, after_message_id, limit + 1,
        )
        return self._messages(rows[:limit]), len(rows) > limit

    # --- pins ----------------------------------------------------------------

    def pin_count(self, channel_id: str) -> int:
        return self._one(
            "SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND pinned_at IS NOT NULL", channel_id
        )["n"]

    def set_pinned(self, message_id: int, by: str | None) -> dict:
        if by is None:
            self._exec("UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE message_id = ?", message_id)
        else:
            self._exec(
                "UPDATE messages SET pinned_at = ?, pinned_by = ? WHERE message_id = ?", now_iso(), by, message_id
            )
        return self.get_message(message_id)

    def pins(self, channel_id: str) -> list[dict]:
        rows = self._all(
            "SELECT * FROM messages WHERE channel_id = ? AND pinned_at IS NOT NULL ORDER BY pinned_at DESC",
            channel_id,
        )
        return self._messages(rows)

    # --- search --------------------------------------------------------------

    def search(
        self, channel_ids: list[str], *, query: str | None, author_id: str | None, has: str | None,
        pinned: bool | None, before: int | None, after: int | None, offset: int, limit: int,
    ) -> tuple[list[dict], int]:
        if not channel_ids:
            return [], 0
        where = [f"m.channel_id IN ({','.join('?' * len(channel_ids))})", "m.type = 'default'"]
        args: list[Any] = list(channel_ids)
        join = ""
        if query:
            if self.has_fts:
                # Each word as a quoted prefix term: no FTS syntax from users.
                terms = [t.replace('"', '""') for t in query.split() if t]
                if terms:
                    join = "JOIN messages_fts f ON f.rowid = m.message_id"
                    where.append("messages_fts MATCH ?")
                    args.append(" ".join(f'"{t}"*' for t in terms))
            else:
                for t in query.split():
                    where.append("lower(m.content) LIKE ? ESCAPE '\\'")
                    args.append("%" + _like_escape(t.lower()) + "%")
        if author_id:
            where.append("m.author_user_id = ?")
            args.append(author_id)
        if has == "file":
            where.append("EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.message_id)")
        elif has == "image":
            where.append(
                "EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.message_id AND a.content_type LIKE 'image/%')"
            )
        elif has == "video":
            where.append(
                "EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.message_id AND a.content_type LIKE 'video/%')"
            )
        elif has == "link":
            where.append("(m.content LIKE '%http://%' OR m.content LIKE '%https://%')")
        if pinned:
            where.append("m.pinned_at IS NOT NULL")
        if before is not None:
            where.append("m.message_id < ?")
            args.append(before)
        if after is not None:
            where.append("m.message_id > ?")
            args.append(after)
        cond = " AND ".join(where)
        total = self._one(f"SELECT COUNT(*) AS n FROM messages m {join} WHERE {cond}", *args)["n"]
        rows = self._all(
            f"SELECT m.* FROM messages m {join} WHERE {cond} ORDER BY m.message_id DESC LIMIT ? OFFSET ?",
            *args, limit, offset,
        )
        return self._messages(rows), total

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

    def _invite(self, r: sqlite3.Row, users: dict[str, dict] | None = None) -> dict:
        users = users if users is not None else self.public_users([r["created_by"]])
        return {
            "code": r["code"],
            "guild_id": r["guild_id"],
            "inviter": users.get(r["created_by"]),
            "uses": r["uses"],
            "max_uses": r["max_uses"],
            "expires_at": r["expires_at"],
            "created_at": r["created_at"],
        }

    def create_invite(
        self, guild_id: str, created_by: str, *, max_uses: int = 0, max_age_seconds: int = 0
    ) -> dict:
        expires = iso_in(max_age_seconds) if max_age_seconds else None
        while True:
            code = "".join(secrets.choice(INVITE_ALPHABET) for _ in range(8))
            try:
                self._exec(
                    "INSERT INTO invites(code, guild_id, created_by, created_at, max_uses, expires_at) "
                    "VALUES (?,?,?,?,?,?)",
                    code, guild_id, created_by, now_iso(), max_uses, expires,
                )
                return self._invite(self._one("SELECT * FROM invites WHERE code = ?", code))
            except sqlite3.IntegrityError:
                continue

    def invite_row(self, code: str) -> sqlite3.Row | None:
        return self._one("SELECT * FROM invites WHERE code = ?", code.strip().upper())

    def invite_state(self, code: str) -> tuple[str, sqlite3.Row | None, dict | None]:
        """("ok" | "invalid" | "expired", invite row or None, guild or None).
        Also resolves vanity codes (row None, guild set)."""
        code = code.strip()
        row = self.invite_row(code)
        if row is None:
            g = self._one("SELECT * FROM guilds WHERE vanity_code = ?", code.lower())
            return ("ok", None, _guild(g)) if g else ("invalid", None, None)
        if row["revoked_at"]:
            return "invalid", row, None
        guild = self.get_guild(row["guild_id"])
        if (row["expires_at"] and row["expires_at"] <= now_iso()) or (
            row["max_uses"] and row["uses"] >= row["max_uses"]
        ):
            return "expired", row, guild
        return "ok", row, guild

    def use_invite(self, code: str) -> None:
        self._exec("UPDATE invites SET uses = uses + 1 WHERE code = ?", code)

    def list_invites(self, guild_id: str, created_by: str | None = None) -> list[dict]:
        """Active invites (not revoked, expired or used up), newest first."""
        sql = (
            "SELECT * FROM invites WHERE guild_id = ? AND revoked_at IS NULL "
            "AND (expires_at IS NULL OR expires_at > ?) AND (max_uses = 0 OR uses < max_uses)"
        )
        args: list[Any] = [guild_id, now_iso()]
        if created_by is not None:
            sql += " AND created_by = ?"
            args.append(created_by)
        rows = self._all(sql + " ORDER BY created_at DESC", *args)
        users = self.public_users(r["created_by"] for r in rows)
        return [self._invite(r, users) for r in rows]

    def revoke_invite(self, code: str) -> None:
        self._exec("UPDATE invites SET revoked_at = ? WHERE code = ?", now_iso(), code)

    def resolve_invite(self, code: str) -> str | None:
        status, _, guild = self.invite_state(code)
        return guild["guild_id"] if status == "ok" and guild else None

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

    # --- server-wide bans (IP / device) --------------------------------------

    def ip_bans(self) -> list[dict]:
        rows = self._all("SELECT * FROM ip_bans ORDER BY created_at DESC")
        users = self.public_users(r["banned_by"] for r in rows)
        return [
            {"cidr": r["cidr"], "reason": r["reason"], "banned_by": users.get(r["banned_by"]), "created_at": r["created_at"]}
            for r in rows
        ]

    def ip_ban_cidrs(self) -> list[str]:
        return [r["cidr"] for r in self._all("SELECT cidr FROM ip_bans")]

    def add_ip_ban(self, cidr: str, reason: str | None, by: str) -> None:
        self._exec(
            "INSERT OR REPLACE INTO ip_bans(cidr, reason, banned_by, created_at) VALUES (?,?,?,?)",
            cidr, reason, by, now_iso(),
        )

    def remove_ip_ban(self, cidr: str) -> bool:
        return self._exec("DELETE FROM ip_bans WHERE cidr = ?", cidr).rowcount > 0

    def device_bans(self) -> list[dict]:
        rows = self._all("SELECT * FROM device_bans ORDER BY created_at DESC")
        users = self.public_users([r["banned_by"] for r in rows] + [r["user_id"] for r in rows if r["user_id"]])
        return [
            {
                "device_id": r["device_id"], "user": users.get(r["user_id"]) if r["user_id"] else None,
                "reason": r["reason"], "banned_by": users.get(r["banned_by"]), "created_at": r["created_at"],
            }
            for r in rows
        ]

    def is_device_banned(self, device_id: str | None) -> bool:
        if not device_id:
            return False
        return self._one("SELECT 1 FROM device_bans WHERE device_id = ?", device_id) is not None

    def add_device_ban(self, device_id: str, user_id: str | None, reason: str | None, by: str) -> None:
        self._exec(
            "INSERT OR REPLACE INTO device_bans(device_id, user_id, reason, banned_by, created_at) VALUES (?,?,?,?,?)",
            device_id, user_id, reason, by, now_iso(),
        )

    def remove_device_ban(self, device_id: str) -> bool:
        return self._exec("DELETE FROM device_bans WHERE device_id = ?", device_id).rowcount > 0

    # --- server audit log ------------------------------------------------------

    def add_server_audit(self, actor: str, action: str, target_id: str | None = None, details: dict | None = None) -> None:
        self._exec(
            "INSERT INTO server_audit_log(entry_id, actor_user_id, action, target_id, details, created_at) "
            "VALUES (?,?,?,?,?,?)",
            int(new_id()), actor, action, target_id, json.dumps(details or {}), now_iso(),
        )

    def list_server_audit(self, before: int | None, limit: int) -> tuple[list[dict], bool]:
        sql = "SELECT * FROM server_audit_log"
        args: list[Any] = []
        if before is not None:
            sql += " WHERE entry_id < ?"
            args.append(before)
        rows = self._all(sql + " ORDER BY entry_id DESC LIMIT ?", *args, limit + 1)
        has_more = len(rows) > limit
        rows = rows[:limit]
        users = self.public_users(r["actor_user_id"] for r in rows)
        return [
            {
                "entry_id": str(r["entry_id"]), "actor": users.get(r["actor_user_id"]), "action": r["action"],
                "target_id": r["target_id"], "details": json.loads(r["details"]), "created_at": r["created_at"],
            }
            for r in rows
        ], has_more

    def stats(self) -> dict:
        n = lambda sql: self._one(sql)["n"]  # noqa: E731
        return {
            "users": n("SELECT COUNT(*) AS n FROM users WHERE status = 'active'"),
            "guilds": n("SELECT COUNT(*) AS n FROM guilds"),
            "messages": n("SELECT COUNT(*) AS n FROM messages"),
            "attachments": self.storage_stats(),
            "media": self.media_stats(),
        }

    # --- media (images uploaded over HTTP: emoji, stickers, banners, ...) -------

    def create_media(
        self, media_id: str, *, uploader_id: str, kind: str, content_type: str, size: int, width: int, height: int,
        animated: bool,
    ) -> dict:
        self._exec(
            "INSERT INTO media(media_id, uploader_id, kind, content_type, size, width, height, animated, claimed, "
            "created_at) VALUES (?,?,?,?,?,?,?,?,0,?)",
            media_id, uploader_id, kind, content_type, size, width, height, int(animated), now_iso(),
        )
        return self.media(media_id)

    def media_row(self, media_id: str) -> sqlite3.Row | None:
        return self._one("SELECT * FROM media WHERE media_id = ?", media_id)

    def media(self, media_id: str) -> dict | None:
        r = self.media_row(media_id)
        if r is None:
            return None
        return {
            "media_id": r["media_id"], "kind": r["kind"], "content_type": r["content_type"], "size": r["size"],
            "width": r["width"], "height": r["height"], "animated": bool(r["animated"]),
        }

    def claim_media(self, media_id: str, uploader_id: str, kind: str) -> sqlite3.Row | None:
        """Marks an unclaimed upload of `kind` by `uploader_id` as used; None if there's no such upload."""
        cur = self._exec(
            "UPDATE media SET claimed = 1 WHERE media_id = ? AND uploader_id = ? AND kind = ? AND claimed = 0",
            media_id, uploader_id, kind,
        )
        return self.media_row(media_id) if cur.rowcount else None

    def delete_media(self, media_id: str) -> None:
        self._exec("DELETE FROM media WHERE media_id = ?", media_id)

    def pending_media_count(self, user_id: str) -> int:
        return self._one("SELECT COUNT(*) AS n FROM media WHERE uploader_id = ? AND claimed = 0", user_id)["n"]

    def stale_media_ids(self, older_than_iso: str) -> list[str]:
        ids = [
            r["media_id"]
            for r in self._all("SELECT media_id FROM media WHERE claimed = 0 AND created_at < ?", older_than_iso)
        ]
        if ids:
            with self._tx():
                for mid in ids:
                    self._exec("DELETE FROM media WHERE media_id = ?", mid)
        return ids

    def all_media_ids(self) -> set[str]:
        return {r["media_id"] for r in self._all("SELECT media_id FROM media")}

    def media_stats(self) -> dict:
        r = self._one("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM media WHERE claimed = 1")
        return {"count": r["n"], "bytes": r["bytes"]}

    def guild_media_ids(self, guild_id: str) -> list[str]:
        """Every image a guild owns (icon, banner, role icons, emoji, stickers), for deleting with it."""
        g = self._one("SELECT icon_id, banner_id FROM guilds WHERE guild_id = ?", guild_id)
        ids = [g["icon_id"], g["banner_id"]] if g else []
        ids += [r["icon_id"] for r in self._all("SELECT icon_id FROM roles WHERE guild_id = ?", guild_id)]
        ids += [r["emoji_id"] for r in self._all("SELECT emoji_id FROM emojis WHERE guild_id = ?", guild_id)]
        ids += [r["sticker_id"] for r in self._all("SELECT sticker_id FROM stickers WHERE guild_id = ?", guild_id)]
        return [i for i in ids if i]

    # --- custom emoji and stickers --------------------------------------------

    @staticmethod
    def _emoji(r: sqlite3.Row) -> dict:
        return {
            "emoji_id": r["emoji_id"], "guild_id": r["guild_id"], "name": r["name"], "animated": bool(r["animated"]),
            "creator_id": r["creator_id"], "created_at": r["created_at"],
        }

    @staticmethod
    def _sticker(r: sqlite3.Row) -> dict:
        return {
            "sticker_id": r["sticker_id"], "guild_id": r["guild_id"], "name": r["name"],
            "description": r["description"], "tag_emoji": r["tag_emoji"], "animated": bool(r["animated"]),
            "creator_id": r["creator_id"], "created_at": r["created_at"],
        }

    def list_emojis(self, guild_id: str) -> list[dict]:
        return [self._emoji(r) for r in self._all("SELECT * FROM emojis WHERE guild_id = ? ORDER BY emoji_id", guild_id)]

    def get_emoji(self, emoji_id: str) -> dict | None:
        r = self._one("SELECT * FROM emojis WHERE emoji_id = ?", emoji_id)
        return self._emoji(r) if r else None

    def emoji_name_taken(self, guild_id: str, name: str, exclude: str | None = None) -> bool:
        return self._one(
            "SELECT 1 FROM emojis WHERE guild_id = ? AND lower(name) = lower(?) AND emoji_id != ?",
            guild_id, name, exclude or "",
        ) is not None

    def count_emojis(self, guild_id: str) -> int:
        return self._one("SELECT COUNT(*) AS n FROM emojis WHERE guild_id = ?", guild_id)["n"]

    def create_emoji(self, emoji_id: str, guild_id: str, name: str, animated: bool, creator_id: str) -> dict:
        self._exec(
            "INSERT INTO emojis(emoji_id, guild_id, name, animated, creator_id, created_at) VALUES (?,?,?,?,?,?)",
            emoji_id, guild_id, name, int(animated), creator_id, now_iso(),
        )
        return self.get_emoji(emoji_id)

    def rename_emoji(self, emoji_id: str, name: str) -> dict:
        self._exec("UPDATE emojis SET name = ? WHERE emoji_id = ?", name, emoji_id)
        return self.get_emoji(emoji_id)

    def delete_emoji(self, emoji_id: str) -> None:
        self._exec("DELETE FROM emojis WHERE emoji_id = ?", emoji_id)

    def list_stickers(self, guild_id: str) -> list[dict]:
        return [
            self._sticker(r) for r in self._all("SELECT * FROM stickers WHERE guild_id = ? ORDER BY sticker_id", guild_id)
        ]

    def get_sticker(self, sticker_id: str) -> dict | None:
        r = self._one("SELECT * FROM stickers WHERE sticker_id = ?", sticker_id)
        return self._sticker(r) if r else None

    def stickers_by_id(self, ids: Iterable[str]) -> dict[str, dict]:
        ids = list(ids)
        if not ids:
            return {}
        marks = ",".join("?" * len(ids))
        return {r["sticker_id"]: self._sticker(r) for r in self._all(f"SELECT * FROM stickers WHERE sticker_id IN ({marks})", *ids)}

    def count_stickers(self, guild_id: str) -> int:
        return self._one("SELECT COUNT(*) AS n FROM stickers WHERE guild_id = ?", guild_id)["n"]

    def create_sticker(
        self, sticker_id: str, guild_id: str, *, name: str, description: str | None, tag_emoji: str | None,
        animated: bool, creator_id: str,
    ) -> dict:
        self._exec(
            "INSERT INTO stickers(sticker_id, guild_id, name, description, tag_emoji, animated, creator_id, created_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            sticker_id, guild_id, name, description, tag_emoji, int(animated), creator_id, now_iso(),
        )
        return self.get_sticker(sticker_id)

    def update_sticker(self, sticker_id: str, fields: dict) -> dict:
        with self._tx():
            for key, val in fields.items():
                assert key in ("name", "description", "tag_emoji"), key
                self._exec(f"UPDATE stickers SET {key} = ? WHERE sticker_id = ?", val, sticker_id)
        return self.get_sticker(sticker_id)

    def delete_sticker(self, sticker_id: str) -> None:
        self._exec("DELETE FROM stickers WHERE sticker_id = ?", sticker_id)

    def perk_users(self) -> list[dict]:
        return [_public_user(r) for r in self._all("SELECT * FROM users WHERE perks = 1 ORDER BY username_lower")]

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
