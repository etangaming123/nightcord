"""message.*, reaction.* and typing.* handlers (PROTOCOL.md §5 Messaging)."""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import math
import re

from .. import commands as C
from .. import embeds as E
from .. import permissions as perm
from .. import protocol as P
from ..protocol import ProtocolError
from . import handles
from . import polls as poll_lib
from ._access import check_muted, check_timeout, get_channel, require_channel_perm, require_member
from .proxy import proxy_embed

log = logging.getLogger("nightcord.messages")

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


async def post_system(ctx, channel: dict, user_id: str, type_: str, *, reply_to_id: int | None = None) -> dict:
    """A system message (join/leave/pin) authored by the user it's about."""
    message = ctx.db.create_message(channel["channel_id"], user_id, "", type_=type_, reply_to_id=reply_to_id)
    message["guild_id"] = channel["guild_id"]
    await ctx.hub.send_to_channel_viewers(channel, P.frame(P.MESSAGE_NEW, message))
    return message


# Link previews are filled in after the message is already delivered: a slow
# site must never hold up sending. The follow-up is a message.updated that
# leaves edited_at alone, so nothing reads as "(edited)" (PROTOCOL.md §4 Embed).
_embed_tasks: set[asyncio.Task] = set()


def spawn_embeds(ctx, channel: dict, message: dict) -> None:
    if not ctx.db.get_server_config()["link_embeds"] or ctx.http is None:
        return
    if message.get("embeds_suppressed") or not E.extract_urls(message["content"] or ""):
        return
    task = asyncio.create_task(_fill_embeds(ctx, channel, int(message["message_id"])))
    _embed_tasks.add(task)
    task.add_done_callback(_embed_tasks.discard)


async def _fill_embeds(ctx, channel: dict, message_id: int) -> None:
    try:
        row = ctx.db.message_row(message_id)
        if row is None:
            return
        found = await E.build_embeds(ctx.http, row["content"] or "")
        # The message may have been edited or deleted while we were fetching.
        fresh = ctx.db.message_row(message_id)
        if fresh is None or fresh["content"] != row["content"] or fresh["embeds_suppressed"]:
            return
        stored = [proxy_embed(ctx.db.file_secret(), e) for e in found]
        if not stored and not json.loads(fresh["embeds"] or "[]"):
            return
        message = ctx.db.set_embeds(message_id, stored)
        if message is None:
            return
        message["guild_id"] = channel["guild_id"]
        await ctx.hub.send_to_channel_viewers(channel, P.frame(P.MESSAGE_UPDATED, message))
    except asyncio.CancelledError:
        raise
    except Exception:
        log.exception("filling embeds for message %s failed", message_id)


def _parse_iso(s: str) -> dt.datetime:
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def _check_slowmode(ctx, channel: dict, perms: int, user_id: str) -> None:
    seconds = channel.get("slowmode_seconds") or 0
    if not seconds or perms & (perm.MANAGE_MESSAGES | perm.MANAGE_CHANNELS):
        return
    last = ctx.db.last_sent_at(channel["channel_id"], user_id)
    if last is None:
        return
    wait = seconds - (dt.datetime.now(dt.timezone.utc) - _parse_iso(last)).total_seconds()
    if wait > 0:
        retry = math.ceil(wait)
        raise ProtocolError(P.SLOWMODE, f"Slowmode is on; wait {retry}s", retry_after=retry)


