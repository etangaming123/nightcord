"""Custom status: hidden while you're away, and able to clear itself (§4 User)."""

from __future__ import annotations

import datetime as dt

from conftest import types
from nightcord.db import iso_in
from nightcord.handlers.users import _status_expiry, clear_expired_statuses


async def test_your_own_status_is_always_visible_to_you(user):
    alice = await user("alice")
    res = await alice.ok("user.update", {"custom_status": "reading"})
    assert res["user"]["custom_status"] == "reading"
    await alice.ok("presence.set", {"status": "invisible"})
    assert (await alice.ok("user.profile", {"user_id": alice.uid}))["user"]["custom_status"] == "reading"


async def test_invisible_hides_the_status_from_others(user):
    alice = await user("alice")
    bob = await user("bob")
    await alice.ok("user.update", {"custom_status": "reading"})
    assert (await bob.ok("user.profile", {"user_id": alice.uid}))["user"]["custom_status"] == "reading"
    await alice.ok("presence.set", {"status": "invisible"})
    assert (await bob.ok("user.profile", {"user_id": alice.uid}))["user"]["custom_status"] is None
    await alice.ok("presence.set", {"status": "online"})
    assert (await bob.ok("user.profile", {"user_id": alice.uid}))["user"]["custom_status"] == "reading"


async def test_offline_hides_the_status_from_others(user, connect, ctx):
    alice = await user("alice")
    bob = await user("bob")
    await alice.ok("user.update", {"custom_status": "afk"})
    await alice.ws.close()
    # The hub drops the connection asynchronously; give it a moment.
    for _ in range(50):
        if ctx.hub.status_of(alice.uid) == "offline":
            break
        await _sleep()
    assert (await bob.ok("user.profile", {"user_id": alice.uid}))["user"]["custom_status"] is None
    assert ctx.db.get_user(alice.uid)["custom_status"] == "afk"  # still stored


async def _sleep():
    import asyncio

    await asyncio.sleep(0.02)


async def test_it_is_hidden_in_member_lists_too(guild, ctx):
    gid, cid, (alice, bob) = await guild("alice", "bob")
    await bob.ok("user.update", {"custom_status": "brb"})
    await bob.ok("presence.set", {"status": "invisible"})
    members = (await alice.ok("guild.members", {"guild_id": gid}))["members"]
    theirs = next(m for m in members if m["user"]["user_id"] == bob.uid)
    assert theirs["user"]["custom_status"] is None


async def test_it_is_hidden_on_their_messages(guild):
    gid, cid, (alice, bob) = await guild("alice", "bob")
    await bob.ok("user.update", {"custom_status": "brb"})
    await bob.ok("message.send", {"channel_id": cid, "content": "hi"})
    await bob.ok("presence.set", {"status": "invisible"})
    page = await alice.ok("channel.history", {"channel_id": cid})
    assert page["messages"][0]["author"]["custom_status"] is None


# --- expiry --------------------------------------------------------------------


def test_expiry_options():
    assert _status_expiry(None) is None and _status_expiry("never") is None
    soon = _status_expiry("30m")
    assert soon > iso_in(1700) and soon < iso_in(1900)
    end_of_day = _status_expiry("today")
    assert end_of_day.endswith("T00:00:00.000Z")
    assert dt.datetime.fromisoformat(end_of_day.replace("Z", "+00:00")) > dt.datetime.now(dt.timezone.utc)


async def test_setting_a_clear_after(user):
    alice = await user("alice")
    res = await alice.ok("user.update", {"custom_status": "lunch", "custom_status_clear_after": "1h"})
    assert res["user"]["custom_status_expires_at"] is not None


async def test_clearing_the_text_clears_the_expiry(user):
    alice = await user("alice")
    await alice.ok("user.update", {"custom_status": "lunch", "custom_status_clear_after": "1h"})
    res = await alice.ok("user.update", {"custom_status": None})
    assert res["user"]["custom_status"] is None and res["user"]["custom_status_expires_at"] is None


async def test_replacing_the_text_without_an_option_drops_the_old_expiry(user):
    alice = await user("alice")
    await alice.ok("user.update", {"custom_status": "lunch", "custom_status_clear_after": "30m"})
    res = await alice.ok("user.update", {"custom_status": "back"})
    assert res["user"]["custom_status_expires_at"] is None


async def test_clear_after_on_its_own_is_refused(user):
    alice = await user("alice")
    assert await alice.err("user.update", {"custom_status_clear_after": "1h"}) == "bad_request"
    assert await alice.err("user.update", {"custom_status": "x", "custom_status_clear_after": "10y"}) == "bad_request"


async def test_the_sweeper_clears_and_announces(user, ctx):
    alice = await user("alice")
    bob = await user("bob")
    await alice.ok("user.update", {"custom_status": "lunch", "custom_status_clear_after": "30m"})
    ctx.db.update_profile(alice.uid, {"custom_status_expires_at": iso_in(-60)})
    await alice.drain()
    await bob.drain()
    assert await clear_expired_statuses(ctx) == 1
    assert ctx.db.get_user(alice.uid)["custom_status"] is None
    assert "user.updated" in types(await alice.drain(0.3))
    assert await clear_expired_statuses(ctx) == 0


async def test_a_status_with_no_expiry_is_left_alone(user, ctx):
    alice = await user("alice")
    await alice.ok("user.update", {"custom_status": "forever"})
    assert await clear_expired_statuses(ctx) == 0
    assert ctx.db.get_user(alice.uid)["custom_status"] == "forever"
