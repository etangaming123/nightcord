"""channel.* handlers (PROTOCOL.md §5 Channels)."""

from __future__ import annotations

from .. import protocol as P
from ..protocol import ProtocolError
from . import handles
from ._access import require_channel, require_guild_owner, require_member


@handles(P.CHANNEL_LIST)
async def list_channels(ctx, conn, payload):
    guild, _ = require_member(ctx, conn, P.req_str(payload, "guild_id"))
    return {"channels": ctx.db.list_channels(guild["guild_id"])}


@handles(P.CHANNEL_JOIN)
async def join(ctx, conn, payload):
    channel, _ = require_channel(ctx, conn, P.req_str(payload, "channel_id"))
    ctx.hub.subscribe(conn, channel["channel_id"])
    return {}


@handles(P.CHANNEL_LEAVE)
async def leave(ctx, conn, payload):
    channel_id = P.req_str(payload, "channel_id")
    if conn.channel_id == channel_id:
        ctx.hub.unsubscribe(conn)
    return {}


@handles(P.CHANNEL_HISTORY)
async def history(ctx, conn, payload):
    channel, _ = require_channel(ctx, conn, P.req_str(payload, "channel_id"))
    limit = P.opt_int(payload, "limit")
    limit = P.HISTORY_DEFAULT_LIMIT if limit is None else max(1, min(limit, P.HISTORY_MAX_LIMIT))
    before = P.opt_str(payload, "before_message_id")
    if before is not None and not before.isdigit():
        raise ProtocolError(P.BAD_REQUEST, "'before_message_id' must be a message id")
    messages, has_more = ctx.db.history(
        channel["channel_id"], int(before) if before is not None else None, limit
    )
    return {"messages": messages, "has_more": has_more}


@handles(P.CHANNEL_CREATE)
async def create(ctx, conn, payload):
    guild = require_guild_owner(ctx, conn, P.req_str(payload, "guild_id"))
    name = P.validate_channel_name(payload.get("name"))
    channel = ctx.db.create_channel(guild["guild_id"], name)
    await ctx.hub.send_to_guild(guild["guild_id"], P.frame(P.CHANNEL_CREATED, channel))
    return {"channel": channel}


def _owned_channel(ctx, conn, payload) -> dict:
    channel, _ = require_channel(ctx, conn, P.req_str(payload, "channel_id"))
    require_guild_owner(ctx, conn, channel["guild_id"])
    return channel


@handles(P.CHANNEL_UPDATE)
async def update(ctx, conn, payload):
    channel = _owned_channel(ctx, conn, payload)
    name = payload.get("name")
    if name is not None:
        name = P.validate_channel_name(name)
    position = P.opt_int(payload, "position")
    if position is not None and position < 0:
        raise ProtocolError(P.BAD_REQUEST, "'position' must be >= 0")
    channel = ctx.db.update_channel(channel["channel_id"], name=name, position=position)
    await ctx.hub.send_to_guild(channel["guild_id"], P.frame(P.CHANNEL_UPDATED, channel))
    return {"channel": channel}


@handles(P.CHANNEL_DELETE)
async def delete(ctx, conn, payload):
    channel = _owned_channel(ctx, conn, payload)
    ctx.db.delete_channel(channel["channel_id"])
    ctx.hub.drop_channel(channel["channel_id"])
    await ctx.hub.send_to_guild(
        channel["guild_id"],
        P.frame(P.CHANNEL_DELETED, {"guild_id": channel["guild_id"], "channel_id": channel["channel_id"]}),
    )
    return {}
