"""channel.* and read_state.* handlers (PROTOCOL.md §5 Channels, Read state)."""

from __future__ import annotations

from .. import permissions as perm
from .. import protocol as P
from ..protocol import ProtocolError
from . import handles
from ._access import (
    get_channel,
    require_channel_perm,
    require_guild_perm,
    require_member,
    with_perms,
)


def _parse_overwrites(ctx, guild_id: str, raw) -> list[dict]:
    if not isinstance(raw, list) or len(raw) > P.MAX_ROLES:
        raise ProtocolError(P.BAD_REQUEST, "'overwrites' must be a list")
    roles = {r["role_id"] for r in ctx.db.list_roles(guild_id)}
    out: dict[str, dict] = {}
    for o in raw:
        if not isinstance(o, dict):
            raise ProtocolError(P.BAD_REQUEST, "Each overwrite must be an object")
        role_id = P.req_id(o, "role_id")
        allow = P.opt_int(o, "allow") or 0
        deny = P.opt_int(o, "deny") or 0
        if role_id not in roles:
            raise ProtocolError(P.BAD_REQUEST, "Overwrite for an unknown role")
        if allow < 0 or deny < 0 or (allow | deny) & ~perm.CHANNEL_PERMS or allow & deny:
            raise ProtocolError(P.BAD_REQUEST, "Overwrites may only use channel permissions, never both allow and deny")
        out[role_id] = {"role_id": role_id, "allow": allow, "deny": deny}
    return list(out.values())


def _check_overwrites_allowed(ctx, conn, guild_id: str, overwrites: list[dict] | None = None) -> None:
    """Editing overwrites needs MANAGE_ROLES, and you can't allow what you lack."""
    mine = ctx.perms.guild_perms(guild_id, conn.user_id)
    if not mine & perm.MANAGE_ROLES:
        raise ProtocolError(P.FORBIDDEN, "Changing channel permissions needs Manage Roles")
    for o in overwrites or []:
        if o["allow"] & ~mine:
            raise ProtocolError(P.FORBIDDEN, "You can't allow permissions you don't have")


def _voice_enabled(ctx) -> bool:
    return bool(ctx.db.get_server_config()["voice_enabled"])


def _name_for(kind: str, raw) -> str:
    return P.validate_channel_name(raw) if kind == "text" else P.validate_channel_title(raw)


def _require_category(ctx, guild_id: str, parent_id: str | None) -> None:
    if parent_id is None:
        return
    parent = ctx.db.get_channel(parent_id)
    if parent is None or parent["guild_id"] != guild_id or parent["kind"] != "category":
        raise ProtocolError(P.BAD_REQUEST, "'parent_id' must be a category in this guild")


async def send_channel_event(ctx, channel: dict, type_: str) -> None:
    await ctx.hub.send_to_channel_viewers(
        channel, lambda uid: P.frame(type_, with_perms(ctx, channel, uid))
    )


def synced_children(ctx, category: dict) -> list[dict]:
    if category["kind"] != "category":
        return []
    return [
        c for c in ctx.db.list_channels(category["guild_id"])
        if c["parent_id"] == category["channel_id"] and c["perms_synced"]
    ]


def visible_channel_ids(ctx, user_id: str) -> list[str]:
    ids = []
    for g in ctx.db.list_user_guilds(user_id):
        for c in ctx.db.list_channels(g["guild_id"]):
            if c["kind"] == "text" and ctx.perms.can_view(c, user_id):
                ids.append(c["channel_id"])
    return ids


def channels_for(ctx, guild_id: str, user_id: str) -> list[dict]:
    """Channels user_id can see: viewable text/voice channels (voice only when
    enabled) and categories that are viewable or hold a visible channel."""
    voice = _voice_enabled(ctx)
    all_channels = [with_perms(ctx, c, user_id) for c in ctx.db.list_channels(guild_id)]
    visible = [
        c for c in all_channels
        if c["kind"] != "category" and c["my_permissions"] & perm.VIEW_CHANNEL and (voice or c["kind"] != "voice")
    ]
    parents = {c["parent_id"] for c in visible if c["parent_id"]}
    categories = [
        c for c in all_channels
        if c["kind"] == "category" and (c["my_permissions"] & perm.VIEW_CHANNEL or c["channel_id"] in parents)
    ]
    order = {c["channel_id"]: i for i, c in enumerate(all_channels)}
    return sorted(visible + categories, key=lambda c: order[c["channel_id"]])


