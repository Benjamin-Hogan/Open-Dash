"""Tiny in-process TTL cache, exposed through a PUBLIC API.

The original reached into `cache._store.clear()` from four call sites, leaking
the abstraction. Here every operation has a method; nothing pokes internals.
"""

from __future__ import annotations

import time
from typing import Any


class TTLCache:
    def __init__(self, max_entries: int = 256) -> None:
        self._store: dict[str, tuple[float, Any]] = {}  # key -> (expires_at, value)
        self._max_entries = max_entries

    def get(self, key: str) -> Any | None:
        item = self._store.get(key)
        if item is None:
            return None
        expires_at, value = item
        if expires_at < time.monotonic():
            self._store.pop(key, None)
            return None
        # Refresh insertion order for LRU eviction (CPython 3.7+ dict order).
        self._store.pop(key)
        self._store[key] = (expires_at, value)
        return value

    def set(self, key: str, value: Any, ttl: float) -> None:
        self._store.pop(key, None)
        self._store[key] = (time.monotonic() + ttl, value)
        while len(self._store) > self._max_entries:
            oldest = next(iter(self._store))
            self._store.pop(oldest, None)

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
