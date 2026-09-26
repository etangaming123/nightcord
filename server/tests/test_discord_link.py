"""Discord link (PROTOCOL.md §5 Discord link), with a pretend bot in place of discord.py."""

import asyncio

import pytest

from nightcord import discord_link as DL
from nightcord.db import Database
from nightcord.discord_link import DiscordImage, DiscordLink, DiscordProfile, LinkError

from conftest import befriend, types
from images import gif, png


class FakeBot:
    def __init__(self):
        self.online = True
        self.name = "nightbot"
        self.install_url = "https://discord.com/oauth2/authorize?client_id=1"
        self.sent: list[tuple[str, list, int]] = []
        self.refuse = False
        self.profile: DiscordProfile | None = None

    async def send_notes(self, discord_id, notes, more):
        self.sent.append((discord_id, notes, more))
        return not self.refuse

    async def fetch_profile(self, discord_id):
        return self.profile

    def notes(self):
        return [n for _, notes, _ in self.sent for n in notes]


@pytest.fixture
def bot(ctx, monkeypatch):
    monkeypatch.setattr(DL, "FLUSH_DELAY", 0.03)
    fake = FakeBot()
    ctx.discord = DiscordLink(ctx, fake)
    return fake


async def settle():
    await asyncio.sleep(0.12)


async def link(ctx, c, discord_id="111", **start):
    code = (await c.ok("discord.link.start", start))["code"]
    await ctx.discord.redeem(code, discord_id, f"d-{c.user['username']}")
    await c.drain()


async def test_unavailable_without_a_bot(owner):
    info = await owner.ok("server.info")
    assert info["discord_link"] is False
    for t in ("discord.get", "discord.link.start", "discord.unlink", "discord.sync", "discord.test"):
        assert await owner.err(t) == "discord_unavailable"


async def test_linking_with_a_code(ctx, bot, user):
    alice = await user("alice")
    assert (await alice.ok("server.info"))["discord_link"] is True
    got = await alice.ok("discord.get")
    assert got["link"] is None and got["bot"] == {"online": True, "name": "nightbot", "install_url": bot.install_url}

    code = (await alice.ok("discord.link.start"))["code"]
    assert len(code) == 9 and code[4] == "-"
    user_ = await ctx.discord.redeem("code:" + code.lower().replace("-", " "), "111", "alice_dc")
    assert user_["user_id"] == alice.uid
    events = await alice.drain()
    assert types(events) == ["discord.link.updated"]
    link_ = events[0]["payload"]["link"]
    assert link_["discord_id"] == "111" and link_["discord_username"] == "alice_dc"
    assert all(link_["notify"].values()) and link_["only_when_away"] and link_["include_content"]
    assert (await alice.ok("discord.get"))["link"]["discord_id"] == "111"
    assert ctx.discord.user_for("111") == alice.uid

    # Codes are single use.
    with pytest.raises(LinkError):
        await ctx.discord.redeem(code, "222", "someone")


async def test_new_code_replaces_the_old_one(ctx, bot, user):
    alice = await user("alice")
    first = (await alice.ok("discord.link.start"))["code"]
    second = (await alice.ok("discord.link.start"))["code"]
    with pytest.raises(LinkError):
        await ctx.discord.redeem(first, "111", "a")
    await ctx.discord.redeem(second, "111", "a")


async def test_wrong_codes_are_rate_limited(ctx, bot, user):
    alice = await user("alice")
    code = (await alice.ok("discord.link.start"))["code"]
    for _ in range(DL.MAX_CODE_FAILURES):
        with pytest.raises(LinkError) as e:
            await ctx.discord.redeem("ZZZZ-ZZZZ", "111", "a")
        assert e.value.code == "not_found"
    with pytest.raises(LinkError) as e:
        await ctx.discord.redeem(code, "111", "a")
    assert e.value.code == "rate_limited"
    await ctx.discord.redeem(code, "222", "b")  # someone else's Discord account isn't held up


