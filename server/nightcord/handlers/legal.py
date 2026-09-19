"""legal.* handlers: the server's Terms of Service and Privacy Policy (PROTOCOL.md §8b).

The documents are Markdown files in <data_dir>/legal/. Their combined hash is
the "legal version"; users accept a version when registering and again after
the documents change.
"""

from __future__ import annotations

import hashlib

from .. import protocol as P
from ..protocol import ProtocolError
from . import handles

DOCS = ("terms", "privacy")


def legal_dir(ctx):
    return ctx.config.data_dir / "legal"


def read_docs(ctx) -> dict[str, str | None]:
    out = {}
    for name in DOCS:
        path = legal_dir(ctx) / f"{name}.md"
        try:
            text = path.read_text(encoding="utf-8").strip()
        except (FileNotFoundError, UnicodeDecodeError):
            text = ""
        out[name] = text or None
    return out


def write_doc(ctx, name: str, text: str | None) -> None:
    folder = legal_dir(ctx)
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{name}.md"
    if text:
        path.write_text(text.strip() + "\n", encoding="utf-8")
    else:
        path.unlink(missing_ok=True)


def legal_version(ctx, docs: dict | None = None) -> str | None:
    """None when the server has no documents."""
    docs = docs if docs is not None else read_docs(ctx)
    if not any(docs.values()):
        return None
    h = hashlib.sha256()
    for name in DOCS:
        h.update((docs[name] or "").encode() + b"\0")
    return h.hexdigest()[:16]


def legal_info(ctx) -> dict:
    docs = read_docs(ctx)
    return {
        "legal_version": legal_version(ctx, docs),
        "has_terms": docs["terms"] is not None,
        "has_privacy": docs["privacy"] is not None,
    }


def require_accepted(ctx, payload) -> str | None:
    """For account creation: the current version, which the client must echo."""
    version = legal_version(ctx)
    if version is not None and payload.get("accept_legal_version") != version:
        raise ProtocolError(P.LEGAL_REQUIRED, "Accept the server's Terms of Service and Privacy Policy first")
    return version


@handles(P.LEGAL_GET)
async def get(ctx, conn, payload):
    docs = read_docs(ctx)
    return {"terms": docs["terms"], "privacy": docs["privacy"], "legal_version": legal_version(ctx, docs)}


@handles(P.LEGAL_ACCEPT)
async def accept(ctx, conn, payload):
    from .users import broadcast_user

    version = legal_version(ctx)
    if version is None or payload.get("legal_version") != version:
        raise ProtocolError(P.BAD_REQUEST, "That isn't the current version; reload the documents")
    user = ctx.db.update_profile(conn.user_id, {"legal_version": version})
    await broadcast_user(ctx, user)
    return {"user": user}
