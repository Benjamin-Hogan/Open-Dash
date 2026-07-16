"""Backend data-provider registry — the server-side mirror of the frontend
widget registry.

A data-backed widget = one Provider here + one frontend plugin. The generic
`/api/data/{provider}` route (see server/main.py) looks the provider up, serves
from the shared TTLCache, and only calls `fetch()` on a miss. This is what lets
the two apps drop their duplicated, copy-pasted read endpoints.
"""

from __future__ import annotations

from typing import Any


class Provider:
    """Base class. Subclasses set `name`/`ttl` and implement `fetch`."""

    name: str = ""
    ttl: float = 60.0  # seconds the result stays cached

    async def fetch(self, params: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    def cache_key(self, params: dict[str, Any]) -> str:
        items = "&".join(f"{k}={v}" for k, v in sorted(params.items()))
        return f"provider:{self.name}:{items}"


_registry: dict[str, Provider] = {}


def register(provider: Provider) -> Provider:
    if not provider.name:
        raise ValueError("provider must define a name")
    _registry[provider.name] = provider
    return provider


def get(name: str) -> Provider | None:
    return _registry.get(name)


def names() -> list[str]:
    return sorted(_registry)


def load_builtin() -> None:
    """Import provider modules so their `register(...)` calls run."""
    from ..providers import (  # noqa: F401
        air_quality,
        ical,
        octoprint,
        pi_stats,
        rss,
        space_weather,
        stocks,
        weather,
        youtube,
    )
