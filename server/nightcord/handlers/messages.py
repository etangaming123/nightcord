"""message.*, reaction.* and typing.* handlers (PROTOCOL.md §5 Messaging)."""

from __future__ import annotations

import json
import re

from .. import permissions as perm
from .. import protocol as P
from ..protocol import ProtocolError
from . import handles
from ._access import check_timeout, get_channel, require_channel_perm

MENTION_RE = re.compile(r"<@(\d{1,20})>")
EVERYONE_RE = re.compile(r"(?<![\w`])@everyone\b")
MAX_MENTIONS = 50


def _require_message(ctx, conn, payload) -> tuple[dict, dict, int]:
    """(message row, channel, my channel perms) for a message the user can see."""
    message_id = P.req_id(payload, "message_id")
    row = ctx.db.message_row(int(message_id))
    if row is None:
        raise ProtocolError(P.NOT_FOUND, "Message not found")
    channel, perms = get_channel(ctx, conn, row["channel_id"])
    return row, channel, perms


def _audience_ids(ctx, channel: dict) -> list[str]:
    """Everyone (online or not) who can view the channel."""
    if channel["guild_id"] is None:
        return ctx.db.dm_recipient_ids(channel["channel_id"])
    return [u for u in ctx.db.non_ghost_member_ids(channel["guild_id"]) if ctx.perms.can_view(channel, u)]


def parse_mentions(ctx, channel: dict, content: str, perms: int, extra: list[str] = ()) -> tuple[list[str], bool]:
    audience = set(_audience_ids(ctx, channel))
    ids: list[str] = []
    for uid in [*MENTION_RE.findall(content), *extra]:
        if uid in audience and uid not in ids:
            ids.append(uid)
        if len(ids) >= MAX_MENTIONS:
            break
    everyone = (
        channel["guild_id"] is not None
        and bool(perms & perm.MENTION_EVERYONE)
        and EVERYONE_RE.search(content) is not None
    )
    return ids, everyone


async def broadcast_deleted(ctx, channel: dict, message_id: str) -> None:
    await ctx.hub.send_to_channel_viewers(
        channel,
        P.frame(P.MESSAGE_DELETED, {
            "channel_id": channel["channel_id"], "guild_id": channel["guild_id"], "message_id": message_id,
        }),
    )


async def _reveal_dm(ctx, channel: dict) -> None:
    """A message in a DM makes it visible again for recipients who closed it."""
    hidden = ctx.db.hidden_dm_recipients(channel["channel_id"])
    if not hidden:
        return
    for uid in hidden:
        ctx.db.set_dm_hidden(channel["channel_id"], uid, False)
    fresh = ctx.db.get_channel(channel["channel_id"])
    await ctx.hub.send_to_users(hidden, P.frame(P.DM_CREATED, {**fresh, "my_permissions": perm.DM_PERMS}))


@handles(P.MESSAGE_SEND)
async def send(ctx, conn, payload):
    channel, perms = require_channel_perm(ctx, conn, P.req_str(payload, "channel_id"), perm.SEND_MESSAGES)
    content = P.validate_content(payload.get("content"))
    reply_to = P.opt_id(payload, "reply_to_id")
    extra: list[str] = []
    if reply_to is not None:
        target = ctx.db.message_row(int(reply_to))
        if target is None or target["channel_id"] != channel["channel_id"]:
            raise ProtocolError(P.BAD_REQUEST, "The message you're replying to isn't in this channel")
        if P.opt_bool(payload, "mention_reply") is not False and target["author_user_id"] != conn.user_id:
            extra.append(target["author_user_id"])
    if not conn.allow_message():
        raise ProtocolError(P.RATE_LIMITED, "You're sending messages too fast")
    mentions, everyone = parse_mentions(ctx, channel, content, perms, extra)
    if channel["guild_id"] is None:
        await _reveal_dm(ctx, channel)
    message = ctx.db.create_message(
        channel["channel_id"], conn.user_id, content,
        reply_to_id=int(reply_to) if reply_to else None, mentions=mentions, mention_everyone=everyone,
    )
    pinged = set(_audience_ids(ctx, channel)) if everyone else set(mentions)
    pinged.discard(conn.user_id)
    ctx.db.bump_mentions(channel["channel_id"], pinged)
    message["guild_id"] = channel["guild_id"]
    await ctx.hub.send_to_channel_viewers(channel, P.frame(P.MESSAGE_NEW, message))
    return {"message_id": message["message_id"], "message": message}


