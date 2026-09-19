"""Profiles, avatars, presence status, password and sessions (PROTOCOL.md §5 Users, Presence)."""

import base64

from conftest import types

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


async def test_profile_update_broadcasts(guild):
    gid, cid, (a, b) = await guild("alice", "bob")
    res = await a.ok("user.update", {"display_name": "  Alice A.  ", "bio": "hi", "avatar_color": "#123ABC", "custom_status": "coding"})
    assert res["user"]["display_name"] == "Alice A." and res["user"]["bio"] == "hi"
    ev = [e for e in await b.drain() if e["type"] == "user.updated"]
    assert ev[0]["payload"]["display_name"] == "Alice A."
    assert "bio" not in ev[0]["payload"]  # public view
    prof = await b.ok("user.profile", {"user_id": a.uid})
    assert prof["user"]["bio"] == "hi" and prof["status"] == "online"
    await a.ok("user.update", {"display_name": None, "bio": ""})
    me = (await a.ok("user.profile", {"user_id": a.uid}))["user"]
    assert me["display_name"] is None and me["bio"] is None
    assert await a.err("user.update", {"avatar_color": "red"}) == "bad_request"
    assert await a.err("user.update", {"bio": "x" * 191}) == "bad_request"
    assert await a.err("user.update", {}) == "bad_request"


async def test_avatar_upload_and_serve(guild, server):
    gid, cid, (a, b) = await guild("alice", "bob")
    assert await a.err("user.avatar.set", {"data_b64": "not base64!"}) == "avatar_invalid"
    assert await a.err("user.avatar.set", {"data_b64": base64.b64encode(b"GIF89a....").decode()}) == "avatar_invalid"
    big = base64.b64encode(PNG + b"\x00" * 41 * 1024).decode()
    assert await a.err("user.avatar.set", {"data_b64": big}) == "avatar_invalid"

    user = (await a.ok("user.avatar.set", {"data_b64": base64.b64encode(PNG).decode()}))["user"]
    avatar_id = user["avatar_id"]
    assert avatar_id.endswith(".png")
    assert any(e["payload"].get("avatar_id") == avatar_id for e in await b.drain() if e["type"] == "user.updated")
    resp = await server.get(f"/avatars/{avatar_id}")
    assert resp.status == 200 and resp.content_type == "image/png"
    assert "immutable" in resp.headers["Cache-Control"]
    assert await resp.read() == PNG
    assert (await server.get("/avatars/../secret")).status == 404
    assert (await server.get("/avatars/123.png")).status == 404

    await a.ok("user.avatar.set", {"data_b64": None})
    assert (await server.get(f"/avatars/{avatar_id}")).status == 404  # old file removed


async def test_presence_status(guild, connect):
    gid, cid, (a, b) = await guild("alice", "bob")
    for status, seen in (("dnd", "dnd"), ("idle", "idle"), ("invisible", "offline"), ("online", "online")):
        res = await a.ok("presence.set", {"status": status})
        assert res["status"] == seen
        ev = await b.drain()
        assert {"type": "presence.update", "payload": {"user_id": a.uid, "status": seen}} in ev
    # afk on every connection -> idle; one active connection keeps them online.
    a2 = await connect()
    await a2.login("alice", "password123")
    await a.ok("presence.set", {"afk": True})
    assert await b.drain() == []
    await a2.ok("presence.set", {"afk": True})
    assert (await b.drain())[-1]["payload"]["status"] == "idle"
    await a2.ok("presence.set", {"afk": False})
    assert (await b.drain())[-1]["payload"]["status"] == "online"
    # The chosen status is saved on the account.
    await a.ok("presence.set", {"status": "dnd"})
    a3 = await connect()
    assert (await a3.login("alice", "password123"))["user"]["presence"] == "dnd"
    assert await a.err("presence.set", {"status": "away"}) == "bad_request"


async def test_password_change_revokes_other_sessions(connect, user):
    a = await user("alice")
    a2 = await connect()
    await a2.login("alice", "password123")
    assert await a.err("user.password.change", {"current_password": "nope-nope", "new_password": "newpassword1"}) == "invalid_current_password"
    await a.ok("user.password.change", {"current_password": "password123", "new_password": "newpassword1"})
    msg = await a2.ws.receive()
    assert msg.data == 4001  # close code
    await a.ok("guild.list")  # this connection survives
    c = await connect()
    assert await c.err("auth.login", {"username": "alice", "password": "password123"}) == "invalid_credentials"
    await c.login("alice", "newpassword1")


async def test_sessions_list_and_revoke(connect, user):
    a = await user("alice")
    a2 = await connect()
    await a2.login("alice", "password123")
    sessions = (await a.ok("user.sessions.list"))["sessions"]
    assert len(sessions) == 2 and sum(s["current"] for s in sessions) == 1
    other = [s for s in sessions if not s["current"]][0]
    await a.ok("user.sessions.revoke", {"session_id": other["session_id"]})
    assert (await a2.ws.receive()).data == 4001
    assert len((await a.ok("user.sessions.list"))["sessions"]) == 1
    assert await a.err("user.sessions.revoke", {"session_id": other["session_id"]}) == "not_found"
    a3 = await connect()
    await a3.login("alice", "password123")
    await a.ok("user.sessions.revoke", {"session_id": "others"})
    assert (await a3.ws.receive()).data == 4001


async def test_notify_prefs(guild, connect):
    gid, cid, (a,) = await guild("alice")
    a2 = await connect()
    await a2.login("alice", "password123")
    await a2.drain()
    pref = (await a.ok("notify.prefs.set", {"target_id": gid, "level": "mentions", "muted": True}))["pref"]
    assert pref == {"target_id": gid, "level": "mentions", "muted": True}
    assert (await a2.drain()) == [{"type": "notify.prefs.updated", "payload": pref}]
    await a.ok("notify.prefs.set", {"target_id": cid, "level": "none"})
    assert len((await a2.ok("notify.prefs.get"))["prefs"]) == 2
    await a.ok("notify.prefs.set", {"target_id": cid})  # inherit + unmuted -> removed
    assert (await a.ok("notify.prefs.get"))["prefs"] == [pref]
    assert await a.err("notify.prefs.set", {"target_id": "123"}) == "not_found"
    assert await a.err("notify.prefs.set", {"target_id": gid, "level": "loud"}) == "bad_request"
