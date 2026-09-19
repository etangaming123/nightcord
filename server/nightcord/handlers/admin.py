"""admin.* handlers — server staff tools (PROTOCOL.md §5 Admin, §8c).

Server roles, lowest to highest: none < moderator < admin < owner.
Moderators enforce (approve/disable accounts, global mutes, IP/device bans);
admins also delete accounts, reset passwords and manage guilds; only the
owner changes server config, legal documents and appoints admins. Staff can
only act on users whose server role is strictly below their own.
"""

from __future__ import annotations

import ipaddress
import secrets

from .. import protocol as P
from ..db import iso_in
from ..protocol import ProtocolError
from . import handles
from ._access import ADMIN, MODERATOR, OWNER, require_guild, require_outranks, require_staff, staff_level
from .auth import hash_password
from .guilds import remove_guild

USER_STATUSES = ("pending", "active", "rejected", "disabled")
# Allowed admin.users.set_status transitions.
_TRANSITIONS = {
    "active": {"pending", "disabled"},
    "rejected": {"pending"},
    "disabled": {"active"},
}
_ROLE_LEVELS = {"none": 0, "moderator": MODERATOR, "admin": ADMIN}


def _audit(ctx, conn, action: str, target_id: str | None = None, details: dict | None = None) -> None:
    ctx.db.add_server_audit(conn.user_id, action, target_id, details)


async def _refresh_user(ctx, user_id: str) -> None:
    from .users import broadcast_user

    user = ctx.db.get_user(user_id)
    if user is not None:
        await broadcast_user(ctx, user)


def _limit(payload) -> tuple[int | None, int]:
    before = P.opt_id(payload, "before")
    limit = P.opt_int(payload, "limit")
    return (int(before) if before else None), (50 if limit is None else max(1, min(limit, 100)))


@handles(P.ADMIN_USERS_LIST)
async def users_list(ctx, conn, payload):
    require_staff(conn, MODERATOR)
    status = P.opt_enum(payload, "status", USER_STATUSES)
    query = P.opt_text(payload, "query", 64) or None
    return {"users": ctx.db.list_users(status=status, query=query)}


@handles(P.ADMIN_USERS_SET_STATUS)
async def users_set_status(ctx, conn, payload):
    require_staff(conn, MODERATOR)
    row = require_outranks(ctx, conn, P.req_id(payload, "user_id"))
    status = P.opt_enum(payload, "status", tuple(_TRANSITIONS))
    if status is None:
        raise ProtocolError(P.BAD_REQUEST, "'status' is required")
    if row["status"] not in _TRANSITIONS[status]:
        raise ProtocolError(P.BAD_REQUEST, f"Can't change a {row['status']} account to {status}")
    ctx.db.set_user_status(row["user_id"], status)
    _audit(ctx, conn, "user.status", row["user_id"], {"username": row["username"], "status": status})
    if status == "disabled":
        await ctx.hub.voice_leave(row["user_id"])
        await ctx.hub.close_user(row["user_id"])
    return {"user": ctx.db.admin_user(row["user_id"])}


@handles(P.ADMIN_USERS_RESET_PASSWORD)
async def users_reset_password(ctx, conn, payload):
    require_staff(conn, ADMIN)
    row = require_outranks(ctx, conn, P.req_id(payload, "user_id"))
    password = secrets.token_urlsafe(12)
    ctx.db.set_password_hash(row["user_id"], await hash_password(password))
    _audit(ctx, conn, "user.reset_password", row["user_id"], {"username": row["username"]})
    await ctx.hub.close_user(row["user_id"])
    return {"password": password}


@handles(P.ADMIN_USERS_MUTE)
async def users_mute(ctx, conn, payload):
    require_staff(conn, MODERATOR)
    row = require_outranks(ctx, conn, P.req_id(payload, "user_id"))
    seconds = P.opt_int(payload, "duration_seconds")
    permanent = P.opt_bool(payload, "permanent") or False
    if seconds is not None and not 0 < seconds <= P.MAX_MUTE_SECONDS:
        raise ProtocolError(P.BAD_REQUEST, "'duration_seconds' must be between 1 second and 365 days")
    until = "permanent" if permanent else (iso_in(seconds) if seconds else None)
    reason = P.opt_text(payload, "reason", P.BAN_REASON_MAX) or None
    ctx.db.update_profile(row["user_id"], {"muted_until": until})
    _audit(ctx, conn, "user.mute", row["user_id"], {"username": row["username"], "until": until, "reason": reason})
    if until:
        await ctx.hub.voice_leave(row["user_id"])
    await _refresh_user(ctx, row["user_id"])
    return {"user": ctx.db.admin_user(row["user_id"])}


