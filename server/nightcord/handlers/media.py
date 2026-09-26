"""HTTP media routes: POST /media and GET /media/{media_id} (PROTOCOL.md §2 HTTP).

Media are images for emoji, stickers, avatars, banners, guild icons and role
icons. An upload is unclaimed until a WebSocket request uses its media_id
(emoji.create, user.avatar.set, ...); unclaimed uploads are deleted after an
hour. Unlike attachments, media are public by id and never change, so they
are served with immutable caching.

Where a model stores an image reference (avatar_id, icon_id, banner_id), an
animated image's reference is its media_id prefixed with "a_", like Discord.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time

from aiohttp import web

from .. import files as F
from .. import protocol as P
from ..db import iso_in
from ..ids import new_id
from ..protocol import ProtocolError

log = logging.getLogger("nightcord.media")

MEDIA_ID_RE = re.compile(r"^\d{1,20}$")
MEDIA_REF_RE = re.compile(r"^(a_)?(\d{1,20})$")
MAX_PENDING_MEDIA = 20
UNCLAIMED_TTL_SECONDS = 3600


def media_dir(ctx):
    return ctx.config.data_dir / "media"


def media_ref(row) -> str:
    """The image reference stored on a model for a media row."""
    return f"a_{row['media_id']}" if row["animated"] else row["media_id"]


def claim(ctx, user_id: str, media_id, kind: str):
    """Uses an upload of `kind` made by `user_id`; returns its media row."""
    if not isinstance(media_id, str) or not MEDIA_ID_RE.match(media_id):
        raise ProtocolError(P.BAD_REQUEST, "'media_id' must be an id")
    row = ctx.db.claim_media(media_id, user_id, kind)
    if row is None:
        raise ProtocolError(P.MEDIA_INVALID, "Unknown or already used upload; upload the image again")
    return row


def unclaim(ctx, media_id: str) -> None:
    """Gives back a claimed upload that a request couldn't use after all."""
    drop_media(ctx, media_id)


def drop_media(ctx, ref: str | None) -> None:
    """Deletes a media file and row, given a media_id or an "a_" reference."""
    m = MEDIA_REF_RE.match(ref or "")
    if not m:
        return
    media_id = m.group(2)
    ctx.db.delete_media(media_id)
    try:
        (media_dir(ctx) / media_id).unlink(missing_ok=True)
    except OSError as e:
        log.warning("couldn't delete media %s: %s", media_id, e)


def _error(ctx, request, status: int, code: str, message: str) -> web.Response:
    from .files import cors_headers

    return web.json_response(
        {"error": {"code": code, "message": message}}, status=status, headers=cors_headers(ctx, request)
    )


async def upload(request: web.Request) -> web.StreamResponse:
    from ..app import CTX_KEY, client_ip, ip_banned
    from .files import cors_headers

    ctx = request.app[CTX_KEY]
    if not ctx.config.origin_allowed(request.headers.get("Origin")):
        return _error(ctx, request, 403, P.FORBIDDEN, "Origin not allowed")
    if ip_banned(ctx, client_ip(ctx, request)):
        return _error(ctx, request, 403, P.IP_BANNED, "Your IP address is banned from this server")
    auth = request.headers.get("Authorization", "")
    token = auth[7:] if auth.startswith("Bearer ") else ""
    user_id = ctx.db.session_user_id(token) if token else None
    row = ctx.db.get_user_row(user_id) if user_id else None
    if row is None or row["status"] != "active":
        return _error(ctx, request, 401, P.NOT_AUTHENTICATED, "Log in first")
    kind = request.query.get("kind", "")
    if kind not in P.MEDIA_KINDS:
        return _error(ctx, request, 400, P.BAD_REQUEST, f"'kind' must be one of {', '.join(P.MEDIA_KINDS)}")
    if ctx.db.pending_media_count(user_id) >= MAX_PENDING_MEDIA:
        return _error(ctx, request, 429, P.RATE_LIMITED, "Too many unused uploads; wait a bit")
    limit, max_dim = P.MEDIA_KINDS[kind]
    too_big = f"Images for this can be at most {limit // 1024} KB"
    if request.content_length is not None and request.content_length > limit:
        return _error(ctx, request, 413, P.FILE_TOO_LARGE, too_big)
    chunks, size = [], 0
    async for chunk in request.content.iter_chunked(64 * 1024):
        size += len(chunk)
        if size > limit:
            return _error(ctx, request, 413, P.FILE_TOO_LARGE, too_big)
        chunks.append(chunk)
    data = b"".join(chunks)
    content_type = F.sniff(data[:4096], "image")
    info = F.image_info(data) if content_type in P.MEDIA_TYPES else None
    if info is None:
        return _error(ctx, request, 415, P.MEDIA_INVALID, "Images must be PNG, JPEG, GIF or WebP")
    width, height, animated = info
    if not width or not height:
        return _error(ctx, request, 415, P.MEDIA_INVALID, "That image has no size")
    if max_dim and (width > max_dim or height > max_dim):
        return _error(ctx, request, 400, P.MEDIA_INVALID, f"Images for this can be at most {max_dim}×{max_dim} pixels")
    media_id = new_id()
    folder = media_dir(ctx)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / media_id).write_bytes(data)
    media = ctx.db.create_media(
        media_id, uploader_id=user_id, kind=kind, content_type=content_type, size=size, width=width, height=height,
        animated=animated,
    )
    return web.json_response({"media": media}, headers=cors_headers(ctx, request))


async def serve(request: web.Request) -> web.StreamResponse:
    from ..app import CTX_KEY

    ctx = request.app[CTX_KEY]
    media_id = request.match_info["media_id"]
    if not MEDIA_ID_RE.match(media_id):
        raise web.HTTPNotFound()
    row = ctx.db.media_row(media_id)
    path = media_dir(ctx) / media_id
    if row is None or row["content_type"] not in P.MEDIA_TYPES or not path.is_file():
        raise web.HTTPNotFound()
    return web.FileResponse(path, headers={
        "Content-Type": row["content_type"],
        # Each upload gets a new id, so the bytes behind an id never change.
        "Cache-Control": "public, max-age=31536000, immutable",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
    })


def sweep(ctx, max_age: int = UNCLAIMED_TTL_SECONDS) -> int:
    """Deletes uploads never claimed (older than max_age seconds), and files
    without a row. Returns files removed."""
    stale = ctx.db.stale_media_ids(iso_in(-max_age))
    folder = media_dir(ctx)
    for media_id in stale:
        (folder / media_id).unlink(missing_ok=True)
    removed = len(stale)
    if folder.is_dir():
        known = ctx.db.all_media_ids()
        for name in os.listdir(folder):
            if MEDIA_ID_RE.match(name) and name not in known:
                try:
                    if (folder / name).stat().st_mtime > time.time() - 60:
                        continue
                    (folder / name).unlink()
                    removed += 1
                except OSError:
                    pass
    return removed


async def sweeper(app: web.Application) -> None:
    from ..app import CTX_KEY

    ctx = app[CTX_KEY]
    while True:
        await asyncio.sleep(3600)
        try:
            n = sweep(ctx)
            if n:
                log.info("removed %d unused media files", n)
        except Exception:
            log.exception("media sweep failed")
