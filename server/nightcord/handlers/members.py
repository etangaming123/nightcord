"""member.* handlers: role assignment and moderation (PROTOCOL.md §5 Members)."""

from __future__ import annotations

from .. import permissions as perm
from .. import protocol as P
from ..db import iso_in
from ..protocol import ProtocolError
from . import handles
from ._access import rank, require_above, require_guild_perm


async def member_updated(ctx, guild_id: str, user_id: str) -> None:
    ctx.perms.invalidate_guild(guild_id)
    member = ctx.db.member(guild_id, user_id)
    await ctx.hub.send_to_guild(guild_id, P.frame(P.GUILD_MEMBER_UPDATED, {"guild_id": guild_id, "member": member}))
    await ctx.hub.send_to_user(user_id, P.frame(P.GUILD_PERMISSIONS_CHANGED, {"guild_id": guild_id}))


@handles(P.MEMBER_ROLES_SET)
async def roles_set(ctx, conn, payload):
    guild, _ = require_guild_perm(ctx, conn, P.req_id(payload, "guild_id"), perm.MANAGE_ROLES)
    guild_id = guild["guild_id"]
    user_id = P.req_id(payload, "user_id")
    if user_id != conn.user_id:
        require_above(ctx, conn, guild, user_id)
    elif ctx.db.get_membership(guild_id, user_id) is None:
        raise ProtocolError(P.NOT_FOUND, "Member not found")
    wanted = P.id_list(payload, "role_ids", max_len=P.MAX_ROLES)
    roles = {r["role_id"]: r for r in ctx.db.list_roles(guild_id)}
    for rid in wanted:
        if rid not in roles or roles[rid]["is_everyone"]:
            raise ProtocolError(P.BAD_REQUEST, "Unknown role")
    current = set(ctx.db.member_role_ids(guild_id, user_id))
    my_rank = rank(ctx, guild_id, conn.user_id)
    for rid in current.symmetric_difference(wanted):
        if roles[rid]["position"] >= my_rank:
            raise ProtocolError(P.FORBIDDEN, f"'{roles[rid]['name']}' is not below your highest role")
    ctx.db.set_member_roles(guild_id, user_id, wanted)
    added = [roles[r]["name"] for r in wanted if r not in current]
    removed = [roles[r]["name"] for r in current if r not in wanted]
    ctx.db.add_audit(guild_id, conn.user_id, "member.roles", user_id, {"added": added, "removed": removed})
    await member_updated(ctx, guild_id, user_id)
    return {"member": ctx.db.member(guild_id, user_id)}


@handles(P.MEMBER_KICK)
async def kick(ctx, conn, payload):
    from .guilds import drop_member

    guild, _ = require_guild_perm(ctx, conn, P.req_id(payload, "guild_id"), perm.KICK_MEMBERS)
    user_id = P.req_id(payload, "user_id")
    require_above(ctx, conn, guild, user_id)
    reason = P.opt_text(payload, "reason", P.BAN_REASON_MAX) or None
    ctx.db.add_audit(guild["guild_id"], conn.user_id, "member.kick", user_id, {"reason": reason})
    await drop_member(ctx, guild["guild_id"], user_id, "kicked")
    return {}