@handles(P.ADMIN_USERS_DELETE)
async def users_delete(ctx, conn, payload):
    from .users import delete_account

    require_staff(conn, ADMIN)
    row = require_outranks(ctx, conn, P.req_id(payload, "user_id"))
    _audit(ctx, conn, "user.delete", row["user_id"], {"username": row["username"]})
    await delete_account(ctx, row["user_id"])
    return {}


@handles(P.ADMIN_STAFF_SET)
async def staff_set(ctx, conn, payload):
    require_staff(conn, ADMIN)
    role = P.opt_enum(payload, "role", P.STAFF_ROLES)
    if role is None:
        raise ProtocolError(P.BAD_REQUEST, "'role' is required")
    row = require_outranks(ctx, conn, P.req_id(payload, "user_id"))
    if row["status"] != "active":
        raise ProtocolError(P.BAD_REQUEST, "Only active accounts can be staff")
    if _ROLE_LEVELS[role] >= staff_level(conn.user):
        raise ProtocolError(P.FORBIDDEN, "You can only give server roles below your own")
    ctx.db.update_profile(row["user_id"], {"server_role": role})
    _audit(ctx, conn, "staff.set", row["user_id"], {"username": row["username"], "role": role})
    await _refresh_user(ctx, row["user_id"])
    return {"user": ctx.db.admin_user(row["user_id"])}


# --- IP and device bans -------------------------------------------------------


def _network(raw) -> ipaddress.IPv4Network | ipaddress.IPv6Network:
    if not isinstance(raw, str):
        raise ProtocolError(P.BAD_REQUEST, "'cidr' must be an IP address or range")
    try:
        return ipaddress.ip_network(raw.strip(), strict=False)
    except ValueError:
        raise ProtocolError(P.BAD_REQUEST, "That isn't a valid IP address or range") from None


def ip_matches(ip: str | None, cidrs: list[str]) -> bool:
    if not ip or not cidrs:
        return False
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    for c in cidrs:
        try:
            if addr in ipaddress.ip_network(c, strict=False):
                return True
        except (ValueError, TypeError):
            continue
    return False


@handles(P.ADMIN_IP_BANS_LIST)
async def ip_bans_list(ctx, conn, payload):
    require_staff(conn, MODERATOR)
    return {"bans": ctx.db.ip_bans()}


@handles(P.ADMIN_IP_BANS_ADD)
async def ip_bans_add(ctx, conn, payload):
    require_staff(conn, MODERATOR)
    net = _network(payload.get("cidr"))
    cidr = str(net)
    if ip_matches(conn.remote, [cidr]):
        raise ProtocolError(P.BAD_REQUEST, "That would ban your own IP address")
    # Never lock out someone who outranks you.
    for uid in ctx.hub.conns_by_user:
        user = ctx.db.get_user(uid)
        if user and staff_level(user) >= staff_level(conn.user):
            for c in ctx.hub.conns_by_user[uid]:
                if ip_matches(c.remote, [cidr]):
                    raise ProtocolError(P.FORBIDDEN, "That range includes a staff member at or above your level")
    reason = P.opt_text(payload, "reason", P.BAN_REASON_MAX) or None
    ctx.db.add_ip_ban(cidr, reason, conn.user_id)
    _audit(ctx, conn, "ip_ban.add", None, {"cidr": cidr, "reason": reason})
    await ctx.hub.close_where(lambda c: ip_matches(c.remote, [cidr]), message=b"Your IP address has been banned from this server")
    return {"bans": ctx.db.ip_bans()}


@handles(P.ADMIN_IP_BANS_REMOVE)
async def ip_bans_remove(ctx, conn, payload):
    require_staff(conn, MODERATOR)
    cidr = str(_network(payload.get("cidr")))
    if not ctx.db.remove_ip_ban(cidr):
        raise ProtocolError(P.NOT_FOUND, "That address isn't banned")
    _audit(ctx, conn, "ip_ban.remove", None, {"cidr": cidr})
    return {"bans": ctx.db.ip_bans()}


