"""friend.* and user.block handlers: friends, friend requests and blocking
(PROTOCOL.md §5 Friends).

Each side of a pair has its own row: friend, outgoing, incoming or blocked.
Blocking is one-sided and silent — the blocked person isn't told.
"""

from __future__ import annotations

from .. import protocol as P
from ..protocol import ProtocolError
from . import handles


async def _push(ctx, user_id: str, other_id: str) -> None:
    """relationship.updated / .removed for user_id's view of other_id."""
    rel = ctx.db.get_relationship(user_id, other_id)
    if rel is None:
        await ctx.hub.send_to_user(user_id, P.frame(P.RELATIONSHIP_REMOVED, {"user_id": other_id}))
    else:
        await ctx.hub.send_to_user(user_id, P.frame(P.RELATIONSHIP_UPDATED, rel))


async def _push_both(ctx, a: str, b: str) -> None:
    await _push(ctx, a, b)
    await _push(ctx, b, a)


async def _became_friends(ctx, a: str, b: str) -> None:
    """Friends see each other's presence from now on."""
    for x, y in ((a, b), (b, a)):
        status = ctx.hub.status_of(x)
        if status != "offline":
            await ctx.hub.send_to_user(y, P.frame(P.PRESENCE_UPDATE, {"user_id": x, "status": status}))


def _target(ctx, conn, payload) -> dict:
    """The other person, by user_id or exact username."""
    if payload.get("user_id") is not None:
        row = ctx.db.get_user_row(P.req_id(payload, "user_id"))
    else:
        name = P.req_str(payload, "username", max_len=32).strip().lstrip("@")
        row = ctx.db.get_user_row_by_name(name)
    if row is None or row["status"] != "active":
        raise ProtocolError(P.NOT_FOUND, "Nobody here has that username")
    if row["user_id"] == conn.user_id:
        raise ProtocolError(P.BAD_REQUEST, "You can't friend yourself (we checked)")
    return row


@handles(P.FRIEND_LIST)
async def list_(ctx, conn, payload):
    return {"relationships": ctx.db.list_relationships(conn.user_id)}


@handles(P.FRIEND_REQUEST)
async def request(ctx, conn, payload):
    other = _target(ctx, conn, payload)["user_id"]
    mine = ctx.db.relationship(conn.user_id, other)
    if mine == "friend":
        raise ProtocolError(P.ALREADY_FRIENDS, "You're already friends")
    if mine == "blocked":
        raise ProtocolError(P.BLOCKED, "Unblock them first")
    if ctx.db.relationship(other, conn.user_id) == "blocked":
        raise ProtocolError(P.BLOCKED, "They aren't taking friend requests from you")
    if mine == "incoming":
        # They already asked: this is a yes.
        ctx.db.set_relationships(conn.user_id, other, "friend", "friend")
        await _became_friends(ctx, conn.user_id, other)
    elif mine != "outgoing":
        ctx.db.set_relationships(conn.user_id, other, "outgoing", "incoming")
    await _push_both(ctx, conn.user_id, other)
    return {"relationship": ctx.db.get_relationship(conn.user_id, other)}


@handles(P.FRIEND_ACCEPT)
async def accept(ctx, conn, payload):
    other = P.req_id(payload, "user_id")
    if ctx.db.relationship(conn.user_id, other) != "incoming":
        raise ProtocolError(P.NOT_FOUND, "No friend request from them")
    ctx.db.set_relationships(conn.user_id, other, "friend", "friend")
    await _became_friends(ctx, conn.user_id, other)
    await _push_both(ctx, conn.user_id, other)
    return {"relationship": ctx.db.get_relationship(conn.user_id, other)}


@handles(P.FRIEND_REMOVE)
async def remove(ctx, conn, payload):
    """Unfriend, cancel an outgoing request, or decline an incoming one."""
    other = P.req_id(payload, "user_id")
    if ctx.db.relationship(conn.user_id, other) not in ("friend", "outgoing", "incoming"):
        raise ProtocolError(P.NOT_FOUND, "You aren't friends and there's no request")
    ctx.db.set_relationships(conn.user_id, other, None, None)
    await _push_both(ctx, conn.user_id, other)
    return {}


@handles(P.USER_BLOCK)
async def block(ctx, conn, payload):
    other = _target(ctx, conn, payload)["user_id"]
    ctx.db.set_relationships(conn.user_id, other, "blocked", None)
    await _push_both(ctx, conn.user_id, other)
    return {"relationship": ctx.db.get_relationship(conn.user_id, other)}


@handles(P.USER_UNBLOCK)
async def unblock(ctx, conn, payload):
    other = P.req_id(payload, "user_id")
    if ctx.db.relationship(conn.user_id, other) != "blocked":
        raise ProtocolError(P.NOT_FOUND, "They aren't blocked")
    ctx.db.set_relationships(conn.user_id, other, None, None)
    await _push(ctx, conn.user_id, other)
    return {}
