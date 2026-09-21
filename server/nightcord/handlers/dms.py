"""dm.* handlers: 1:1 and group direct messages (PROTOCOL.md §5 Direct messages).

Who may message whom (PROTOCOL.md §5 Message requests): friends always can;
otherwise the recipient's dm_privacy decides — `everyone`, `requests` (one
message that waits in their Message Requests until they accept) or `friends`.
Blocking either way stops everything. Group DMs only take the adder's friends.
"""

from __future__ import annotations

from .. import permissions as perm
from .. import protocol as P
from ..protocol import ProtocolError
from . import handles
from ._access import get_channel


def _dm(channel: dict) -> dict:
    return {**channel, "my_permissions": perm.DM_PERMS}


def _require_dm(ctx, conn, payload, *, group: bool = False) -> dict:
    channel, _ = get_channel(ctx, conn, P.req_id(payload, "channel_id"))
    if channel["guild_id"] is not None:
        raise ProtocolError(P.NOT_FOUND, "Direct message not found")
    if group and channel["kind"] != "group_dm":
        raise ProtocolError(P.BAD_REQUEST, "Only group DMs can do that")
    return channel


def _active_user(ctx, user_id: str) -> dict:
    row = ctx.db.get_user_row(user_id)
    if row is None or row["status"] != "active":
        raise ProtocolError(P.NOT_FOUND, "User not found")
    return row


async def announce_dm(
    ctx, channel: dict, *, created_for: list[str] = (), exclude: str | None = None, exclude_hidden: bool = False
) -> None:
    """dm.created to `created_for`; dm.updated to every other recipient
    (except those who closed it, with exclude_hidden)."""
    await ctx.hub.send_to_users(created_for, P.frame(P.DM_CREATED, _dm(channel)))
    hidden = set(ctx.db.hidden_dm_recipients(channel["channel_id"])) if exclude_hidden else set()
    others = [
        u["user_id"] for u in channel["recipients"]
        if u["user_id"] not in created_for and u["user_id"] != exclude and u["user_id"] not in hidden
    ]
    await ctx.hub.send_to_users(others, P.frame(P.DM_UPDATED, _dm(channel)))


async def _presence_for(ctx, user_ids: list[str]) -> None:
    """New DM partners start hearing each other's presence."""
    for uid in user_ids:
        status = ctx.hub.status_of(uid)
        if status != "offline":
            await ctx.hub.send_to_users(
                [u for u in user_ids if u != uid], P.frame(P.PRESENCE_UPDATE, {"user_id": uid, "status": status})
            )


def _other(channel: dict, user_id: str) -> str | None:
    return next((u["user_id"] for u in channel["recipients"] if u["user_id"] != user_id), None)


def dm_gate(ctx, sender: str, recipient: str, channel: dict | None) -> str | None:
    """Whether `sender` may message `recipient` in a 1:1 DM. Returns the
    request state the channel should move to ("pending" / "accepted"), or None
    for no change; raises when they can't."""
    if ctx.db.is_blocked_either(sender, recipient):
        raise ProtocolError(P.BLOCKED, "You can't message this person")
    request = channel.get("request") if channel else None
    if ctx.db.are_friends(sender, recipient) or (request and request["state"] == "accepted"):
        return None
    if request and request["state"] == "pending" and request["from_user_id"] == recipient:
        return "accepted"  # replying to their request accepts it
    privacy = ctx.db.get_user_row(recipient)["dm_privacy"]
    if privacy == "everyone":
        return None
    if privacy == "friends":
        raise ProtocolError(P.DM_NOT_ALLOWED, "They only take messages from friends")
    if request and request["from_user_id"] == sender:
        if request["state"] == "declined":
            raise ProtocolError(P.DM_NOT_ALLOWED, "They aren't taking messages from you")
        raise ProtocolError(P.REQUEST_PENDING, "Wait for them to accept your message request")
    return "pending"


def _require_friends(ctx, user_id: str, others: list[str]) -> None:
    for uid in others:
        if not ctx.db.are_friends(user_id, uid):
            raise ProtocolError(P.NOT_FRIENDS, "You can only add your friends to a group")


@handles(P.DM_LIST)
async def list_dms(ctx, conn, payload):
    return {"channels": [_dm(c) for c in ctx.db.list_dms(conn.user_id)]}


@handles(P.DM_OPEN)
async def open_dm(ctx, conn, payload):
    user_id = P.req_id(payload, "user_id")
    if user_id == conn.user_id:
        raise ProtocolError(P.BAD_REQUEST, "You can't DM yourself")
    _active_user(ctx, user_id)
    channel_id = ctx.db.find_dm(conn.user_id, user_id)
    existing = ctx.db.get_channel(channel_id) if channel_id else None
    try:
        dm_gate(ctx, conn.user_id, user_id, existing)
    except ProtocolError as e:
        # A request already waiting is fine to look at; anything else isn't.
        if e.code != P.REQUEST_PENDING:
            raise
    if channel_id is None:
        channel = ctx.db.create_dm(conn.user_id, user_id)
        await _presence_for(ctx, [conn.user_id, user_id])
    else:
        ctx.db.set_dm_hidden(channel_id, conn.user_id, False)
        channel = ctx.db.get_channel(channel_id)
    # The other side hears about it with the first message (dm.created).
    await ctx.hub.send_to_user(conn.user_id, P.frame(P.DM_CREATED, _dm(channel)), exclude=conn)
    return {"channel": _dm(channel)}