async def _channels_changed(ctx, guild_id: str, changed: list[dict], before_viewers: dict[str, set[str]]) -> None:
    """After a permission-affecting change: channel.updated to current viewers,
    channel.deleted to users who lost sight of a channel."""
    for channel in changed:
        fresh = ctx.db.get_channel(channel["channel_id"])
        await send_channel_event(ctx, fresh, P.CHANNEL_UPDATED)
        gone = before_viewers.get(channel["channel_id"], set()) - set(ctx.hub.viewer_ids(fresh))
        await ctx.hub.send_to_users(
            gone, P.frame(P.CHANNEL_DELETED, {"guild_id": guild_id, "channel_id": channel["channel_id"]})
        )
    await ctx.hub.send_to_guild(guild_id, P.frame(P.GUILD_PERMISSIONS_CHANGED, {"guild_id": guild_id}))


@handles(P.CHANNEL_LIST)
async def list_channels(ctx, conn, payload):
    guild, _ = require_member(ctx, conn, P.req_str(payload, "guild_id"))
    voice_states = ctx.hub.voice_states(guild["guild_id"]) if _voice_enabled(ctx) else []
    return {"channels": channels_for(ctx, guild["guild_id"], conn.user_id), "voice_states": voice_states}


@handles(P.CHANNEL_JOIN)
async def join(ctx, conn, payload):
    channel, _ = get_channel(ctx, conn, P.req_str(payload, "channel_id"))
    ctx.hub.focus(conn, channel["channel_id"])
    return {}


@handles(P.CHANNEL_LEAVE)
async def leave(ctx, conn, payload):
    channel_id = P.req_str(payload, "channel_id")
    if conn.channel_id == channel_id:
        ctx.hub.focus(conn, None)
    return {}


def _cursor(payload, key: str) -> int | None:
    val = P.opt_str(payload, key)
    if val is not None and not val.isdigit():
        raise ProtocolError(P.BAD_REQUEST, f"'{key}' must be a message id")
    return int(val) if val is not None else None


@handles(P.CHANNEL_HISTORY)
async def history(ctx, conn, payload):
    channel, _ = require_channel_perm(ctx, conn, P.req_str(payload, "channel_id"), perm.READ_HISTORY)
    limit = P.opt_int(payload, "limit")
    limit = P.HISTORY_DEFAULT_LIMIT if limit is None else max(1, min(limit, P.HISTORY_MAX_LIMIT))
    before = _cursor(payload, "before_message_id")
    after = _cursor(payload, "after_message_id")
    around = _cursor(payload, "around_message_id")
    if sum(x is not None for x in (before, after, around)) > 1:
        raise ProtocolError(P.BAD_REQUEST, "Use at most one of before/after/around_message_id")
    if around is not None:
        messages, more_before, more_after = ctx.db.around(channel["channel_id"], around, limit)
        return {"messages": messages, "has_more": more_before, "has_more_after": more_after}
    if after is not None:
        messages, more_after = ctx.db.history_after(channel["channel_id"], after, limit)
        return {"messages": messages, "has_more": True, "has_more_after": more_after}
    messages, has_more = ctx.db.history(channel["channel_id"], before, limit)
    return {"messages": messages, "has_more": has_more, "has_more_after": False}


@handles(P.CHANNEL_CREATE)
async def create(ctx, conn, payload):
    guild, _ = require_guild_perm(ctx, conn, P.req_str(payload, "guild_id"), perm.MANAGE_CHANNELS)
    guild_id = guild["guild_id"]
    kind = P.opt_enum(payload, "kind", P.CHANNEL_KINDS) or "text"
    if kind == "voice" and not _voice_enabled(ctx):
        raise ProtocolError(P.VOICE_DISABLED, "Voice channels are turned off on this server")
    if ctx.db.count_channels(guild_id) >= P.MAX_CHANNELS:
        raise ProtocolError(P.BAD_REQUEST, f"A guild can have at most {P.MAX_CHANNELS} channels")
    name = _name_for(kind, payload.get("name"))
    parent_id = P.opt_id(payload, "parent_id")
    if kind == "category" and parent_id:
        raise ProtocolError(P.BAD_REQUEST, "Categories can't be nested")
    _require_category(ctx, guild_id, parent_id)
    topic = P.opt_text(payload, "topic", P.TOPIC_MAX) if kind == "text" else None
    overwrites = []
    if payload.get("overwrites"):
        overwrites = _parse_overwrites(ctx, guild_id, payload["overwrites"])
        _check_overwrites_allowed(ctx, conn, guild_id, overwrites)
    channel = ctx.db.create_channel(
        guild_id, name, overwrites, kind=kind, parent_id=parent_id, topic=topic or None,
        perms_synced=bool(parent_id) and not overwrites,
    )
    ctx.db.add_audit(guild_id, conn.user_id, "channel.create", channel["channel_id"], {"name": name, "kind": kind})
    await send_channel_event(ctx, channel, P.CHANNEL_CREATED)
    return {"channel": with_perms(ctx, channel, conn.user_id)}