@handles(P.MESSAGE_EDIT)
async def edit(ctx, conn, payload):
    row, channel, perms = _require_message(ctx, conn, payload)
    if row["author_user_id"] != conn.user_id:
        raise ProtocolError(P.FORBIDDEN, "You can only edit your own messages")
    if channel["guild_id"] is not None:
        check_timeout(ctx, channel["guild_id"], conn.user_id)
    content = P.validate_content(payload.get("content"))
    if not conn.allow_message():
        raise ProtocolError(P.RATE_LIMITED, "You're sending messages too fast")
    old_mentions = set(json.loads(row["mentions"]))
    mentions, everyone = parse_mentions(ctx, channel, content, perms)
    # A reply ping survives edits.
    if row["reply_to_id"] is not None:
        target = ctx.db.message_row(row["reply_to_id"])
        if target is not None and target["author_user_id"] in old_mentions and target["author_user_id"] not in mentions:
            mentions.append(target["author_user_id"])
    message = ctx.db.edit_message(row["message_id"], content, mentions, everyone)
    message["guild_id"] = channel["guild_id"]
    await ctx.hub.send_to_channel_viewers(channel, P.frame(P.MESSAGE_UPDATED, message))
    return {"message": message}


@handles(P.MESSAGE_DELETE)
async def delete(ctx, conn, payload):
    row, channel, perms = _require_message(ctx, conn, payload)
    own = row["author_user_id"] == conn.user_id
    if not own and not (channel["guild_id"] is not None and perms & perm.MANAGE_MESSAGES):
        raise ProtocolError(P.FORBIDDEN, "You can only delete your own messages")
    ctx.db.delete_message(row["message_id"])
    if not own:
        ctx.db.add_audit(
            channel["guild_id"], conn.user_id, "message.delete", row["author_user_id"],
            {"channel_id": channel["channel_id"], "channel": channel["name"]},
        )
    await broadcast_deleted(ctx, channel, str(row["message_id"]))
    return {}


async def _reaction_event(ctx, channel: dict, type_: str, row, emoji: str, user_id: str) -> None:
    await ctx.hub.send_to_channel_viewers(
        channel,
        P.frame(type_, {
            "channel_id": channel["channel_id"], "guild_id": channel["guild_id"],
            "message_id": str(row["message_id"]), "emoji": emoji, "user_id": user_id,
        }),
    )


@handles(P.REACTION_ADD)
async def reaction_add(ctx, conn, payload):
    row, channel, perms = _require_message(ctx, conn, payload)
    emoji = P.validate_emoji(payload.get("emoji"))
    if not perms & perm.ADD_REACTIONS:
        if channel["guild_id"] is not None:
            check_timeout(ctx, channel["guild_id"], conn.user_id)
        raise ProtocolError(P.FORBIDDEN, "You can't add reactions here")
    existing = ctx.db.reaction_emoji(row["message_id"])
    if emoji not in existing and len(existing) >= P.MAX_REACTION_EMOJI:
        raise ProtocolError(P.TOO_MANY_REACTIONS, "This message has too many different reactions")
    if ctx.db.add_reaction(row["message_id"], conn.user_id, emoji):
        await _reaction_event(ctx, channel, P.REACTION_ADDED, row, emoji, conn.user_id)
    return {}


@handles(P.REACTION_REMOVE)
async def reaction_remove(ctx, conn, payload):
    row, channel, _ = _require_message(ctx, conn, payload)
    emoji = P.validate_emoji(payload.get("emoji"))
    if ctx.db.remove_reaction(row["message_id"], conn.user_id, emoji):
        await _reaction_event(ctx, channel, P.REACTION_REMOVED, row, emoji, conn.user_id)
    return {}


@handles(P.TYPING_START)
async def typing_start(ctx, conn, payload):
    channel, _ = require_channel_perm(ctx, conn, P.req_str(payload, "channel_id"), perm.SEND_MESSAGES)
    if conn.allow_typing(channel["channel_id"]):
        await ctx.hub.send_to_focused(
            channel,
            P.frame(P.TYPING_STARTED, {
                "channel_id": channel["channel_id"], "guild_id": channel["guild_id"], "user_id": conn.user_id,
            }),
            exclude_user=conn.user_id,
        )
    return {}
