"""channel.* and read_state.* handlers (PROTOCOL.md §5 Channels, Read state)."""

from __future__ import annotations

from .. import permissions as perm
from .. import protocol as P
from ..protocol import ProtocolError
from . import handles
from ._access import (
    get_channel,
    require_channel_perm,
    require_guild_perm,
    require_member,
    with_perms,
)


def _parse_overwrites(ctx, guild_id: str, raw) -> list[dict]:
    if not isinstance(raw, list) or len(raw) > P.MAX_ROLES:
        raise ProtocolError(P.BAD_REQUEST, "'overwrites' must be a list")
    roles = {r["role_id"] for r in ctx.db.list_roles(guild_id)}
    out: dict[str, dict] = {}
    for o in raw:
        if not isinstance(o, dict):
            raise ProtocolError(P.BAD_REQUEST, "Each overwrite must be an object")
        role_id = P.req_id(o, "role_id")
        allow = P.opt_int(o, "allow") or 0
        deny = P.opt_int(o, "deny") or 0
        if role_id not in roles:
            raise ProtocolError(P.BAD_REQUEST, "Overwrite for an unknown role")
        if allow < 0 or deny < 0 or (allow | deny) & ~perm.CHANNEL_PERMS or allow & deny:
            raise ProtocolError(P.BAD_REQUEST, "Overwrites may only use channel permissions, never both allow and deny")
        out[role_id] = {"role_id": role_id, "allow": allow, "deny": deny}
    return list(out.values())


def _check_overwrites_allowed(ctx, conn, guild_id: str, overwrites: list[dict]) -> None:
    """Editing overwrites needs MANAGE_ROLES, and you can't allow what you lack."""
    mine = ctx.perms.guild_perms(guild_id, conn.user_id)
    if not mine & perm.MANAGE_ROLES:
        raise ProtocolError(P.FORBIDDEN, "Changing channel permissions needs Manage Roles")
    for o in overwrites:
        if o["allow"] & ~mine:
            raise ProtocolError(P.FORBIDDEN, "You can't allow permissions you don't have")


async def send_channel_event(ctx, channel: dict, type_: str) -> None:
    await ctx.hub.send_to_channel_viewers(
        channel, lambda uid: P.frame(type_, with_perms(ctx, channel, uid))
    )


def visible_channel_ids(ctx, user_id: str) -> list[str]:
    ids = []
    for g in ctx.db.list_user_guilds(user_id):
        for c in ctx.db.list_channels(g["guild_id"]):
            if ctx.perms.can_view(c, user_id):
                ids.append(c["channel_id"])
    return ids


@handles(P.CHANNEL_LIST)
async def list_channels(ctx, conn, payload):
    guild, _ = require_member(ctx, conn, P.req_str(payload, "guild_id"))
    channels = []
    for c in ctx.db.list_channels(guild["guild_id"]):
        c = with_perms(ctx, c, conn.user_id)
        if c["my_permissions"] & perm.VIEW_CHANNEL:
            channels.append(c)
    return {"channels": channels}


@handles(P.CHANNEL_JOIN)
async def join(ctx, conn, payload):
    channel, _ = get_channel(ctx, conn, P.req_str(payload, "channel_id"))
    ctx.hub.focus(conn, channel["channel_id"])
    return {}


@handles(P.CHANNEL_LEAVE)
async def leave(ctx, conn, payload):
    channel_id = P.req_str(payload, "channel_id")
    if conn.channel_id == channel_id:
        ctx.hub.focus(conn, None)
    return {}


@handles(P.CHANNEL_HISTORY)
async def history(ctx, conn, payload):
    channel, _ = require_channel_perm(ctx, conn, P.req_str(payload, "channel_id"), perm.READ_HISTORY)
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
    guild, _ = require_guild_perm(ctx, conn, P.req_str(payload, "guild_id"), perm.MANAGE_CHANNELS)
    name = P.validate_channel_name(payload.get("name"))
    overwrites = []
    if payload.get("overwrites"):
        overwrites = _parse_overwrites(ctx, guild["guild_id"], payload["overwrites"])
        _check_overwrites_allowed(ctx, conn, guild["guild_id"], overwrites)
    channel = ctx.db.create_channel(guild["guild_id"], name, overwrites)
    ctx.db.add_audit(guild["guild_id"], conn.user_id, "channel.create", channel["channel_id"], {"name": name})
    await send_channel_event(ctx, channel, P.CHANNEL_CREATED)
    return {"channel": with_perms(ctx, channel, conn.user_id)}


