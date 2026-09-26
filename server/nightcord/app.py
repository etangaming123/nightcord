"""aiohttp application: GET /ws (the protocol), GET / (cert-trust page),
GET /avatars/{avatar_id} (small base64-uploaded avatars and guild icons),
the attachment routes POST /upload and GET /files/{id}/{name}, the media
routes POST /media and GET /media/{media_id}, and GET /proxy/{sig}/{url}
for images inside link embeds."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import secrets

from aiohttp import WSMsgType, web

from . import embeds as embed_lib
from . import protocol as P
from .config import Config
from .db import Database
from .dispatch import dispatch
from .handlers import Ctx
from .handlers import files as file_routes
from .handlers import media as media_routes
from .handlers import polls as poll_routes
from .handlers import proxy as proxy_routes
from .handlers.admin import ip_matches
from .handlers.auth import LoginThrottle, hash_setup_code, setup_required
from .handlers.server import public_config
from .handlers.users import AVATAR_ID_RE, AVATAR_TYPES, avatar_dir, status_sweeper
from .hub import BANNED_CLOSE, Connection, Hub
from .permissions import PermissionService

log = logging.getLogger("nightcord.app")

CTX_KEY = web.AppKey("ctx", Ctx)
SWEEPER_KEY = web.AppKey("sweepers", list)

LANDING_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nightcord server</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: linear-gradient(160deg, #241530, #120d19 60%); color: #f4ecf6;
         font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 32rem; padding: 2rem; }
  svg { display: block; margin-bottom: 1rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .5rem; }
  p { color: #c9bcd2; }
  small { color: #9a8ca6; }
  a { color: #ddaacc; }
  .desc { color: #f4ecf6; }
  .desc p { color: inherit; }
  .desc code { background: rgba(255,255,255,.08); padding: 1px 4px; border-radius: 4px; }
</style></head>
<body><main>
  <svg width="56" height="56" viewBox="0 0 32 32" aria-hidden="true">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#884499"/><stop offset="1" stop-color="#bb6688"/></linearGradient></defs>
    <rect width="32" height="32" rx="7" fill="url(#g)"/>
    <path d="M19.5 7.5a9.3 9.3 0 1 0 6.3 14.6A10.6 10.6 0 0 1 19.5 7.5z" fill="#ddaacc"/>
  </svg>
  <h1>{name}</h1>
  {body}
  <p><small>You can close this tab and go back to Nightcord to connect. Protocol {version}</small></p>
</main></body></html>
"""


TRUST_NOTE = "<p>This Nightcord server is reachable, and your browser now trusts its certificate.</p>"

_URL_RE = re.compile(r"https?://[^\s<]+[^\s<.,:;!?)\]'\"]")
_INLINE = (
    (re.compile(r"`([^`\n]+)`"), r"<code>\1</code>"),
    (re.compile(r"\*\*([^*\n]+)\*\*"), r"<strong>\1</strong>"),
    (re.compile(r"(?<![*\w])\*([^*\n]+)\*(?!\w)"), r"<em>\1</em>"),
)


def _escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def description_html(text: str) -> str:
    """The server description as safe HTML: paragraphs, line breaks, bare
    links and a little inline Markdown (bold, italics, code). Everything is
    escaped first, so nothing the owner types can become a tag."""
    out = []
    for para in re.split(r"\n\s*\n", text.strip()):
        html = _escape(para)
        for pattern, repl in _INLINE:
            html = pattern.sub(repl, html)
        html = _URL_RE.sub(lambda m: f'<a href="{m.group(0)}" rel="noopener noreferrer">{m.group(0)}</a>', html)
        out.append("<p>" + html.replace("\n", "<br>") + "</p>")
    return "\n  ".join(out)


async def landing(request: web.Request) -> web.Response:
    ctx = request.app[CTX_KEY]
    cfg = public_config(ctx)
    desc = cfg.get("server_description") or ""
    body = f'<div class="desc">{description_html(desc)}</div>' if desc else TRUST_NOTE
    html = (
        LANDING_HTML.replace("{name}", _escape(cfg["server_name"]))
        .replace("{version}", P.PROTOCOL_VERSION)
        .replace("{body}", body)
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


def client_ip(ctx, request: web.Request) -> str | None:
    """The peer address, or the first X-Forwarded-For hop behind a trusted proxy."""
    if ctx.config.trust_proxy:
        fwd = request.headers.get("X-Forwarded-For")
        if fwd:
            return fwd.split(",")[0].strip()
    return request.remote


def ip_banned(ctx, ip: str | None) -> bool:
    return ip_matches(ip, ctx.db.ip_ban_cidrs())


async def websocket(request: web.Request) -> web.StreamResponse:
    ctx = request.app[CTX_KEY]
    origin = request.headers.get("Origin")
    if not ctx.config.origin_allowed(origin):
        log.warning("rejected websocket from origin %s", origin)
        raise web.HTTPForbidden(text="Origin not allowed")

    ws = web.WebSocketResponse(heartbeat=30.0, max_msg_size=P.MAX_FRAME_BYTES)
    await ws.prepare(request)
    ip = client_ip(ctx, request)
    if ip_banned(ctx, ip):
        # Tell the client why before closing, so it can show a message.
        await ws.send_json(P.frame(P.ERROR, P.error_payload(P.IP_BANNED, "Your IP address is banned from this server")))
        await ws.close(code=BANNED_CLOSE, message=b"Banned")
        return ws
    conn = Connection(ws, ip, request.headers.get("User-Agent"))
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
    db = db or Database(config.db_path, backup_dir=config.data_dir.parent / "backups")
    perms = PermissionService(db)
    ctx = Ctx(db=db, hub=Hub(db, perms), perms=perms, config=config, login_throttle=LoginThrottle())
    # Serialised PublicUsers hide the custom status of anyone who reads as
    # offline (really offline, or invisible) — §4 User.
    db.set_status_source(ctx.hub.status_of)
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
    app.router.add_post("/upload", file_routes.upload)
    app.router.add_route("OPTIONS", "/upload", file_routes.upload_preflight)
    app.router.add_get("/files/{attachment_id}/{filename}", file_routes.download)
    app.router.add_post("/media", media_routes.upload)
    app.router.add_route("OPTIONS", "/media", file_routes.upload_preflight)
    app.router.add_get("/media/{media_id}", media_routes.serve)
    app.router.add_get("/proxy/{sig}/{token}", proxy_routes.serve)

    async def on_startup(app: web.Application) -> None:
        # One outbound session for every link preview, with the SSRF-guarded
        # resolver; nothing else in the server makes outbound requests.
        app[CTX_KEY].http = embed_lib.make_session()
        app[SWEEPER_KEY] = [
            asyncio.create_task(file_routes.sweeper(app)),
            asyncio.create_task(media_routes.sweeper(app)),
            asyncio.create_task(proxy_routes.sweeper(app)),
            asyncio.create_task(poll_routes.sweeper(app)),
            asyncio.create_task(status_sweeper(app)),
        ]

    async def on_shutdown(app: web.Application) -> None:
        for task in app.get(SWEEPER_KEY, []):
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        # Close sockets first so open handlers return and shutdown doesn't stall.
        await app[CTX_KEY].hub.close_all()
        session = app[CTX_KEY].http
        app[CTX_KEY].http = None
        if session is not None:
            await session.close()

    async def on_cleanup(app: web.Application) -> None:
        db.close()

    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)
    app.on_cleanup.append(on_cleanup)
    return app