@handles(P.MESSAGE_SEND)
async def send(ctx, conn, payload):
    channel, perms = require_channel_perm(ctx, conn, P.req_str(payload, "channel_id"), perm.SEND_MESSAGES)
    if channel["kind"] not in ("text", "dm", "group_dm"):
        raise ProtocolError(P.BAD_REQUEST, "You can't send messages in that channel")
    check_muted(ctx, conn)
    attachment_ids = P.id_list(payload, "attachment_ids", max_len=P.MAX_ATTACHMENTS) if payload.get("attachment_ids") else []
    sticker_ids = (
        P.id_list(payload, "sticker_ids", max_len=P.MAX_STICKERS_PER_MESSAGE) if payload.get("sticker_ids") else []
    )
    command = C.validate(payload)
    poll = poll_lib.validate(payload)
    content = P.validate_content(
        payload.get("content"), allow_empty=bool(attachment_ids or sticker_ids or command or poll)
    )
    for sticker_id in sticker_ids:
        sticker = ctx.db.get_sticker(sticker_id)
        if sticker is None:
            raise ProtocolError(P.NOT_FOUND, "Sticker not found")
        require_expression_member(ctx, conn, sticker["guild_id"], "stickers")
    if attachment_ids:
        if not perms & perm.ATTACH_FILES:
            raise ProtocolError(P.FORBIDDEN, "You can't upload files here")
        if not ctx.db.claimable_attachments(attachment_ids, conn.user_id, channel["channel_id"]):
            raise ProtocolError(P.BAD_REQUEST, "Unknown or already used attachment")
    _check_slowmode(ctx, channel, perms, conn.user_id)
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
    request_state = None
    if channel["kind"] == "dm":
        from .dms import dm_gate

        other = next(u["user_id"] for u in channel["recipients"] if u["user_id"] != conn.user_id)
        request_state = dm_gate(ctx, conn.user_id, other, channel)
    mentions, everyone = parse_mentions(ctx, channel, content, perms, extra)
    if request_state is not None:
        from_user = conn.user_id if request_state == "pending" else channel["request"]["from_user_id"]
        ctx.db.set_dm_request(channel["channel_id"], from_user, request_state)
        channel = ctx.db.get_channel(channel["channel_id"])
        from .dms import announce_dm

        await announce_dm(ctx, channel, exclude_hidden=True)
    if channel["guild_id"] is None:
        await _reveal_dm(ctx, channel)
    message = ctx.db.create_message(
        channel["channel_id"], conn.user_id, content,
        reply_to_id=int(reply_to) if reply_to else None, mentions=mentions, mention_everyone=everyone,
        attachment_ids=attachment_ids, sticker_ids=sticker_ids, command=command, poll=poll,
    )
    pinged = set(_audience_ids(ctx, channel)) if everyone else set(mentions)
    pinged.discard(conn.user_id)
    ctx.db.bump_mentions(channel["channel_id"], pinged)
    message["guild_id"] = channel["guild_id"]
    await ctx.hub.send_to_channel_viewers(channel, P.frame(P.MESSAGE_NEW, message))
    spawn_embeds(ctx, channel, message)
    return {"message_id": message["message_id"], "message": message}


def _forward_snapshot(ctx, row, channel: dict) -> dict:
    """What travels with a forward: enough to show it, never a live link.
    Editing or deleting the original leaves the copy exactly as it was."""
    author = ctx.db.public_user(row["author_user_id"])
    if channel["guild_id"] is not None:
        guild = ctx.db.get_guild(channel["guild_id"])
        source = f"#{channel['name']}" + (f" · {guild['name']}" if guild else "")
    else:
        source = channel.get("name") or "DM"
    attachments = ctx.db.message_attachments(row["message_id"])[: P.FORWARD_ATTACHMENTS_MAX]
    return {
        "message_id": str(row["message_id"]),
        "channel_id": channel["channel_id"],
        "guild_id": channel["guild_id"],
        "source": source,
        "author": author,
        "sent_at": row["sent_at"],
        "content": (row["content"] or "")[: P.FORWARD_CONTENT_MAX],
        "attachments": [
            {"filename": a["filename"], "content_type": a["content_type"], "size": a["size"]} for a in attachments
        ],
    }