@handles(P.CHANNEL_UPDATE)
async def update(ctx, conn, payload):
    channel, _ = require_channel_perm(ctx, conn, P.req_str(payload, "channel_id"), perm.MANAGE_CHANNELS)
    if channel["guild_id"] is None:
        raise ProtocolError(P.BAD_REQUEST, "Use dm.update for direct messages")
    guild_id = channel["guild_id"]
    fields: dict = {}
    if payload.get("name") is not None:
        fields["name"] = _name_for(channel["kind"], payload["name"])
    position = P.opt_int(payload, "position")
    if position is not None:
        if position < 0:
            raise ProtocolError(P.BAD_REQUEST, "'position' must be >= 0")
        fields["position"] = position
    if "topic" in payload:
        if channel["kind"] != "text":
            raise ProtocolError(P.BAD_REQUEST, "Only text channels have topics")
        fields["topic"] = P.opt_text(payload, "topic", P.TOPIC_MAX) or None
    slowmode = P.opt_int(payload, "slowmode_seconds")
    if slowmode is not None:
        if channel["kind"] != "text" or slowmode not in P.SLOWMODE_PRESETS:
            raise ProtocolError(P.BAD_REQUEST, "'slowmode_seconds' must be one of the preset values on a text channel")
        fields["slowmode_seconds"] = slowmode
    overwrites = None
    if payload.get("overwrites") is not None:
        overwrites = _parse_overwrites(ctx, guild_id, payload["overwrites"])
        _check_overwrites_allowed(ctx, conn, guild_id, overwrites)
        if channel["perms_synced"]:
            fields["perms_synced"] = False  # editing a synced channel's overwrites unsyncs it
    synced = P.opt_bool(payload, "perms_synced")
    if synced is not None and overwrites is None:
        if synced and not channel["parent_id"]:
            raise ProtocolError(P.BAD_REQUEST, "Only channels in a category can sync with it")
        _check_overwrites_allowed(ctx, conn, guild_id)
        fields["perms_synced"] = synced
    perms_change = overwrites is not None or "perms_synced" in fields
    affected = [channel, *synced_children(ctx, channel)] if perms_change else [channel]
    before_viewers = {c["channel_id"]: set(ctx.hub.viewer_ids(c)) for c in affected}
    if overwrites is not None:
        ctx.db.set_overwrites(channel["channel_id"], overwrites)
        ctx.perms.invalidate_channel(channel["channel_id"])
    channel = ctx.db.update_channel(channel["channel_id"], fields) if fields else ctx.db.get_channel(channel["channel_id"])
    if fields or overwrites is not None:
        details = {"name": channel["name"], **{k: v for k, v in fields.items() if k not in ("name", "position")}}
        if overwrites is not None:
            details["overwrites"] = True
        ctx.db.add_audit(guild_id, conn.user_id, "channel.update", channel["channel_id"], details)
    if perms_change:
        await _channels_changed(ctx, guild_id, affected, before_viewers)
    else:
        await send_channel_event(ctx, channel, P.CHANNEL_UPDATED)
    return {"channel": with_perms(ctx, channel, conn.user_id)}


