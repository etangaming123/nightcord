"""Polls (PROTOCOL.md §4 Poll, §5 Messaging: poll.*)."""

from __future__ import annotations

import pytest

from nightcord import protocol as P
from nightcord.db import iso_in
from nightcord.handlers import polls as poll_lib

from conftest import types

POLL = {
    "question": "Lunch?",
    "answers": [{"text": "Pizza", "emoji": "🍕"}, {"text": "Pasta"}, {"text": "Rice"}],
    "duration": "1d",
}


async def send_poll(client, cid, **overrides):
    poll = {**POLL, **overrides}
    return await client.ok("message.send", {"channel_id": cid, "content": "", "poll": poll})


# --- validation ----------------------------------------------------------------


def test_validate_defaults():
    out = poll_lib.validate({"poll": {"question": "Q", "answers": [{"text": "a"}, {"text": "b"}]}})
    assert out["multi"] is False and out["expires_at"] > ""
    assert [a["text"] for a in out["answers"]] == ["a", "b"]


@pytest.mark.parametrize("poll", [
    {"question": "", "answers": [{"text": "a"}, {"text": "b"}]},
    {"question": "Q", "answers": [{"text": "a"}]},
    {"question": "Q", "answers": [{"text": f"a{i}"} for i in range(P.POLL_MAX_ANSWERS + 1)]},
    {"question": "Q", "answers": [{"text": "a"}, {"text": ""}]},
    {"question": "Q", "answers": [{"text": "a"}, {"text": "b"}], "duration": "10y"},
    {"question": "Q", "answers": [{"text": "a"}, {"text": "b"}], "multi": "yes"},
    {"question": "Q" * (P.POLL_QUESTION_MAX + 1), "answers": [{"text": "a"}, {"text": "b"}]},
    {"question": "Q", "answers": "nope"},
])
def test_validate_refuses_bad_polls(poll):
    with pytest.raises(Exception):
        poll_lib.validate({"poll": poll})


def test_validate_passes_through_none():
    assert poll_lib.validate({}) is None


# --- sending -------------------------------------------------------------------


async def test_poll_is_attached_to_the_message(guild):
    gid, cid, (alice,) = await guild("alice")
    m = (await send_poll(alice, cid))["message"]
    assert m["poll"]["question"] == "Lunch?"
    assert [a["answer_id"] for a in m["poll"]["answers"]] == [1, 2, 3]
    assert m["poll"]["answers"][0]["emoji"] == "🍕"
    assert m["poll"]["total_votes"] == 0 and m["poll"]["ended_at"] is None
    assert m["content"] == ""


async def test_history_carries_the_poll(guild):
    gid, cid, (alice,) = await guild("alice")
    await send_poll(alice, cid)
    page = await alice.ok("channel.history", {"channel_id": cid})
    assert page["messages"][0]["poll"]["question"] == "Lunch?"


# --- voting --------------------------------------------------------------------


async def test_vote_and_change_your_mind(guild):
    gid, cid, (alice, bob) = await guild("alice", "bob")
    mid = (await send_poll(alice, cid))["message_id"]
    await bob.drain()
    out = await bob.ok("poll.vote", {"message_id": mid, "answer_ids": [1]})
    assert out["poll"]["answers"][0]["count"] == 1
    assert out["poll"]["answers"][0]["user_ids"] == [bob.uid]
    assert out["poll"]["total_votes"] == 1
    # Voting again replaces, never adds.
    out = await bob.ok("poll.vote", {"message_id": mid, "answer_ids": [2]})
    assert out["poll"]["answers"][0]["count"] == 0 and out["poll"]["answers"][1]["count"] == 1
    # An empty list takes the vote back.
    out = await bob.ok("poll.vote", {"message_id": mid, "answer_ids": []})
    assert out["poll"]["total_votes"] == 0


async def test_voting_tells_everyone_who_can_see_it(guild):
    gid, cid, (alice, bob) = await guild("alice", "bob")
    mid = (await send_poll(alice, cid))["message_id"]
    await alice.drain()
    await bob.ok("poll.vote", {"message_id": mid, "answer_ids": [3]})
    events = await alice.drain(0.3)
    assert "poll.updated" in types(events)
    payload = next(e["payload"] for e in events if e["type"] == "poll.updated")
    assert payload["message_id"] == mid and payload["poll"]["answers"][2]["count"] == 1


