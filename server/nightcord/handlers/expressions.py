"""emoji.* and sticker.* handlers (PROTOCOL.md §5 Emoji and stickers).

A guild's emoji and stickers are managed with MANAGE_EXPRESSIONS and can be
used by its members in any guild or DM. An emoji's or sticker's id is the
media_id of its image, so clients can show it from the id alone.
"""

from __future__ import annotations

from .. import permissions as perm
from .. import protocol as P
from ..protocol import ProtocolError
from . import handles
from ._access import require_guild_perm
from .media import claim, drop_media, unclaim


async def _emojis_changed(ctx, guild_id: str) -> None:
    await ctx.hub.send_to_guild(
        guild_id, P.frame(P.GUILD_EMOJIS_UPDATED, {"guild_id": guild_id, "emojis": ctx.db.list_emojis(guild_id)})
    )


async def _stickers_changed(ctx, guild_id: str) -> None:
    await ctx.hub.send_to_guild(
        guild_id,
        P.frame(P.GUILD_STICKERS_UPDATED, {"guild_id": guild_id, "stickers": ctx.db.list_stickers(guild_id)}),
    )


def _require_emoji(ctx, conn, payload) -> dict:
    emoji = ctx.db.get_emoji(P.req_id(payload, "emoji_id"))
    if emoji is None:
        raise ProtocolError(P.NOT_FOUND, "Emoji not found")
    require_guild_perm(ctx, conn, emoji["guild_id"], perm.MANAGE_EXPRESSIONS)
    return emoji


def _require_sticker(ctx, conn, payload) -> dict:
    sticker = ctx.db.get_sticker(P.req_id(payload, "sticker_id"))
    if sticker is None:
        raise ProtocolError(P.NOT_FOUND, "Sticker not found")
    require_guild_perm(ctx, conn, sticker["guild_id"], perm.MANAGE_EXPRESSIONS)
    return sticker


def _emoji_name(ctx, guild_id: str, payload, exclude: str | None = None) -> str:
    name = P.validate_emoji_name(payload.get("name"))
    if ctx.db.emoji_name_taken(guild_id, name, exclude):
        raise ProtocolError(P.BAD_REQUEST, f"This guild already has an emoji called :{name}:")
    return name


def _sticker_fields(payload) -> dict:
    fields = {}
    if "name" in payload:
        name = P.opt_text(payload, "name", P.STICKER_NAME_MAX)
        if not name or len(name) < 2:
            raise ProtocolError(P.BAD_REQUEST, f"Sticker names must be 2-{P.STICKER_NAME_MAX} characters")
        fields["name"] = name
    if "description" in payload:
        fields["description"] = P.opt_text(payload, "description", P.STICKER_DESCRIPTION_MAX) or None
    if "tag_emoji" in payload:
        tag = payload["tag_emoji"]
        fields["tag_emoji"] = None if tag in (None, "") else P.validate_emoji(tag, allow_custom=False)
    return fields


@handles(P.EMOJI_CREATE)
async def emoji_create(ctx, conn, payload):
    guild, _ = require_guild_perm(ctx, conn, P.req_id(payload, "guild_id"), perm.MANAGE_EXPRESSIONS)
    guild_id = guild["guild_id"]
    if ctx.db.count_emojis(guild_id) >= P.MAX_GUILD_EMOJI:
        raise ProtocolError(P.BAD_REQUEST, f"A guild can have at most {P.MAX_GUILD_EMOJI} emoji")
    name = _emoji_name(ctx, guild_id, payload)
    row = claim(ctx, conn.user_id, payload.get("media_id"), "emoji")
    emoji = ctx.db.create_emoji(row["media_id"], guild_id, name, bool(row["animated"]), conn.user_id)
    ctx.db.add_audit(guild_id, conn.user_id, "emoji.create", emoji["emoji_id"], {"name": name})
    await _emojis_changed(ctx, guild_id)
    return {"emoji": emoji}


