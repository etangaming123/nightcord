"""Customisation perks: config, allow-list and feature gates (PROTOCOL.md §8d)."""

from conftest import types
from images import gif, media_id, png


async def _set(owner, **cfg):
    return (await owner.ok("server.config.update", cfg))["config"]


async def test_config_validation_and_partial_features(owner):
    cfg = await _set(owner, customization_mode="allowlist")
    assert cfg["customization_mode"] == "allowlist" and all(cfg["customization_features"].values())
    cfg = await _set(owner, customization_features={"gradient_roles": False})
    assert cfg["customization_features"]["gradient_roles"] is False
    assert cfg["customization_features"]["profile_banner"] is True
    assert await owner.err("server.config.update", {"customization_mode": "maybe"}) == "bad_request"
    assert await owner.err("server.config.update", {"customization_features": {"sparkles": True}}) == "bad_request"
    assert await owner.err("server.config.update", {"customization_features": {"guild_banner": 1}}) == "bad_request"
    info = await owner.ok("server.info")
    assert info["customization_mode"] == "allowlist"


async def test_profile_perks_by_mode(server, owner, user):
    a = await user("alice")
    banner = await media_id(server, a, "banner", png(600, 240))
    me = (await a.ok("user.update", {"banner_media_id": banner, "profile_colors": ["#112233", "#AABBCC"]}))["user"]
    assert me["banner_id"] == banner and me["profile_colors"] == ["#112233", "#aabbcc"]
    await _set(owner, customization_mode="off")
    assert await a.err("user.update", {"profile_colors": ["#000000", "#ffffff"]}) == "feature_disabled"
    # Clearing always works; the rejected upload can be retried later.
    assert (await a.ok("user.update", {"profile_colors": None}))["user"]["profile_colors"] is None
    other = await media_id(server, a, "banner", png())
    assert await a.err("user.update", {"banner_media_id": other}) == "feature_disabled"
    # Stored cosmetics are kept when the mode changes.
    assert (await a.ok("user.profile", {"user_id": a.uid}))["user"]["banner_id"] == banner
    assert await a.err("user.update", {"profile_colors": ["#000000"]}) == "bad_request"


async def test_allowlist_and_staff(server, owner, user):
    a = await user("alice")
    b = await user("bob")
    await _set(owner, customization_mode="allowlist")
    assert await a.err("user.update", {"profile_colors": ["#000000", "#ffffff"]}) == "feature_disabled"
    res = await owner.ok("admin.users.set_perks", {"user_id": a.uid, "perks": True})
    assert res["user"]["perks"] is True
    assert "user.updated" in types(await a.drain())
    await a.ok("user.update", {"profile_colors": ["#000000", "#ffffff"]})
    # Staff always count as allowed.
    await owner.ok("admin.staff.set", {"user_id": b.uid, "role": "moderator"})
    b2_frames = await b.drain()
    assert any(f["type"] == "user.updated" for f in b2_frames)
    # (bob's connection has the new role once refreshed)
    await b.ok("user.update", {"profile_colors": ["#000000", "#ffffff"]})
    # Only admins can hand out perks, and it's audited.
    assert await b.err("admin.users.set_perks", {"user_id": a.uid, "perks": False}) == "forbidden"
    entries = (await owner.ok("admin.audit_log"))["entries"]
    assert any(e["action"] == "user.perks" for e in entries)
    # A feature switched off applies even to allowed users.
    await _set(owner, customization_features={"profile_colors": False})
    assert await a.err("user.update", {"profile_colors": ["#000000", "#ffffff"]}) == "feature_disabled"


async def test_animated_media_gate(server, owner, user):
    a = await user("alice")
    await _set(owner, customization_features={"animated_media": False})
    mid = await media_id(server, a, "avatar", gif(animated=True))
    assert await a.err("user.avatar.set", {"media_id": mid}) == "feature_disabled"
    still = await media_id(server, a, "avatar", gif())
    assert (await a.ok("user.avatar.set", {"media_id": still}))["user"]["avatar_id"] == still


async def test_guild_features_follow_the_guild_owner(server, owner, guild):
    gid, cid, (a, b) = await guild("alice", "bob")
    role = (await a.ok("role.create", {"guild_id": gid, "name": "Admins", "permissions": 256 | 128}))["role"]
    await a.ok("member.roles.set", {"guild_id": gid, "user_id": b.uid, "role_ids": [role["role_id"]]})
    await _set(owner, customization_mode="allowlist")
    await owner.ok("admin.users.set_perks", {"user_id": b.uid, "perks": True})
    # bob has perks, but alice (the owner) doesn't: guild perks are off.
    banner = await media_id(server, b, "guild_banner", png(960, 540))
    assert await b.err("guild.config.update", {"guild_id": gid, "banner_media_id": banner}) == "feature_disabled"
    target = (await b.ok("role.create", {"guild_id": gid, "name": "Fancy"}))["role"]
    assert await b.err("role.update", {"role_id": target["role_id"], "colors": ["#ff0000", "#0000ff"]}) == "feature_disabled"
    assert await b.err("role.update", {"role_id": target["role_id"], "icon_emoji": "🥞"}) == "feature_disabled"
    await owner.ok("admin.users.set_perks", {"user_id": a.uid, "perks": True})
    guild_ = (await b.ok("guild.config.update", {"guild_id": gid, "banner_media_id": await media_id(server, b, "guild_banner", png())}))["guild"]
    assert guild_["banner_id"]
    fancy = (await b.ok("role.update", {"role_id": target["role_id"], "colors": ["#ff0000", "#00ff00", "#0000ff"]}))["role"]
    assert fancy["colors"] == ["#ff0000", "#00ff00", "#0000ff"] and fancy["color"] == "#ff0000"
    icon = await media_id(server, b, "role_icon", png())
    fancy = (await b.ok("role.update", {"role_id": target["role_id"], "icon_media_id": icon}))["role"]
    assert fancy["icon_id"] == icon and fancy["icon_emoji"] is None
    fancy = (await b.ok("role.update", {"role_id": target["role_id"], "icon_emoji": "🥞"}))["role"]
    assert fancy["icon_id"] is None and fancy["icon_emoji"] == "🥞"
    # A plain color removes the gradient.
    fancy = (await b.ok("role.update", {"role_id": target["role_id"], "color": "#123456"}))["role"]
    assert fancy["colors"] is None and fancy["color"] == "#123456"
    assert await a.err("role.update", {"role_id": gid, "icon_emoji": "🥞"}) == "bad_request"  # @everyone
    # The invite preview hides the banner once the owner loses perks.
    code = (await a.ok("guild.invite.create", {"guild_id": gid}))["invite_code"]
    assert (await b.ok("guild.invite.resolve", {"invite_code": code}))["guild"]["banner_id"]
    await owner.ok("admin.users.set_perks", {"user_id": a.uid, "perks": False})
    assert (await b.ok("guild.invite.resolve", {"invite_code": code}))["guild"]["banner_id"] is None


async def test_account_deletion_clears_cosmetics(server, owner, user, ctx):
    from nightcord.handlers import media as M

    a = await user("alice")
    banner = await media_id(server, a, "banner", png())
    await a.ok("user.update", {"banner_media_id": banner, "profile_colors": ["#000000", "#ffffff"]})
    await owner.ok("admin.users.delete", {"user_id": a.uid})
    row = ctx.db.get_user_row(a.uid)
    assert row["banner_id"] is None and row["profile_colors"] is None
    assert not (M.media_dir(ctx) / banner).exists()
