"""aiohttp application: GET /ws (the protocol), GET / (cert-trust page) and
GET /avatars/{avatar_id} (profile pictures)."""

from __future__ import annotations

import logging
import secrets

from aiohttp import WSMsgType, web

from . import protocol as P
from .config import Config
from .db import Database
from .dispatch import dispatch
from .handlers import Ctx
from .handlers.auth import LoginThrottle, hash_setup_code, setup_required
from .handlers.server import public_config
from .handlers.users import AVATAR_ID_RE, AVATAR_TYPES, avatar_dir
from .hub import Connection, Hub
from .permissions import PermissionService

log = logging.getLogger("nightcord.app")

CTX_KEY = web.AppKey("ctx", Ctx)

LANDING_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nightcord server</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #1a1b26; color: #c0caf5; font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 32rem; padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  code { background: #24283b; padding: .1rem .35rem; border-radius: 4px; }
</style></head>
<body><main>
  <h1>{name}</h1>
  <p>This Nightcord server is reachable, and your browser now trusts its certificate.</p>
  <p>You can close this tab and go back to Nightcord to connect.</p>
  <p><small>Protocol {version}</small></p>
</main></body></html>
"""


def _escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


async def landing(request: web.Request) -> web.Response:
    ctx = request.app[CTX_KEY]
    html = LANDING_HTML.replace("{name}", _escape(public_config(ctx)["server_name"])).replace(
        "{version}", P.PROTOCOL_VERSION
    )
    return web.Response(text=html, content_type="text/html")


async def avatar(request: web.Request) -> web.StreamResponse:
    ctx = request.app[CTX_KEY]
    avatar_id = request.match_info["avatar_id"]
    if not AVATAR_ID_RE.match(avatar_id):
        raise web.HTTPNotFound()
    path = avatar_dir(ctx) / avatar_id
    if not path.is_file():
        raise web.HTTPNotFound()
    return web.Response(
        body=path.read_bytes(),
        content_type=AVATAR_TYPES[avatar_id.rsplit(".", 1)[1]],
        headers={
            # Each upload gets a new id, so the bytes behind an id never change.
            "Cache-Control": "public, max-age=31536000, immutable",
            "Cross-Origin-Resource-Policy": "cross-origin",
            "X-Content-Type-Options": "nosniff",
        },
    )


async def websocket(request: web.Request) -> web.StreamResponse:
    ctx = request.app[CTX_KEY]
    origin = request.headers.get("Origin")
    if not ctx.config.origin_allowed(origin):
        log.warning("rejected websocket from origin %s", origin)
        raise web.HTTPForbidden(text="Origin not allowed")

    ws = web.WebSocketResponse(heartbeat=30.0, max_msg_size=P.MAX_FRAME_BYTES)
    await ws.prepare(request)
    conn = Connection(ws, request.remote, request.headers.get("User-Agent"))
    ctx.hub.add(conn)
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                await conn.send(await dispatch(ctx, conn, msg.data))
            elif msg.type == WSMsgType.BINARY:
                await conn.send(
                    P.frame(P.ERROR, P.error_payload(P.BAD_REQUEST, "Binary frames are not supported"))
                )
            elif msg.type == WSMsgType.ERROR:
                log.debug("ws error from %s: %s", conn.remote, ws.exception())
    finally:
        await ctx.hub.remove(conn)
    return ws


def new_setup_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    raw = "".join(secrets.choice(alphabet) for _ in range(12))
    return f"{raw[:4]}-{raw[4:8]}-{raw[8:]}"


def create_app(config: Config, db: Database | None = None, *, setup_code: str | None = None) -> web.Application:
    """setup_code: the one-time code that claims a server with no owner yet.
    If the server needs one and none is given, a code is generated and logged."""
    db = db or Database(config.db_path)
    perms = PermissionService(db)
    ctx = Ctx(db=db, hub=Hub(db, perms), perms=perms, config=config, login_throttle=LoginThrottle())
    if setup_required(ctx):
        if setup_code is None:
            setup_code = new_setup_code()
            log.warning("server has no owner yet; setup code: %s", setup_code)
        ctx.setup_code_hash = hash_setup_code(setup_code)
    app = web.Application()
    app[CTX_KEY] = ctx
    app.router.add_get("/", landing)
    app.router.add_get("/ws", websocket)
    app.router.add_get("/avatars/{avatar_id}", avatar)

    async def on_shutdown(app: web.Application) -> None:
        # Close sockets first so open handlers return and shutdown doesn't stall.
        await app[CTX_KEY].hub.close_all()

    async def on_cleanup(app: web.Application) -> None:
        db.close()

    app.on_shutdown.append(on_shutdown)
    app.on_cleanup.append(on_cleanup)
    return app
