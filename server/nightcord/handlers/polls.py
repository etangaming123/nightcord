"""poll.* handlers and the sweeper that closes expired polls (PROTOCOL.md §4 Poll)."""

from __future__ import annotations

import asyncio
import logging

from aiohttp import web

from .. import permissions as perm
from .. import protocol as P
from ..protocol import ProtocolError
from . import handles
from ._access import get_channel

log = logging.getLogger("nightcord.polls")

SWEEP_EVERY = 30


def validate(payload: dict) -> dict | None:
    """Reads message.send's optional `poll` field into what db.create_message wants."""
    raw = payload.get("poll")
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ProtocolError(P.BAD_REQUEST, "'poll' must be an object")
    question = raw.get("question")
    if not isinstance(question, str) or not question.strip():
        raise ProtocolError(P.BAD_REQUEST, "A poll needs a question")
    question = question.strip()
    if len(question) > P.POLL_QUESTION_MAX:
        raise ProtocolError(P.BAD_REQUEST, f"The question can be at most {P.POLL_QUESTION_MAX} characters")
    answers = raw.get("answers")
    if not isinstance(answers, list) or not P.POLL_MIN_ANSWERS <= len(answers) <= P.POLL_MAX_ANSWERS:
        raise ProtocolError(
            P.BAD_REQUEST, f"A poll needs {P.POLL_MIN_ANSWERS} to {P.POLL_MAX_ANSWERS} answers"
        )
    cleaned = []
    for answer in answers:
        if not isinstance(answer, dict):
            raise ProtocolError(P.BAD_REQUEST, "Each answer must be an object")
        text = answer.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ProtocolError(P.BAD_REQUEST, "Every answer needs text")
        text = text.strip()
        if len(text) > P.POLL_ANSWER_MAX:
            raise ProtocolError(P.BAD_REQUEST, f"Answers can be at most {P.POLL_ANSWER_MAX} characters")
        emoji = answer.get("emoji")
        if emoji is not None:
            emoji = P.validate_emoji(emoji)
        cleaned.append({"text": text, "emoji": emoji})
    duration = raw.get("duration", "1d")
    if duration not in P.POLL_DURATIONS:
        raise ProtocolError(P.BAD_REQUEST, f"'duration' must be one of {', '.join(P.POLL_DURATIONS)}")
    multi = raw.get("multi", False)
    if not isinstance(multi, bool):
        raise ProtocolError(P.BAD_REQUEST, "'multi' must be a boolean")
    from ..db import iso_in

    return {
        "question": question,
        "answers": cleaned,
        "multi": multi,
        "expires_at": iso_in(P.POLL_DURATIONS[duration]),
    }


async def broadcast(ctx, channel: dict, message_id: int) -> None:
    poll = ctx.db.get_poll(message_id)
    if poll is None:
        return
    await ctx.hub.send_to_channel_viewers(channel, P.frame(P.POLL_UPDATED, {
        "message_id": str(message_id),
        "channel_id": channel["channel_id"],
        "guild_id": channel["guild_id"],
        "poll": poll,
    }))


def _require_poll(ctx, conn, payload):
    message_id = P.req_id(payload, "message_id")
    row = ctx.db.message_row(int(message_id))
    if row is None:
        raise ProtocolError(P.NOT_FOUND, "Message not found")
    poll = ctx.db.poll_row(int(message_id))
    if poll is None:
        raise ProtocolError(P.NOT_FOUND, "That message has no poll")
    channel, perms = get_channel(ctx, conn, row["channel_id"])
    return row, poll, channel, perms


@handles(P.POLL_VOTE)
async def vote(ctx, conn, payload):
    """Replaces this user's votes. An empty list takes the vote back."""
    row, poll, channel, perms = _require_poll(ctx, conn, payload)
    if poll["ended_at"] is not None:
        raise ProtocolError(P.POLL_ENDED, "This poll has closed")
    raw = payload.get("answer_ids")
    if not isinstance(raw, list) or len(raw) > P.POLL_MAX_ANSWERS:
        raise ProtocolError(P.BAD_REQUEST, "'answer_ids' must be a list of answer ids")
    known = ctx.db.poll_answer_ids(row["message_id"])
    chosen: list[int] = []
    for item in raw:
        if not isinstance(item, int) or isinstance(item, bool) or item not in known:
            raise ProtocolError(P.BAD_REQUEST, "Unknown answer")
        if item not in chosen:
            chosen.append(item)
    if not poll["multi"] and len(chosen) > 1:
        raise ProtocolError(P.BAD_REQUEST, "This poll only takes one answer")
    ctx.db.set_poll_votes(row["message_id"], conn.user_id, chosen)
    await broadcast(ctx, channel, row["message_id"])
    return {"poll": ctx.db.get_poll(row["message_id"])}


@handles(P.POLL_END)
async def end(ctx, conn, payload):
    """Closes a poll early: its author, or anyone who can manage messages here."""
    row, poll, channel, perms = _require_poll(ctx, conn, payload)
    own = row["author_user_id"] == conn.user_id
    if not own and not (channel["guild_id"] is not None and perms & perm.MANAGE_MESSAGES):
        raise ProtocolError(P.FORBIDDEN, "Only the author can end this poll")
    if poll["ended_at"] is not None:
        raise ProtocolError(P.POLL_ENDED, "This poll has already closed")
    ctx.db.end_poll(row["message_id"])
    await broadcast(ctx, channel, row["message_id"])
    return {"poll": ctx.db.get_poll(row["message_id"])}


async def close_expired(ctx) -> int:
    """Ends polls whose time is up and tells everyone who can see them."""
    closed = 0
    for message_id in ctx.db.expired_poll_ids():
        if not ctx.db.end_poll(message_id):
            continue
        closed += 1
        row = ctx.db.message_row(message_id)
        channel = ctx.db.get_channel(row["channel_id"]) if row else None
        if channel is not None:
            await broadcast(ctx, channel, message_id)
    return closed


async def sweeper(app: web.Application) -> None:
    from ..app import CTX_KEY

    ctx = app[CTX_KEY]
    while True:
        await asyncio.sleep(SWEEP_EVERY)
        try:
            await close_expired(ctx)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("poll sweep failed")
