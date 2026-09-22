"""saved.* and user.note.set (PROTOCOL.md §4 Saved message, User note).

Both are private to the person who wrote them. Saved messages are checked
against live permissions on every read, so a message in a channel you've
since lost access to quietly drops out of the list rather than leaking.
"""

from __future__ import annotations

from .. import permissions as perm
from .. import protocol as P
from ..protocol import ProtocolError
from . import handles
from ._access import get_channel


def _require_message(ctx, conn, payload):
    message_id = P.req_id(payload, "message_id")
    row = ctx.db.message_row(int(message_id))
    if row is None:
        raise ProtocolError(P.NOT_FOUND, "Message not found")
    get_channel(ctx, conn, row["channel_id"])  # raises unless it's visible
    return row


async def _announce(ctx, conn, message_id: str, saved: bool) -> None:
    """Keep this account's other windows in step."""
    await ctx.hub.send_to_user(
        conn.user_id,
        P.frame(P.SAVED_UPDATED, {"message_id": message_id, "saved": saved, "count": ctx.db.saved_count(conn.user_id)}),
        exclude=conn,
    )


@handles(P.SAVED_LIST)
async def saved_list(ctx, conn, payload):
    before = P.opt_str(payload, "before")
    limit = P.opt_int(payload, "limit") or P.SAVED_PAGE
    limit = max(1, min(limit, P.SAVED_PAGE))
    # Over-read: rows whose channel the user can't read any more are dropped
    # below, and shouldn't cost them a page.
    rows = ctx.db.saved_messages(conn.user_id, before=before, limit=limit * 2)
    out = []
    last = None  # the cursor to carry on from, including rows we filtered out
    channels: dict[str, dict | None] = {}
    for m in rows:
        last = m["cursor"]
        cid = m["channel_id"]
        if cid not in channels:
            channels[cid] = ctx.db.get_channel(cid)
        channel = channels[cid]
        if channel is not None:
            perms = ctx.perms.channel_perms(channel, conn.user_id)
            if perms & perm.VIEW_CHANNEL and perms & perm.READ_HISTORY:
                m["guild_id"] = channel["guild_id"]
                out.append(m)
        if len(out) >= limit:
            break
    return {
        "messages": out,
        # Only "no more rows at all" ends the list: a page can come back short
        # because everything in it was filtered out.
        "has_more": len(rows) >= limit * 2 or len(out) >= limit,
        "next": last,
        "count": ctx.db.saved_count(conn.user_id),
    }


@handles(P.SAVED_ADD)
async def saved_add(ctx, conn, payload):
    row = _require_message(ctx, conn, payload)
    if not ctx.db.is_saved(conn.user_id, row["message_id"]) and ctx.db.saved_count(conn.user_id) >= P.MAX_SAVED:
        raise ProtocolError(P.BAD_REQUEST, f"You can save at most {P.MAX_SAVED} messages")
    if ctx.db.save_message(conn.user_id, row["message_id"]):
        await _announce(ctx, conn, str(row["message_id"]), True)
    return {"message_id": str(row["message_id"]), "saved": True, "count": ctx.db.saved_count(conn.user_id)}


@handles(P.SAVED_REMOVE)
async def saved_remove(ctx, conn, payload):
    # Unsaving works even for a message you can no longer see, so nothing
    # can get stuck in the list.
    message_id = P.req_id(payload, "message_id")
    if ctx.db.unsave_message(conn.user_id, int(message_id)):
        await _announce(ctx, conn, message_id, False)
    return {"message_id": message_id, "saved": False, "count": ctx.db.saved_count(conn.user_id)}


@handles(P.USER_NOTE_SET)
async def note_set(ctx, conn, payload):
    target_id = P.req_id(payload, "user_id")
    if ctx.db.get_user(target_id) is None:
        raise ProtocolError(P.NOT_FOUND, "User not found")
    note = P.opt_text(payload, "note", P.USER_NOTE_MAX)
    stored = ctx.db.set_user_note(conn.user_id, target_id, note)
    await ctx.hub.send_to_user(
        conn.user_id, P.frame(P.USER_NOTE_UPDATED, {"user_id": target_id, "note": stored}), exclude=conn
    )
    return {"user_id": target_id, "note": stored}
