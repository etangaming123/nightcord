"""Shared lookups and permission checks for handlers."""

from __future__ import annotations

from .. import permissions as perm
from .. import protocol as P
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
    """Guild object as sent to its member: adds `ghost` and `my_permissions`."""
    return {**guild, "ghost": ghost, "my_permissions": ctx.perms.guild_perms(guild["guild_id"], user_id)}
