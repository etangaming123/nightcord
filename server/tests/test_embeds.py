"""Link previews: PROTOCOL.md §4 Embed, §2 HTTP /proxy.

The fetcher is deliberately hostile to its own input, so most of this file is
about what it *refuses*. A local aiohttp site stands in for the internet; the
SSRF guard is opened for that one host only, exactly the way it isn't in
production.
"""

from __future__ import annotations

import asyncio
import base64
import time

import pytest
from aiohttp import web

from nightcord import embeds as E
from nightcord import protocol as P
from nightcord.handlers import proxy as PX

PAGE = """<!doctype html><html><head>
<title>Fallback title</title>
<meta name="description" content="Fallback description">
<meta property="og:title" content="Open Graph title">
<meta property="og:description" content="  Open   Graph   description  ">
<meta property="og:site_name" content="Example Site">
<meta property="og:image" content="/pic.png">
<meta name="theme-color" content="#abc">
</head><body><p>ignored</p><title>late</title></body></html>"""

LARGE_PAGE = """<html><head>
<meta property="og:title" content="Big picture">
<meta property="og:image" content="/pic.png">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="alternate" type="application/json+oembed" href="/oembed.json">
</head></html>"""

OEMBED = {"author_name": "💬 12 🔁 3 ❤️ 45", "author_url": "https://x.com/someone/status/1",
          "provider_name": "FixupX", "provider_url": "https://github.com/FxEmbed/FxEmbed", "title": "Embed"}

TWEET_PAGE = """<html><head>
<meta property="og:title" content="someone (@someone)">
<meta property="og:description" content="line one
line two">
<meta property="og:site_name" content="FixupX">
<meta property="og:image" content="/pic.png">
<meta property="twitter:card" content="summary">
<link rel="alternate" type="application/json+oembed" href="/oembed.json">
</head></html>"""

LATIN1_PAGE = "<html><head><meta property='og:title' content='Caf\u00e9'></head></html>".encode("latin-1")

PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000a49444154789c6300010000050001" "0d0a2db4" "0000000049454e44ae426082"
)


@pytest.fixture
async def site(aiohttp_server):
    """A tiny site the fetcher is allowed to reach, on 127.0.0.1."""
    hits = {"page": 0, "pic": 0}

    async def page(request):
        hits["page"] += 1
        return web.Response(text=PAGE, content_type="text/html")

    async def pic(request):
        hits["pic"] += 1
        return web.Response(body=PNG, content_type="image/png")

    async def large(request):
        hits["large"] = hits.get("large", 0) + 1
        return web.Response(text=LARGE_PAGE, content_type="text/html")

    async def oembed(request):
        return web.json_response(OEMBED)

    async def tweet(request):
        hits["tweet"] = request.path
        return web.Response(text=TWEET_PAGE, content_type="text/html")

    async def youtube(request):
        hits["youtube"] = request.query.get("url")
        return web.json_response({"title": "Never Gonna Give You Up", "author_name": "Rick Astley",
                                  "author_url": "https://www.youtube.com/@RickAstleyYT"})

    async def latin1(request):
        return web.Response(body=LATIN1_PAGE, headers={"Content-Type": "text/html; charset=iso-8859-1"})

    async def clip(request):
        return web.Response(body=b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64, content_type="video/mp4")

    async def huge_clip(request):
        return web.Response(body=b"\x00" * (P.EMBED_VIDEO_MAX_BYTES + 1), content_type="video/mp4")

    async def empty(request):
        hits["empty"] = hits.get("empty", 0) + 1
        return web.Response(text="<html><head></head><body>nothing</body></html>", content_type="text/html")

    async def huge(request):
        return web.Response(body=b"x" * (2 * 1024 * 1024), content_type="text/html")

    async def plain(request):
        return web.Response(text="just text", content_type="text/plain")

    async def to_private(request):
        raise web.HTTPFound("http://169.254.169.254/latest/meta-data/")

    async def to_page(request):
        raise web.HTTPFound("/page")

    app = web.Application()
    app.router.add_get("/page", page)
    app.router.add_get("/pic.png", pic)
    app.router.add_get("/huge", huge)
    app.router.add_get("/plain", plain)
    app.router.add_get("/to-private", to_private)
    app.router.add_get("/to-page", to_page)
    app.router.add_get("/large", large)
    app.router.add_get("/oembed.json", oembed)
    app.router.add_get("/someone/status/1", tweet)
    app.router.add_get("/yt-oembed", youtube)
    app.router.add_get("/latin1", latin1)
    app.router.add_get("/clip.mp4", clip)
    app.router.add_get("/huge.mp4", huge_clip)
    app.router.add_get("/empty", empty)
    server = await aiohttp_server(app)
    E.allow_private_host("127.0.0.1")
    E.cache_clear()
    fx_base, yt = E.FX_BASE, E.YOUTUBE_OEMBED
    E.FX_BASE = f"http://127.0.0.1:{server.port}"
    E.YOUTUBE_OEMBED = f"http://127.0.0.1:{server.port}/yt-oembed?url="
    try:
        yield server, hits
    finally:
        E.FX_BASE, E.YOUTUBE_OEMBED = fx_base, yt
        E.allow_private_host(None)
        E.cache_clear()


