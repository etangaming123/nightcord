"""user.* handlers: profiles, avatars, password, sessions, search."""

from __future__ import annotations

import base64
import binascii
import logging
import re

from .. import perks
from .. import protocol as P
from ..ids import new_id
from ..protocol import ProtocolError
from . import handles
from .auth import check_password, hash_password

log = logging.getLogger("nightcord.users")

AVATAR_ID_RE = re.compile(r"^\d{1,20}\.(png|jpg|webp)$")
AVATAR_TYPES = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}


def avatar_dir(ctx):
    return ctx.config.data_dir / "avatars"


def _sniff_image(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if len(data) > 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


async def broadcast_user(ctx, user: dict) -> None:
    """user.updated: the full self view to the user, the public view to their audience."""
    ctx.hub.update_user(user)
    await ctx.hub.send_to_user(user["user_id"], P.frame(P.USER_UPDATED, user))
    public = ctx.db.public_user(user["user_id"])
    await ctx.hub.send_to_users(ctx.db.audience_of(user["user_id"]), P.frame(P.USER_UPDATED, public))


@handles(P.USER_PROFILE)
async def profile(ctx, conn, payload):
    profile = ctx.db.profile(P.req_id(payload, "user_id"))
    if profile is None:
        raise ProtocolError(P.NOT_FOUND, "User not found")
    return {"user": profile, "status": ctx.hub.status_of(profile["user_id"])}


@handles(P.USER_UPDATE)
async def update(ctx, conn, payload):
    fields = {}
    for key, limit in (("display_name", P.DISPLAY_NAME_MAX), ("bio", P.BIO_MAX), ("custom_status", P.CUSTOM_STATUS_MAX)):
        if key in payload:
            val = payload[key]
            if val is not None:
                val = P.opt_text(payload, key, limit)
            fields[key] = val or None
    if "avatar_color" in payload:
        fields["avatar_color"] = P.validate_color(payload["avatar_color"])
    if "profile_colors" in payload:
        colors = P.validate_colors(
            payload["profile_colors"], min_len=P.PROFILE_COLORS, max_len=P.PROFILE_COLORS, key="profile_colors"
        )
        if colors is not None:
            perks.require(ctx, "profile_colors", conn.user)
        fields["profile_colors"] = colors
    old_banner = conn.user.get("banner_id")
    if "banner_media_id" in payload:
        fields["banner_id"] = None
        if payload["banner_media_id"] is not None:
            fields["banner_id"] = claim_image(ctx, conn.user_id, payload["banner_media_id"], "banner", "profile_banner", conn.user)
    if not fields:
        raise ProtocolError(P.BAD_REQUEST, "Nothing to update")
    user = ctx.db.update_profile(conn.user_id, fields)
    if "banner_id" in fields and old_banner != fields["banner_id"]:
        drop_image(ctx, old_banner)
    await broadcast_user(ctx, user)
    return {"user": user}


def claim_image(ctx, user_id: str, media_id, kind: str, feature: str | None, owner: dict | None, *, guild=False) -> str:
    """Claims an uploaded image for a profile/guild/role field and returns the
    reference to store. `feature` (and animated_media for animated images)
    must be allowed for `owner` — the user, or the guild's owner."""
    from .media import claim, media_ref, unclaim

    row = claim(ctx, user_id, media_id, kind)
    try:
        if feature:
            perks.require(ctx, feature, owner, guild=guild)
        if row["animated"]:
            perks.require(ctx, "animated_media", owner, guild=guild)
    except ProtocolError:
        unclaim(ctx, row["media_id"])
        raise
    return media_ref(row)


def store_image(ctx, data_b64) -> str:
    """Validates a base64 avatar/icon image and stores it; returns its id."""
    if not isinstance(data_b64, str):
        raise ProtocolError(P.AVATAR_INVALID, "'data_b64' must be a base64 string or null")
    try:
        data = base64.b64decode(data_b64, validate=True)
    except (binascii.Error, ValueError):
        raise ProtocolError(P.AVATAR_INVALID, "Image isn't valid base64") from None
    if len(data) > P.AVATAR_MAX_BYTES:
        raise ProtocolError(P.AVATAR_INVALID, "Image must be at most 40 KB")
    ext = _sniff_image(data)
    if ext is None:
        raise ProtocolError(P.AVATAR_INVALID, "Image must be a PNG, JPEG or WebP")
    image_id = f"{new_id()}.{ext}"
    folder = avatar_dir(ctx)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / image_id).write_bytes(data)
    return image_id


def drop_image(ctx, image_id: str | None) -> None:
    """Deletes an avatar/icon/banner: a base64 upload (/avatars/) or a media reference (/media/)."""
    from .media import MEDIA_REF_RE, drop_media

    if image_id and MEDIA_REF_RE.match(image_id):
        drop_media(ctx, image_id)
    elif image_id and AVATAR_ID_RE.match(image_id):
        try:
            (avatar_dir(ctx) / image_id).unlink(missing_ok=True)
        except OSError as e:
            log.warning("couldn't delete image %s: %s", image_id, e)


