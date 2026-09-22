"""Server-rolled slash commands (PROTOCOL.md §4 Command)."""

from __future__ import annotations

import pytest

from nightcord import commands as C
from nightcord import protocol as P
from nightcord.protocol import ProtocolError


def test_roll_notation():
    r = C.run("roll", "2d6+3")["result"]
    assert r["notation"] == "2d6+3" and len(r["rolls"]) == 2 and r["modifier"] == 3
    assert r["total"] == sum(r["rolls"]) + 3
    assert all(1 <= v <= 6 for v in r["rolls"])


def test_roll_defaults_and_shorthand():
    assert C.run("roll", "")["result"]["notation"] == "1d6"
    assert C.run("roll", "d20")["result"]["notation"] == "1d20"
    assert C.run("roll", "3d10-2")["result"]["modifier"] == -2


@pytest.mark.parametrize("args", ["", "d20", "20d1000", "1d2"])
def test_roll_accepts_the_edges(args):
    C.run("roll", args)


@pytest.mark.parametrize("args", ["21d6", "1d1", "1d1001", "nonsense", "2d6+99999999", "d", "1d6d6"])
def test_roll_refuses_the_rest(args):
    with pytest.raises(ProtocolError):
        C.run("roll", args)


def test_roll_stays_in_range_over_many_tries():
    for _ in range(200):
        r = C.run("roll", "5d4")["result"]
        assert len(r["rolls"]) == 5 and all(1 <= v <= 4 for v in r["rolls"])
        assert r["total"] == sum(r["rolls"])


def test_coinflip():
    sides = {C.run("coinflip", "")["result"]["side"] for _ in range(100)}
    assert sides == {"heads", "tails"}


def test_8ball_needs_a_question():
    assert C.run("8ball", "will it rain")["result"]["answer"] in C.EIGHT_BALL
    with pytest.raises(ProtocolError):
        C.run("8ball", "")


def test_choose_picks_one_of_the_options():
    r = C.run("choose", "pizza | pasta | rice")["result"]
    assert r["options"] == ["pizza", "pasta", "rice"] and r["picked"] in r["options"]


@pytest.mark.parametrize("args", ["", "only one", "a |", "|"])
def test_choose_needs_at_least_two(args):
    with pytest.raises(ProtocolError):
        C.run("choose", args)


def test_choose_caps_the_options():
    with pytest.raises(ProtocolError):
        C.run("choose", " | ".join(str(i) for i in range(P.MAX_CHOICES + 1)))


def test_unknown_command_is_refused():
    with pytest.raises(ProtocolError):
        C.run("rm-rf", "")
    with pytest.raises(ProtocolError):
        C.validate({"command": {"name": "nuke"}})
    with pytest.raises(ProtocolError):
        C.run("roll", "d6" * 200)


def test_validate_passes_through_none():
    assert C.validate({}) is None


# --- through message.send ------------------------------------------------------


async def test_command_is_stored_on_the_message(guild):
    gid, cid, (alice,) = await guild("alice")
    res = await alice.ok("message.send", {
        "channel_id": cid, "content": "", "command": {"name": "roll", "args": "2d6"},
    })
    m = res["message"]
    assert m["command"]["name"] == "roll"
    assert m["command"]["result"]["total"] == sum(m["command"]["result"]["rolls"])
    assert m["content"] == ""  # a command is enough on its own


async def test_a_bad_command_doesnt_post_anything(guild):
    gid, cid, (alice,) = await guild("alice")
    assert await alice.err("message.send", {
        "channel_id": cid, "content": "", "command": {"name": "roll", "args": "99d99999"},
    }) == "bad_request"
    assert (await alice.ok("channel.history", {"channel_id": cid}))["messages"] == []


async def test_editing_a_message_keeps_its_command(guild):
    gid, cid, (alice,) = await guild("alice")
    res = await alice.ok("message.send", {
        "channel_id": cid, "content": "rolling", "command": {"name": "coinflip"},
    })
    before = res["message"]["command"]["result"]["side"]
    after = await alice.ok("message.edit", {"message_id": res["message_id"], "content": "rolled"})
    assert after["message"]["command"]["result"]["side"] == before
