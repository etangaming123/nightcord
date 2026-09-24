"""Badges the server owner uploads and hands out (PROTOCOL.md §4 Badge, §5 Badges)."""

from nightcord import protocol as P
from nightcord.handlers import media as M

from images import gif, media_id, png


async def _badge(server, owner, name="Early", **extra):
    mid = await media_id(server, owner, "badge", extra.pop("data", png()))
    return (await owner.ok("badge.create", {"name": name, "media_id": mid, **extra}))["badge"]


async def test_verified_is_built_in(owner):
    badges = (await owner.ok("badge.list"))["badges"]
    assert [b["id"] for b in badges] == ["verified"]
    assert badges[0]["image"] is None and badges[0]["inline"] is True
    assert await owner.err("badge.update", {"badge_id": "verified", "name": "x"}) == "bad_request"
    assert await owner.err("badge.delete", {"badge_id": "verified"}) == "bad_request"


async def test_only_the_server_owner_manages_badges(server, owner, user):
    badge = await _badge(server, owner)
    bob = await user("bob")
    mid = await media_id(server, bob, "badge", png())
    assert await bob.err("badge.list") == "forbidden"
    assert await bob.err("badge.create", {"name": "Mine", "media_id": mid}) == "forbidden"
    assert await bob.err("badge.update", {"badge_id": badge["id"], "name": "x"}) == "forbidden"
    assert await bob.err("badge.delete", {"badge_id": badge["id"]}) == "forbidden"
    assert await bob.err("admin.users.set_badges", {"user_id": bob.uid, "badge_ids": ["verified"]}) == "forbidden"


async def test_create_update_and_list(server, owner):
    badge = await _badge(server, owner, description="Was here first", inline=False, data=gif(animated=True))
    assert badge["name"] == "Early" and badge["inline"] is False and badge["image"] == f"a_{badge['id']}"
    updated = (await owner.ok("badge.update", {"badge_id": badge["id"], "name": "Older", "inline": True}))["badge"]
    assert updated["name"] == "Older" and updated["inline"] is True and updated["description"] == "Was here first"
    ids = [b["id"] for b in (await owner.ok("badge.list"))["badges"]]
    assert ids == ["verified", badge["id"]]
    mid = await media_id(server, owner, "badge", png())
    assert await owner.err("badge.create", {"name": "", "media_id": mid}) == "bad_request"


async def test_badge_limit(server, owner, monkeypatch):
    monkeypatch.setattr(P, "MAX_BADGES", 1)
    await _badge(server, owner)
    mid = await media_id(server, owner, "badge", png())
    assert await owner.err("badge.create", {"name": "Two", "media_id": mid}) == "bad_request"


async def test_granting_shows_up_everywhere_a_user_does(server, owner, user):
    bob = await user("bob")
    badge = await _badge(server, owner, inline=False)
    await bob.drain()
    res = await owner.ok("admin.users.set_badges", {"user_id": bob.uid, "badge_ids": ["verified", badge["id"]]})
    assert [b["id"] for b in res["user"]["badges"]] == ["verified", badge["id"]]
    # Bob hears about it, and so does anyone looking at his profile.
    ev = [e for e in await bob.drain() if e["type"] == "user.updated"]
    assert [b["id"] for b in ev[-1]["payload"]["badges"]] == ["verified", badge["id"]]
    prof = (await owner.ok("user.profile", {"user_id": bob.uid}))["user"]
    assert [b["id"] for b in prof["badges"]] == ["verified", badge["id"]]
    assert prof["badges"][1]["inline"] is False
    # Revoking is just setting a shorter list, and order is kept.
    res = await owner.ok("admin.users.set_badges", {"user_id": bob.uid, "badge_ids": [badge["id"]]})
    assert [b["id"] for b in res["user"]["badges"]] == [badge["id"]]
    res = await owner.ok("admin.users.set_badges", {"user_id": bob.uid, "badge_ids": []})
    assert res["user"]["badges"] == []


async def test_badges_ride_on_message_authors(owner, user):
    a = await user("alice")
    gid = (await a.ok("guild.create", {"name": "G"}))
    cid = gid["channels"][0]["channel_id"]
    await owner.ok("admin.users.set_badges", {"user_id": a.uid, "badge_ids": ["verified"]})
    await a.ok("message.send", {"channel_id": cid, "content": "hi"})
    msgs = (await a.ok("channel.history", {"channel_id": cid}))["messages"]
    assert [b["id"] for b in msgs[-1]["author"]["badges"]] == ["verified"]


async def test_grant_validation(server, owner, user):
    bob = await user("bob")
    badge = await _badge(server, owner)
    grant = lambda ids, uid=None: owner.err("admin.users.set_badges", {"user_id": uid or bob.uid, "badge_ids": ids})
    assert await grant(["nope"]) == "not_found"
    assert await grant(["verified", "verified"]) == "bad_request"
    assert await grant("verified") == "bad_request"
    assert await grant(["verified"], uid="999") == "not_found"
    many = [badge["id"]] + ["verified"] * 0
    assert (await owner.ok("admin.users.set_badges", {"user_id": bob.uid, "badge_ids": many}))["user"]
    P_max = P.MAX_USER_BADGES
    assert await grant([str(i) for i in range(P_max + 1)]) == "bad_request"


async def test_delete_removes_grants_and_the_image(server, owner, user, ctx):
    bob = await user("bob")
    badge = await _badge(server, owner)
    await owner.ok("admin.users.set_badges", {"user_id": bob.uid, "badge_ids": [badge["id"], "verified"]})
    await bob.drain()
    await owner.ok("badge.delete", {"badge_id": badge["id"]})
    assert not (M.media_dir(ctx) / badge["id"]).exists()
    ev = [e for e in await bob.drain() if e["type"] == "user.updated"]
    assert [b["id"] for b in ev[-1]["payload"]["badges"]] == ["verified"]
    assert [b["id"] for b in (await owner.ok("badge.list"))["badges"]] == ["verified"]


async def test_deleting_an_account_drops_its_badges(owner, user, ctx):
    bob = await user("bob")
    await owner.ok("admin.users.set_badges", {"user_id": bob.uid, "badge_ids": ["verified"]})
    ctx.db.anonymize_user(bob.uid)
    assert ctx.db.user_badge_ids(bob.uid) == []