@handles(P.MEMBER_BAN)
async def ban(ctx, conn, payload):
    from .guilds import drop_member
    from .messages import broadcast_deleted

    guild, _ = require_guild_perm(ctx, conn, P.req_id(payload, "guild_id"), perm.BAN_MEMBERS)
    guild_id = guild["guild_id"]
    user_id = P.req_id(payload, "user_id")
    if ctx.db.get_user_row(user_id) is None:
        raise ProtocolError(P.NOT_FOUND, "User not found")
    membership = ctx.db.get_membership(guild_id, user_id)
    if membership is not None and not membership["ghost"]:
        require_above(ctx, conn, guild, user_id)
    elif user_id == conn.user_id or user_id == guild["owner_user_id"]:
        raise ProtocolError(P.FORBIDDEN, "You can't ban that user")
    reason = P.opt_text(payload, "reason", P.BAN_REASON_MAX) or None
    delete_seconds = P.opt_int(payload, "delete_seconds") or 0
    if not 0 <= delete_seconds <= P.MAX_BAN_DELETE_SECONDS:
        raise ProtocolError(P.BAD_REQUEST, "'delete_seconds' must be between 0 and 7 days")
    ctx.db.add_ban(guild_id, user_id, reason, conn.user_id)
    ctx.db.add_audit(guild_id, conn.user_id, "member.ban", user_id, {"reason": reason})
    if membership is not None:
        await drop_member(ctx, guild_id, user_id, "banned", ghost=membership["ghost"])
    if delete_seconds:
        for channel_id, message_id in ctx.db.recent_message_ids_by(guild_id, user_id, iso_in(-delete_seconds)):
            channel = ctx.db.get_channel(channel_id)
            ctx.db.delete_message(message_id)
            await broadcast_deleted(ctx, channel, str(message_id))
    return {}


@handles(P.MEMBER_UNBAN)
async def unban(ctx, conn, payload):
    guild, _ = require_guild_perm(ctx, conn, P.req_id(payload, "guild_id"), perm.BAN_MEMBERS)
    user_id = P.req_id(payload, "user_id")
    if not ctx.db.remove_ban(guild["guild_id"], user_id):
        raise ProtocolError(P.NOT_FOUND, "That user isn't banned")
    ctx.db.add_audit(guild["guild_id"], conn.user_id, "member.unban", user_id)
    return {}


@handles(P.MEMBER_TIMEOUT)
async def timeout(ctx, conn, payload):
    guild, _ = require_guild_perm(ctx, conn, P.req_id(payload, "guild_id"), perm.MODERATE_MEMBERS)
    user_id = P.req_id(payload, "user_id")
    require_above(ctx, conn, guild, user_id)
    seconds = P.opt_int(payload, "duration_seconds")
    if seconds is not None and not 0 < seconds <= P.MAX_TIMEOUT_SECONDS:
        raise ProtocolError(P.BAD_REQUEST, "'duration_seconds' must be between 1 second and 28 days")
    until = iso_in(seconds) if seconds else None
    reason = P.opt_text(payload, "reason", P.BAN_REASON_MAX) or None
    ctx.db.set_timeout(guild["guild_id"], user_id, until)
    ctx.db.add_audit(
        guild["guild_id"], conn.user_id, "member.timeout", user_id, {"until": until, "reason": reason}
    )
    await member_updated(ctx, guild["guild_id"], user_id)
    return {"member": ctx.db.member(guild["guild_id"], user_id)}


@handles(P.MEMBER_NICKNAME_SET)
async def nickname_set(ctx, conn, payload):
    guild_id = P.req_id(payload, "guild_id")
    user_id = P.req_id(payload, "user_id")
    flag = perm.CHANGE_NICKNAME if user_id == conn.user_id else perm.MANAGE_NICKNAMES
    guild, _ = require_guild_perm(ctx, conn, guild_id, flag)
    if user_id != conn.user_id:
        require_above(ctx, conn, guild, user_id)
    elif ctx.db.get_membership(guild["guild_id"], user_id) is None:
        raise ProtocolError(P.NOT_FOUND, "Member not found")
    nickname = P.opt_text(payload, "nickname", P.NICKNAME_MAX) or None
    ctx.db.set_nickname(guild["guild_id"], user_id, nickname)
    if user_id != conn.user_id:
        ctx.db.add_audit(guild["guild_id"], conn.user_id, "member.nickname", user_id, {"nickname": nickname})
    member = ctx.db.member(guild["guild_id"], user_id)
    await ctx.hub.send_to_guild(guild["guild_id"], P.frame(P.GUILD_MEMBER_UPDATED, {"guild_id": guild["guild_id"], "member": member}))
    return {"member": member}
