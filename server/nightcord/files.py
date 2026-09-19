"""Attachment storage helpers: signed URLs and content sniffing (PROTOCOL.md §2 HTTP).

Files live in <data_dir>/files/<attachment_id>; metadata lives in the
attachments table. Download URLs are signed with a per-server secret and
expire, so a leaked link stops working on its own.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import time
import urllib.parse

DAY = 86400
URL_LIFETIME_DAYS = 7

# Served inline with their real type; everything else is a download.
INLINE_TYPES = {
    "image/png", "image/jpeg", "image/gif", "image/webp",
    "video/mp4", "video/webm",
    "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm", "audio/mp4",
}

TEXT_EXTENSIONS = {
    "txt", "md", "markdown", "log", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "conf",
    "xml", "html", "htm", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt",
    "c", "h", "cpp", "hpp", "cc", "cs", "php", "sh", "bash", "zsh", "fish", "ps1", "bat", "sql", "lua", "swift",
    "r", "pl", "hs", "ex", "exs", "erl", "clj", "scala", "dart", "vue", "svelte", "diff", "patch", "env", "srt",
    "vtt", "tex", "rst", "adoc", "gitignore", "dockerfile", "makefile",
}

_FILENAME_BAD = re.compile(r"[\x00-\x1f\x7f/\\:*?\"<>|]+")


def clean_filename(name: str) -> str:
    name = _FILENAME_BAD.sub("_", name).strip(" .")
    if not name:
        name = "file"
    if len(name) > 128:
        stem, dot, ext = name.rpartition(".")
        name = (stem[: 120 - len(ext)] + dot + ext) if dot and len(ext) <= 8 else name[:128]
    return name


def expiry(now: float | None = None) -> int:
    """URLs expire URL_LIFETIME_DAYS after the start of the current UTC day,
    so a URL stays the same (and cacheable) for a whole day."""
    now = time.time() if now is None else now
    return (int(now) // DAY + 1 + URL_LIFETIME_DAYS) * DAY


def signature(secret: str, attachment_id: str, exp: int) -> str:
    msg = f"{attachment_id}:{exp}".encode()
    return hmac.new(secret.encode(), msg, hashlib.sha256).hexdigest()[:32]


def signed_url(secret: str, attachment_id: str, filename: str, now: float | None = None) -> str:
    exp = expiry(now)
    return (
        f"/files/{attachment_id}/{urllib.parse.quote(filename)}"
        f"?exp={exp}&sig={signature(secret, attachment_id, exp)}"
    )


def verify(secret: str, attachment_id: str, exp: str, sig: str) -> bool:
    if not exp.isdigit() or int(exp) < time.time():
        return False
    return hmac.compare_digest(signature(secret, attachment_id, int(exp)), sig)


def sniff(head: bytes, filename: str) -> str:
    """Content type from the first bytes of a file. Never trusts the client."""
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "audio/wav"
    if len(head) >= 12 and head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand.startswith(b"M4A"):
            return "audio/mp4"
        return "video/mp4"
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return "audio/webm" if filename.lower().endswith(".weba") else "video/webm"
    if head.startswith(b"OggS"):
        return "audio/ogg"
    if head.startswith(b"ID3") or head[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        return "audio/mpeg"
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else filename.lower()
    if ext in TEXT_EXTENSIONS and b"\x00" not in head:
        try:
            head.decode("utf-8")
            return "text/plain"
        except UnicodeDecodeError as e:
            # A multi-byte character cut off at the end of the sample is fine.
            if e.start >= len(head) - 3:
                return "text/plain"
    return "application/octet-stream"


def image_info(data: bytes) -> tuple[int, int, bool] | None:
    """(width, height, animated) for a PNG/APNG, JPEG, GIF or WebP image,
    read from its headers only (no decoding). None if unrecognised."""
    try:
        if data.startswith(b"\x89PNG\r\n\x1a\n") and data[12:16] == b"IHDR":
            w, h = int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
            # APNG: an acTL chunk before the first IDAT.
            pos, animated = 8, False
            while pos + 8 <= len(data):
                length = int.from_bytes(data[pos : pos + 4], "big")
                kind = data[pos + 4 : pos + 8]
                if kind == b"acTL":
                    animated = True
                    break
                if kind == b"IDAT":
                    break
                pos += 12 + length
            return w, h, animated
        if data[:6] in (b"GIF87a", b"GIF89a"):
            w, h = int.from_bytes(data[6:8], "little"), int.from_bytes(data[8:10], "little")
            return w, h, b"NETSCAPE2.0" in data or data.count(b"\x21\xf9\x04") > 1
        if len(data) >= 30 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            chunk = data[12:16]
            if chunk == b"VP8X":
                w = int.from_bytes(data[24:27], "little") + 1
                h = int.from_bytes(data[27:30], "little") + 1
                return w, h, bool(data[20] & 0x02)
            if chunk == b"VP8 ":
                w = int.from_bytes(data[26:28], "little") & 0x3FFF
                h = int.from_bytes(data[28:30], "little") & 0x3FFF
                return w, h, False
            if chunk == b"VP8L":
                bits = int.from_bytes(data[21:25], "little")
                return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1, False
            return None
        if data.startswith(b"\xff\xd8"):
            pos = 2
            while pos + 9 < len(data):
                if data[pos] != 0xFF:
                    pos += 1
                    continue
                marker = data[pos + 1]
                if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7 or marker == 0xFF:
                    pos += 1 if marker == 0xFF else 2
                    continue
                length = int.from_bytes(data[pos + 2 : pos + 4], "big")
                if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                    h = int.from_bytes(data[pos + 5 : pos + 7], "big")
                    w = int.from_bytes(data[pos + 7 : pos + 9], "big")
                    return w, h, False
                pos += 2 + length
            return None
    except (IndexError, ValueError):
        return None
    return None
