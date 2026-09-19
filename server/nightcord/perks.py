"""Customisation entitlement (PROTOCOL.md §8d).

The server owner sets `customization_mode` (off | allowlist | on) and turns
each feature in `customization_features` on or off. In allowlist mode a
user may customise when an admin gave them perks (users.perks) or when they
are server staff. Guild features (banner, gradient roles, role icons) follow
the guild owner, like a boosted server.
"""

from __future__ import annotations

from . import protocol as P
from .protocol import ProtocolError

GUILD_FEATURES = frozenset({"guild_banner", "gradient_roles", "role_icons"})

_FEATURE_NAMES = {
    "profile_banner": "Profile banners",
    "profile_colors": "Profile colours",
    "animated_media": "Animated avatars, icons and banners",
    "guild_banner": "Guild banners",
    "gradient_roles": "Gradient role colours",
    "role_icons": "Role icons",
    "client_themes": "Themes",
}


def entitled(cfg: dict, user: dict | None) -> bool:
    """Whether `user` (a PublicUser) may customise at all under `cfg`."""
    mode = cfg["customization_mode"]
    if mode == "on":
        return True
    if mode == "off" or user is None:
        return False
    return bool(user.get("perks")) or (user.get("server_role") or "none") != "none"


def can(ctx, feature: str, user: dict | None) -> bool:
    cfg = ctx.db.get_server_config()
    return bool(cfg["customization_features"].get(feature)) and entitled(cfg, user)


def require(ctx, feature: str, user: dict | None, *, guild: bool = False) -> None:
    if can(ctx, feature, user):
        return
    who = "this guild's owner" if guild else "you"
    raise ProtocolError(P.FEATURE_DISABLED, f"{_FEATURE_NAMES[feature]} aren't available to {who} on this server")


def guild_owner(ctx, guild: dict) -> dict | None:
    return ctx.db.public_user(guild["owner_user_id"])