@handles(P.ADMIN_DEVICE_BANS_LIST)
async def device_bans_list(ctx, conn, payload):
    require_staff(conn, MODERATOR)
    return {"bans": ctx.db.device_bans()}


@handles(P.ADMIN_DEVICE_BANS_ADD)
async def device_bans_add(ctx, conn, payload):
    """Bans every device the user has logged in from (while their sessions exist)."""
    require_staff(conn, MODERATOR)
    row = require_outranks(ctx, conn, P.req_id(payload, "user_id"))
    devices = set(ctx.db.device_ids_of(row["user_id"]))
    devices |= {c.device_id for c in ctx.hub.conns_by_user.get(row["user_id"], ()) if c.device_id}
    if not devices:
        raise ProtocolError(P.NOT_FOUND, "No known devices for that user")
    reason = P.opt_text(payload, "reason", P.BAN_REASON_MAX) or None
    for d in devices:
        ctx.db.add_device_ban(d, row["user_id"], reason, conn.user_id)
    _audit(ctx, conn, "device_ban.add", row["user_id"], {"username": row["username"], "devices": len(devices), "reason": reason})
    await ctx.hub.close_where(lambda c: c.device_id in devices, message=b"This device has been banned from this server")
    return {"bans": ctx.db.device_bans()}


@handles(P.ADMIN_DEVICE_BANS_REMOVE)
async def device_bans_remove(ctx, conn, payload):
    require_staff(conn, MODERATOR)
    device_id = P.opt_device_id(payload)
    if device_id is None or not ctx.db.remove_device_ban(device_id):
        raise ProtocolError(P.NOT_FOUND, "That device isn't banned")
    _audit(ctx, conn, "device_ban.remove", None, {"device_id": device_id})
    return {"bans": ctx.db.device_bans()}


# --- server overview ------------------------------------------------------------


@handles(P.ADMIN_AUDIT_LOG)
async def audit_log(ctx, conn, payload):
    require_staff(conn, MODERATOR)
    before, limit = _limit(payload)
    entries, has_more = ctx.db.list_server_audit(before, limit)
    return {"entries": entries, "has_more": has_more}


@handles(P.ADMIN_STATS)
async def stats(ctx, conn, payload):
    require_staff(conn, ADMIN)
    return ctx.db.stats()


@handles(P.ADMIN_GUILDS_LIST)
async def guilds_list(ctx, conn, payload):
    require_staff(conn, ADMIN)
    return {"guilds": ctx.db.admin_list_guilds()}


@handles(P.ADMIN_GUILDS_DELETE)
async def guilds_delete(ctx, conn, payload):
    require_staff(conn, ADMIN)
    guild = require_guild(ctx, P.req_id(payload, "guild_id"))
    _audit(ctx, conn, "guild.delete", guild["guild_id"], {"name": guild["name"]})
    await remove_guild(ctx, guild)
    return {}


@handles(P.ADMIN_LEGAL_SET)
async def legal_set(ctx, conn, payload):
    from .legal import legal_info, write_doc

    require_staff(conn, OWNER)
    changed = []
    for name in ("terms", "privacy"):
        if name in payload:
            text = payload[name]
            if text is not None and not isinstance(text, str):
                raise ProtocolError(P.BAD_REQUEST, f"'{name}' must be a string or null")
            if text and len(text) > P.LEGAL_MAX_CHARS:
                raise ProtocolError(P.BAD_REQUEST, f"'{name}' must be at most {P.LEGAL_MAX_CHARS} characters")
            write_doc(ctx, name, (text or "").strip() or None)
            changed.append(name)
    if not changed:
        raise ProtocolError(P.BAD_REQUEST, "Send 'terms' and/or 'privacy'")
    info = legal_info(ctx)
    _audit(ctx, conn, "legal.update", None, {"documents": changed})
    from .server import public_config

    await ctx.hub.send_to_everyone(P.frame(P.SERVER_CONFIG_UPDATED, {**public_config(ctx), **info}))
    return info