@pytest.fixture
async def http():
    session = E.make_session()
    try:
        yield session
    finally:
        await session.close()


def url_for(server, path):
    return f"http://127.0.0.1:{server.port}{path}"


# --- extraction ---------------------------------------------------------------


def test_extract_skips_code_spoilers_and_quiet_links():
    content = (
        "one https://a.example/x\n"
        "```\nhttps://code.example\n```\n"
        "`https://inline.example`\n"
        "||https://spoiler.example||\n"
        "<https://quiet.example>\n"
        "[masked](https://masked.example)\n"
        "[quiet](<https://quietmask.example>)"
    )
    assert E.extract_urls(content) == ["https://a.example/x", "https://masked.example"]


def test_extract_caps_at_five_and_dedupes():
    content = " ".join(f"https://s{i}.example" for i in range(9))
    assert len(E.extract_urls(content)) == 5
    assert E.extract_urls("https://a.example https://a.example") == ["https://a.example"]


def test_extract_trims_trailing_punctuation_like_the_client():
    assert E.extract_urls("see https://a.example/p.") == ["https://a.example/p"]
    assert E.extract_urls("(https://a.example/p)") == ["https://a.example/p"]
    assert E.extract_urls("https://en.wikipedia.org/wiki/A_(b)") == ["https://en.wikipedia.org/wiki/A_(b)"]


def test_extract_refuses_non_http_schemes():
    assert E.extract_urls("ftp://a.example file:///etc/passwd javascript:alert(1)") == []


# --- the guard ----------------------------------------------------------------


@pytest.mark.parametrize("url", [
    "http://127.0.0.1/x", "http://10.0.0.1/x", "http://192.168.1.1/x", "http://169.254.169.254/x",
    "http://[::1]/x", "file:///etc/passwd", "gopher://a.example/",
])
def test_check_url_refuses_private_and_odd_schemes(url):
    with pytest.raises(E.UnsafeUrl):
        E.check_url(url)


def test_check_url_allows_a_public_address():
    assert E.check_url("https://example.com/a")[1] == "example.com"


async def test_private_address_is_refused_without_the_test_hook(http):
    E.allow_private_host(None)
    assert await E.build_embed(http, "http://127.0.0.1:1/page") == {}


async def test_redirect_to_a_private_address_is_refused(site, http):
    server, _ = site
    assert await E.build_embed(http, url_for(server, "/to-private")) == {}


async def test_redirects_are_followed_within_the_limit(site, http):
    server, _ = site
    embed = await E.build_embed(http, url_for(server, "/to-page"))
    assert embed["title"] == "Open Graph title"


async def test_oversized_page_is_refused(site, http):
    server, _ = site
    assert await E.build_embed(http, url_for(server, "/huge")) == {}


async def test_non_html_is_ignored(site, http):
    server, _ = site
    assert await E.build_embed(http, url_for(server, "/plain")) == {}


# --- meta parsing --------------------------------------------------------------


