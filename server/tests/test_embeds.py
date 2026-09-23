"""Link previews: PROTOCOL.md §4 Embed, §2 HTTP /proxy.

The fetcher is deliberately hostile to its own input, so most of this file is
about what it *refuses*. A local aiohttp site stands in for the internet; the
SSRF guard is opened for that one host only, exactly the way it isn't in
production.
"""

from __future__ import annotations

import asyncio
import base64

import pytest
from aiohttp import web

from nightcord import embeds as E
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
    server = await aiohttp_server(app)
    E.allow_private_host("127.0.0.1")
    E.cache_clear()
    try:
        yield server, hits
    finally:
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
    assert embed["image"] == url_for(server, "/pic.png")  # made absolute


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


async def test_pages_are_cached_for_an_hour(site, http):
    server, hits = site
    await E.build_embed(http, url_for(server, "/page"))
    await E.build_embed(http, url_for(server, "/page"))
    assert hits["page"] == 1


def test_youtube_links_become_video_cards():
    assert E.youtube_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ") == "dQw4w9WgXcQ"
    assert E.youtube_id("https://youtu.be/dQw4w9WgXcQ") == "dQw4w9WgXcQ"
    assert E.youtube_id("https://www.youtube.com/shorts/dQw4w9WgXcQ") == "dQw4w9WgXcQ"
    assert E.youtube_id("https://www.youtube.com/watch?v=short") is None
    assert E.youtube_id("https://notyoutube.example/watch?v=dQw4w9WgXcQ") is None


async def test_youtube_card_is_built_without_fetching(http):
    embed = await E.build_embed(http, "https://youtu.be/dQw4w9WgXcQ")
    assert embed["kind"] == "video" and embed["site_name"] == "YouTube"
    assert embed["image"] == "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"


# --- the proxy route -----------------------------------------------------------


def test_proxy_url_is_signed(db):
    secret = db.file_secret()
    url = PX.proxy_url(secret, "https://a.example/pic.png")
    assert url.startswith("/proxy/")
    _, _, sig, token = url.split("/", 3)
    assert PX.signature(secret, token) == sig
    assert base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)).decode() == "https://a.example/pic.png"


def test_proxy_embed_rewrites_only_image_fields(db):
    embed = {"kind": "link", "url": "https://a.example", "image": "https://a.example/i.png", "thumbnail": None}
    out = PX.proxy_embed(db.file_secret(), embed)
    assert out["url"] == "https://a.example"  # the link itself stays
    assert out["image"].startswith("/proxy/") and out["thumbnail"] is None


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
        assert stored["embeds"][0]["image"].startswith("/proxy/")
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
