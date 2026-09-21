"""announcement.* handlers: the server-wide inbox (PROTOCOL.md §5 Announcements).

The server owner (and admins, if `announcements_admins` is on) post notes
everyone sees in their Inbox. The server adds its own entries too, e.g. when
the Terms or Privacy Policy change (kind "legal").
"""

from __future__ import annotations

from .. import protocol as P
from ..protocol import ProtocolError
from . import handles
from ._access import ADMIN, OWNER, require_staff


def _require_poster(ctx, conn) -> None:
    admins = ctx.db.get_server_config()["announcements_admins"]
    require_staff(conn, ADMIN if admins else OWNER)


def _content(payload) -> str:
    content = P.req_str(payload, "content").strip()
    if not content:
        raise ProtocolError(P.BAD_REQUEST, "Write something first")
    if len(content) > P.ANNOUNCEMENT_MAX_CHARS:
        raise ProtocolError(P.CONTENT_TOO_LONG, f"Announcements are at most {P.ANNOUNCEMENT_MAX_CHARS} characters")
    return content


def _require_announcement(ctx, payload) -> dict:
    found = ctx.db.get_announcement(int(P.req_id(payload, "announcement_id")))
    if found is None:
        raise ProtocolError(P.NOT_FOUND, "Announcement not found")
    return found


async def post(ctx, author_id: str | None, kind: str, content: str) -> dict:
    """Creates an announcement and tells everyone online."""
    item = ctx.db.create_announcement(author_id, kind, content)
    await ctx.hub.send_to_everyone(P.frame(P.ANNOUNCEMENT_CREATED, item))
    return item


@handles(P.ANNOUNCEMENT_LIST)
async def list_(ctx, conn, payload):
    before = P.opt_id(payload, "before")
    items = ctx.db.list_announcements(before=int(before) if before else None)
    return {
        "announcements": items,
        "last_read_id": str(ctx.db.announcement_read_id(conn.user_id)),
        "unread": ctx.db.unread_announcements(conn.user_id),
    }


@handles(P.ANNOUNCEMENT_CREATE)
async def create(ctx, conn, payload):
    _require_poster(ctx, conn)
    item = await post(ctx, conn.user_id, "post", _content(payload))
    # Your own post counts as read.
    ctx.db.set_announcement_read_id(conn.user_id, int(item["announcement_id"]))
    return {"announcement": item}


@handles(P.ANNOUNCEMENT_UPDATE)
async def update(ctx, conn, payload):
    _require_poster(ctx, conn)
    item = _require_announcement(ctx, payload)
    if item["kind"] != "post":
        raise ProtocolError(P.FORBIDDEN, "Automatic announcements can't be edited")
    item = ctx.db.update_announcement(int(item["announcement_id"]), _content(payload))
    await ctx.hub.send_to_everyone(P.frame(P.ANNOUNCEMENT_UPDATED, item))
    return {"announcement": item}


@handles(P.ANNOUNCEMENT_DELETE)
async def delete(ctx, conn, payload):
    _require_poster(ctx, conn)
    item = _require_announcement(ctx, payload)
    ctx.db.delete_announcement(int(item["announcement_id"]))
    await ctx.hub.send_to_everyone(P.frame(P.ANNOUNCEMENT_DELETED, {"announcement_id": item["announcement_id"]}))
    return {}


@handles(P.ANNOUNCEMENT_ACK)
async def ack(ctx, conn, payload):
    last = ctx.db.set_announcement_read_id(conn.user_id, int(P.req_id(payload, "announcement_id")))
    state = {"last_read_id": str(last), "unread": ctx.db.unread_announcements(conn.user_id)}
    await ctx.hub.send_to_user(conn.user_id, P.frame(P.ANNOUNCEMENT_ACKED, state), exclude=conn)
    return state