async def test_meta_parsing(site, http):
    server, _ = site
    embed = await E.build_embed(http, url_for(server, "/page"))
    assert embed["kind"] == "link"
    assert embed["title"] == "Open Graph title"
    assert embed["description"] == "Open Graph description"  # whitespace collapsed
    assert embed["site_name"] == "Example Site"
    assert embed["color"] == "#aabbcc"  # #abc expanded
    # No large-image card: the page's image is a thumbnail, as on Discord.
    assert embed["thumbnail"] == url_for(server, "/pic.png") and embed["image"] is None  # made absolute


async def test_large_image_cards_and_oembed(site, http):
    server, _ = site
    embed = await E.build_embed(http, url_for(server, "/large"))
    assert embed["image"] == url_for(server, "/pic.png") and embed["thumbnail"] is None
    assert (embed["image_width"], embed["image_height"]) == (1200, 630)
    # oEmbed fills the author and provider lines; its title doesn't replace the page's.
    assert embed["author"] == OEMBED["author_name"] and embed["author_url"] == OEMBED["author_url"]
    assert embed["site_name"] == "FixupX" and embed["provider_url"] == OEMBED["provider_url"]
    assert embed["title"] == "Big picture"


async def test_twitter_links_are_read_through_fixupx(site, http):
    server, hits = site
    embed = await E.build_embed(http, "https://x.com/someone/status/1?s=20")
    assert hits["tweet"] == "/someone/status/1"
    assert embed["url"] == "https://x.com/someone/status/1?s=20"  # the link as posted
    assert embed["description"] == "line one\nline two"  # line breaks kept
    assert embed["author"] == OEMBED["author_name"]
    # With fx_links off it's fetched from x.com itself (not reachable here).
    assert E.fx_url("https://twitter.com/a/status/5") and not E.fx_url("https://x.com/home")


def test_gif_sites_become_gifv_and_videos_are_found():
    page = b"""<html><head><meta property="og:image" content="https://media.tenor.com/a.gif">
    <meta name="twitter:player:stream" content="https://media.tenor.com/a.mp4">
    <meta name="twitter:player:stream:content_type" content="video/mp4">
    <meta name="twitter:player:width" content="498"><meta name="twitter:player:height" content="476"></head></html>"""
    embed = E.parse_meta(page, "https://tenor.com/view/cat-123")
    assert embed["kind"] == "gifv" and embed["video"] == "https://media.tenor.com/a.mp4"
    assert (embed["video_width"], embed["video_height"]) == (498, 476)
    assert embed["image"] == "https://media.tenor.com/a.gif"
    other = E.parse_meta(page.replace(b"tenor", b"example"), "https://example.com/clip")
    assert other["kind"] == "video"


async def test_page_charset_is_honoured(site, http):
    server, _ = site
    assert (await E.build_embed(http, url_for(server, "/latin1")))["title"] == "Caf\u00e9"


async def test_direct_video_link_becomes_a_video(site, http):
    server, _ = site
    embed = await E.build_embed(http, url_for(server, "/clip.mp4"))
    assert embed["kind"] == "video" and embed["video"] == url_for(server, "/clip.mp4")


def test_meta_falls_back_to_title_and_description():
    body = b"<html><head><title>Just a title</title></head><body></body></html>"
    embed = E.parse_meta(body, "https://a.example/p")
    assert embed["title"] == "Just a title" and embed["site_name"] == "a.example"


def test_meta_with_nothing_worth_showing_is_empty():
    assert E.parse_meta(b"<html><head></head><body>hi</body></html>", "https://a.example") == {}


async def test_direct_image_url_becomes_an_image_embed(site, http):
    server, _ = site
    embed = await E.build_embed(http, url_for(server, "/pic.png"))
    assert embed["kind"] == "image" and embed["image"] == url_for(server, "/pic.png")
    assert (embed["image_width"], embed["image_height"]) == (1, 1)  # read from the image header


async def test_pages_are_cached(site, http):
    server, hits = site
    await E.build_embed(http, url_for(server, "/page"))
    await E.build_embed(http, url_for(server, "/page"))
    assert hits["page"] == 1


