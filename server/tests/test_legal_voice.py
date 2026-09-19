"""Legal documents gate account creation; voice placeholder."""

from conftest import types

VOICE_OFF = {"voice_enabled": False}


async def test_legal_flow(owner, connect, user):
    c = await connect()
    info = await c.ok("server.info")
    assert info["legal_version"] is None and not info["has_terms"]
    await user("early")  # no documents: nothing to accept
    res = await owner.ok("admin.legal.set", {"terms": "# Rules\n\nBe nice.", "privacy": "We store messages."})
    version = res["legal_version"]
    assert version and res["has_terms"] and res["has_privacy"]
    docs = await c.ok("legal.get")
    assert docs["terms"].startswith("# Rules") and docs["legal_version"] == version
    assert await c.err("auth.register", {"username": "late", "password": "password123"}) == "legal_required"
    ok = await c.ok("auth.register", {"username": "late", "password": "password123", "accept_legal_version": version})
    assert ok["legal_update_required"] is False and ok["user"]["legal_version"] == version
    # Existing users are asked to accept on their next login.
    e = await connect()
    res = await e.ok("auth.login", {"username": "early", "password": "password123"})
    assert res["legal_update_required"] is True
    assert await e.err("legal.accept", {"legal_version": "stale"}) == "bad_request"
    await e.ok("legal.accept", {"legal_version": version})
    # Changing the documents bumps the version.
    res2 = await owner.ok("admin.legal.set", {"terms": "# Rules\n\nBe very nice."})
    assert res2["legal_version"] != version
    assert await c.err("admin.legal.set", {"terms": "x"}) == "forbidden"
    await owner.ok("admin.legal.set", {"terms": None, "privacy": None})
    assert (await c.ok("server.info"))["legal_version"] is None


async def test_voice_placeholder(owner, guild):
    gid, cid, (a, b) = await guild("alice", "bob")
    assert await a.err("channel.create", {"guild_id": gid, "name": "Lounge", "kind": "voice"}) == "voice_disabled"
    await owner.ok("server.config.update", {"voice_enabled": True})
    assert "server.config.updated" in types(await a.drain())
    vc = (await a.ok("channel.create", {"guild_id": gid, "name": "Lounge", "kind": "voice"}))["channel"]
    vc2 = (await a.ok("channel.create", {"guild_id": gid, "name": "Gaming", "kind": "voice"}))["channel"]
    assert await b.err("message.send", {"channel_id": vc["channel_id"], "content": "x"}) == "bad_request"
    assert await b.err("voice.join", {"channel_id": cid}) == "bad_request"
    await a.drain()
    st = (await b.ok("voice.join", {"channel_id": vc["channel_id"]}))["voice_state"]
    assert st["channel_id"] == vc["channel_id"] and st["user_id"] == b.uid
    ev = [e["payload"] for e in await a.drain() if e["type"] == "voice.state_updated"]
    assert ev == [st]
    listed = await a.ok("channel.list", {"guild_id": gid})
    assert listed["voice_states"] == [st]
    # One voice channel at a time.
    await b.ok("voice.join", {"channel_id": vc2["channel_id"]})
    ev = [e["payload"]["channel_id"] for e in await a.drain() if e["type"] == "voice.state_updated"]
    assert ev == [None, vc2["channel_id"]]
    st = (await b.ok("voice.state.set", {"self_mute": True}))["voice_state"]
    assert st["self_mute"] is True
    # Disconnecting leaves the channel.
    await b.ws.close()
    ev = [e["payload"] for e in await a.drain(0.3) if e["type"] == "voice.state_updated"]
    assert ev[-1]["channel_id"] is None
    # Turning voice off drops everyone and hides voice channels.
    await a.ok("voice.join", {"channel_id": vc["channel_id"]})
    await owner.ok("server.config.update", VOICE_OFF)
    assert all(c["kind"] != "voice" for c in (await a.ok("channel.list", {"guild_id": gid}))["channels"])
    assert await a.err("voice.join", {"channel_id": vc["channel_id"]}) == "voice_disabled"
    assert (await a.ok("channel.list", {"guild_id": gid}))["voice_states"] == []


async def test_voice_needs_connect(owner, guild):
    gid, cid, (a, b) = await guild("alice", "bob")
    await owner.ok("server.config.update", {"voice_enabled": True})
    vc = (await a.ok("channel.create", {"guild_id": gid, "name": "Stage", "kind": "voice"}))["channel"]
    await a.ok("role.update", {"role_id": gid, "permissions": 229903 & ~(1 << 16)})
    assert await b.err("voice.join", {"channel_id": vc["channel_id"]}) == "forbidden"
