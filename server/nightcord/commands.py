"""Slash commands the server rolls (PROTOCOL.md §4 Message: `command`).

Only the commands whose *result* matters live here: a die roll typed by hand
is worth nothing, so the server rolls it, stores what it rolled beside the
message, and clients show a "used /roll" header. Everything else (/shrug,
/me, /tableflip…) is the client rewriting your own text and needs no server.

`secrets` rather than `random`: these are toys, but an unpredictable toy is
a better toy.
"""

from __future__ import annotations

import re
import secrets

from . import protocol as P
from .protocol import ProtocolError

# NdM, with an optional +K or -K. "d20" means 1d20.
DICE_RE = re.compile(r"^\s*(\d{1,3})?\s*[dD]\s*(\d{1,5})\s*(?:([+-])\s*(\d{1,6}))?\s*$")

EIGHT_BALL = (
    "It is certain.", "It is decidedly so.", "Without a doubt.", "Yes — definitely.",
    "You may rely on it.", "As I see it, yes.", "Most likely.", "Outlook good.",
    "Yes.", "Signs point to yes.", "Reply hazy, try again.", "Ask again later.",
    "Better not tell you now.", "Cannot predict now.", "Concentrate and ask again.",
    "Don't count on it.", "My reply is no.", "My sources say no.",
    "Outlook not so good.", "Very doubtful.",
)


def _roll(args: str) -> dict:
    m = DICE_RE.match(args or "1d6")
    if not m:
        raise ProtocolError(P.BAD_REQUEST, "Rolls look like 2d6, d20 or 3d10+2")
    count = int(m.group(1) or 1)
    sides = int(m.group(2))
    modifier = int(m.group(4) or 0) * (-1 if m.group(3) == "-" else 1)
    if not 1 <= count <= P.MAX_DICE:
        raise ProtocolError(P.BAD_REQUEST, f"Roll between 1 and {P.MAX_DICE} dice")
    if not 2 <= sides <= P.MAX_DIE_SIDES:
        raise ProtocolError(P.BAD_REQUEST, f"Dice have 2 to {P.MAX_DIE_SIDES} sides")
    if abs(modifier) > P.MAX_DICE_MODIFIER:
        raise ProtocolError(P.BAD_REQUEST, "That modifier is too big")
    rolls = [secrets.randbelow(sides) + 1 for _ in range(count)]
    total = sum(rolls) + modifier
    notation = f"{count}d{sides}" + (f"{modifier:+d}" if modifier else "")
    return {"notation": notation, "rolls": rolls, "modifier": modifier, "total": total}


def _choose(args: str) -> dict:
    options = [o.strip() for o in (args or "").split("|") if o.strip()]
    if len(options) < 2:
        raise ProtocolError(P.BAD_REQUEST, "Give at least two options, separated by |")
    if len(options) > P.MAX_CHOICES:
        raise ProtocolError(P.BAD_REQUEST, f"At most {P.MAX_CHOICES} options")
    return {"options": options, "picked": options[secrets.randbelow(len(options))]}


def run(name: str, args: str) -> dict:
    """The stored `command` object for a server-rolled command."""
    if name not in P.SERVER_COMMANDS:
        raise ProtocolError(P.BAD_REQUEST, f"Unknown command /{name}")
    if len(args or "") > P.COMMAND_ARGS_MAX:
        raise ProtocolError(P.BAD_REQUEST, "That's too long")
    args = (args or "").strip()
    if name == "roll":
        return {"name": "roll", "args": args, "result": _roll(args)}
    if name == "coinflip":
        return {"name": "coinflip", "args": "", "result": {"side": "heads" if secrets.randbelow(2) else "tails"}}
    if name == "8ball":
        if not args:
            raise ProtocolError(P.BAD_REQUEST, "Ask it something")
        return {"name": "8ball", "args": args, "result": {"answer": EIGHT_BALL[secrets.randbelow(len(EIGHT_BALL))]}}
    return {"name": "choose", "args": args, "result": _choose(args)}


def validate(payload: dict) -> dict | None:
    """Reads message.send's optional `command` field."""
    raw = payload.get("command")
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ProtocolError(P.BAD_REQUEST, "'command' must be an object")
    name = raw.get("name")
    if not isinstance(name, str) or name not in P.SERVER_COMMANDS:
        raise ProtocolError(P.BAD_REQUEST, f"'command.name' must be one of {', '.join(P.SERVER_COMMANDS)}")
    args = raw.get("args") or ""
    if not isinstance(args, str):
        raise ProtocolError(P.BAD_REQUEST, "'command.args' must be a string")
    return run(name, args)