@handles(P.MESSAGE_FORWARD)
async def forward(ctx, conn, payload):
    """Copy a message you can see into a channel you can send in. The copy is
    a snapshot, not a reference (PROTOCOL.md §4 Forward)."""
    row, source, _ = _require_message(ctx, conn, payload)
    if source["kind"] not in ("text", "dm", "group_dm"):
        raise ProtocolError(P.BAD_REQUEST, "That message can't be forwarded")
    target, perms = require_channel_perm(ctx, conn, P.req_str(payload, "channel_id"), perm.SEND_MESSAGES)
    if target["kind"] not in ("text", "dm", "group_dm"):
        raise ProtocolError(P.BAD_REQUEST, "You can't send messages in that channel")
    check_muted(ctx, conn)
    _check_slowmode(ctx, target, perms, conn.user_id)
    if not conn.allow_message():
        raise ProtocolError(P.RATE_LIMITED, "You're sending messages too fast")
    note = P.validate_content(payload.get("content"), allow_empty=True)
    if target["kind"] == "dm":
        from .dms import dm_gate

        other = next(u["user_id"] for u in target["recipients"] if u["user_id"] != conn.user_id)
        request_state = dm_gate(ctx, conn.user_id, other, target)
        if request_state is not None:
            from_user = conn.user_id if request_state == "pending" else target["request"]["from_user_id"]
            ctx.db.set_dm_request(target["channel_id"], from_user, request_state)
            target = ctx.db.get_channel(target["channel_id"])
            from .dms import announce_dm

            await announce_dm(ctx, target, exclude_hidden=True)
    if target["guild_id"] is None:
        await _reveal_dm(ctx, target)
    mentions, everyone = parse_mentions(ctx, target, note, perms)
    message = ctx.db.create_message(
        target["channel_id"], conn.user_id, note, mentions=mentions, mention_everyone=everyone,
        forward=_forward_snapshot(ctx, row, source),
    )
    pinged = set(_audience_ids(ctx, target)) if everyone else set(mentions)
    pinged.discard(conn.user_id)
    ctx.db.bump_mentions(target["channel_id"], pinged)
    message["guild_id"] = target["guild_id"]
    await ctx.hub.send_to_channel_viewers(target, P.frame(P.MESSAGE_NEW, message))
    spawn_embeds(ctx, target, message)
    return {"message_id": message["message_id"], "message": message}


@handles(P.MESSAGE_EDIT)
async def edit(ctx, conn, payload):
    row, channel, perms = _require_message(ctx, conn, payload)
    if row["author_user_id"] != conn.user_id or row["type"] != "default":
        raise ProtocolError(P.FORBIDDEN, "You can only edit your own messages")
    if channel["guild_id"] is not None:
        check_timeout(ctx, channel["guild_id"], conn.user_id)
    check_muted(ctx, conn)
    has_files = bool(ctx.db.message_attachment_ids(row["message_id"]))
    content = P.validate_content(payload.get("content"), allow_empty=has_files)
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
    if content != row["content"]:
        # Links may have changed; drop the old previews and look again.
        ctx.db.set_embeds(row["message_id"], [])
        spawn_embeds(ctx, channel, message)
    return {"message": message}


@handles(P.MESSAGE_DELETE)
async def delete(ctx, conn, payload):
    row, channel, perms = _require_message(ctx, conn, payload)
    from .files import delete_files

    own = row["author_user_id"] == conn.user_id
    if not own and not (channel["guild_id"] is not None and perms & perm.MANAGE_MESSAGES):
        raise ProtocolError(P.FORBIDDEN, "You can only delete your own messages")
    files = ctx.db.message_attachment_ids(row["message_id"])
    ctx.db.delete_message(row["message_id"])
    delete_files(ctx, files)
    if not own:
        ctx.db.add_audit(
            channel["guild_id"], conn.user_id, "message.delete", row["author_user_id"],
            {"channel_id": channel["channel_id"], "channel": channel["name"]},
        )
    await broadcast_deleted(ctx, channel, str(row["message_id"]))
    return {}