async def test_one_discord_account_per_nightcord_account(ctx, bot, user):
    alice, bob = await user("alice"), await user("bob")
    await link(ctx, alice, "111")
    await link(ctx, bob, "111")  # the same Discord account moves to bob
    assert (await alice.drain())[-1]["payload"]["link"] is None
    assert ctx.db.discord_link(alice.uid) is None
    assert ctx.discord.user_for("111") == bob.uid
    await link(ctx, bob, "222")  # and bob can switch Discord accounts
    with pytest.raises(LinkError):
        ctx.discord.user_for("111")


async def test_settings_and_unlink(ctx, bot, user):
    alice = await user("alice")
    assert await alice.err("discord.settings.set", {"only_when_away": False}) == "not_found"
    assert await alice.err("discord.unlink") == "not_found"
    await link(ctx, alice)
    assert await alice.err("discord.settings.set", {}) == "bad_request"
    assert await alice.err("discord.settings.set", {"notify": {"pings": True}}) == "bad_request"
    res = await alice.ok("discord.settings.set", {"notify": {"dms": False}, "include_content": False})
    assert res["link"]["notify"]["dms"] is False and res["link"]["notify"]["mentions"] is True
    assert res["link"]["include_content"] is False
    # Linking the same Discord account again keeps the settings.
    await link(ctx, alice)
    assert ctx.db.discord_link(alice.uid)["notify"]["dms"] is False
    await alice.ok("discord.unlink")
    assert (await alice.ok("discord.get"))["link"] is None


async def test_dm_notifications_while_away(ctx, bot, user):
    alice, bob = await user("alice"), await user("bob")
    await befriend(alice, bob)
    await link(ctx, bob, "222", app_url="https://nc.example/app", server="chat.example:8765")
    ch = (await alice.ok("dm.open", {"user_id": bob.uid}))["channel"]

    await alice.ok("message.send", {"channel_id": ch["channel_id"], "content": "while you're here"})
    await settle()
    assert bot.sent == []  # bob is on Nightcord

    await bob.ok("presence.set", {"afk": True})
    sent = (await alice.ok("message.send", {"channel_id": ch["channel_id"], "content": f"hey <@{bob.uid}>"}))["message"]
    await alice.ok("message.send", {"channel_id": ch["channel_id"], "content": "second"})
    await settle()
    assert len(bot.sent) == 1  # gathered into one DM
    discord_id, notes, more = bot.sent[0]
    assert discord_id == "222" and more == 0
    assert [n.body for n in notes] == ["hey @bob", "second"]
    assert notes[0].kind == "dms" and notes[0].title == "alice"
    assert notes[0].url == f"https://nc.example/app/dms/{ch['channel_id']}/{sent['message_id']}?server=chat.example:8765"

    # Muting the DM stops them.
    await bob.ok("notify.prefs.set", {"target_id": ch["channel_id"], "muted": True})
    await alice.ok("message.send", {"channel_id": ch["channel_id"], "content": "muted"})
    await settle()
    assert len(bot.sent) == 1


async def test_nothing_while_dnd_or_switched_off(ctx, bot, user):
    alice, bob = await user("alice"), await user("bob")
    await befriend(alice, bob)
    await link(ctx, bob)
    await bob.ok("discord.settings.set", {"only_when_away": False})
    ch = (await alice.ok("dm.open", {"user_id": bob.uid}))["channel"]
    await bob.ok("presence.set", {"status": "dnd"})
    await alice.ok("message.send", {"channel_id": ch["channel_id"], "content": "shh"})
    await settle()
    assert bot.sent == []
    await bob.ok("presence.set", {"status": "online"})
    await bob.ok("discord.settings.set", {"notify": {"dms": False}})
    await alice.ok("message.send", {"channel_id": ch["channel_id"], "content": "off"})
    await settle()
    assert bot.sent == []
    await bob.ok("discord.settings.set", {"notify": {"dms": True}, "include_content": False})
    await alice.ok("message.send", {"channel_id": ch["channel_id"], "content": "secret"})
    await settle()
    assert [(n.title, n.body) for n in bot.notes()] == [("alice", None)]


