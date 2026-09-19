"""presence.* handlers (PROTOCOL.md §5 Presence)."""

from __future__ import annotations

from .. import protocol as P
from ..protocol import ProtocolError
from . import handles
from ._access import require_member
from .users import broadcast_user


@handles(P.PRESENCE_LIST)
async def list_presence(ctx, conn, payload):
    if payload.get("guild_id") is not None:
        guild, _ = require_member(ctx, conn, P.req_id(payload, "guild_id"))
        # Only visible (non-ghost) members are reported.
        ids = ctx.db.non_ghost_member_ids(guild["guild_id"])
    else:
        ids = P.id_list(payload, "user_ids", max_len=200)
        allowed = ctx.db.audience_of(conn.user_id) | {conn.user_id}
        ids = [u for u in ids if u in allowed]
    return {"presences": ctx.hub.presences(ids)}


@handles(P.PRESENCE_SET)
async def set_presence(ctx, conn, payload):
    status = P.opt_enum(payload, "status", P.PRESENCE_PREFS)
    afk = P.opt_bool(payload, "afk")
    if status is None and afk is None:
        raise ProtocolError(P.BAD_REQUEST, "Send 'status' and/or 'afk'")
    if afk is not None:
        conn.afk = afk
    if status is not None and status != conn.user.get("presence"):
        user = ctx.db.update_profile(conn.user_id, {"presence_pref": status})
        await broadcast_user(ctx, user)
    await ctx.hub.refresh_presence(conn.user_id)
    return {"status": ctx.hub.status_of(conn.user_id)}
