"""Server description (PROTOCOL.md §4 Server config): set by the owner,
broadcast like any other setting, shown on the landing page."""

from nightcord import protocol as P


async def test_description_set_and_broadcast(owner, user):
    alice = await user("alice")
    assert (await alice.ok("server.info"))["server_description"] == ""
    assert await alice.err("server.config.update", {"server_description": "hi"}) == "forbidden"
    assert await owner.err("server.config.update", {"server_description": 5}) == "bad_request"
    too_long = "x" * (P.SERVER_DESCRIPTION_MAX + 1)
    assert await owner.err("server.config.update", {"server_description": too_long}) == "bad_request"
    res = await owner.ok("server.config.update", {"server_description": "  Night owls only.\n\nBe nice.  "})
    assert res["config"]["server_description"] == "Night owls only.\n\nBe nice."
    ev = [e for e in await alice.drain() if e["type"] == "server.config.updated"]
    assert ev[-1]["payload"]["server_description"] == "Night owls only.\n\nBe nice."
    assert (await alice.ok("server.info"))["server_description"] == "Night owls only.\n\nBe nice."


async def test_landing_page_shows_description(server, owner):
    page = await (await server.get("/")).text()
    assert "now trusts its certificate" in page
    await owner.ok("server.config.update", {
        "server_description": "<b>Welcome</b> to **the den**\nsee https://example.com/rules.",
    })
    page = await (await server.get("/")).text()
    assert "now trusts its certificate" not in page
    assert "&lt;b&gt;Welcome&lt;/b&gt;" in page and "<b>Welcome" not in page
    assert "<strong>the den</strong><br>" in page
    assert '<a href="https://example.com/rules" rel="noopener noreferrer">https://example.com/rules</a>.' in page