async def test_guild_mentions(ctx, bot, guild):
    gid, cid, (alice, bob, carol) = await guild("alice", "bob", "carol")
    await link(ctx, bob, "222")
    await link(ctx, carol, "333")
    for c in (bob, carol):
        await c.ok("discord.settings.set", {"only_when_away": False})
    await alice.ok("message.send", {"channel_id": cid, "content": "no ping"})
    await alice.ok("message.send", {"channel_id": cid, "content": f"hi <@{bob.uid}> in <#{cid}> <:owl:123>"})
    await settle()
    assert [d for d, _, _ in bot.sent] == ["222"]
    note = bot.sent[0][1][0]
    assert note.kind == "mentions" and note.title == "alice mentioned you in #general"
    assert note.body == "hi @bob in #general :owl:" and note.footer == "G · Test"

    # A reply pings too, and says so.
    bot.sent.clear()
    target = (await bob.ok("message.send", {"channel_id": cid, "content": "mine"}))["message_id"]
    await alice.ok("message.send", {"channel_id": cid, "content": "answer", "reply_to_id": target})
    await settle()
    assert [n.title for n in bot.notes()] == ["alice replied to you in #general"]

    # level "none" silences the guild; blocking the author does too.
    bot.sent.clear()
    await bob.ok("notify.prefs.set", {"target_id": gid, "level": "none"})
    await carol.ok("user.block", {"user_id": alice.uid})
    await alice.ok("message.send", {"channel_id": cid, "content": f"<@{bob.uid}> <@{carol.uid}>"})
    await settle()
    assert bot.sent == []


async def test_requests_and_announcements(ctx, bot, user, owner):
    alice, bob = await user("alice"), await user("bob")
    await link(ctx, bob, "222")
    await bob.ok("discord.settings.set", {"only_when_away": False})
    await alice.ok("friend.request", {"user_id": bob.uid})
    ch = (await alice.ok("dm.open", {"user_id": bob.uid}))["channel"]
    await alice.ok("message.send", {"channel_id": ch["channel_id"], "content": "can we talk"})
    await owner.ok("announcement.create", {"content": "Maintenance tonight"})
    await settle()
    notes = bot.notes()
    assert [(n.kind, n.title) for n in notes] == [
        ("friend_requests", "alice sent you a friend request"),
        ("message_requests", "Message request from alice"),
        ("announcements", "New announcement"),
    ]
    assert notes[1].body == "can we talk" and notes[2].body == "Maintenance tonight"


async def test_offline_bot_sends_nothing(ctx, bot, user):
    alice, bob = await user("alice"), await user("bob")
    await befriend(alice, bob)
    await link(ctx, bob)
    await bob.ok("discord.settings.set", {"only_when_away": False})
    bot.online = False
    ch = (await alice.ok("dm.open", {"user_id": bob.uid}))["channel"]
    await alice.ok("message.send", {"channel_id": ch["channel_id"], "content": "hello?"})
    await settle()
    assert bot.sent == []
    assert await bob.err("discord.sync") == "discord_unavailable"
    assert await bob.err("discord.test") == "discord_unavailable"


async def test_test_notification_and_refused_dms(ctx, bot, user):
    alice = await user("alice")
    assert await alice.err("discord.test") == "not_found"
    await link(ctx, alice)
    assert (await alice.ok("discord.test"))["delivered"] is True
    assert bot.notes()[0].kind == "test"
    assert await alice.err("discord.test") == "rate_limited"
    ctx.discord._cooldowns.clear()
    bot.refuse = True
    assert (await alice.ok("discord.test"))["delivered"] is False
    events = await alice.drain()
    assert events[-1]["payload"]["link"]["dm_refused"] is True


