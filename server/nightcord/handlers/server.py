"""server.* handlers (PROTOCOL.md §4 Server config, §5 Server info)."""

from __future__ import annotations

from .. import protocol as P
from ..protocol import ProtocolError
from . import handles

_CONFIG_ENUMS = {
    "guild_creation": ("off", "on"),
    "account_creation": ("off", "request", "on"),
}


def public_config(ctx) -> dict:
    return {"server_name": ctx.config.server_name, **ctx.db.get_server_config()}


@handles(P.SERVER_INFO)
async def info(ctx, conn, payload):
    return {**public_config(ctx), "protocol_version": P.PROTOCOL_VERSION}


@handles(P.SERVER_CONFIG_UPDATE)
async def config_update(ctx, conn, payload):
    if not conn.user["is_server_owner"]:
        raise ProtocolError(P.FORBIDDEN, "Only the server owner can change server settings")
    updates = {}
    for key, val in payload.items():
        if key in _CONFIG_ENUMS:
            if val not in _CONFIG_ENUMS[key]:
                raise ProtocolError(P.BAD_REQUEST, f"'{key}' must be one of {_CONFIG_ENUMS[key]}")
        elif key == "guild_list_visible":
            if not isinstance(val, bool):
                raise ProtocolError(P.BAD_REQUEST, "'guild_list_visible' must be a boolean")
        else:
            raise ProtocolError(P.BAD_REQUEST, f"'{key}' is not an editable server setting")
        updates[key] = val
    ctx.db.set_server_config(updates)
    return {"config": public_config(ctx)}
