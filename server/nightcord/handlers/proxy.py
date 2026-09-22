"""GET /proxy/{sig}/{b64url} — images inside link embeds (PROTOCOL.md §4 Embed).

Embeds never point a viewer's browser at a third-party host: every image URL
in a stored embed is rewritten to this route, so the only address the remote
site sees is the server's. The signature is HMAC-SHA256 over the encoded URL
with the per-server file secret, so the route can't be used as an open proxy.

Fetched bytes are kept in <data_dir>/proxy-cache/<sha256>, swept after a week.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import logging
import os
import re
import time

import aiohttp
from aiohttp import web

from .. import embeds as E
from .. import protocol as P

log = logging.getLogger("nightcord.proxy")

CACHE_NAME_RE = re.compile(r"^[0-9a-f]{64}$")
SWEEP_AFTER = P.PROXY_CACHE_DAYS * 86400


def proxy_dir(ctx):
    return ctx.config.data_dir / "proxy-cache"


def _b64(url: str) -> str:
    return base64.urlsafe_b64encode(url.encode()).decode().rstrip("=")


def _unb64(token: str) -> str | None:
    try:
        return base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)).decode()
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return None


def signature(secret: str, token: str) -> str:
    return hmac.new(secret.encode(), token.encode(), hashlib.sha256).hexdigest()[:32]


def proxy_url(secret: str, url: str) -> str:
    """The /proxy path that stands in for a remote image URL."""
    token = _b64(url)
    return f"/proxy/{signature(secret, token)}/{token}"


def proxy_embed(secret: str, embed: dict) -> dict:
    """A copy of `embed` whose image fields point at this server."""
    out = dict(embed)
    for key in ("image", "thumbnail"):
        if out.get(key):
            out[key] = proxy_url(secret, out[key])
    return out


def _cache_path(ctx, url: str):
    return proxy_dir(ctx) / hashlib.sha256(url.encode()).hexdigest()


HEADERS = {
    "Cache-Control": "public, max-age=86400",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Access-Control-Allow-Origin": "*",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
}


async def serve(request: web.Request) -> web.StreamResponse:
    from ..app import CTX_KEY

    ctx = request.app[CTX_KEY]
    token = request.match_info["token"]
    sig = request.match_info["sig"]
    if not hmac.compare_digest(signature(ctx.db.file_secret(), token), sig):
        raise web.HTTPNotFound()
    url = _unb64(token)
    if not url:
        raise web.HTTPNotFound()

    path = _cache_path(ctx, url)
    meta = path.with_suffix(".type")
    if path.is_file() and meta.is_file():
        return web.FileResponse(path, headers={**HEADERS, "Content-Type": meta.read_text()[:64]})

    if ctx.http is None or not ctx.db.get_server_config()["link_embeds"]:
        raise web.HTTPNotFound()
    try:
        _final, resp, body = await E.fetch_guarded(
            ctx.http, url, accept="image/*", max_bytes=P.EMBED_IMAGE_MAX_BYTES
        )
    except (E.UnsafeUrl, aiohttp.ClientError, asyncio.TimeoutError, UnicodeError, OSError) as e:
        log.debug("proxy fetch failed for %s: %s", url, e)
        raise web.HTTPNotFound()
    content_type = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
    if content_type not in E.IMAGE_TYPES:
        raise web.HTTPNotFound()
    try:
        proxy_dir(ctx).mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        meta.write_text(content_type)
    except OSError as e:
        log.warning("couldn't cache proxied image: %s", e)
    return web.Response(body=body, headers={**HEADERS, "Content-Type": content_type})


def sweep(ctx) -> int:
    """Drops cached images older than PROXY_CACHE_DAYS. Returns files removed."""
    folder = proxy_dir(ctx)
    if not folder.is_dir():
        return 0
    cutoff = time.time() - SWEEP_AFTER
    removed = 0
    for name in os.listdir(folder):
        stem = name.removesuffix(".type")
        if not CACHE_NAME_RE.match(stem):
            continue
        try:
            if (folder / name).stat().st_mtime < cutoff:
                (folder / name).unlink()
                removed += 1
        except OSError:
            pass
    return removed


async def sweeper(app: web.Application) -> None:
    from ..app import CTX_KEY

    ctx = app[CTX_KEY]
    while True:
        await asyncio.sleep(6 * 3600)
        try:
            n = sweep(ctx)
            if n:
                log.info("removed %d cached preview images", n)
        except Exception:
            log.exception("proxy cache sweep failed")