@handles(P.EMOJI_UPDATE)
async def emoji_update(ctx, conn, payload):
    emoji = _require_emoji(ctx, conn, payload)
    name = _emoji_name(ctx, emoji["guild_id"], payload, exclude=emoji["emoji_id"])
    updated = ctx.db.rename_emoji(emoji["emoji_id"], name)
    ctx.db.add_audit(emoji["guild_id"], conn.user_id, "emoji.update", emoji["emoji_id"], {"name": name, "was": emoji["name"]})
    await _emojis_changed(ctx, emoji["guild_id"])
    return {"emoji": updated}


@handles(P.EMOJI_DELETE)
async def emoji_delete(ctx, conn, payload):
    emoji = _require_emoji(ctx, conn, payload)
    ctx.db.delete_emoji(emoji["emoji_id"])
    drop_media(ctx, emoji["emoji_id"])
    ctx.db.add_audit(emoji["guild_id"], conn.user_id, "emoji.delete", emoji["emoji_id"], {"name": emoji["name"]})
    await _emojis_changed(ctx, emoji["guild_id"])
    return {}


@handles(P.EMOJI_INFO)
async def emoji_info(ctx, conn, payload):
    """Where a custom emoji seen in a message comes from."""
    emoji = ctx.db.get_emoji(P.req_id(payload, "emoji_id"))
    if emoji is None:
        raise ProtocolError(P.NOT_FOUND, "That emoji was deleted")
    guild = ctx.db.get_guild(emoji["guild_id"])
    m = ctx.db.get_membership(guild["guild_id"], conn.user_id)
    is_member = m is not None and not m["ghost"]
    public = guild["listed"] and ctx.db.get_server_config()["guild_list_visible"]
    return {
        "emoji": emoji,
        # Only members and the public guild list may learn which guild it is.
        "guild": {"guild_id": guild["guild_id"], "name": guild["name"], "icon_id": guild["icon_id"]}
        if m is not None or public else None,
        "is_member": is_member,
    }


@handles(P.STICKER_CREATE)
async def sticker_create(ctx, conn, payload):
    guild, _ = require_guild_perm(ctx, conn, P.req_id(payload, "guild_id"), perm.MANAGE_EXPRESSIONS)
    guild_id = guild["guild_id"]
    if ctx.db.count_stickers(guild_id) >= P.MAX_GUILD_STICKERS:
        raise ProtocolError(P.BAD_REQUEST, f"A guild can have at most {P.MAX_GUILD_STICKERS} stickers")
    fields = _sticker_fields(payload)
    if "name" not in fields:
        raise ProtocolError(P.BAD_REQUEST, "'name' is required")
    row = claim(ctx, conn.user_id, payload.get("media_id"), "sticker")
    try:
        sticker = ctx.db.create_sticker(
            row["media_id"], guild_id, name=fields["name"], description=fields.get("description"),
            tag_emoji=fields.get("tag_emoji"), animated=bool(row["animated"]), creator_id=conn.user_id,
        )
    except Exception:
        unclaim(ctx, row["media_id"])
        raise
    ctx.db.add_audit(guild_id, conn.user_id, "sticker.create", sticker["sticker_id"], {"name": sticker["name"]})
    await _stickers_changed(ctx, guild_id)
    return {"sticker": sticker}


@handles(P.STICKER_UPDATE)
async def sticker_update(ctx, conn, payload):
    sticker = _require_sticker(ctx, conn, payload)
    fields = _sticker_fields(payload)
    if not fields:
        raise ProtocolError(P.BAD_REQUEST, "Nothing to update")
    updated = ctx.db.update_sticker(sticker["sticker_id"], fields)
    ctx.db.add_audit(sticker["guild_id"], conn.user_id, "sticker.update", sticker["sticker_id"], fields)
    await _stickers_changed(ctx, sticker["guild_id"])
    return {"sticker": updated}


@handles(P.STICKER_DELETE)
async def sticker_delete(ctx, conn, payload):
    sticker = _require_sticker(ctx, conn, payload)
    ctx.db.delete_sticker(sticker["sticker_id"])
    drop_media(ctx, sticker["sticker_id"])
    ctx.db.add_audit(sticker["guild_id"], conn.user_id, "sticker.delete", sticker["sticker_id"], {"name": sticker["name"]})
    await _stickers_changed(ctx, sticker["guild_id"])
    return {}
