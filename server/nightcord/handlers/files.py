"""HTTP attachment routes: POST /upload and GET /files/{id}/{name} (PROTOCOL.md §2 HTTP).

Uploads are raw request bodies (not multipart) authenticated with the
session token. A stored file is referenced by message.send's
`attachment_ids`; files not attached within an hour are deleted.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
import urllib.parse

from aiohttp import web

from .. import files as F
from .. import permissions as perm
from .. import protocol as P
from ..db import iso_in, now_iso
from ..ids import new_id
from ..protocol import ProtocolError

log = logging.getLogger("nightcord.files")

ATTACHMENT_ID_RE = re.compile(r"^\d{1,20}$")
MAX_PENDING_UPLOADS = 50
UNCLAIMED_TTL_SECONDS = 3600
CHUNK = 64 * 1024


def files_dir(ctx):
    return ctx.config.data_dir / "files"


def delete_files(ctx, attachment_ids) -> None:
    folder = files_dir(ctx)
    for aid in attachment_ids:
        if ATTACHMENT_ID_RE.match(aid):
            try:
                (folder / aid).unlink(missing_ok=True)
            except OSError as e:
                log.warning("couldn't delete attachment %s: %s", aid, e)


def cors_headers(ctx, request: web.Request) -> dict:
    origin = request.headers.get("Origin")
    if origin and ctx.config.origin_allowed(origin):
        return {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
            "Access-Control-Max-Age": "600",
            "Vary": "Origin",
        }
    return {}


def _error(ctx, request, status: int, code: str, message: str) -> web.Response:
    return web.json_response(
        {"error": {"code": code, "message": message}}, status=status, headers=cors_headers(ctx, request)
    )


async def upload_preflight(request: web.Request) -> web.Response:
    from ..app import CTX_KEY

    return web.Response(status=204, headers=cors_headers(request.app[CTX_KEY], request))


def _dimension(request, key: str) -> int | None:
    raw = request.query.get(key)
    if raw is None or not raw.isdigit():
        return None
    return min(int(raw), 32768) or None


async def upload(request: web.Request) -> web.StreamResponse:
    from ..app import CTX_KEY, client_ip, ip_banned

    ctx = request.app[CTX_KEY]
    origin = request.headers.get("Origin")
    if not ctx.config.origin_allowed(origin):
        return _error(ctx, request, 403, P.FORBIDDEN, "Origin not allowed")
    if ip_banned(ctx, client_ip(ctx, request)):
        return _error(ctx, request, 403, P.IP_BANNED, "Your IP address is banned from this server")
    auth = request.headers.get("Authorization", "")
    token = auth[7:] if auth.startswith("Bearer ") else ""
    user_id = ctx.db.session_user_id(token) if token else None
    user = ctx.db.get_user(user_id) if user_id else None
    row = ctx.db.get_user_row(user_id) if user_id else None
    if user is None or row["status"] != "active":
        return _error(ctx, request, 401, P.NOT_AUTHENTICATED, "Log in first")

    channel = ctx.db.get_channel(request.query.get("channel_id", ""))
    perms = ctx.perms.channel_perms(channel, user_id) if channel else 0
    if not perms & perm.VIEW_CHANNEL:
        return _error(ctx, request, 404, P.NOT_FOUND, "Channel not found")
    if not perms & perm.ATTACH_FILES or not perms & perm.SEND_MESSAGES:
        return _error(ctx, request, 403, P.FORBIDDEN, "You can't upload files here")
    until = user.get("muted_until")
    if until and (until == "permanent" or until > now_iso()):
        return _error(ctx, request, 403, P.MUTED, "You've been muted on this server")
    if ctx.db.pending_attachment_count(user_id) >= MAX_PENDING_UPLOADS:
        return _error(ctx, request, 429, P.RATE_LIMITED, "Too many unsent uploads; send or wait a bit")

    filename = F.clean_filename(request.query.get("filename", "file"))
    limit = ctx.db.get_server_config()["max_upload_bytes"]
    too_big = f"Files can be at most {limit // (1024 * 1024)} MB on this server"
    if request.content_length is not None and request.content_length > limit:
        return _error(ctx, request, 413, P.FILE_TOO_LARGE, too_big)

    folder = files_dir(ctx)
    folder.mkdir(parents=True, exist_ok=True)
    attachment_id = new_id()
    path = folder / attachment_id
    size = 0
    head = b""
    try:
        with open(path, "wb") as f:
            async for chunk in request.content.iter_chunked(CHUNK):
                size += len(chunk)
                if size > limit:
                    raise ProtocolError(P.FILE_TOO_LARGE, too_big)
                if len(head) < 4096:
                    head += chunk[: 4096 - len(head)]
                f.write(chunk)
    except ProtocolError as e:
        path.unlink(missing_ok=True)
        return _error(ctx, request, 413, e.code, e.message)
    except (ConnectionResetError, asyncio.CancelledError):
        path.unlink(missing_ok=True)
        raise
    if size == 0:
        path.unlink(missing_ok=True)
        return _error(ctx, request, 400, P.BAD_REQUEST, "The file is empty")

    content_type = F.sniff(head, filename)
    visual = content_type.startswith(("image/", "video/"))
    attachment = ctx.db.create_attachment(
        attachment_id, uploader_id=user_id, channel_id=channel["channel_id"], filename=filename,
        content_type=content_type, size=size,
        width=_dimension(request, "width") if visual else None,
        height=_dimension(request, "height") if visual else None,
    )
    return web.json_response({"attachment": attachment}, headers=cors_headers(ctx, request))


async def download(request: web.Request) -> web.StreamResponse:
    from ..app import CTX_KEY, client_ip, ip_banned

    ctx = request.app[CTX_KEY]
    attachment_id = request.match_info["attachment_id"]
    if not ATTACHMENT_ID_RE.match(attachment_id):
        raise web.HTTPNotFound()
    if not F.verify(ctx.db.file_secret(), attachment_id, request.query.get("exp", ""), request.query.get("sig", "")):
        raise web.HTTPForbidden(text="This link has expired")
    if ip_banned(ctx, client_ip(ctx, request)):
        raise web.HTTPForbidden(text="Banned")
    row = ctx.db.attachment_row(attachment_id)
    path = files_dir(ctx) / attachment_id
    if row is None or not path.is_file():
        raise web.HTTPNotFound()
    content_type = row["content_type"]
    headers = {
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "Access-Control-Allow-Origin": "*",
        "Content-Security-Policy": "default-src 'none'; sandbox",
    }
    name = row["filename"]
    ascii_name = name.encode("ascii", "replace").decode().replace('"', "_").replace("?", "_")
    quoted = f"\"{ascii_name}\"; filename*=UTF-8''{urllib.parse.quote(name)}"
    if content_type in F.INLINE_TYPES:
        headers["Content-Disposition"] = f"inline; filename={quoted}"
    elif content_type == "text/plain":
        content_type = "text/plain; charset=utf-8"
        headers["Content-Disposition"] = f"inline; filename={quoted}"
    else:
        content_type = "application/octet-stream"
        headers["Content-Disposition"] = f"attachment; filename={quoted}"
    headers["Content-Type"] = content_type
    return web.FileResponse(path, headers=headers)


def sweep(ctx) -> int:
    """Deletes uploads never attached to a message, and files whose rows are
    gone (their message, channel or guild was deleted). Returns files removed."""
    stale = ctx.db.stale_attachment_ids(iso_in(-UNCLAIMED_TTL_SECONDS))
    delete_files(ctx, stale)
    removed = len(stale)
    folder = files_dir(ctx)
    if folder.is_dir():
        known = ctx.db.all_attachment_ids()
        for name in os.listdir(folder):
            if ATTACHMENT_ID_RE.match(name) and name not in known:
                # Skip files still being written (created in the last minute).
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
                log.info("removed %d unused attachment files", n)
        except Exception:
            log.exception("attachment sweep failed")

