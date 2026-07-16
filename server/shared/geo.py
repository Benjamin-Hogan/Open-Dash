"""Best-effort IP geolocation with a graceful fallback to Phoenix, AZ.

Cached for the process lifetime; widgets that need a location (weather, sun/moon)
read from here so they don't each re-resolve.
"""

from __future__ import annotations

import httpx

# Graceful-degradation default (matches the original project's fallback).
FALLBACK = {"lat": 33.4484, "lon": -112.0740, "city": "Phoenix", "region": "AZ"}

_resolved: dict | None = None


async def get_location() -> dict:
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
            }
    except Exception:
        _resolved = dict(FALLBACK)
    return _resolved
