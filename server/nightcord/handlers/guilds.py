"""guild.* handlers (PROTOCOL.md §5 Guilds, §6, §7)."""

from __future__ import annotations

from .. import protocol as P
from ..protocol import ProtocolError
from . import handles
from ._access import require_guild, require_guild_owner, require_member


async def _announce_join(ctx, conn, guild_id: str) -> None:
    member = ctx.db.member(guild_id, conn.user_id)
    await ctx.hub.send_to_guild(
        guild_id,
        P.frame(P.GUILD_MEMBER_JOINED, {"guild_id": guild_id, "member": member}),
        exclude_user=conn.user_id,
    )
    # The joiner is online by definition; let the guild know.
    await ctx.hub.send_to_guild(
        guild_id,
        P.frame(P.PRESENCE_UPDATE, {"guild_id": guild_id, "user_id": conn.user_id, "status": "online"}),
        exclude_user=conn.user_id,
    )


async def _join(ctx, conn, guild: dict) -> dict:
    """Normal (visible) join. Upgrades an existing ghost membership."""
    guild_id = guild["guild_id"]
    membership = ctx.db.get_membership(guild_id, conn.user_id)
    if membership is not None and not membership["ghost"]:
        raise ProtocolError(P.ALREADY_MEMBER, "You're already in this guild")
    if membership is not None:
        ctx.db.remove_membership(guild_id, conn.user_id)
    ctx.db.add_membership(guild_id, conn.user_id)
    await _announce_join(ctx, conn, guild_id)
    return {"guild": {**guild, "ghost": False}}


@handles(P.GUILD_LIST)
async def list_guilds(ctx, conn, payload):
    return {"guilds": ctx.db.list_user_guilds(conn.user_id)}


@handles(P.GUILD_CREATE)
async def create(ctx, conn, payload):
    name = P.validate_guild_name(payload.get("name"))
    if ctx.db.get_server_config()["guild_creation"] != "on" and not conn.user["is_server_owner"]:
        raise ProtocolError(P.GUILD_CREATION_DISABLED, "Guild creation is disabled on this server")
    guild, channels = ctx.db.create_guild(name, conn.user_id)
    return {"guild": {**guild, "ghost": False}, "channels": channels}


@handles(P.GUILD_PUBLIC_LIST)
async def public_list(ctx, conn, payload):
    if not ctx.db.get_server_config()["guild_list_visible"]:
        return {"guilds": []}
    return {"guilds": ctx.db.list_public_guilds()}


@handles(P.GUILD_JOIN_BY_CODE)
async def join_by_code(ctx, conn, payload):
    code = P.req_str(payload, "invite_code", max_len=64)
    guild_id = ctx.db.resolve_invite(code)
    if guild_id is None:
        raise ProtocolError(P.INVITE_INVALID, "That invite code is invalid")
    return await _join(ctx, conn, require_guild(ctx, guild_id))


@handles(P.GUILD_JOIN_BY_ID)
async def join_by_id(ctx, conn, payload):
    guild = require_guild(ctx, P.req_str(payload, "guild_id"))
    listed = guild["listed"] and ctx.db.get_server_config()["guild_list_visible"]
    if not listed:
        # Unlisted guilds are indistinguishable from missing ones.
        raise ProtocolError(P.NOT_FOUND, "Guild not found")
    return await _join(ctx, conn, guild)


@handles(P.GUILD_OWNER_OVERRIDE_JOIN)
async def owner_override_join(ctx, conn, payload):
    if not conn.user["is_server_owner"]:
        raise ProtocolError(P.FORBIDDEN, "Only the server owner can do that")
    guild = require_guild(ctx, P.req_str(payload, "guild_id"))
    if ctx.db.get_membership(guild["guild_id"], conn.user_id) is not None:
        raise ProtocolError(P.ALREADY_MEMBER, "You're already in this guild")
    ctx.db.add_membership(guild["guild_id"], conn.user_id, ghost=True)
    # Silent: no member_joined / presence events (§7).
    return {"guild": {**guild, "ghost": True}}


@handles(P.GUILD_LEAVE)
async def leave(ctx, conn, payload):
    guild, membership = require_member(ctx, conn, P.req_str(payload, "guild_id"))
    guild_id = guild["guild_id"]
    if membership["role"] == "owner":
        raise ProtocolError(P.FORBIDDEN, "The guild owner can't leave their own guild")
    ctx.db.remove_membership(guild_id, conn.user_id)
    ctx.hub.unsubscribe_user_from(
        conn.user_id, (c["channel_id"] for c in ctx.db.list_channels(guild_id))
    )
    if not membership["ghost"]:
        await ctx.hub.send_to_guild(
            guild_id, P.frame(P.GUILD_MEMBER_LEFT, {"guild_id": guild_id, "user_id": conn.user_id})
        )
    return {}


@handles(P.GUILD_MEMBERS)
async def members(ctx, conn, payload):
    guild, _ = require_member(ctx, conn, P.req_str(payload, "guild_id"))
    return {"members": ctx.db.list_members(guild["guild_id"])}


@handles(P.GUILD_CONFIG_UPDATE)
async def config_update(ctx, conn, payload):
    guild = require_guild_owner(ctx, conn, P.req_str(payload, "guild_id"))
    name = payload.get("name")
    if name is not None:
        name = P.validate_guild_name(name)
    listed = P.opt_bool(payload, "listed")
    guild = ctx.db.update_guild(guild["guild_id"], name=name, listed=listed)
    await ctx.hub.send_to_guild(guild["guild_id"], P.frame(P.GUILD_UPDATED, guild))
    return {"guild": guild}


@handles(P.GUILD_INVITE_CREATE)
async def invite_create(ctx, conn, payload):
    guild = require_guild_owner(ctx, conn, P.req_str(payload, "guild_id"))
    return {"invite_code": ctx.db.create_invite(guild["guild_id"], conn.user_id)}
