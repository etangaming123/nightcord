"""aiohttp application: GET /ws (the protocol) and GET / (cert-trust page)."""

from __future__ import annotations

import logging

from aiohttp import WSCloseCode, WSMsgType, web

from . import protocol as P
from .config import Config
from .db import Database
from .dispatch import dispatch
from .handlers import Ctx
from .handlers.auth import LoginThrottle
from .hub import Connection, Hub

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
    html = LANDING_HTML.replace("{name}", _escape(ctx.config.server_name)).replace(
        "{version}", P.PROTOCOL_VERSION
    )
    return web.Response(text=html, content_type="text/html")


async def websocket(request: web.Request) -> web.StreamResponse:
    ctx = request.app[CTX_KEY]
    origin = request.headers.get("Origin")
    if not ctx.config.origin_allowed(origin):
        log.warning("rejected websocket from origin %s", origin)
        raise web.HTTPForbidden(text="Origin not allowed")

    ws = web.WebSocketResponse(heartbeat=30.0, max_msg_size=P.MAX_FRAME_BYTES)
    await ws.prepare(request)
    conn = Connection(ws, request.remote)
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


def create_app(config: Config, db: Database | None = None) -> web.Application:
    db = db or Database(config.db_path)
    app = web.Application()
    app[CTX_KEY] = Ctx(db=db, hub=Hub(db), config=config, login_throttle=LoginThrottle())
    app.router.add_get("/", landing)
    app.router.add_get("/ws", websocket)

    async def on_shutdown(app: web.Application) -> None:
        # Close sockets first so open handlers return and shutdown doesn't stall.
        for conn in list(app[CTX_KEY].hub.all_conns):
            await conn.ws.close(code=WSCloseCode.GOING_AWAY, message=b"Server shutting down")

    async def on_cleanup(app: web.Application) -> None:
        db.close()

    app.on_shutdown.append(on_shutdown)
    app.on_cleanup.append(on_cleanup)
    return app
