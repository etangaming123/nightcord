#!/usr/bin/env python3
"""Generate Nightcord's default logo and sound effects (no dependencies).

    python tools/gen_assets.py

Writes client/assets/logo.png and client/assets/sounds/*.wav. These are only
the defaults: replace any of the files with your own (same name and format)
and the client picks them up — see README → Customising. Running this again
overwrites your replacements, so only do that to get the defaults back.
"""

from __future__ import annotations

import math
import struct
import wave
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "client" / "assets"

# Brand palette.
PLUM = (0x88, 0x44, 0x99)
ROSE = (0xBB, 0x66, 0x88)
LAVENDER = (0x88, 0x88, 0xCC)
SAND = (0xCC, 0xAA, 0x88)
BLUSH = (0xDD, 0xAA, 0xCC)


# --- logo -----------------------------------------------------------------------

def _png(path: Path, width: int, height: int, rgba: bytearray) -> None:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    stride = width * 4
    raw = b"".join(b"\0" + bytes(rgba[y * stride:(y + 1) * stride]) for y in range(height))
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def _in_rounded_square(x: float, y: float, r: float) -> bool:
    cx = min(max(x, r), 1 - r)
    cy = min(max(y, r), 1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def _in_crescent(x: float, y: float) -> bool:
    inside = (x - 0.46) ** 2 + (y - 0.52) ** 2 <= 0.29 ** 2
    bite = (x - 0.60) ** 2 + (y - 0.40) ** 2 <= 0.25 ** 2
    return inside and not bite


def _in_sparkle(x: float, y: float, cx: float, cy: float, size: float) -> bool:
    # A four-pointed star: |dx|^0.5 + |dy|^0.5 <= size^0.5
    dx, dy = abs(x - cx), abs(y - cy)
    return math.sqrt(dx) + math.sqrt(dy) <= math.sqrt(size)


def _mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def logo(size: int = 512, samples: int = 3) -> None:
    rgba = bytearray(size * size * 4)
    step = 1 / (size * samples)
    for py in range(size):
        for px in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(samples):
                for sx in range(samples):
                    x = (px * samples + sx + 0.5) * step
                    y = (py * samples + sy + 0.5) * step
                    if not _in_rounded_square(x, y, 0.22):
                        continue
                    if _in_crescent(x, y):
                        color = BLUSH
                    elif _in_sparkle(x, y, 0.77, 0.75, 0.07) or _in_sparkle(x, y, 0.80, 0.30, 0.035):
                        color = SAND
                    else:
                        color = _mix(PLUM, ROSE, (x + y) / 2)  # diagonal gradient
                    acc[0] += color[0]
                    acc[1] += color[1]
                    acc[2] += color[2]
                    acc[3] += 255
            n = samples * samples
            covered = acc[3] / 255
            i = (py * size + px) * 4
            if covered:
                rgba[i:i + 4] = bytes((round(acc[0] / covered), round(acc[1] / covered), round(acc[2] / covered), round(acc[3] / n)))
    _png(ASSETS / "logo.png", size, size, rgba)


# --- sounds ---------------------------------------------------------------------

RATE = 44100


def _tone(f0: float, f1: float, glide: float, length: float, peak: float = 0.3) -> list[float]:
    """A sine gliding exponentially from f0 to f1 over `glide` seconds with a
    fast attack and exponential decay — the original synthesised blip."""
    out, phase = [], 0.0
    for i in range(int(RATE * length)):
        t = i / RATE
        f = f0 * (f1 / f0) ** min(1.0, t / glide)
        phase += 2 * math.pi * f / RATE
        env = min(1.0, t / 0.01) * math.exp(-t * 18)
        out.append(math.sin(phase) * env * peak)
    return out


def _wav(name: str, samples: list[float]) -> None:
    with wave.open(str(ASSETS / "sounds" / name), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", max(-32767, min(32767, int(s * 32767)))) for s in samples))


def _concat(*parts: list[float], gap: float = 0.0) -> list[float]:
    out: list[float] = []
    for p in parts:
        out += p + [0.0] * int(RATE * gap)
    return out


def sounds() -> None:
    (ASSETS / "sounds").mkdir(parents=True, exist_ok=True)
    blip = _tone(880, 1320, 0.08, 0.3)
    _wav("message.wav", blip)
    _wav("mention.wav", blip)  # same default; swap in something louder if you like
    _wav("voice-join.wav", _concat(_tone(660, 660, 0.01, 0.12), _tone(990, 990, 0.01, 0.22), gap=0.02))
    _wav("voice-leave.wav", _concat(_tone(990, 990, 0.01, 0.12), _tone(660, 660, 0.01, 0.22), gap=0.02))


if __name__ == "__main__":
    ASSETS.mkdir(parents=True, exist_ok=True)
    logo()
    sounds()
    print(f"wrote {ASSETS.relative_to(ROOT)}/logo.png and sounds/*.wav")
