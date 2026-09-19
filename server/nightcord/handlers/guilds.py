"""guild.* handlers (PROTOCOL.md §5 Guilds, §6, §7)."""

from __future__ import annotations

from .. import perks
from .. import permissions as perm
from .. import protocol as P
from ..protocol import ProtocolError
from . import handles
from ._access import (
    ADMIN,
    guild_for,
    require_guild,
    require_guild_owner,
    require_guild_perm,
    require_member,
    require_staff,
)


async def system_message(ctx, guild_id: str, user_id: str, flag: int, type_: str) -> None:
    """Post a join/leave line to the guild's system channel if enabled."""
    from .messages import post_system

    guild = ctx.db.get_guild(guild_id)
    if guild is None or not guild["system_channel_id"] or not guild["system_flags"] & flag:
        return
    channel = ctx.db.get_channel(guild["system_channel_id"])
    if channel is None or channel["guild_id"] != guild_id or channel["kind"] != "text":
        return
    await post_system(ctx, channel, user_id, type_)


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
    await system_message(ctx, guild_id, user_id, P.SYSTEM_JOIN, "member_join")


async def _join(ctx, conn, guild: dict, *, invite_row=None) -> dict:
    """Normal (visible) join. Upgrades an existing ghost membership."""
    guild_id = guild["guild_id"]
    membership = ctx.db.get_membership(guild_id, conn.user_id)
    if membership is not None and not membership["ghost"]:
        raise ProtocolError(P.ALREADY_MEMBER, "You're already in this guild")
    if ctx.db.is_banned(guild_id, conn.user_id):
        raise ProtocolError(P.BANNED, "You're banned from this guild")
    if membership is not None:
        ctx.db.remove_membership(guild_id, conn.user_id)
    if invite_row is not None:
        ctx.db.use_invite(invite_row["code"])
    ctx.db.add_membership(
        guild_id, conn.user_id,
        invited_by=invite_row["created_by"] if invite_row is not None else None,
        invite_code=invite_row["code"] if invite_row is not None else (
            guild["vanity_code"] if guild.get("_via_vanity") else None
        ),
    )
    ctx.perms.invalidate_guild(guild_id)
    await announce_join(ctx, guild_id, conn.user_id)
    return {"guild": guild_for(ctx, guild, conn.user_id, ghost=False)}


async def remove_guild(ctx, guild: dict) -> None:
    """Delete a guild and tell every member (guild.removed, reason deleted)."""
    from .files import delete_files
    from .users import drop_image

    guild_id = guild["guild_id"]
    members = ctx.db.all_member_ids(guild_id)
    channel_ids = [c["channel_id"] for c in ctx.db.list_channels(guild_id)]
    media = ctx.db.guild_media_ids(guild_id)
    files = ctx.db.attachment_ids_in_guild(guild_id)
    ctx.db.delete_guild(guild_id)
    for ref in media:
        drop_image(ctx, ref)
    delete_files(ctx, files)
    ctx.perms.invalidate_guild(guild_id)
    await ctx.hub.voice_drop_where(lambda v: v["guild_id"] == guild_id)
    for cid in channel_ids:
        ctx.hub.unfocus_channel(cid)
    await ctx.hub.send_to_users(
        members, P.frame(P.GUILD_REMOVED, {"guild_id": guild_id, "reason": "deleted"})
    )


async def drop_member(ctx, guild_id: str, user_id: str, reason: str, *, ghost: bool = False) -> None:
    """Remove a membership and send the events for `reason` (left | kicked | banned)."""
    channel_ids = {c["channel_id"] for c in ctx.db.list_channels(guild_id)}
    state = ctx.hub.voice.get(user_id)
    if state and state["guild_id"] == guild_id:
        await ctx.hub.voice_leave(user_id)
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
        await system_message(ctx, guild_id, user_id, P.SYSTEM_LEAVE, "member_leave")


