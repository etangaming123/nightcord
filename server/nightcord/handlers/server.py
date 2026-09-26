"""server.* handlers (PROTOCOL.md §4 Server config, §5 Server info)."""

from __future__ import annotations

from .. import protocol as P
from ..protocol import ProtocolError
from . import handles
from ._access import require_server_owner

_CONFIG_ENUMS = {
    "guild_creation": ("off", "on"),
    "account_creation": ("off", "request", "on"),
    "user_search": P.USER_SEARCH_MODES,
}


def public_config(ctx) -> dict:
    cfg = ctx.db.get_server_config()
    return {**cfg, "server_name": cfg["server_name"] or ctx.config.server_name}


def apply_config_updates(ctx, payload: dict) -> dict:
    """Validates a partial ServerConfig; returns the updates to store."""
    updates = {}
    for key, val in payload.items():
        if key in _CONFIG_ENUMS:
            if val not in _CONFIG_ENUMS[key]:
                raise ProtocolError(P.BAD_REQUEST, f"'{key}' must be one of {_CONFIG_ENUMS[key]}")
        elif key in ("guild_list_visible", "voice_enabled", "announcements_admins", "link_embeds", "fx_links"):
            if not isinstance(val, bool):
                raise ProtocolError(P.BAD_REQUEST, f"'{key}' must be a boolean")
        elif key == "max_upload_bytes":
            if not isinstance(val, int) or isinstance(val, bool) or not 1024 * 1024 <= val <= P.MAX_UPLOAD_BYTES_CEILING:
                raise ProtocolError(P.BAD_REQUEST, "'max_upload_bytes' must be between 1 MB and 1 GB")
        elif key == "max_accounts_per_client":
            if not isinstance(val, int) or isinstance(val, bool) or not 0 <= val <= P.MAX_ACCOUNTS_PER_CLIENT:
                raise ProtocolError(P.BAD_REQUEST, f"'{key}' must be 0 (no limit) to {P.MAX_ACCOUNTS_PER_CLIENT}")
        elif key == "server_name":
            val = P.validate_server_name(val)
        elif key == "server_description":
            val = P.validate_server_description(val)
        elif key == "customization_mode":
            if val not in P.CUSTOMIZATION_MODES:
                raise ProtocolError(P.BAD_REQUEST, f"'{key}' must be one of {P.CUSTOMIZATION_MODES}")
        elif key == "customization_features":
            # Partial: only the given features change.
            if not isinstance(val, dict) or not val:
                raise ProtocolError(P.BAD_REQUEST, "'customization_features' must be an object of feature: bool")
            for feature, on in val.items():
                if feature not in P.CUSTOMIZATION_FEATURES or not isinstance(on, bool):
                    raise ProtocolError(P.BAD_REQUEST, f"Unknown customisation feature or value: {feature}")
            val = {**ctx.db.get_server_config()["customization_features"], **val}
        else:
            raise ProtocolError(P.BAD_REQUEST, f"'{key}' is not an editable server setting")
        updates[key] = val
    return updates


@handles(P.SERVER_INFO)
async def info(ctx, conn, payload):
    from .auth import setup_required

    from .legal import legal_info

    return {
        **public_config(ctx),
        **legal_info(ctx),
        "protocol_version": P.PROTOCOL_VERSION,
        "setup_required": setup_required(ctx),
    }


@handles(P.SERVER_CONFIG_UPDATE)
async def config_update(ctx, conn, payload):
    require_server_owner(conn)
    updates = apply_config_updates(ctx, payload)
    ctx.db.set_server_config(updates)
    if updates:
        ctx.db.add_server_audit(conn.user_id, "config.update", None, updates)
    if updates.get("voice_enabled") is False:
        await ctx.hub.voice_drop_where(lambda s: True)
    if updates:
        from .legal import legal_info

        await ctx.hub.send_to_everyone(P.frame(P.SERVER_CONFIG_UPDATED, {**public_config(ctx), **legal_info(ctx)}))
    return {"config": public_config(ctx)}
