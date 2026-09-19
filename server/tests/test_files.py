"""Attachments: POST /upload, message attachments, GET /files (PROTOCOL.md §2 HTTP)."""

import time

from nightcord import files as F

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


async def _upload(server, c, cid, data, filename="a.png", **query):
    params = {"channel_id": cid, "filename": filename, **query}
    return await server.post(
        "/upload", params=params, data=data, headers={"Authorization": f"Bearer {c.token}"}
    )


async def test_upload_send_and_download(server, guild):
    gid, cid, (a, b) = await guild("alice", "bob")
    r = await _upload(server, a, cid, PNG, width="640", height="480")
    assert r.status == 200
    att = (await r.json())["attachment"]
    assert att["content_type"] == "image/png" and att["size"] == len(PNG) and att["width"] == 640
    res = await a.ok("message.send", {"channel_id": cid, "content": "", "attachment_ids": [att["attachment_id"]]})
    msg = res["message"]
    assert msg["content"] == "" and msg["attachments"][0]["attachment_id"] == att["attachment_id"]
    ev = [e for e in await b.drain() if e["type"] == "message.new"]
    url = ev[0]["payload"]["attachments"][0]["url"]
    got = await server.get(url)
    assert got.status == 200 and await got.read() == PNG
    assert got.headers["Content-Type"] == "image/png"
    assert got.headers["X-Content-Type-Options"] == "nosniff"
    # Range requests work (video seeking).
    part = await server.get(url, headers={"Range": "bytes=0-7"})
    assert part.status == 206 and await part.read() == PNG[:8]
    # An attachment can only be used once.
    assert await a.err("message.send", {"channel_id": cid, "content": "x", "attachment_ids": [att["attachment_id"]]}) == "bad_request"


async def test_signature_checks(server, guild, ctx):
    gid, cid, (a,) = await guild("alice")
    att = (await (await _upload(server, a, cid, PNG)).json())["attachment"]
    await a.ok("message.send", {"channel_id": cid, "content": "", "attachment_ids": [att["attachment_id"]]})
    good = att["url"]
    assert (await server.get(good.replace("sig=", "sig=0"))).status == 403
    secret = ctx.db.file_secret()
    old = int(time.time()) - 10
    stale = f"/files/{att['attachment_id']}/a.png?exp={old}&sig={F.signature(secret, att['attachment_id'], old)}"
    assert (await server.get(stale)).status == 403


async def test_types_and_disposition(server, guild):
    gid, cid, (a,) = await guild("alice")
    cases = [
        (b"<svg xmlns='http://www.w3.org/2000/svg'><script>x</script></svg>", "evil.svg", "application/octet-stream", "attachment"),
        (b"print('hi')\n", "hello.py", "text/plain; charset=utf-8", "inline"),
        (b"PK\x03\x04zipdata", "stuff.zip", "application/octet-stream", "attachment"),
        (b"\x00\x00\x00\x18ftypisom" + b"\x00" * 20, "clip.mp4", "video/mp4", "inline"),
        (b"<html>hi</html>", "page.html", "text/plain; charset=utf-8", "inline"),
    ]
    ids = []
    for data, name, ctype, disp in cases:
        att = (await (await _upload(server, a, cid, data, filename=name)).json())["attachment"]
        ids.append(att["attachment_id"])
        r = await server.get(att["url"])
        assert r.headers["Content-Type"] == ctype, name
        assert r.headers["Content-Disposition"].startswith(disp), name
    await a.ok("message.send", {"channel_id": cid, "content": "files", "attachment_ids": ids[:5]})


async def test_upload_rules(server, guild, ctx):
    gid, cid, (a, b) = await guild("alice", "bob")
    # No token / bad token.
    r = await server.post("/upload", params={"channel_id": cid, "filename": "a.png"}, data=PNG)
    assert r.status == 401
    # Size limit set by the owner.
    ctx.db.set_server_config({"max_upload_bytes": 1024 * 1024})
    r = await _upload(server, a, cid, b"x" * (1024 * 1024 + 1), filename="big.bin")
    assert r.status == 413 and (await r.json())["error"]["code"] == "file_too_large"
    # Needs ATTACH_FILES.
    await a.ok("role.update", {"role_id": gid, "permissions": 229903 & ~(1 << 15)})
    r = await _upload(server, b, cid, PNG)
    assert r.status == 403
    # Other people's uploads can't be attached.
    att = (await (await _upload(server, a, cid, PNG)).json())["attachment"]
    assert await b.err("message.send", {"channel_id": cid, "content": "x", "attachment_ids": [att["attachment_id"]]}) in ("bad_request", "forbidden")
    # Private channel: non-viewers get 404.
    ch = (await a.ok("channel.create", {"guild_id": gid, "name": "secret", "overwrites": [{"role_id": gid, "allow": 0, "deny": 1}]}))["channel"]
    r = await _upload(server, b, ch["channel_id"], PNG)
    assert r.status == 404


async def test_delete_and_sweep(server, guild, ctx):
    from nightcord.handlers.files import files_dir, sweep

    gid, cid, (a,) = await guild("alice")
    att = (await (await _upload(server, a, cid, PNG)).json())["attachment"]
    mid = (await a.ok("message.send", {"channel_id": cid, "content": "", "attachment_ids": [att["attachment_id"]]}))["message_id"]
    assert (files_dir(ctx) / att["attachment_id"]).exists()
    await a.ok("message.delete", {"message_id": mid})
    assert not (files_dir(ctx) / att["attachment_id"]).exists()
    # Unattached uploads older than an hour are swept.
    stale = (await (await _upload(server, a, cid, PNG)).json())["attachment"]
    ctx.db.conn.execute("UPDATE attachments SET created_at = '2000-01-01T00:00:00.000Z'")
    assert sweep(ctx) == 1
    assert not (files_dir(ctx) / stale["attachment_id"]).exists()


async def test_dm_upload(server, user):
    a, b = await user("alice"), await user("bob")
    dm = (await a.ok("dm.open", {"user_id": b.uid}))["channel"]["channel_id"]
    r = await _upload(server, a, dm, PNG)
    assert r.status == 200


async def test_cors_preflight(server):
    r = await server.options("/upload", headers={"Origin": "http://localhost:8000", "Access-Control-Request-Method": "POST"})
    assert r.status == 204 and r.headers["Access-Control-Allow-Origin"] == "http://localhost:8000"
    r = await server.options("/upload", headers={"Origin": "https://evil.example"})
    assert "Access-Control-Allow-Origin" not in r.headers
