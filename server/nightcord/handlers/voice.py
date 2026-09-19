"""voice.* handlers — a placeholder for voice channels (PROTOCOL.md §5 Voice).

Joining a voice channel only records presence in it; there is no audio yet.
Clients show who is "in" each voice channel and cosmetic mute/deafen state.
"""

from __future__ import annotations

from .. import permissions as perm
from .. import protocol as P
from ..protocol import ProtocolError
from . import handles
from ._access import check_muted, require_channel_perm


@handles(P.VOICE_JOIN)
async def join(ctx, conn, payload):
    if not ctx.db.get_server_config()["voice_enabled"]:
        raise ProtocolError(P.VOICE_DISABLED, "Voice channels are turned off on this server")
    channel, _ = require_channel_perm(ctx, conn, P.req_id(payload, "channel_id"), perm.CONNECT)
    if channel["kind"] != "voice":
        raise ProtocolError(P.BAD_REQUEST, "That isn't a voice channel")
    check_muted(ctx, conn)
    return {"voice_state": await ctx.hub.voice_join(conn, channel)}


@handles(P.VOICE_LEAVE)
async def leave(ctx, conn, payload):
    await ctx.hub.voice_leave(conn.user_id)
    return {}


@handles(P.VOICE_STATE_SET)
async def state_set(ctx, conn, payload):
    flags = {k: v for k in ("self_mute", "self_deaf") if (v := P.opt_bool(payload, k)) is not None}
    if not flags:
        raise ProtocolError(P.BAD_REQUEST, "Send 'self_mute' and/or 'self_deaf'")
    state = await ctx.hub.voice_set(conn.user_id, **flags)
    if state is None:
        raise ProtocolError(P.BAD_REQUEST, "You're not in a voice channel")
    return {"voice_state": state}
