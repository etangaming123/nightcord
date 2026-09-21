"""Request handlers, one function per C→S message type.

Each handler is `async def h(ctx, conn, payload) -> dict` and returns the
success payload; it raises protocol.ProtocolError on failure. dispatch.py
wraps the return value as `X.result` (or `auth.ok`).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Awaitable, Callable

if TYPE_CHECKING:
    from ..config import Config
    from ..db import Database
    from ..hub import Connection, Hub
    from ..permissions import PermissionService
    from .auth import LoginThrottle


@dataclass
class Ctx:
    db: "Database"
    hub: "Hub"
    perms: "PermissionService"
    config: "Config"
    login_throttle: "LoginThrottle"
    # sha256 of the one-time setup code while the server has no owner.
    setup_code_hash: str | None = None


Handler = Callable[["Ctx", "Connection", dict], Awaitable[dict]]
REGISTRY: dict[str, Handler] = {}


def handles(type_: str):
    def deco(fn: Handler) -> Handler:
        assert type_ not in REGISTRY, type_
        REGISTRY[type_] = fn
        return fn

    return deco


def load_all() -> dict[str, Handler]:
    # Importing registers handlers via @handles.
    from . import (  # noqa: F401
        admin, announcements, auth, channels, dms, expressions, friends, guilds, legal, members, messages, notify,
        presence, roles, server, users, voice,
    )

    return REGISTRY