@handles(P.MESSAGE_EMBEDS_SUPPRESS)
async def embeds_suppress(ctx, conn, payload):
    """Hide (or bring back) a message's link previews. Author or Manage Messages."""
    row, channel, perms = _require_message(ctx, conn, payload)
    own = row["author_user_id"] == conn.user_id
    if not own and not (channel["guild_id"] is not None and perms & perm.MANAGE_MESSAGES):
        raise ProtocolError(P.FORBIDDEN, "You can only hide previews on your own messages")
    suppressed = P.opt_bool(payload, "suppressed")
    suppressed = True if suppressed is None else suppressed
    if bool(row["embeds_suppressed"]) == suppressed:
        return {"message": ctx.db.get_message(row["message_id"])}
    message = ctx.db.suppress_embeds(row["message_id"], suppressed)
    message["guild_id"] = channel["guild_id"]
    await ctx.hub.send_to_channel_viewers(channel, P.frame(P.MESSAGE_UPDATED, message))
    if not suppressed:
        spawn_embeds(ctx, channel, message)
    return {"message": message}


async def _reaction_event(ctx, channel: dict, type_: str, row, emoji: str, user_id: str) -> None:
    await ctx.hub.send_to_channel_viewers(
        channel,
        P.frame(type_, {
            "channel_id": channel["channel_id"], "guild_id": channel["guild_id"],
            "message_id": str(row["message_id"]), "emoji": emoji, "user_id": user_id,
        }),
    )


def require_expression_member(ctx, conn, guild_id: str, what: str) -> None:
    """Custom emoji and stickers can be used anywhere by members of their guild."""
    m = ctx.db.get_membership(guild_id, conn.user_id)
    if m is None or m["ghost"]:
        raise ProtocolError(P.FORBIDDEN, f"Join the guild these {what} are from to use them")


def _custom_reaction(ctx, conn, row, emoji: str) -> str:
    """Checks a <:name:id> reaction and returns the key to store: the one
    already on the message for that emoji id, else <:current_name:id>."""
    m = P.CUSTOM_EMOJI_RE.match(emoji)
    if not m:
        return emoji
    emoji_id = m.group(3)
    for existing in ctx.db.reaction_emoji(row["message_id"]):
        if existing.endswith(f":{emoji_id}>"):
            return existing
    found = ctx.db.get_emoji(emoji_id)
    if found is None:
        raise ProtocolError(P.NOT_FOUND, "That emoji was deleted")
    require_expression_member(ctx, conn, found["guild_id"], "emoji")
    return f"<{'a' if found['animated'] else ''}:{found['name']}:{emoji_id}>"


@handles(P.REACTION_ADD)
async def reaction_add(ctx, conn, payload):
    row, channel, perms = _require_message(ctx, conn, payload)
    emoji = P.validate_emoji(payload.get("emoji"))
    if not perms & perm.ADD_REACTIONS:
        if channel["guild_id"] is not None:
            check_timeout(ctx, channel["guild_id"], conn.user_id)
        raise ProtocolError(P.FORBIDDEN, "You can't add reactions here")
    check_muted(ctx, conn)
    emoji = _custom_reaction(ctx, conn, row, emoji)
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
    check_muted(ctx, conn)
    if conn.allow_typing(channel["channel_id"]):
        await ctx.hub.send_to_focused(
            channel,
            P.frame(P.TYPING_STARTED, {
                "channel_id": channel["channel_id"], "guild_id": channel["guild_id"], "user_id": conn.user_id,
            }),
            exclude_user=conn.user_id,
        )
    return {}


# --- pins ----------------------------------------------------------------------


def _require_pin_perm(ctx, conn, channel: dict, perms: int) -> None:
    if channel["guild_id"] is None:
        check_muted(ctx, conn)
        return
    if not perms & perm.MANAGE_MESSAGES:
        check_timeout(ctx, channel["guild_id"], conn.user_id)
        raise ProtocolError(P.FORBIDDEN, "Pinning messages needs Manage Messages")