@handles(P.DM_CREATE_GROUP)
async def create_group(ctx, conn, payload):
    others = [u for u in P.id_list(payload, "user_ids", max_len=P.GROUP_DM_MAX) if u != conn.user_id]
    if not others:
        raise ProtocolError(P.BAD_REQUEST, "Pick at least one person")
    if len(others) + 1 > P.GROUP_DM_MAX:
        raise ProtocolError(P.DM_LIMIT, f"Group DMs can have at most {P.GROUP_DM_MAX} people")
    for uid in others:
        _active_user(ctx, uid)
    _require_friends(ctx, conn.user_id, others)
    channel = ctx.db.create_group_dm(conn.user_id, others)
    await _presence_for(ctx, [conn.user_id, *others])
    await announce_dm(ctx, channel, created_for=[conn.user_id, *others])
    return {"channel": _dm(channel)}


@handles(P.DM_UPDATE)
async def update(ctx, conn, payload):
    channel = _require_dm(ctx, conn, payload, group=True)
    name = P.opt_text(payload, "name", P.GROUP_DM_NAME_MAX)
    ctx.db.set_dm_name(channel["channel_id"], name or None)
    channel = ctx.db.get_channel(channel["channel_id"])
    await announce_dm(ctx, channel)
    return {"channel": _dm(channel)}


@handles(P.DM_ADD_RECIPIENT)
async def add_recipient(ctx, conn, payload):
    channel = _require_dm(ctx, conn, payload, group=True)
    user_id = P.req_id(payload, "user_id")
    _active_user(ctx, user_id)
    ids = [u["user_id"] for u in channel["recipients"]]
    if user_id in ids:
        raise ProtocolError(P.ALREADY_MEMBER, "They're already in this group")
    if len(ids) >= P.GROUP_DM_MAX:
        raise ProtocolError(P.DM_LIMIT, f"Group DMs can have at most {P.GROUP_DM_MAX} people")
    _require_friends(ctx, conn.user_id, [user_id])
    ctx.db.add_dm_recipient(channel["channel_id"], user_id)
    channel = ctx.db.get_channel(channel["channel_id"])
    await _presence_for(ctx, [*ids, user_id])
    await announce_dm(ctx, channel, created_for=[user_id])
    return {"channel": _dm(channel)}


@handles(P.DM_LEAVE)
async def leave(ctx, conn, payload):
    channel = _require_dm(ctx, conn, payload)
    if channel["kind"] == "dm":
        # 1:1 DMs are only hidden; a new message brings them back.
        ctx.db.set_dm_hidden(channel["channel_id"], conn.user_id, True)
    else:
        ctx.db.remove_dm_recipient(channel["channel_id"], conn.user_id)
        fresh = ctx.db.get_channel(channel["channel_id"])
        if fresh is not None:
            await announce_dm(ctx, fresh)
    for c in ctx.hub.conns_by_user.get(conn.user_id, ()):
        if c.channel_id == channel["channel_id"]:
            c.channel_id = None
    return {}


def _require_request(ctx, conn, payload) -> dict:
    """A pending message request that someone else sent to this user."""
    channel = _require_dm(ctx, conn, payload)
    request = channel.get("request")
    if not request or request["state"] != "pending" or request["from_user_id"] == conn.user_id:
        raise ProtocolError(P.NOT_FOUND, "No message request here")
    return channel


@handles(P.DM_REQUEST_ACCEPT)
async def request_accept(ctx, conn, payload):
    channel = _require_request(ctx, conn, payload)
    ctx.db.set_dm_request(channel["channel_id"], channel["request"]["from_user_id"], "accepted")
    channel = ctx.db.get_channel(channel["channel_id"])
    await announce_dm(ctx, channel)
    return {"channel": _dm(channel)}


@handles(P.DM_REQUEST_DECLINE)
async def request_decline(ctx, conn, payload):
    """Hides the request. The sender isn't told; they just can't send more."""
    channel = _require_request(ctx, conn, payload)
    ctx.db.set_dm_request(channel["channel_id"], channel["request"]["from_user_id"], "declined")
    ctx.db.set_dm_hidden(channel["channel_id"], conn.user_id, True)
    channel = ctx.db.get_channel(channel["channel_id"])
    await ctx.hub.send_to_user(conn.user_id, P.frame(P.DM_UPDATED, _dm(channel)))
    return {"channel": _dm(channel)}