async def transfer_guild(ctx, guild_id: str, new_owner: str) -> None:
    ctx.db.transfer_guild(guild_id, new_owner)
    ctx.perms.invalidate_guild(guild_id)
    ctx.db.add_audit(guild_id, new_owner, "guild.transfer", new_owner)
    await ctx.hub.send_to_guild(guild_id, P.frame(P.GUILD_UPDATED, ctx.db.get_guild(guild_id)))
    member = ctx.db.member(guild_id, new_owner)
    await ctx.hub.send_to_guild(guild_id, P.frame(P.GUILD_MEMBER_UPDATED, {"guild_id": guild_id, "member": member}))
    await ctx.hub.send_to_guild(guild_id, P.frame(P.GUILD_PERMISSIONS_CHANGED, {"guild_id": guild_id}))

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
    row, guild = _check_invite(ctx, code)
    if row is None:
        guild = {**guild, "_via_vanity": True}
    result = await _join(ctx, conn, guild, invite_row=row)
    return result


def _check_invite(ctx, code: str):
    status, row, guild = ctx.db.invite_state(code)
    if status == "invalid" or guild is None:
        raise ProtocolError(P.INVITE_INVALID, "That invite is invalid or has been revoked")
    if status == "expired":
        raise ProtocolError(P.INVITE_EXPIRED, "That invite has expired")
    return row, guild


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
    require_staff(conn, ADMIN)
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
    guild_id = guild["guild_id"]
    changes: dict = {}
    if payload.get("name") is not None:
        changes["name"] = P.validate_guild_name(payload["name"])
    listed = P.opt_bool(payload, "listed")
    if listed is not None:
        changes["listed"] = listed
    if "system_channel_id" in payload:
        cid = P.opt_id(payload, "system_channel_id")
        if cid is not None:
            ch = ctx.db.get_channel(cid)
            if ch is None or ch["guild_id"] != guild_id or ch["kind"] != "text":
                raise ProtocolError(P.BAD_REQUEST, "The system channel must be a text channel in this guild")
        changes["system_channel_id"] = cid
    flags = P.opt_int(payload, "system_flags")
    if flags is not None:
        if flags < 0 or flags & ~(P.SYSTEM_JOIN | P.SYSTEM_LEAVE):
            raise ProtocolError(P.BAD_REQUEST, "Unknown system message flags")
        changes["system_flags"] = flags
    if "vanity_code" in payload:
        vanity = payload["vanity_code"]
        if vanity is not None:
            if not isinstance(vanity, str) or not P.VANITY_RE.match(vanity.strip().lower()):
                raise ProtocolError(P.BAD_REQUEST, "Vanity links must be 3-32 characters: a-z, 0-9, -")
            vanity = vanity.strip().lower()
            if ctx.db.vanity_taken(vanity, guild_id) or ctx.db.invite_row(vanity) is not None:
                raise ProtocolError(P.BAD_REQUEST, "That vanity link is taken")
        changes["vanity_code"] = vanity
    old_banner = guild["banner_id"]
    if "banner_media_id" in payload:
        from .users import claim_image

        changes["banner_id"] = None
        if payload["banner_media_id"] is not None:
            changes["banner_id"] = claim_image(
                ctx, conn.user_id, payload["banner_media_id"], "guild_banner", "guild_banner",
                perks.guild_owner(ctx, guild), guild=True,
            )
    guild = ctx.db.update_guild(guild_id, changes)
    if "banner_id" in changes and changes["banner_id"] != old_banner:
        from .users import drop_image

        drop_image(ctx, old_banner)
    if changes:
        ctx.db.add_audit(
            guild_id, conn.user_id, "guild.update", guild_id,
            {k: (bool(v) if k == "banner_id" else v) for k, v in changes.items()},
        )
    await ctx.hub.send_to_guild(guild_id, P.frame(P.GUILD_UPDATED, guild))
    return {"guild": guild}


