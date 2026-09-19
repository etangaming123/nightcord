"""Shared lookups and permission checks for handlers."""

from __future__ import annotations

from .. import permissions as perm
from .. import protocol as P
from ..db import now_iso
from ..protocol import ProtocolError


def require_guild(ctx, guild_id) -> dict:
    guild = ctx.db.get_guild(guild_id) if isinstance(guild_id, str) else None
    if guild is None:
        raise ProtocolError(P.NOT_FOUND, "Guild not found")
    return guild


def require_member(ctx, conn, guild_id) -> tuple[dict, dict]:
    """Returns (guild, membership). Non-members get not_found so guild ids don't leak."""
    guild = require_guild(ctx, guild_id)
    membership = ctx.db.get_membership(guild["guild_id"], conn.user_id)
    if membership is None:
        raise ProtocolError(P.NOT_FOUND, "Guild not found")
    return guild, membership


def check_timeout(ctx, guild_id: str, user_id: str) -> None:
    mp = ctx.perms.member(guild_id, user_id)
    if mp is not None and mp.timed_out():
        raise ProtocolError(P.TIMED_OUT, f"You're timed out until {mp.timed_out_until}")


def require_guild_perm(ctx, conn, guild_id, flag: int) -> tuple[dict, dict]:
    """A member with `flag` guild-wide. Ghosts are read-only (§7)."""
    guild, membership = require_member(ctx, conn, guild_id)
    if membership["ghost"]:
        raise ProtocolError(P.FORBIDDEN, "Ghost memberships are read-only")
    if not ctx.perms.guild_perms(guild["guild_id"], conn.user_id) & flag:
        check_timeout(ctx, guild["guild_id"], conn.user_id)
        raise ProtocolError(P.FORBIDDEN, "You don't have permission to do that")
    return guild, membership


def require_guild_owner(ctx, conn, guild_id) -> dict:
    guild, membership = require_member(ctx, conn, guild_id)
    if membership["ghost"] or membership["role"] != "owner":
        raise ProtocolError(P.FORBIDDEN, "Only the guild owner can do that")
    return guild


def get_channel(ctx, conn, channel_id) -> tuple[dict, int]:
    """(channel, my permissions) for a channel the user can view."""
    channel = ctx.db.get_channel(channel_id) if isinstance(channel_id, str) else None
    if channel is None:
        raise ProtocolError(P.NOT_FOUND, "Channel not found")
    perms = ctx.perms.channel_perms(channel, conn.user_id)
    if not perms & perm.VIEW_CHANNEL:
        raise ProtocolError(P.NOT_FOUND, "Channel not found")
    return channel, perms


def require_channel_perm(ctx, conn, channel_id, flag: int) -> tuple[dict, int]:
    channel, perms = get_channel(ctx, conn, channel_id)
    if not perms & flag:
        if channel["guild_id"] is not None:
            m = ctx.db.get_membership(channel["guild_id"], conn.user_id)
            if m and m["ghost"]:
                raise ProtocolError(P.FORBIDDEN, "Ghost memberships are read-only")
            check_timeout(ctx, channel["guild_id"], conn.user_id)
        raise ProtocolError(P.FORBIDDEN, "You don't have permission to do that")
    return channel, perms


def require_server_owner(conn) -> None:
    if not conn.user["is_server_owner"]:
        raise ProtocolError(P.FORBIDDEN, "Only the server owner can do that")


STAFF_LEVELS = {"none": 0, "moderator": 1, "admin": 2, "owner": 3}
MODERATOR, ADMIN, OWNER = 1, 2, 3


def staff_level(user: dict) -> int:
    return STAFF_LEVELS.get(user.get("server_role") or "none", 0)


def require_staff(conn, level: int) -> None:
    if staff_level(conn.user) < level:
        name = {MODERATOR: "server moderators", ADMIN: "server admins", OWNER: "the server owner"}[level]
        raise ProtocolError(P.FORBIDDEN, f"Only {name} can do that")


def require_outranks(ctx, conn, user_id: str) -> dict:
    """A server-staff target: must exist and be strictly below the actor."""
    from ..db import staff_level as row_level

    row = ctx.db.get_user_row(user_id)
    if row is None or row["status"] == "deleted":
        raise ProtocolError(P.NOT_FOUND, "User not found")
    if user_id == conn.user_id:
        raise ProtocolError(P.BAD_REQUEST, "You can't do that to yourself")
    if row_level(row) >= staff_level(conn.user):
        raise ProtocolError(P.FORBIDDEN, "That user's server role is not below yours")
    return row


def check_muted(ctx, conn) -> None:
    """Server-wide mute: no sending, reacting, typing, uploading or voice."""
    until = conn.user.get("muted_until")
    if until and (until == "permanent" or until > now_iso()):
        when = "indefinitely" if until == "permanent" else f"until {until}"
        raise ProtocolError(P.MUTED, f"You've been muted on this server {when}")


def rank(ctx, guild_id: str, user_id: str) -> int:
    mp = ctx.perms.member(guild_id, user_id)
    return mp.rank if mp else -1


def require_above(ctx, conn, guild: dict, target_user_id: str) -> dict:
    """target must be a visible member ranked strictly below the actor."""
    if target_user_id == conn.user_id:
        raise ProtocolError(P.BAD_REQUEST, "You can't do that to yourself")
    target = ctx.db.get_membership(guild["guild_id"], target_user_id)
    if target is None or target["ghost"]:
        raise ProtocolError(P.NOT_FOUND, "Member not found")
    if target["role"] == "owner" or rank(ctx, guild["guild_id"], target_user_id) >= rank(ctx, guild["guild_id"], conn.user_id):
        raise ProtocolError(P.FORBIDDEN, "That member's highest role is not below yours")
    return target


def with_perms(ctx, channel: dict, user_id: str) -> dict:
    """Channel object as sent to user_id: adds `my_permissions`."""
    return {**channel, "my_permissions": ctx.perms.channel_perms(channel, user_id)}


def guild_for(ctx, guild: dict, user_id: str, *, ghost: bool) -> dict:
    """Guild object as sent to its member: adds `ghost`, `my_permissions`, `emojis` and `stickers`."""
    return {
        **guild, "ghost": ghost, "my_permissions": ctx.perms.guild_perms(guild["guild_id"], user_id),
        "emojis": ctx.db.list_emojis(guild["guild_id"]), "stickers": ctx.db.list_stickers(guild["guild_id"]),
    }
