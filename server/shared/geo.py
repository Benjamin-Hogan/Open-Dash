"""Best-effort IP geolocation with a graceful fallback to Phoenix, AZ.

Cached for the process lifetime; widgets that need a location (weather, AQI)
and the NWS alert poller read from here so they don't each re-resolve.

Admin can pin a home location via ``settings.location`` (lat+lon); that overrides
IP lookup until cleared.
"""

from __future__ import annotations

import httpx

# Graceful-degradation default (matches the original project's fallback).
FALLBACK = {"lat": 33.4484, "lon": -112.0740, "city": "Phoenix", "region": "AZ"}

_resolved: dict | None = None


def invalidate() -> None:
    """Drop the cached IP lookup (e.g. after admin clears a home override)."""
    global _resolved
    _resolved = None


def _config_override() -> dict | None:
    """Return a location dict when admin has set both lat and lon; else None."""
    try:
        from . import config as config_store

        loc = config_store.get_config().settings.location
    except Exception:
        return None
    if loc.lat is None or loc.lon is None:
        return None
    return {
        "lat": float(loc.lat),
        "lon": float(loc.lon),
        "city": (loc.city or "").strip(),
        "region": (loc.region or "").strip(),
        "source": "config",
    }


async def get_location() -> dict:
    override = _config_override()
    if override is not None:
        return override

    global _resolved
    if _resolved is not None:
        return _resolved
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            r = await client.get("https://ipapi.co/json/")
            r.raise_for_status()
            d = r.json()
            _resolved = {
                "lat": float(d["latitude"]),
                "lon": float(d["longitude"]),
                "city": d.get("city", ""),
                "region": d.get("region_code", ""),
                "source": "ip",
            }
    except Exception:
        _resolved = {**FALLBACK, "source": "fallback"}
    return _resolved
