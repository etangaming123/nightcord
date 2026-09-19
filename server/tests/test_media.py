"""POST /media and GET /media/{id} (PROTOCOL.md §2 HTTP, §4 Media)."""

from nightcord import files as F
from nightcord.handlers import media as M

from images import gif, jpeg, media_id, png, upload, webp


def test_image_info():
    assert F.image_info(png(10, 20)) == (10, 20, False)
    assert F.image_info(png(10, 20, animated=True)) == (10, 20, True)
    assert F.image_info(gif(30, 40)) == (30, 40, False)
    assert F.image_info(gif(30, 40, animated=True)) == (30, 40, True)
    assert F.image_info(webp(50, 60)) == (50, 60, False)
    assert F.image_info(webp(50, 60, animated=True)) == (50, 60, True)
    assert F.image_info(jpeg(70, 80)) == (70, 80, False)
    assert F.image_info(b"<svg/>") is None
    assert F.image_info(b"\x89PNG\r\n\x1a\n") is None


async def test_upload_and_serve(server, user):
    a = await user("alice")
    r = await upload(server, a, "emoji", gif(64, 64, animated=True))
    assert r.status == 200
    media = (await r.json())["media"]
    assert media["content_type"] == "image/gif" and media["animated"] and media["width"] == 64
    got = await server.get(f"/media/{media['media_id']}")
    assert got.status == 200 and got.headers["Content-Type"] == "image/gif"
    assert "immutable" in got.headers["Cache-Control"] and got.headers["X-Content-Type-Options"] == "nosniff"
    assert (await server.get("/media/123")).status == 404
    assert (await server.get("/media/../x")).status == 404


async def test_upload_rules(server, user):
    a = await user("alice")
    assert (await server.post("/media", params={"kind": "emoji"}, data=png())).status == 401
    assert (await upload(server, a, "nope", png())).status == 400
    for bad in (b"<svg xmlns='http://www.w3.org/2000/svg'/>", b"<html></html>", b"\x00" * 100):
        r = await upload(server, a, "avatar", bad)
        assert r.status == 415 and (await r.json())["error"]["code"] == "media_invalid"
    r = await upload(server, a, "emoji", png(300, 300))
    assert r.status == 400 and (await r.json())["error"]["code"] == "media_invalid"
    assert (await upload(server, a, "sticker", png(320, 320))).status == 200
    r = await upload(server, a, "emoji", png() + b"\0" * (256 * 1024))
    assert r.status == 413 and (await r.json())["error"]["code"] == "file_too_large"


async def test_claims_are_single_use_and_kind_bound(server, user):
    a = await user("alice")
    b = await user("bob")
    mid = await media_id(server, a, "avatar", png())
    assert await b.err("user.avatar.set", {"media_id": mid}) == "media_invalid"  # not bob's
    banner = await media_id(server, a, "banner", png())
    assert await a.err("user.avatar.set", {"media_id": banner}) == "media_invalid"  # wrong kind
    me = (await a.ok("user.avatar.set", {"media_id": mid}))["user"]
    assert me["avatar_id"] == mid
    assert await a.err("user.avatar.set", {"media_id": mid}) == "media_invalid"  # used


async def test_animated_avatar_reference_and_replacement(server, user, ctx):
    a = await user("alice")
    mid = await media_id(server, a, "avatar", webp(animated=True))
    me = (await a.ok("user.avatar.set", {"media_id": mid}))["user"]
    assert me["avatar_id"] == f"a_{mid}"
    path = M.media_dir(ctx) / mid
    assert path.is_file()
    await a.ok("user.avatar.set", {"data_b64": None})
    assert not path.is_file() and ctx.db.media_row(mid) is None
    assert (await server.get(f"/media/{mid}")).status == 404


async def test_sweep_removes_unclaimed(server, user, ctx):
    a = await user("alice")
    used = await media_id(server, a, "avatar", png())
    await a.ok("user.avatar.set", {"media_id": used})
    unused = await media_id(server, a, "avatar", png())
    ctx.db._exec("UPDATE media SET created_at = '2000-01-01T00:00:00.000Z'")
    assert M.sweep(ctx) == 1
    assert (M.media_dir(ctx) / used).is_file() and not (M.media_dir(ctx) / unused).is_file()


async def test_pending_upload_limit(server, user):
    a = await user("alice")
    for _ in range(M.MAX_PENDING_MEDIA):
        assert (await upload(server, a, "emoji", png())).status == 200
    r = await upload(server, a, "emoji", png())
    assert r.status == 429