@handles(P.USER_AVATAR_SET)
async def avatar_set(ctx, conn, payload):
    data_b64 = payload.get("data_b64")
    old = conn.user.get("avatar_id")
    if payload.get("media_id") is not None:
        avatar_id = claim_image(ctx, conn.user_id, payload["media_id"], "avatar", None, conn.user)
    else:
        avatar_id = None if data_b64 is None else store_image(ctx, data_b64)
    user = ctx.db.update_profile(conn.user_id, {"avatar_id": avatar_id})
    drop_image(ctx, old)
    await broadcast_user(ctx, user)
    return {"user": user}


@handles(P.USER_PASSWORD_CHANGE)
async def password_change(ctx, conn, payload):
    current = payload.get("current_password")
    if not isinstance(current, str):
        raise ProtocolError(P.BAD_REQUEST, "'current_password' is required")
    new = P.validate_password(payload.get("new_password"))
    ctx.login_throttle.check(conn.remote, record=False)
    row = ctx.db.get_user_row(conn.user_id)
    if not await check_password(current, row["password_hash"]):
        ctx.login_throttle.record(conn.remote)
        raise ProtocolError(P.INVALID_CURRENT_PASSWORD, "Your current password is wrong")
    ctx.db.set_password_hash(conn.user_id, await hash_password(new), keep_token=conn.session_token)
    await ctx.hub.close_user(conn.user_id, keep=conn, only_revoked=True)
    return {}


@handles(P.USER_SESSIONS_LIST)
async def sessions_list(ctx, conn, payload):
    return {"sessions": ctx.db.list_sessions(conn.user_id, conn.session_token)}


@handles(P.USER_SESSIONS_REVOKE)
async def sessions_revoke(ctx, conn, payload):
    session_id = P.req_str(payload, "session_id", max_len=32)
    if session_id == "others":
        ctx.db.delete_other_sessions(conn.user_id, conn.session_token)
    elif not ctx.db.delete_session_by_id(conn.user_id, session_id):
        raise ProtocolError(P.NOT_FOUND, "Session not found")
    await ctx.hub.close_user(conn.user_id, keep=conn, only_revoked=True)
    return {}


async def delete_account(ctx, user_id: str, *, keep=None) -> None:
    """Delete an account (PROTOCOL.md §5 Users, user.delete): guilds it owns
    pass to the highest-ranked member (or are deleted when empty), it leaves
    every guild and group DM, and its messages stay as "Deleted User"."""
    from .dms import announce_dm
    from .files import delete_files
    from .guilds import drop_member, remove_guild, transfer_guild

    audience = ctx.db.audience_of(user_id)
    await ctx.hub.voice_leave(user_id)
    for guild_id in ctx.db.owned_guild_ids(user_id):
        heir = ctx.db.successor(guild_id, user_id)
        if heir is None:
            await remove_guild(ctx, ctx.db.get_guild(guild_id))
        else:
            await transfer_guild(ctx, guild_id, heir)
    for g in ctx.db.list_user_guilds(user_id):
        await drop_member(ctx, g["guild_id"], user_id, "left", ghost=g["ghost"])
    for channel in ctx.db.list_dms(user_id) + [ctx.db.get_channel(c) for c in ctx.db.dm_channel_ids(user_id)]:
        if channel and channel["kind"] == "group_dm" and ctx.db.is_dm_recipient(channel["channel_id"], user_id):
            ctx.db.remove_dm_recipient(channel["channel_id"], user_id)
            fresh = ctx.db.get_channel(channel["channel_id"])
            if fresh is not None:
                await announce_dm(ctx, fresh)
    leftovers = ctx.db.anonymize_user(user_id)
    # `keep` (the deleting connection) stays open, logged out, to get its reply.
    await ctx.hub.close_user(user_id, keep=keep)
    if keep is not None:
        await ctx.hub.deauthenticate(keep)
    drop_image(ctx, leftovers["avatar_id"])
    drop_image(ctx, leftovers["banner_id"])
    delete_files(ctx, leftovers["attachment_ids"])
    await ctx.hub.send_to_users(audience, P.frame(P.USER_UPDATED, ctx.db.public_user(user_id)))


@handles(P.USER_DELETE)
async def delete(ctx, conn, payload):
    password = payload.get("password")
    if not isinstance(password, str):
        raise ProtocolError(P.BAD_REQUEST, "'password' is required")
    if conn.user["is_server_owner"]:
        raise ProtocolError(P.FORBIDDEN, "The server owner's account can't be deleted")
    ctx.login_throttle.check(conn.remote, record=False)
    row = ctx.db.get_user_row(conn.user_id)
    if not await check_password(password, row["password_hash"]):
        ctx.login_throttle.record(conn.remote)
        raise ProtocolError(P.INVALID_CURRENT_PASSWORD, "Your password is wrong")
    ctx.db.add_server_audit(conn.user_id, "user.delete_self", conn.user_id, {"username": row["username"]})
    await delete_account(ctx, conn.user_id, keep=conn)
    return {}


@handles(P.USER_SEARCH)
async def search(ctx, conn, payload):
    query = P.req_str(payload, "query", max_len=32).strip()
    if not query:
        return {"users": []}
    return {"users": ctx.db.search_users(query, exclude=conn.user_id)}
