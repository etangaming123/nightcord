"""presence.* handlers (PROTOCOL.md §5 Presence)."""

from __future__ import annotations

from .. import protocol as P
from . import handles
from ._access import require_member


@handles(P.PRESENCE_LIST)
async def list_presence(ctx, conn, payload):
    guild, _ = require_member(ctx, conn, P.req_str(payload, "guild_id"))
    # online_member_ids only considers non-ghost memberships.
    return {"online_user_ids": ctx.hub.online_member_ids(guild["guild_id"])}