async def test_cache_survives_a_restart_via_the_database(site, http, db):
    server, hits = site
    await E.build_embed(http, url_for(server, "/large"), db=db)
    E.cache_clear()  # as if the server restarted
    embed = await E.build_embed(http, url_for(server, "/large"), db=db)
    assert hits["large"] == 1 and embed["title"] == "Big picture"
    assert db.embed_cache_get(url_for(server, "/large"))[0]["title"] == "Big picture"


async def test_nothing_to_show_is_only_remembered_briefly(site, http, db):
    server, hits = site
    assert await E.build_embed(http, url_for(server, "/empty"), db=db) == {}
    data, expires = db.embed_cache_get(url_for(server, "/empty"))
    assert data == {} and expires <= time.time() + P.EMBED_FAIL_CACHE_SECONDS + 1
    assert hits["empty"] == 1


def test_cache_prune_drops_expired_and_extra_rows(db):
    now = int(time.time())
    db.embed_cache_put("https://old.example", {}, now - 5)
    for i in range(5):
        db.embed_cache_put(f"https://n{i}.example", {"kind": "link"}, now + 100)
    assert db.embed_cache_prune(max_rows=3) == 3
    assert db.embed_cache_get("https://old.example") is None


def test_youtube_links_become_video_cards():
    assert E.youtube_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ") == "dQw4w9WgXcQ"
    assert E.youtube_id("https://youtu.be/dQw4w9WgXcQ") == "dQw4w9WgXcQ"
    assert E.youtube_id("https://www.youtube.com/shorts/dQw4w9WgXcQ") == "dQw4w9WgXcQ"
    assert E.youtube_id("https://www.youtube.com/watch?v=short") is None
    assert E.youtube_id("https://notyoutube.example/watch?v=dQw4w9WgXcQ") is None


async def test_youtube_card_gets_its_title_from_oembed(site, http):
    _, hits = site
    embed = await E.build_embed(http, "https://youtu.be/dQw4w9WgXcQ")
    assert hits["youtube"] == "https://youtu.be/dQw4w9WgXcQ"
    assert embed["kind"] == "video" and embed["site_name"] == "YouTube" and embed["youtube_id"] == "dQw4w9WgXcQ"
    assert embed["title"] == "Never Gonna Give You Up" and embed["author"] == "Rick Astley"
    assert embed["image"] == "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"
    assert embed["video"] is None  # played from YouTube by the client, on click only


# --- the proxy route -----------------------------------------------------------


def test_proxy_url_is_signed(db):
    secret = db.file_secret()
    url = PX.proxy_url(secret, "https://a.example/pic.png")
    assert url.startswith("/proxy/")
    _, _, sig, token = url.split("/", 3)
    assert PX.signature(secret, token) == sig
    assert base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)).decode() == "https://a.example/pic.png"


def test_proxy_embed_rewrites_only_media_fields(db):
    embed = {"kind": "link", "url": "https://a.example", "image": "https://a.example/i.png", "thumbnail": None,
             "video": "https://a.example/v.mp4", "author_url": "https://a.example/me"}
    out = PX.proxy_embed(db.file_secret(), embed)
    assert out["url"] == "https://a.example" and out["author_url"] == "https://a.example/me"  # links stay
    assert out["image"].startswith("/proxy/") and out["video"].startswith("/proxy/") and out["thumbnail"] is None


async def test_proxy_serves_videos_up_to_the_cap(server, ctx, site):
    remote, _ = site
    ctx.http = E.make_session()
    try:
        ok = await server.get(PX.proxy_url(ctx.db.file_secret(), url_for(remote, "/clip.mp4")))
        assert ok.status == 200 and ok.headers["Content-Type"] == "video/mp4"
        big = await server.get(PX.proxy_url(ctx.db.file_secret(), url_for(remote, "/huge.mp4")))
        assert big.status == 404
    finally:
        await ctx.http.close()
        ctx.http = None


async def test_proxy_serves_a_signed_image(server, ctx, site):
    remote, _ = site
    ctx.http = E.make_session()
    try:
        path = PX.proxy_url(ctx.db.file_secret(), url_for(remote, "/pic.png"))
        res = await server.get(path)
        assert res.status == 200
        assert res.headers["Content-Type"] == "image/png"
        assert res.headers["Cross-Origin-Resource-Policy"] == "cross-origin"
        assert res.headers["X-Content-Type-Options"] == "nosniff"
        assert await res.read() == PNG
    finally:
        await ctx.http.close()
        ctx.http = None


