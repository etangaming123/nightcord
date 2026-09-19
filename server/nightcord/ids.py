"""Snowflake-style IDs: (ms since epoch << 12) | per-ms sequence, as strings.

IDs sort by creation time, which makes message pagination a numeric
comparison. See PROTOCOL.md §4 "IDs".
"""

from __future__ import annotations

import threading
import time

_lock = threading.Lock()
_last_ms = 0
_seq = 0


def new_id() -> str:
    global _last_ms, _seq
    with _lock:
        now = int(time.time() * 1000)
        if now <= _last_ms:
            # Same millisecond (or clock went backwards): bump the sequence and
            # borrow from the next millisecond if it overflows.
            now = _last_ms
            _seq += 1
            if _seq >= 4096:
                now += 1
                _seq = 0
        else:
            _seq = 0
        _last_ms = now
        return str((now << 12) | _seq)
