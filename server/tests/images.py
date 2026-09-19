"""Tiny image headers for media tests (the server only reads headers)."""

import struct


def png(w=64, h=64, animated=False) -> bytes:
    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + b"\0\0\0\0"

    out = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    if animated:
        out += chunk(b"acTL", struct.pack(">II", 2, 0))
    return out + chunk(b"IDAT", b"\0" * 16) + chunk(b"IEND", b"")


def gif(w=64, h=64, animated=False) -> bytes:
    out = b"GIF89a" + struct.pack("<HH", w, h) + b"\0\0\0"
    if animated:
        out += b"\x21\xff\x0bNETSCAPE2.0\x03\x01\0\0\0" + b"\x21\xf9\x04\0\0\0\0\0" * 2
    return out + b"\x3b"


def webp(w=64, h=64, animated=False) -> bytes:
    body = bytes([0x02 if animated else 0, 0, 0, 0]) + (w - 1).to_bytes(3, "little") + (h - 1).to_bytes(3, "little")
    chunk = b"VP8X" + struct.pack("<I", len(body)) + body
    return b"RIFF" + struct.pack("<I", 4 + len(chunk)) + b"WEBP" + chunk


def jpeg(w=64, h=64) -> bytes:
    sof = b"\xff\xc0" + struct.pack(">HBHHB", 11, 8, h, w, 1) + b"\x01\x11\x00"
    return b"\xff\xd8" + b"\xff\xe0" + struct.pack(">H", 4) + b"\0\0" + sof + b"\xff\xd9"


async def upload(server, c, kind, data):
    return await server.post("/media", params={"kind": kind}, data=data, headers={"Authorization": f"Bearer {c.token}"})


async def media_id(server, c, kind, data) -> str:
    r = await upload(server, c, kind, data)
    assert r.status == 200, await r.text()
    return (await r.json())["media"]["media_id"]
