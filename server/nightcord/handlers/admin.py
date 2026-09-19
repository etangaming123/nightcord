"""admin.* handlers — server-owner tools (PROTOCOL.md §5 Admin)."""

from __future__ import annotations

import secrets

from .. import protocol as P
from ..protocol import ProtocolError
from . import handles
from ._access import require_guild, require_server_owner
from .auth import hash_password
from .guilds import remove_guild

USER_STATUSES = ("pending", "active", "rejected", "disabled")
# Allowed admin.users.set_status transitions.
_TRANSITIONS = {
    "active": {"pending", "disabled"},
    "rejected": {"pending"},
    "disabled": {"active"},
}


def _target(ctx, payload) -> dict:
    row = ctx.db.get_user_row(P.req_id(payload, "user_id"))
    if row is None:
        raise ProtocolError(P.NOT_FOUND, "User not found")
    if row["is_server_owner"]:
        raise ProtocolError(P.FORBIDDEN, "The server owner's account can't be changed here")
    return row


@handles(P.ADMIN_USERS_LIST)
async def users_list(ctx, conn, payload):
    require_server_owner(conn)
    status = P.opt_enum(payload, "status", USER_STATUSES)
    query = P.opt_text(payload, "query", 64) or None
    return {"users": ctx.db.list_users(status=status, query=query)}


@handles(P.ADMIN_USERS_SET_STATUS)
async def users_set_status(ctx, conn, payload):
    require_server_owner(conn)
    row = _target(ctx, payload)
    status = P.opt_enum(payload, "status", tuple(_TRANSITIONS))
    if status is None:
        raise ProtocolError(P.BAD_REQUEST, "'status' is required")
    if row["status"] not in _TRANSITIONS[status]:
        raise ProtocolError(P.BAD_REQUEST, f"Can't change a {row['status']} account to {status}")
    ctx.db.set_user_status(row["user_id"], status)
    if status == "disabled":
        await ctx.hub.close_user(row["user_id"])
    return {"user": ctx.db.admin_user(row["user_id"])}


@handles(P.ADMIN_USERS_RESET_PASSWORD)
async def users_reset_password(ctx, conn, payload):
    require_server_owner(conn)
    row = _target(ctx, payload)
    password = secrets.token_urlsafe(12)
    ctx.db.set_password_hash(row["user_id"], await hash_password(password))
    await ctx.hub.close_user(row["user_id"])
    return {"password": password}


@handles(P.ADMIN_GUILDS_LIST)
async def guilds_list(ctx, conn, payload):
    require_server_owner(conn)
    return {"guilds": ctx.db.admin_list_guilds()}


@handles(P.ADMIN_GUILDS_DELETE)
async def guilds_delete(ctx, conn, payload):
    require_server_owner(conn)
    guild = require_guild(ctx, P.req_id(payload, "guild_id"))
    await remove_guild(ctx, guild)
    return {}
