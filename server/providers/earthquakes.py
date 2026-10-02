"""Earthquakes near home from the USGS summary feeds — keyless, updated every
minute upstream. Filters the feed to a radius around the home location (or
lat/lon) and a minimum magnitude, and adds distance and bearing from home so
the display can place each quake without doing geodesy.

Feeds: https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php
"""

from __future__ import annotations

import math
from typing import Any

import httpx

from ..shared.geo import get_location
from ..shared.providers import Provider, register

_FEED = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/{level}_{period}.geojson"
_EARTH_KM = 6371.0088
_MAX = 40


def distance_bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> tuple[float, float]:
    """Great-circle distance (km) and initial bearing (degrees from north) from 1 to 2."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    km = 2 * _EARTH_KM * math.asin(min(1.0, math.sqrt(a)))
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return km, (math.degrees(math.atan2(y, x)) + 360) % 360


def _feed_level(min_mag: float) -> str:
    # The smallest feed that still contains everything asked for.
    if min_mag >= 4.5:
        return "4.5"
    if min_mag >= 2.5:
        return "2.5"
    return "1.0"


def nearby(features: list[dict], lat: float, lon: float, radius_km: float, min_mag: float) -> list[dict[str, Any]]:
    """Quakes within radius and at or over min magnitude, newest first. Exported for tests."""
    out = []
    for f in features or []:
        p = f.get("properties") or {}
        coords = (f.get("geometry") or {}).get("coordinates") or []
        mag = p.get("mag")
        if mag is None or len(coords) < 2 or mag < min_mag:
            continue
        km, brg = distance_bearing(lat, lon, coords[1], coords[0])
        if km > radius_km:
            continue
        out.append({
            "id": f.get("id"),
            "mag": round(float(mag), 1),
            "place": p.get("place") or "",
            "time": p.get("time"),  # ms since epoch
            "depthKm": coords[2] if len(coords) > 2 else None,
            "distanceKm": round(km, 1),
            "bearing": round(brg),
            "felt": p.get("felt"),
            "tsunami": bool(p.get("tsunami")),
        })
    out.sort(key=lambda q: q["time"] or 0, reverse=True)
    return out[:_MAX]


class EarthquakesProvider(Provider):
    name = "earthquakes"
    ttl = 300.0

    async def fetch(self, params: dict[str, Any]) -> dict[str, Any]:
        loc = await get_location()
        lat = float(params.get("lat") or loc["lat"])
        lon = float(params.get("lon") or loc["lon"])
        try:
            radius_km = max(10.0, min(5000.0, float(params.get("radiusKm") or 800)))
        except (TypeError, ValueError):
            radius_km = 800.0
        try:
            min_mag = max(0.0, min(9.0, float(params.get("minMagnitude") or 2.5)))
        except (TypeError, ValueError):
            min_mag = 2.5
        period = "day" if params.get("period") == "day" else "week"
        async with httpx.AsyncClient(timeout=10.0, headers={"User-Agent": "OpenDash/3 (+earthquakes)"}) as client:
            r = await client.get(_FEED.format(level=_feed_level(min_mag), period=period))
            r.raise_for_status()
            d = r.json()
        return {
            "home": {"lat": lat, "lon": lon, "city": loc.get("city") or ""},
            "radiusKm": radius_km,
            "minMagnitude": min_mag,
            "period": period,
            "quakes": nearby(d.get("features") or [], lat, lon, radius_km, min_mag),
        }


register(EarthquakesProvider())
