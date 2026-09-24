"""badge.* and admin.users.set_badges — badges the server owner makes and hands out (PROTOCOL.md §4 Badge, §5 Badges).

Only the server owner touches any of this. "verified" is built in (no row,
no image; clients draw the check); everything else is an uploaded image.
"""

from __future__ import annotations

from .. import protocol as P
from ..protocol import ProtocolError
from . import handles
from ._access import require_server_owner
from .admin import _audit, _refresh_user
from .media import claim, drop_media


def _name(payload, *, required: bool) -> str | None:
    if "name" not in payload and not required:
        return None
    name = P.opt_text(payload, "name", P.BADGE_NAME_MAX)
    if not name:
        raise ProtocolError(P.BAD_REQUEST, f"Badge names must be 1-{P.BADGE_NAME_MAX} characters")
    return name


def _require_badge(ctx, payload) -> dict:
    badge_id = P.req_str(payload, "badge_id", max_len=20)
    if badge_id == P.BADGE_VERIFIED:
        raise ProtocolError(P.BAD_REQUEST, "The Verified badge is built in and can't be changed")
    badge = ctx.db.get_badge(badge_id)
    if badge is None:
        raise ProtocolError(P.NOT_FOUND, "Badge not found")
    return badge


async def _refresh_holders(ctx, holders: list[str]) -> None:
    for user_id in holders:
        await _refresh_user(ctx, user_id)


@handles(P.BADGE_LIST)
async def badge_list(ctx, conn, payload):
    require_server_owner(conn)
    return {"badges": ctx.db.list_badges()}


@handles(P.BADGE_CREATE)
async def badge_create(ctx, conn, payload):
    require_server_owner(conn)
    if ctx.db.count_badges() >= P.MAX_BADGES:
        raise ProtocolError(P.BAD_REQUEST, f"There can be at most {P.MAX_BADGES} custom badges")
    name = _name(payload, required=True)
    description = P.opt_text(payload, "description", P.BADGE_DESCRIPTION_MAX) or None
    inline = P.opt_bool(payload, "inline")
    row = claim(ctx, conn.user_id, payload.get("media_id"), "badge")
    badge = ctx.db.create_badge(
        row["media_id"], name, description, bool(row["animated"]), True if inline is None else inline, conn.user_id
    )
    _audit(ctx, conn, "badge.create", badge["id"], {"name": name})
    return {"badge": badge}


@handles(P.BADGE_UPDATE)
async def badge_update(ctx, conn, payload):
    require_server_owner(conn)
    badge = _require_badge(ctx, payload)
    fields: dict = {}
    name = _name(payload, required=False)
    if name is not None:
        fields["name"] = name
    if "description" in payload:
        fields["description"] = P.opt_text(payload, "description", P.BADGE_DESCRIPTION_MAX) or None
    inline = P.opt_bool(payload, "inline")
    if inline is not None:
        fields["inline"] = int(inline)
    updated = ctx.db.update_badge(badge["id"], fields)
    _audit(ctx, conn, "badge.update", badge["id"], {"name": updated["name"], "was": badge["name"]})
    await _refresh_holders(ctx, ctx.db.badge_holders(badge["id"]))
    return {"badge": updated}


@handles(P.BADGE_DELETE)
async def badge_delete(ctx, conn, payload):
    require_server_owner(conn)
    badge = _require_badge(ctx, payload)
    holders = ctx.db.delete_badge(badge["id"])
    drop_media(ctx, badge["id"])
    _audit(ctx, conn, "badge.delete", badge["id"], {"name": badge["name"]})
    await _refresh_holders(ctx, holders)
    return {}


@handles(P.ADMIN_USERS_SET_BADGES)
async def users_set_badges(ctx, conn, payload):
    """Replaces a user's badges with `badge_ids`, in display order."""
    require_server_owner(conn)
    ids = payload.get("badge_ids")
    if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
        raise ProtocolError(P.BAD_REQUEST, "'badge_ids' must be a list of badge ids")
    if len(set(ids)) != len(ids):
        raise ProtocolError(P.BAD_REQUEST, "'badge_ids' can't repeat a badge")
    if len(ids) > P.MAX_USER_BADGES:
        raise ProtocolError(P.BAD_REQUEST, f"A user can have at most {P.MAX_USER_BADGES} badges")
    for badge_id in ids:
        if ctx.db.get_badge(badge_id) is None:
            raise ProtocolError(P.NOT_FOUND, "Badge not found")
    row = ctx.db.get_user_row(P.req_id(payload, "user_id"))
    if row is None or row["status"] == "deleted":
        raise ProtocolError(P.NOT_FOUND, "User not found")
    ctx.db.set_user_badges(row["user_id"], ids, conn.user_id)
    _audit(ctx, conn, "user.badges", row["user_id"], {"username": row["username"], "badges": ids})
    await _refresh_user(ctx, row["user_id"])
    return {"user": ctx.db.admin_user(row["user_id"])}
