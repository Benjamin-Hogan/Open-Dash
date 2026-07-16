"""Tiny in-process TTL cache, exposed through a PUBLIC API.

The original reached into `cache._store.clear()` from four call sites, leaking
the abstraction. Here every operation has a method; nothing pokes internals.
Bounded by ``max_entries`` (LRU-ish: drop oldest expiry first on overflow).
"""

from __future__ import annotations

import time
from typing import Any


class TTLCache:
    def __init__(self, max_entries: int = 256) -> None:
        self._store: dict[str, tuple[float, Any]] = {}  # key -> (expires_at, value)
        self._max_entries = max(8, max_entries)

    def get(self, key: str) -> Any | None:
        item = self._store.get(key)
        if item is None:
            return None
        expires_at, value = item
        if expires_at < time.monotonic():
            self._store.pop(key, None)
            return None
        return value

    def set(self, key: str, value: Any, ttl: float) -> None:
        self._evict_expired()
        if key not in self._store and len(self._store) >= self._max_entries:
            # Drop the entry that expires soonest (approximation of LRU for TTL data).
            oldest = min(self._store.items(), key=lambda kv: kv[1][0])[0]
            self._store.pop(oldest, None)
        self._store[key] = (time.monotonic() + ttl, value)

    def _evict_expired(self) -> None:
        now = time.monotonic()
        dead = [k for k, (exp, _) in self._store.items() if exp < now]
        for k in dead:
            self._store.pop(k, None)

    def invalidate(self, key: str) -> bool:
        """Drop a single key. Returns True if it was present."""
        return self._store.pop(key, None) is not None

    def invalidate_prefix(self, prefix: str) -> int:
        """Drop every key starting with `prefix`. Returns count removed."""
        keys = [k for k in self._store if k.startswith(prefix)]
        for k in keys:
            self._store.pop(k, None)
        return len(keys)

    def clear(self) -> int:
        n = len(self._store)
        self._store.clear()
        return n


# module-global singleton shared by both apps
cache = TTLCache()
