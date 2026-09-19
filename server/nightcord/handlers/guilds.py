"""guild.* handlers (PROTOCOL.md §5 Guilds, §6, §7)."""

from __future__ import annotations

from .. import permissions as perm
from .. import protocol as P
from ..protocol import ProtocolError
from . import handles
from ._access import (
    guild_for,
    require_guild,
    require_guild_owner,
    require_guild_perm,
    require_member,
)


async def announce_join(ctx, guild_id: str, user_id: str) -> None:
    member = ctx.db.member(guild_id, user_id)
    await ctx.hub.send_to_guild(
        guild_id,
        P.frame(P.GUILD_MEMBER_JOINED, {"guild_id": guild_id, "member": member}),
        exclude_user=user_id,
    )
    # The joiner is online by definition; the guild learns their status, and
    # the refresh makes sure new audience members hear future changes.
    status = ctx.hub.status_of(user_id)
    if status != "offline":
        await ctx.hub.send_to_guild(
            guild_id,
            P.frame(P.PRESENCE_UPDATE, {"user_id": user_id, "status": status}),
            exclude_user=user_id,
        )


async def _join(ctx, conn, guild: dict) -> dict:
    """Normal (visible) join. Upgrades an existing ghost membership."""
    guild_id = guild["guild_id"]
    membership = ctx.db.get_membership(guild_id, conn.user_id)
    if membership is not None and not membership["ghost"]:
        raise ProtocolError(P.ALREADY_MEMBER, "You're already in this guild")
    if ctx.db.is_banned(guild_id, conn.user_id):
        raise ProtocolError(P.BANNED, "You're banned from this guild")
    if membership is not None:
        ctx.db.remove_membership(guild_id, conn.user_id)
    ctx.db.add_membership(guild_id, conn.user_id)
    ctx.perms.invalidate_guild(guild_id)
    await announce_join(ctx, guild_id, conn.user_id)
    return {"guild": guild_for(ctx, guild, conn.user_id, ghost=False)}


async def remove_guild(ctx, guild: dict) -> None:
    """Delete a guild and tell every member (guild.removed, reason deleted)."""
    guild_id = guild["guild_id"]
    members = ctx.db.all_member_ids(guild_id)
    channel_ids = [c["channel_id"] for c in ctx.db.list_channels(guild_id)]
    ctx.db.delete_guild(guild_id)
    ctx.perms.invalidate_guild(guild_id)
    for cid in channel_ids:
        ctx.hub.unfocus_channel(cid)
    await ctx.hub.send_to_users(
        members, P.frame(P.GUILD_REMOVED, {"guild_id": guild_id, "reason": "deleted"})
    )


async def drop_member(ctx, guild_id: str, user_id: str, reason: str, *, ghost: bool = False) -> None:
    """Remove a membership and send the events for `reason` (left | kicked | banned)."""
    channel_ids = {c["channel_id"] for c in ctx.db.list_channels(guild_id)}
    ctx.db.remove_membership(guild_id, user_id)
    ctx.perms.invalidate_guild(guild_id)
    for conn in ctx.hub.conns_by_user.get(user_id, ()):
        if conn.channel_id in channel_ids:
            conn.channel_id = None
    if reason != "left":
        await ctx.hub.send_to_user(user_id, P.frame(P.GUILD_REMOVED, {"guild_id": guild_id, "reason": reason}))
    if not ghost:
        await ctx.hub.send_to_guild(
            guild_id,
            P.frame(P.GUILD_MEMBER_LEFT, {"guild_id": guild_id, "user_id": user_id, "reason": reason}),
        )


@handles(P.GUILD_LIST)
async def list_guilds(ctx, conn, payload):
    guilds = ctx.db.list_user_guilds(conn.user_id)
    return {"guilds": [guild_for(ctx, g, conn.user_id, ghost=g["ghost"]) for g in guilds]}


@handles(P.GUILD_CREATE)
async def create(ctx, conn, payload):
    name = P.validate_guild_name(payload.get("name"))
    if ctx.db.get_server_config()["guild_creation"] != "on" and not conn.user["is_server_owner"]:
        raise ProtocolError(P.GUILD_CREATION_DISABLED, "Guild creation is disabled on this server")
    guild, channels = ctx.db.create_guild(name, conn.user_id)
    return {
        "guild": guild_for(ctx, guild, conn.user_id, ghost=False),
        "channels": [{**c, "my_permissions": perm.ALL} for c in channels],
    }


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
    ctx.perms.invalidate_guild(guild["guild_id"])
    # Silent: no member_joined / presence events (§7).
    return {"guild": guild_for(ctx, guild, conn.user_id, ghost=True)}


@handles(P.GUILD_LEAVE)
async def leave(ctx, conn, payload):
    guild, membership = require_member(ctx, conn, P.req_str(payload, "guild_id"))
    if membership["role"] == "owner":
        raise ProtocolError(P.FORBIDDEN, "The guild owner can't leave their own guild")
    await drop_member(ctx, guild["guild_id"], conn.user_id, "left", ghost=membership["ghost"])
    return {}


@handles(P.GUILD_DELETE)
async def delete(ctx, conn, payload):
    guild = require_guild_owner(ctx, conn, P.req_str(payload, "guild_id"))
    await remove_guild(ctx, guild)
    return {}


@handles(P.GUILD_MEMBERS)
async def members(ctx, conn, payload):
    guild, _ = require_member(ctx, conn, P.req_str(payload, "guild_id"))
    return {"members": ctx.db.list_members(guild["guild_id"])}


@handles(P.GUILD_CONFIG_UPDATE)
async def config_update(ctx, conn, payload):
    guild, _ = require_guild_perm(ctx, conn, P.req_str(payload, "guild_id"), perm.MANAGE_GUILD)
    name = payload.get("name")
    if name is not None:
        name = P.validate_guild_name(name)
    listed = P.opt_bool(payload, "listed")
    changes = {k: v for k, v in (("name", name), ("listed", listed)) if v is not None}
    guild = ctx.db.update_guild(guild["guild_id"], name=name, listed=listed)
    if changes:
        ctx.db.add_audit(guild["guild_id"], conn.user_id, "guild.update", guild["guild_id"], changes)
    await ctx.hub.send_to_guild(guild["guild_id"], P.frame(P.GUILD_UPDATED, guild))
    return {"guild": guild}


@handles(P.GUILD_INVITE_CREATE)
async def invite_create(ctx, conn, payload):
    guild, _ = require_guild_perm(ctx, conn, P.req_str(payload, "guild_id"), perm.CREATE_INVITE)
    code = ctx.db.create_invite(guild["guild_id"], conn.user_id)
    return {"invite_code": code}


@handles(P.GUILD_BANS_LIST)
async def bans_list(ctx, conn, payload):
    guild, _ = require_guild_perm(ctx, conn, P.req_str(payload, "guild_id"), perm.BAN_MEMBERS)
    return {"bans": ctx.db.list_bans(guild["guild_id"])}


@handles(P.GUILD_AUDIT_LOG)
async def audit_log(ctx, conn, payload):
    guild, _ = require_guild_perm(ctx, conn, P.req_str(payload, "guild_id"), perm.VIEW_AUDIT_LOG)
    before = P.opt_id(payload, "before")
    limit = P.opt_int(payload, "limit")
    limit = 50 if limit is None else max(1, min(limit, 100))
    entries, has_more = ctx.db.list_audit(guild["guild_id"], int(before) if before else None, limit)
    return {"entries": entries, "has_more": has_more}