@handles(P.CHANNEL_UPDATE)
async def update(ctx, conn, payload):
    channel, _ = require_channel_perm(ctx, conn, P.req_str(payload, "channel_id"), perm.MANAGE_CHANNELS)
    if channel["guild_id"] is None:
        raise ProtocolError(P.BAD_REQUEST, "Use dm.update for direct messages")
    guild_id = channel["guild_id"]
    name = payload.get("name")
    if name is not None:
        name = P.validate_channel_name(name)
    position = P.opt_int(payload, "position")
    if position is not None and position < 0:
        raise ProtocolError(P.BAD_REQUEST, "'position' must be >= 0")
    overwrites = None
    if payload.get("overwrites") is not None:
        overwrites = _parse_overwrites(ctx, guild_id, payload["overwrites"])
        _check_overwrites_allowed(ctx, conn, guild_id, overwrites)
    # Viewers before the change also hear about it, so channels that just
    # became hidden from them can disappear.
    before_viewers = set(ctx.hub.viewer_ids(channel))
    if overwrites is not None:
        ctx.db.set_overwrites(channel["channel_id"], overwrites)
        ctx.perms.invalidate_channel(channel["channel_id"])
    channel = ctx.db.update_channel(channel["channel_id"], name=name, position=position)
    if name is not None or overwrites is not None:
        details = {"name": channel["name"]}
        if overwrites is not None:
            details["overwrites"] = True
        ctx.db.add_audit(guild_id, conn.user_id, "channel.update", channel["channel_id"], details)
    await send_channel_event(ctx, channel, P.CHANNEL_UPDATED)
    if overwrites is not None:
        gone = before_viewers - set(ctx.hub.viewer_ids(channel))
        await ctx.hub.send_to_users(
            gone, P.frame(P.CHANNEL_DELETED, {"guild_id": guild_id, "channel_id": channel["channel_id"]})
        )
        await ctx.hub.send_to_guild(guild_id, P.frame(P.GUILD_PERMISSIONS_CHANGED, {"guild_id": guild_id}))
    return {"channel": with_perms(ctx, channel, conn.user_id)}


@handles(P.CHANNEL_DELETE)
async def delete(ctx, conn, payload):
    channel, _ = require_channel_perm(ctx, conn, P.req_str(payload, "channel_id"), perm.MANAGE_CHANNELS)
    if channel["guild_id"] is None:
        raise ProtocolError(P.BAD_REQUEST, "Use dm.leave for direct messages")
    ctx.db.delete_channel(channel["channel_id"])
    ctx.perms.invalidate_channel(channel["channel_id"])
    ctx.hub.unfocus_channel(channel["channel_id"])
    ctx.db.add_audit(channel["guild_id"], conn.user_id, "channel.delete", channel["channel_id"], {"name": channel["name"]})
    await ctx.hub.send_to_guild(
        channel["guild_id"],
        P.frame(P.CHANNEL_DELETED, {"guild_id": channel["guild_id"], "channel_id": channel["channel_id"]}),
    )
    return {}


@handles(P.CHANNEL_ACK)
async def ack(ctx, conn, payload):
    channel, _ = get_channel(ctx, conn, P.req_str(payload, "channel_id"))
    message_id = P.req_id(payload, "message_id")
    state = ctx.db.ack(conn.user_id, channel["channel_id"], int(message_id))
    await ctx.hub.send_to_user(conn.user_id, P.frame(P.READ_STATE_UPDATED, state), exclude=conn)
    return {"read_state": state}


@handles(P.READ_STATE_LIST)
async def read_state_list(ctx, conn, payload):
    ids = visible_channel_ids(ctx, conn.user_id) + [c["channel_id"] for c in ctx.db.list_dms(conn.user_id)]
    return {"read_states": ctx.db.read_states(conn.user_id, ids)}
