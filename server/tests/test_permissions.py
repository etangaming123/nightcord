"""Permission computation (PROTOCOL.md §5a)."""

import pytest

from nightcord import permissions as perm
from nightcord.db import Database
from nightcord.permissions import MemberPerms, compute_base, compute_channel

V, S, R, M = perm.VIEW_CHANNEL, perm.SEND_MESSAGES, perm.READ_HISTORY, perm.MANAGE_MESSAGES
EVERYONE = perm.DEFAULT_EVERYONE
G = "1"  # guild id == @everyone role id


def member(*, roles=(), role_perms=(), owner=False, ghost=False, timeout=None):
    base = compute_base(is_owner=owner, ghost=ghost, everyone=EVERYONE, role_perms=list(role_perms))
    return MemberPerms(G, "u", owner, ghost, base, frozenset(roles), 0, timeout)


def test_default_everyone():
    assert EVERYONE == 229903  # 527 + ATTACH_FILES + CONNECT + CHANGE_NICKNAME


@pytest.mark.parametrize(
    "m, overwrites, has, lacks",
    [
        # plain member, no overwrites
        (member(), {}, V | S | R, M),
        # private channel: @everyone denied view -> nothing at all
        (member(), {G: (0, V)}, 0, V | S | R),
        # ...but a role allow restores it
        (member(roles=["mod"]), {G: (0, V), "mod": (V, 0)}, V | S | R, 0),
        # read-only channel
        (member(), {G: (0, S)}, V | R, S),
        # role deny beats @everyone allow; role allow beats role deny
        (member(roles=["a"]), {G: (S, 0), "a": (0, S)}, V, S),
        (member(roles=["a", "b"]), {"a": (0, S), "b": (S, 0)}, V | S, 0),
        # administrator ignores overwrites
        (member(role_perms=[perm.ADMINISTRATOR]), {G: (0, V)}, perm.ALL, 0),
        # owner has everything
        (member(owner=True), {G: (0, V)}, perm.ALL, 0),
        # ghosts: read-only everywhere, overwrites don't apply
        (member(ghost=True), {G: (0, V)}, V | R, S | M),
        # timed out: read-only
        (member(role_perms=[M], timeout="9999-01-01T00:00:00.000Z"), {}, V | R, S | M),
        # expired timeout is ignored
        (member(timeout="2000-01-01T00:00:00.000Z"), {}, V | S | R, 0),
    ],
)
def test_compute_channel(m, overwrites, has, lacks):
    p = compute_channel(m, G, overwrites)
    assert p & has == has
    assert p & lacks == 0


def test_rejects_v1_database(tmp_path):
    import sqlite3

    path = tmp_path / "old.db"
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE users (user_id TEXT PRIMARY KEY)")
    con.commit()
    con.close()
    with pytest.raises(RuntimeError, match="v1"):
        Database(path)


def test_fresh_database_is_versioned(tmp_path):
    db = Database(tmp_path / "new.db")
    assert db.conn.execute("PRAGMA user_version").fetchone()[0] == 3
    db.close()
    Database(tmp_path / "new.db").close()  # reopening doesn't re-run migrations