async def test_single_choice_polls_take_one_answer(guild):
    gid, cid, (alice,) = await guild("alice")
    mid = (await send_poll(alice, cid))["message_id"]
    assert await alice.err("poll.vote", {"message_id": mid, "answer_ids": [1, 2]}) == "bad_request"


async def test_multi_choice_polls_take_several(guild):
    gid, cid, (alice,) = await guild("alice")
    mid = (await send_poll(alice, cid, multi=True))["message_id"]
    out = await alice.ok("poll.vote", {"message_id": mid, "answer_ids": [1, 3]})
    assert out["poll"]["total_votes"] == 2


async def test_unknown_answers_are_refused(guild):
    gid, cid, (alice,) = await guild("alice")
    mid = (await send_poll(alice, cid))["message_id"]
    assert await alice.err("poll.vote", {"message_id": mid, "answer_ids": [9]}) == "bad_request"
    assert await alice.err("poll.vote", {"message_id": mid, "answer_ids": ["1"]}) == "bad_request"


async def test_voting_on_a_message_without_a_poll(guild):
    gid, cid, (alice,) = await guild("alice")
    res = await alice.ok("message.send", {"channel_id": cid, "content": "hi"})
    assert await alice.err("poll.vote", {"message_id": res["message_id"], "answer_ids": [1]}) == "not_found"


# --- ending --------------------------------------------------------------------


async def test_author_ends_the_poll(guild):
    gid, cid, (alice, bob) = await guild("alice", "bob")
    mid = (await send_poll(alice, cid))["message_id"]
    await bob.drain()
    out = await alice.ok("poll.end", {"message_id": mid})
    assert out["poll"]["ended_at"] is not None
    assert "poll.updated" in types(await bob.drain(0.3))
    assert await bob.err("poll.vote", {"message_id": mid, "answer_ids": [1]}) == "poll_ended"
    assert await alice.err("poll.end", {"message_id": mid}) == "poll_ended"


async def test_somebody_else_cant_end_it(guild):
    gid, cid, (alice, bob) = await guild("alice", "bob")
    mid = (await send_poll(alice, cid))["message_id"]
    assert await bob.err("poll.end", {"message_id": mid}) == "forbidden"


async def test_manage_messages_can_end_it(guild, ctx):
    gid, cid, (alice, bob) = await guild("alice", "bob")
    mid = (await send_poll(bob, cid))["message_id"]
    await alice.ok("poll.end", {"message_id": mid})  # alice owns the guild


async def test_the_sweeper_closes_expired_polls(guild, ctx):
    gid, cid, (alice,) = await guild("alice")
    mid = (await send_poll(alice, cid))["message_id"]
    ctx.db._exec("UPDATE polls SET expires_at = ? WHERE message_id = ?", iso_in(-60), int(mid))
    await alice.drain()
    assert await poll_lib.close_expired(ctx) == 1
    assert ctx.db.get_poll(int(mid))["ended_at"] is not None
    assert "poll.updated" in types(await alice.drain(0.3))
    assert await poll_lib.close_expired(ctx) == 0  # nothing left to do


async def test_deleting_the_message_takes_the_poll_with_it(guild, ctx):
    gid, cid, (alice,) = await guild("alice")
    mid = (await send_poll(alice, cid))["message_id"]
    await alice.ok("poll.vote", {"message_id": mid, "answer_ids": [1]})
    await alice.ok("message.delete", {"message_id": mid})
    assert ctx.db.get_poll(int(mid)) is None
    assert ctx.db._one("SELECT 1 FROM poll_votes WHERE message_id = ?", int(mid)) is None


async def test_deleting_an_account_removes_its_votes(guild, ctx):
    gid, cid, (alice, bob) = await guild("alice", "bob")
    mid = (await send_poll(alice, cid))["message_id"]
    await bob.ok("poll.vote", {"message_id": mid, "answer_ids": [2]})
    ctx.db.anonymize_user(bob.uid)
    assert ctx.db.get_poll(int(mid))["total_votes"] == 0
