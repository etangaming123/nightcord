"""Shared membership / ownership checks."""

from __future__ import annotations

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


def require_writer(ctx, conn, guild_id) -> tuple[dict, dict]:
    """A real (non-ghost) member. Ghost memberships are read-only (§7)."""
    guild, membership = require_member(ctx, conn, guild_id)
    if membership["ghost"]:
        raise ProtocolError(P.FORBIDDEN, "Ghost memberships are read-only")
    return guild, membership


def require_guild_owner(ctx, conn, guild_id) -> dict:
    guild, membership = require_writer(ctx, conn, guild_id)
    if membership["role"] != "owner":
        raise ProtocolError(P.FORBIDDEN, "Only the guild owner can do that")
    return guild


def require_channel(ctx, conn, channel_id) -> tuple[dict, dict]:
    """Returns (channel, membership) for a channel in a guild the user belongs to."""
    channel = ctx.db.get_channel(channel_id) if isinstance(channel_id, str) else None
    if channel is None:
        raise ProtocolError(P.NOT_FOUND, "Channel not found")
    membership = ctx.db.get_membership(channel["guild_id"], conn.user_id)
    if membership is None:
        raise ProtocolError(P.NOT_FOUND, "Channel not found")
    return channel, membership
