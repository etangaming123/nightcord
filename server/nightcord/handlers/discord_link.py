"""discord.* handlers: linking your account to Discord through the server's
bot (PROTOCOL.md §5 Discord link). The work happens in ../discord_link.py."""

from __future__ import annotations

from .. import protocol as P
from ..discord_link import LinkError, clean_app_url, clean_server_address
from ..protocol import ProtocolError
from . import handles


def _service(ctx):
    if ctx.discord is None:
        raise ProtocolError(P.DISCORD_UNAVAILABLE, "This server doesn't have a Discord bot")
    return ctx.discord


@handles(P.DISCORD_GET)
async def get(ctx, conn, payload):
    d = _service(ctx)
    return {"bot": d.status(), "link": d.view(conn.user_id)}


@handles(P.DISCORD_LINK_START)
async def link_start(ctx, conn, payload):
    d = _service(ctx)
    return d.new_code(
        conn.user_id, app_url=clean_app_url(payload.get("app_url")), server=clean_server_address(payload.get("server"))
    )


@handles(P.DISCORD_UNLINK)
async def unlink(ctx, conn, payload):
    try:
        await _service(ctx).unlink(conn.user_id)
    except LinkError as e:
        raise e.protocol_error() from None
    return {}


@handles(P.DISCORD_SETTINGS_SET)
async def settings_set(ctx, conn, payload):
    d = _service(ctx)
    notify = payload.get("notify")
    if notify is not None:
        if not isinstance(notify, dict) or any(
            k not in P.DISCORD_NOTIFY_KINDS or not isinstance(v, bool) for k, v in notify.items()
        ):
            raise ProtocolError(P.BAD_REQUEST, f"'notify' must map {', '.join(P.DISCORD_NOTIFY_KINDS)} to booleans")
    only_when_away = P.opt_bool(payload, "only_when_away")
    include_content = P.opt_bool(payload, "include_content")
    if not notify and only_when_away is None and include_content is None:
        raise ProtocolError(P.BAD_REQUEST, "Nothing to change")
    try:
        link = await d.update_settings(
            conn.user_id, notify=notify, only_when_away=only_when_away, include_content=include_content
        )
    except LinkError as e:
        raise e.protocol_error() from None
    return {"link": link}


@handles(P.DISCORD_SYNC)
async def sync(ctx, conn, payload):
    d = _service(ctx)
    fields = payload.get("fields", list(P.DISCORD_SYNC_FIELDS))
    if not isinstance(fields, list) or not fields or any(f not in P.DISCORD_SYNC_FIELDS for f in fields):
        raise ProtocolError(P.BAD_REQUEST, f"'fields' must list some of {', '.join(P.DISCORD_SYNC_FIELDS)}")
    try:
        return await d.sync_profile(conn.user_id, fields)
    except LinkError as e:
        raise e.protocol_error() from None


@handles(P.DISCORD_TEST)
async def test(ctx, conn, payload):
    try:
        return {"delivered": await _service(ctx).send_test(conn.user_id)}
    except LinkError as e:
        raise e.protocol_error() from None
