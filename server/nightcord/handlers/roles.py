"""role.* handlers (PROTOCOL.md §5 Roles, §5a)."""

from __future__ import annotations

from .. import permissions as perm
from .. import protocol as P
from ..protocol import ProtocolError
from . import handles
from ._access import rank, require_guild_perm, require_member


def _perm_bits(payload, key: str) -> int | None:
    val = P.opt_int(payload, key)
    if val is not None and (val < 0 or val & ~perm.ALL):
        raise ProtocolError(P.BAD_REQUEST, f"'{key}' has unknown permission bits")
    return val


def _check_grantable(ctx, guild_id: str, user_id: str, old: int, new: int) -> None:
    """Can't add permissions you don't have yourself."""
    mine = ctx.perms.guild_perms(guild_id, user_id)
    if (new & ~old) & ~mine:
        raise ProtocolError(P.FORBIDDEN, "You can't grant permissions you don't have")


def _require_role(ctx, conn, payload) -> tuple[dict, dict]:
    role = ctx.db.get_role(P.req_id(payload, "role_id"))
    if role is None:
        raise ProtocolError(P.NOT_FOUND, "Role not found")
    guild, _ = require_guild_perm(ctx, conn, role["guild_id"], perm.MANAGE_ROLES)
    return guild, role


def _require_below(ctx, conn, role: dict) -> None:
    if not role["is_everyone"] and role["position"] >= rank(ctx, role["guild_id"], conn.user_id):
        raise ProtocolError(P.FORBIDDEN, "That role is not below your highest role")


async def roles_changed(ctx, guild_id: str) -> None:
    ctx.perms.invalidate_guild(guild_id)
    await ctx.hub.send_to_guild(guild_id, P.frame(P.GUILD_PERMISSIONS_CHANGED, {"guild_id": guild_id}))


@handles(P.ROLE_LIST)
async def list_roles(ctx, conn, payload):
    guild, _ = require_member(ctx, conn, P.req_id(payload, "guild_id"))
    return {"roles": ctx.db.list_roles(guild["guild_id"])}


@handles(P.ROLE_CREATE)
async def create(ctx, conn, payload):
    guild, _ = require_guild_perm(ctx, conn, P.req_id(payload, "guild_id"), perm.MANAGE_ROLES)
    guild_id = guild["guild_id"]
    if ctx.db.count_roles(guild_id) >= P.MAX_ROLES:
        raise ProtocolError(P.BAD_REQUEST, f"A guild can have at most {P.MAX_ROLES} roles")
    name = P.opt_text(payload, "name", P.ROLE_NAME_MAX) or "new role"
    color = P.validate_color(payload.get("color"))
    permissions = _perm_bits(payload, "permissions") or 0
    _check_grantable(ctx, guild_id, conn.user_id, 0, permissions)
    my_rank = rank(ctx, guild_id, conn.user_id)
    # New roles go just below the creator's highest role (the top for the owner).
    role = ctx.db.create_role(
        guild_id, name=name, color=color, permissions=permissions,
        position=None if my_rank == perm.OWNER_RANK else my_rank,
    )
    ctx.db.add_audit(guild_id, conn.user_id, "role.create", role["role_id"], {"name": name})
    await ctx.hub.send_to_guild(guild_id, P.frame(P.ROLE_CREATED, role))
    if my_rank != perm.OWNER_RANK:
        # Positions above the new role shifted.
        for r in ctx.db.list_roles(guild_id):
            if r["position"] > role["position"]:
                await ctx.hub.send_to_guild(guild_id, P.frame(P.ROLE_UPDATED, r))
    await roles_changed(ctx, guild_id)
    return {"role": role}


@handles(P.ROLE_UPDATE)
async def update(ctx, conn, payload):
    guild, role = _require_role(ctx, conn, payload)
    _require_below(ctx, conn, role)
    fields = {}
    if payload.get("name") is not None:
        if role["is_everyone"]:
            raise ProtocolError(P.BAD_REQUEST, "@everyone can't be renamed")
        name = P.opt_text(payload, "name", P.ROLE_NAME_MAX)
        if not name:
            raise ProtocolError(P.BAD_REQUEST, "Role name can't be empty")
        fields["name"] = name
    if "color" in payload:
        fields["color"] = P.validate_color(payload["color"])
    permissions = _perm_bits(payload, "permissions")
    if permissions is not None:
        _check_grantable(ctx, guild["guild_id"], conn.user_id, role["permissions"], permissions)
        fields["permissions"] = permissions
    if not fields:
        raise ProtocolError(P.BAD_REQUEST, "Nothing to update")
    role = ctx.db.update_role(role["role_id"], fields)
    ctx.db.add_audit(guild["guild_id"], conn.user_id, "role.update", role["role_id"], {"name": role["name"], **{k: v for k, v in fields.items() if k != "name"}})
    await ctx.hub.send_to_guild(guild["guild_id"], P.frame(P.ROLE_UPDATED, role))
    if "permissions" in fields:
        await roles_changed(ctx, guild["guild_id"])
    return {"role": role}


@handles(P.ROLE_REORDER)
async def reorder(ctx, conn, payload):
    guild, _ = require_guild_perm(ctx, conn, P.req_id(payload, "guild_id"), perm.MANAGE_ROLES)
    guild_id = guild["guild_id"]
    top_down = P.id_list(payload, "role_ids", max_len=P.MAX_ROLES)
    current = [r for r in ctx.db.list_roles(guild_id) if not r["is_everyone"]]
    if set(top_down) != {r["role_id"] for r in current} or len(top_down) != len(current):
        raise ProtocolError(P.BAD_REQUEST, "'role_ids' must list every role except @everyone")
    my_rank = rank(ctx, guild_id, conn.user_id)
    old = {r["role_id"]: r["position"] for r in current}
    new = {rid: len(top_down) - i for i, rid in enumerate(top_down)}
    for rid in top_down:
        if old[rid] != new[rid] and (old[rid] >= my_rank or new[rid] >= my_rank):
            raise ProtocolError(P.FORBIDDEN, "You can only move roles below your highest role")
    ctx.db.set_role_positions(guild_id, list(reversed(top_down)))
    for r in ctx.db.list_roles(guild_id):
        if not r["is_everyone"] and old[r["role_id"]] != r["position"]:
            await ctx.hub.send_to_guild(guild_id, P.frame(P.ROLE_UPDATED, r))
    ctx.db.add_audit(guild_id, conn.user_id, "role.reorder")
    await roles_changed(ctx, guild_id)
    return {"roles": ctx.db.list_roles(guild_id)}


@handles(P.ROLE_DELETE)
async def delete(ctx, conn, payload):
    guild, role = _require_role(ctx, conn, payload)
    if role["is_everyone"]:
        raise ProtocolError(P.BAD_REQUEST, "@everyone can't be deleted")
    _require_below(ctx, conn, role)
    guild_id = guild["guild_id"]
    before = {r["role_id"]: r["position"] for r in ctx.db.list_roles(guild_id)}
    ctx.db.delete_role(role["role_id"])
    ctx.db.add_audit(guild_id, conn.user_id, "role.delete", role["role_id"], {"name": role["name"]})
    await ctx.hub.send_to_guild(guild_id, P.frame(P.ROLE_DELETED, {"guild_id": guild_id, "role_id": role["role_id"]}))
    for r in ctx.db.list_roles(guild_id):
        if before.get(r["role_id"]) != r["position"]:
            await ctx.hub.send_to_guild(guild_id, P.frame(P.ROLE_UPDATED, r))
    await roles_changed(ctx, guild_id)
    return {}
