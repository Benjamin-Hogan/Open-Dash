"""The home location (settings → Appearance → Home location, else IP lookup,
else the Phoenix fallback). Widgets that compute things locally — Sun & Moon —
need coordinates but no other data, so this is all they fetch."""

from __future__ import annotations

from typing import Any

from ..shared.geo import get_location
from ..shared.providers import Provider, register


class LocationProvider(Provider):
    name = "location"
    ttl = 3600.0

    async def fetch(self, params: dict[str, Any]) -> dict[str, Any]:
        loc = await get_location()
        return {
            "lat": float(loc["lat"]),
            "lon": float(loc["lon"]),
            "city": loc.get("city") or "",
            "region": loc.get("region") or "",
        }


register(LocationProvider())
