"""Frame parsing and routing (PROTOCOL.md §2)."""

from __future__ import annotations

import json
import logging

from . import protocol as P
from .handlers import Ctx, load_all
from .hub import Connection
from .protocol import ProtocolError

log = logging.getLogger("nightcord.dispatch")

HANDLERS = load_all()


def _valid_id(id_) -> bool:
    return isinstance(id_, (str, int)) and not isinstance(id_, bool)


async def dispatch(ctx: Ctx, conn: Connection, raw: str) -> dict:
    """Handle one inbound text frame and return the response frame."""
    try:
        msg = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return P.frame(P.ERROR, P.error_payload(P.BAD_REQUEST, "Frame is not valid JSON"))

    if not isinstance(msg, dict):
        return P.frame(P.ERROR, P.error_payload(P.BAD_REQUEST, "Frame must be a JSON object"))
    id_ = msg.get("id")
    if id_ is not None and not _valid_id(id_):
        id_ = None
    type_ = msg.get("type")
    payload = msg.get("payload", {})
    if not isinstance(type_, str) or not isinstance(payload, dict):
        return P.frame(
            P.ERROR,
            P.error_payload(P.BAD_REQUEST, "Frame needs a string 'type' and object 'payload'"),
            id_,
        )

    handler = HANDLERS.get(type_)
    if handler is None:
        return P.frame(P.ERROR, P.error_payload(P.UNKNOWN_TYPE, f"Unknown type '{type_}'"), id_)

    try:
        if conn.user is None and type_ not in P.PRE_AUTH_TYPES:
            raise ProtocolError(P.NOT_AUTHENTICATED, "Log in first")
        result = await handler(ctx, conn, payload)
        return P.frame(P.result_type(type_), result, id_)
    except ProtocolError as e:
        return P.frame(P.error_type(type_), P.error_payload(e.code, e.message), id_)
    except Exception:
        log.exception("handler %s failed", type_)
        return P.frame(
            P.error_type(type_), P.error_payload(P.INTERNAL_ERROR, "Internal server error"), id_
        )
