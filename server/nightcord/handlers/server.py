"""server.* handlers (PROTOCOL.md §4 Server config, §5 Server info)."""

from __future__ import annotations

from .. import protocol as P
from ..protocol import ProtocolError
from . import handles
from ._access import require_server_owner

_CONFIG_ENUMS = {
    "guild_creation": ("off", "on"),
    "account_creation": ("off", "request", "on"),
}


def public_config(ctx) -> dict:
    cfg = ctx.db.get_server_config()
    return {**cfg, "server_name": cfg["server_name"] or ctx.config.server_name}


def apply_config_updates(payload: dict) -> dict:
    """Validates a partial ServerConfig; returns the updates to store."""
    updates = {}
    for key, val in payload.items():
        if key in _CONFIG_ENUMS:
            if val not in _CONFIG_ENUMS[key]:
                raise ProtocolError(P.BAD_REQUEST, f"'{key}' must be one of {_CONFIG_ENUMS[key]}")
        elif key == "guild_list_visible":
            if not isinstance(val, bool):
                raise ProtocolError(P.BAD_REQUEST, "'guild_list_visible' must be a boolean")
        elif key == "server_name":
            val = P.validate_server_name(val)
        else:
            raise ProtocolError(P.BAD_REQUEST, f"'{key}' is not an editable server setting")
        updates[key] = val
    return updates


@handles(P.SERVER_INFO)
async def info(ctx, conn, payload):
    from .auth import setup_required

    return {
        **public_config(ctx),
        "protocol_version": P.PROTOCOL_VERSION,
        "setup_required": setup_required(ctx),
    }


@handles(P.SERVER_CONFIG_UPDATE)
async def config_update(ctx, conn, payload):
    require_server_owner(conn)
    ctx.db.set_server_config(apply_config_updates(payload))
    return {"config": public_config(ctx)}
