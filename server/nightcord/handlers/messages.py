"""message.* handlers (PROTOCOL.md §5 Messaging)."""

from __future__ import annotations

from .. import protocol as P
from ..protocol import ProtocolError
from . import handles
from ._access import require_channel


@handles(P.MESSAGE_SEND)
async def send(ctx, conn, payload):
    channel, membership = require_channel(ctx, conn, P.req_str(payload, "channel_id"))
    if membership["ghost"]:
        raise ProtocolError(P.FORBIDDEN, "Ghost memberships are read-only")
    content = P.validate_content(payload.get("content"))
    if not conn.allow_message():
        raise ProtocolError(P.RATE_LIMITED, "You're sending messages too fast")
    message = ctx.db.create_message(channel["channel_id"], conn.user_id, content)
    await ctx.hub.send_to_channel(channel["channel_id"], P.frame(P.MESSAGE_NEW, message))
    return {"message_id": message["message_id"]}