@handles(P.MESSAGE_PIN)
async def pin(ctx, conn, payload):
    row, channel, perms = _require_message(ctx, conn, payload)
    _require_pin_perm(ctx, conn, channel, perms)
    if row["type"] != "default":
        raise ProtocolError(P.BAD_REQUEST, "System messages can't be pinned")
    if row["pinned_at"] is None:
        if ctx.db.pin_count(channel["channel_id"]) >= P.MAX_PINS:
            raise ProtocolError(P.PIN_LIMIT, f"A channel can have at most {P.MAX_PINS} pins")
        message = ctx.db.set_pinned(row["message_id"], conn.user_id)
        message["guild_id"] = channel["guild_id"]
        await ctx.hub.send_to_channel_viewers(channel, P.frame(P.MESSAGE_UPDATED, message))
        if channel["guild_id"] is not None:
            ctx.db.add_audit(channel["guild_id"], conn.user_id, "message.pin", row["author_user_id"],
                             {"channel_id": channel["channel_id"], "channel": channel["name"]})
        await post_system(ctx, channel, conn.user_id, "pin", reply_to_id=row["message_id"])
    return {}


@handles(P.MESSAGE_UNPIN)
async def unpin(ctx, conn, payload):
    row, channel, perms = _require_message(ctx, conn, payload)
    _require_pin_perm(ctx, conn, channel, perms)
    if row["pinned_at"] is not None:
        message = ctx.db.set_pinned(row["message_id"], None)
        message["guild_id"] = channel["guild_id"]
        await ctx.hub.send_to_channel_viewers(channel, P.frame(P.MESSAGE_UPDATED, message))
    return {}


@handles(P.CHANNEL_PINS)
async def pins(ctx, conn, payload):
    channel, _ = require_channel_perm(ctx, conn, P.req_str(payload, "channel_id"), perm.READ_HISTORY)
    return {"messages": ctx.db.pins(channel["channel_id"])}


# --- search --------------------------------------------------------------------

SEARCH_HAS = ("file", "image", "video", "link")


@handles(P.MESSAGE_SEARCH)
async def search(ctx, conn, payload):
    """Search one channel (guild or DM) or a whole guild, newest first."""
    if payload.get("channel_id") is not None:
        channel, _ = require_channel_perm(ctx, conn, P.req_id(payload, "channel_id"), perm.READ_HISTORY)
        channel_ids = [channel["channel_id"]]
    else:
        guild, _ = require_member(ctx, conn, P.req_id(payload, "guild_id"))
        channel_ids = [
            c["channel_id"] for c in ctx.db.list_channels(guild["guild_id"])
            if c["kind"] == "text" and ctx.perms.channel_perms(c, conn.user_id) & perm.READ_HISTORY
        ]
    query = P.opt_text(payload, "query", 200) or None
    author_id = P.opt_id(payload, "author_id")
    has = P.opt_enum(payload, "has", SEARCH_HAS)
    pinned = P.opt_bool(payload, "pinned")
    before = P.opt_id(payload, "before")
    after = P.opt_id(payload, "after")
    offset = P.opt_int(payload, "offset") or 0
    if not 0 <= offset <= 5000:
        raise ProtocolError(P.BAD_REQUEST, "'offset' must be between 0 and 5000")
    if not (query or author_id or has or pinned):
        raise ProtocolError(P.BAD_REQUEST, "Search for something")
    messages, total = ctx.db.search(
        channel_ids, query=query, author_id=author_id, has=has, pinned=pinned,
        before=int(before) if before else None, after=int(after) if after else None,
        offset=offset, limit=P.SEARCH_PAGE,
    )
    guild_of = {}
    for m in messages:
        cid = m["channel_id"]
        if cid not in guild_of:
            guild_of[cid] = ctx.db.get_channel(cid)["guild_id"]
        m["guild_id"] = guild_of[cid]
    return {"messages": messages, "total": total}