@handles(P.CHANNEL_REORDER)
async def reorder(ctx, conn, payload):
    guild, _ = require_guild_perm(ctx, conn, P.req_id(payload, "guild_id"), perm.MANAGE_CHANNELS)
    guild_id = guild["guild_id"]
    raw = payload.get("channels")
    if not isinstance(raw, list) or not raw or len(raw) > P.MAX_CHANNELS:
        raise ProtocolError(P.BAD_REQUEST, "'channels' must be a non-empty list")
    current = {c["channel_id"]: c for c in ctx.db.list_channels(guild_id)}
    items = []
    for it in raw:
        if not isinstance(it, dict):
            raise ProtocolError(P.BAD_REQUEST, "Each item must be an object")
        cid = P.req_id(it, "channel_id")
        if cid not in current:
            raise ProtocolError(P.BAD_REQUEST, "Unknown channel")
        position = P.opt_int(it, "position")
        if position is None or position < 0:
            raise ProtocolError(P.BAD_REQUEST, "'position' must be >= 0")
        parent_id = P.opt_id(it, "parent_id")
        if parent_id is not None and (current.get(parent_id) or {}).get("kind") != "category":
            raise ProtocolError(P.BAD_REQUEST, "'parent_id' must be a category in this guild")
        if current[cid]["kind"] == "category" and parent_id is not None:
            raise ProtocolError(P.BAD_REQUEST, "Categories can't be nested")
        items.append({"channel_id": cid, "position": position, "parent_id": parent_id})
    moved = [i for i in items if (current[i["channel_id"]]["parent_id"], current[i["channel_id"]]["position"]) != (i["parent_id"], i["position"])]
    reparented_synced = [
        current[i["channel_id"]] for i in moved
        if current[i["channel_id"]]["parent_id"] != i["parent_id"] and current[i["channel_id"]]["perms_synced"]
    ]
    before_viewers = {c["channel_id"]: set(ctx.hub.viewer_ids(c)) for c in reparented_synced}
    ctx.db.reorder_channels(items)
    if moved:
        ctx.db.add_audit(guild_id, conn.user_id, "channel.reorder")
    for i in moved:
        if current[i["channel_id"]] not in reparented_synced:
            await send_channel_event(ctx, ctx.db.get_channel(i["channel_id"]), P.CHANNEL_UPDATED)
    if reparented_synced:
        for c in reparented_synced:
            ctx.perms.invalidate_channel(c["channel_id"])
        await _channels_changed(ctx, guild_id, reparented_synced, before_viewers)
    return {"channels": channels_for(ctx, guild_id, conn.user_id)}


@handles(P.CHANNEL_DELETE)
async def delete(ctx, conn, payload):
    channel, _ = require_channel_perm(ctx, conn, P.req_str(payload, "channel_id"), perm.MANAGE_CHANNELS)
    if channel["guild_id"] is None:
        raise ProtocolError(P.BAD_REQUEST, "Use dm.leave for direct messages")
    guild_id = channel["guild_id"]
    await ctx.hub.voice_drop_where(lambda v: v["channel_id"] == channel["channel_id"])
    children = ctx.db.delete_channel(channel["channel_id"])
    ctx.perms.invalidate_channel(channel["channel_id"])
    ctx.hub.unfocus_channel(channel["channel_id"])
    ctx.db.add_audit(guild_id, conn.user_id, "channel.delete", channel["channel_id"], {"name": channel["name"]})
    await ctx.hub.send_to_guild(
        guild_id, P.frame(P.CHANNEL_DELETED, {"guild_id": guild_id, "channel_id": channel["channel_id"]}),
    )
    for cid in children:
        ctx.perms.invalidate_channel(cid)
        await send_channel_event(ctx, ctx.db.get_channel(cid), P.CHANNEL_UPDATED)
    if ctx.db.get_guild(guild_id)["system_channel_id"] is None and channel["kind"] == "text":
        await ctx.hub.send_to_guild(guild_id, P.frame(P.GUILD_UPDATED, ctx.db.get_guild(guild_id)))
    return {}


@handles(P.CHANNEL_ACK)
async def ack(ctx, conn, payload):
    channel, _ = get_channel(ctx, conn, P.req_str(payload, "channel_id"))
    message_id = P.req_id(payload, "message_id")
    state = ctx.db.ack(conn.user_id, channel["channel_id"], int(message_id))
    await ctx.hub.send_to_user(conn.user_id, P.frame(P.READ_STATE_UPDATED, state), exclude=conn)
    return {"read_state": state}


@handles(P.READ_STATE_LIST)
async def read_state_list(ctx, conn, payload):
    ids = visible_channel_ids(ctx, conn.user_id) + [c["channel_id"] for c in ctx.db.list_dms(conn.user_id)]
    return {"read_states": ctx.db.read_states(conn.user_id, ids)}