async def test_proxy_refuses_a_bad_signature(server, ctx, site):
    remote, _ = site
    path = PX.proxy_url(ctx.db.file_secret(), url_for(remote, "/pic.png"))
    _, _, _sig, token = path.split("/", 3)
    assert (await server.get(f"/proxy/{'0' * 32}/{token}")).status == 404


async def test_proxy_refuses_a_private_target(server, ctx):
    ctx.http = E.make_session()
    try:
        path = PX.proxy_url(ctx.db.file_secret(), "http://169.254.169.254/latest/meta-data/")
        assert (await server.get(path)).status == 404
    finally:
        await ctx.http.close()
        ctx.http = None


# --- end to end through message.send -------------------------------------------


async def test_message_gets_an_embed(guild, ctx, site):
    remote, _ = site
    gid, cid, (alice,) = await guild("alice")
    ctx.http = E.make_session()
    try:
        res = await alice.ok("message.send", {"channel_id": cid, "content": url_for(remote, "/page")})
        assert res["message"]["embeds"] == []  # not yet: the fetch runs after the send
        for _ in range(50):
            await asyncio.sleep(0.05)
            stored = ctx.db.get_message(int(res["message_id"]))
            if stored["embeds"]:
                break
        assert stored["embeds"][0]["title"] == "Open Graph title"
        assert stored["embeds"][0]["thumbnail"].startswith("/proxy/")
        assert stored["edited_at"] is None  # a preview is not an edit
        events = [e for e in await alice.drain(0.3) if e["type"] == "message.updated"]
        assert events and events[-1]["payload"]["embeds"][0]["site_name"] == "Example Site"
    finally:
        await ctx.http.close()
        ctx.http = None


async def test_quiet_link_gets_no_embed(guild, ctx, site):
    remote, _ = site
    gid, cid, (alice,) = await guild("alice")
    ctx.http = E.make_session()
    try:
        res = await alice.ok("message.send", {"channel_id": cid, "content": f"<{url_for(remote, '/page')}>"})
        await asyncio.sleep(0.4)
        assert ctx.db.get_message(int(res["message_id"]))["embeds"] == []
    finally:
        await ctx.http.close()
        ctx.http = None


async def test_link_embeds_off_means_no_fetch(guild, ctx, site):
    remote, hits = site
    gid, cid, (alice,) = await guild("alice")
    ctx.db.set_server_config({"link_embeds": False})
    ctx.http = E.make_session()
    try:
        res = await alice.ok("message.send", {"channel_id": cid, "content": url_for(remote, "/page")})
        await asyncio.sleep(0.4)
        assert ctx.db.get_message(int(res["message_id"]))["embeds"] == []
        assert hits["page"] == 0
    finally:
        await ctx.http.close()
        ctx.http = None


async def test_suppress_hides_and_restores(guild, ctx, site):
    remote, _ = site
    gid, cid, (alice, bob) = await guild("alice", "bob")
    ctx.http = E.make_session()
    try:
        res = await alice.ok("message.send", {"channel_id": cid, "content": url_for(remote, "/page")})
        mid = res["message_id"]
        for _ in range(50):
            await asyncio.sleep(0.05)
            if ctx.db.get_message(int(mid))["embeds"]:
                break
        await bob.drain(0.2)
        out = await alice.ok("message.embeds.suppress", {"message_id": mid})
        assert out["message"]["embeds"] == [] and out["message"]["embeds_suppressed"] is True
        assert any(e["type"] == "message.updated" for e in await bob.drain(0.3))
        # Somebody else's message isn't theirs to hide.
        assert await bob.err("message.embeds.suppress", {"message_id": mid}) == "forbidden"
        back = await alice.ok("message.embeds.suppress", {"message_id": mid, "suppressed": False})
        assert back["message"]["embeds_suppressed"] is False
    finally:
        await ctx.http.close()
        ctx.http = None