@handles(P.GUILD_ICON_SET)
async def icon_set(ctx, conn, payload):
    from .users import claim_image, drop_image, store_image

    guild, _ = require_guild_perm(ctx, conn, P.req_id(payload, "guild_id"), perm.MANAGE_GUILD)
    data_b64 = payload.get("data_b64")
    if payload.get("media_id") is not None:
        icon_id = claim_image(
            ctx, conn.user_id, payload["media_id"], "guild_icon", None, perks.guild_owner(ctx, guild), guild=True
        )
    else:
        icon_id = None if data_b64 is None else store_image(ctx, data_b64)
    old = guild["icon_id"]
    guild = ctx.db.update_guild(guild["guild_id"], {"icon_id": icon_id})
    drop_image(ctx, old)
    ctx.db.add_audit(guild["guild_id"], conn.user_id, "guild.update", guild["guild_id"], {"icon": bool(icon_id)})
    await ctx.hub.send_to_guild(guild["guild_id"], P.frame(P.GUILD_UPDATED, guild))
    return {"guild": guild}


@handles(P.GUILD_INVITE_CREATE)
async def invite_create(ctx, conn, payload):
    guild, _ = require_guild_perm(ctx, conn, P.req_str(payload, "guild_id"), perm.CREATE_INVITE)
    max_uses = P.opt_int(payload, "max_uses") or 0
    max_age = P.opt_int(payload, "max_age_seconds") or 0
    if max_uses not in P.INVITE_MAX_USES:
        raise ProtocolError(P.BAD_REQUEST, f"'max_uses' must be one of {P.INVITE_MAX_USES}")
    if max_age not in P.INVITE_MAX_AGES:
        raise ProtocolError(P.BAD_REQUEST, f"'max_age_seconds' must be one of {P.INVITE_MAX_AGES}")
    invite = ctx.db.create_invite(guild["guild_id"], conn.user_id, max_uses=max_uses, max_age_seconds=max_age)
    return {"invite_code": invite["code"], "invite": invite}


@handles(P.GUILD_INVITE_LIST)
async def invite_list(ctx, conn, payload):
    guild, membership = require_member(ctx, conn, P.req_id(payload, "guild_id"))
    if membership["ghost"]:
        return {"invites": ctx.db.list_invites(guild["guild_id"])}
    mine = ctx.perms.guild_perms(guild["guild_id"], conn.user_id)
    everyone = bool(mine & perm.MANAGE_GUILD)
    return {"invites": ctx.db.list_invites(guild["guild_id"], None if everyone else conn.user_id)}


@handles(P.GUILD_INVITE_REVOKE)
async def invite_revoke(ctx, conn, payload):
    row = ctx.db.invite_row(P.req_str(payload, "invite_code", max_len=64))
    if row is None or row["revoked_at"]:
        raise ProtocolError(P.NOT_FOUND, "Invite not found")
    guild, membership = require_member(ctx, conn, row["guild_id"])
    own = row["created_by"] == conn.user_id
    if membership["ghost"] or not (own or ctx.perms.guild_perms(guild["guild_id"], conn.user_id) & perm.MANAGE_GUILD):
        raise ProtocolError(P.FORBIDDEN, "You can only revoke your own invites")
    ctx.db.revoke_invite(row["code"])
    ctx.db.add_audit(guild["guild_id"], conn.user_id, "invite.revoke", row["created_by"], {"code": row["code"]})
    return {}


@handles(P.GUILD_INVITE_RESOLVE)
async def invite_resolve(ctx, conn, payload):
    code = P.req_str(payload, "invite_code", max_len=64)
    row, guild = _check_invite(ctx, code)
    members = ctx.db.non_ghost_member_ids(guild["guild_id"])
    return {
        "guild": {
            "guild_id": guild["guild_id"], "name": guild["name"], "icon_id": guild["icon_id"],
            "banner_id": guild["banner_id"] if perks.can(ctx, "guild_banner", perks.guild_owner(ctx, guild)) else None,
        },
        "member_count": len(members),
        "online_count": len(ctx.hub.presences(members)),
        "inviter": ctx.db.public_user(row["created_by"]) if row is not None else None,
        "expires_at": row["expires_at"] if row is not None else None,
        "is_member": _is_visible_member(ctx, guild["guild_id"], conn.user_id),
    }


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


def _is_visible_member(ctx, guild_id: str, user_id: str) -> bool:
    m = ctx.db.get_membership(guild_id, user_id)
    return m is not None and not m["ghost"]