async def test_sync_profile(ctx, bot, user):
    alice = await user("alice")
    await link(ctx, alice)

    async def still(animated):
        return png(128, 128)

    async def anim(animated):
        return gif(128, 128, animated=True) if animated else png(128, 128)

    bot.profile = DiscordProfile(
        username="alice_dc", display_name="Alice ✨", avatar=DiscordImage(True, anim), banner=DiscordImage(False, still),
    )
    res = await alice.ok("discord.sync")
    assert res["synced"] == ["display_name", "avatar", "banner"] and res["skipped"] == {}
    user_ = res["user"]
    assert user_["display_name"] == "Alice ✨"
    assert user_["avatar_id"].startswith("a_") and user_["banner_id"]
    assert ctx.db.discord_link(alice.uid)["discord_username"] == "alice_dc"
    assert "user.updated" in types(await alice.drain())

    # Without animated media the avatar arrives still; without banners the
    # banner is skipped and the rest still happens.
    ctx.discord._cooldowns.clear()
    ctx.db.set_server_config({"customization_features": {
        **ctx.db.get_server_config()["customization_features"], "animated_media": False, "profile_banner": False,
    }})
    res = await alice.ok("discord.sync", {"fields": ["avatar", "banner"]})
    assert res["synced"] == ["avatar"] and "banner" in res["skipped"]
    assert not res["user"]["avatar_id"].startswith("a_")

    # Discord has no avatar: neither does Nightcord afterwards.
    ctx.discord._cooldowns.clear()
    bot.profile.avatar = None
    res = await alice.ok("discord.sync", {"fields": ["avatar"]})
    assert res["user"]["avatar_id"] is None
    assert await alice.err("discord.sync", {"fields": ["bio"]}) == "bad_request"


async def test_deleting_the_account_drops_the_link(ctx, bot, user):
    alice = await user("alice")
    await link(ctx, alice)
    await alice.ok("user.delete", {"password": "password123"})
    assert ctx.db.discord_link(alice.uid) is None
    with pytest.raises(LinkError):
        ctx.discord.user_for("111")


async def test_link_start_checks_its_urls(bot, user):
    alice = await user("alice")
    assert await alice.err("discord.link.start", {"app_url": "javascript:alert(1)"}) == "bad_request"
    assert await alice.err("discord.link.start", {"server": "a b"}) == "bad_request"
    await alice.ok("discord.link.start", {"app_url": "http://localhost:8000/app/", "server": "ws://127.0.0.1:8765"})


def test_v12_database_gets_discord_links(tmp_path):
    path = tmp_path / "v12.db"
    d = Database(path)
    uid = d.create_user("keeper", "x")["user_id"]
    d.conn.execute("DROP TABLE discord_links")
    d.conn.execute("PRAGMA user_version = 12")
    d.close()
    d = Database(path)
    assert d.conn.execute("PRAGMA user_version").fetchone()[0] == 13
    d.set_discord_link(uid, "111", "keeper_dc", app_url=None, server_address=None)
    assert d.discord_link(uid)["discord_id"] == "111"
    d.close()


def test_bot_module():
    discord = pytest.importorskip("discord")
    from nightcord.discord_bot import NightcordBot, note_embed

    embed = note_embed(DL.Note("dms", "alice", body="hi", url="https://x.example/", footer="Test",
                               timestamp="2026-09-26T10:00:00.000Z"))
    assert embed.title == "alice" and embed.description == "hi" and embed.footer.text == "Test"
    assert embed.timestamp.year == 2026

    class Stub:
        def server_name(self):
            return "Test"

    bot = NightcordBot(Stub())
    group = bot.tree.get_command("nightcord")
    assert {c.name for c in group.commands} == {"link", "account", "notifications", "sync", "test", "unlink"}
    assert bot.online is False and bot.install_url is None
    assert isinstance(bot, discord.Client)
