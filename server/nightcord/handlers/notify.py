"""notify.prefs.* handlers: per-guild / per-channel notification settings."""

from __future__ import annotations

from .. import protocol as P
from ..protocol import ProtocolError
from . import handles


@handles(P.NOTIFY_PREFS_GET)
async def prefs_get(ctx, conn, payload):
    return {"prefs": ctx.db.notify_prefs(conn.user_id)}


@handles(P.NOTIFY_PREFS_SET)
async def prefs_set(ctx, conn, payload):
    target_id = P.req_id(payload, "target_id")
    level = P.opt_enum(payload, "level", P.NOTIFY_LEVELS)
    muted = P.opt_bool(payload, "muted") or False
    guild = ctx.db.get_guild(target_id)
    channel = ctx.db.get_channel(target_id) if guild is None else None
    ok = (guild is not None and ctx.db.get_membership(target_id, conn.user_id) is not None) or (
        channel is not None and ctx.perms.can_view(channel, conn.user_id)
    )
    if not ok:
        raise ProtocolError(P.NOT_FOUND, "Guild or channel not found")
    pref = ctx.db.set_notify_pref(conn.user_id, target_id, level, muted)
    await ctx.hub.send_to_user(conn.user_id, P.frame(P.NOTIFY_PREFS_UPDATED, pref), exclude=conn)
    return {"pref": pref}
