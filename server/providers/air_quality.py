"""Air quality via Open-Meteo — keyless. US AQI + key pollutants for the resolved
location (or widget-supplied lat/lon)."""

from __future__ import annotations

from typing import Any

import httpx

from ..shared.geo import get_location
from ..shared.providers import Provider, register


def _category(aqi: float | None) -> str:
    if aqi is None:
        return "—"
    for hi, label in [(50, "Good"), (100, "Moderate"), (150, "Unhealthy (sensitive)"),
                      (200, "Unhealthy"), (300, "Very unhealthy")]:
        if aqi <= hi:
            return label
    return "Hazardous"


class AirQualityProvider(Provider):
    name = "air-quality"
    ttl = 1800.0  # 30 min

    async def fetch(self, params: dict[str, Any]) -> dict[str, Any]:
        loc = await get_location()
        lat = float(params.get("lat") or loc["lat"])
        lon = float(params.get("lon") or loc["lon"])
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(
                "https://air-quality-api.open-meteo.com/v1/air-quality",
                params={
                    "latitude": lat,
                    "longitude": lon,
                    "current": "us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide",
                    "timezone": "auto",
                },
            )
            r.raise_for_status()
            cur = r.json().get("current", {})
        aqi = cur.get("us_aqi")
        return {
            "location": {"city": loc.get("city"), "region": loc.get("region")},
            "aqi": aqi,
            "category": _category(aqi),
            "pollutants": {
                "pm2_5": cur.get("pm2_5"),
                "pm10": cur.get("pm10"),
                "ozone": cur.get("ozone"),
                "no2": cur.get("nitrogen_dioxide"),
            },
        }


register(AirQualityProvider())
