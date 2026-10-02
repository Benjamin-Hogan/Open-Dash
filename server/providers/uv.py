"""UV index via Open-Meteo — keyless. Today's and tomorrow's hourly UV in the
location's local wall clock ("2026-10-02T13:00"), with `now` in the same
terms, so the display can draw today's curve and say "Sunscreen until 5:15 PM"
without guessing a timezone. Same location rules as the weather provider.
"""

from __future__ import annotations

from typing import Any

import httpx

from ..shared.geo import get_location
from ..shared.providers import Provider, register


class UVProvider(Provider):
    name = "uv"
    ttl = 1800.0  # UV forecasts move slowly

    async def fetch(self, params: dict[str, Any]) -> dict[str, Any]:
        loc = await get_location()
        lat = float(params.get("lat") or loc["lat"])
        lon = float(params.get("lon") or loc["lon"])
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(
                "https://api.open-meteo.com/v1/forecast",
                params={
                    "latitude": lat,
                    "longitude": lon,
                    "current": "uv_index,is_day",
                    "hourly": "uv_index",
                    "daily": "uv_index_max",
                    "timezone": "auto",
                    "forecast_days": 2,
                },
            )
            r.raise_for_status()
            d = r.json()
        return shape(d)


def shape(d: dict[str, Any]) -> dict[str, Any]:
    """Open-Meteo's response → the widget's shape. Exported for tests."""
    cur = d.get("current") or {}
    hourly = d.get("hourly") or {}
    daily = d.get("daily") or {}
    times = hourly.get("time") or []
    values = hourly.get("uv_index") or []
    hours = [{"time": t, "uv": values[i] if i < len(values) else None} for i, t in enumerate(times)]
    days = [
        {"date": day, "max": (daily.get("uv_index_max") or [None] * (i + 1))[i]}
        for i, day in enumerate(daily.get("time") or [])
    ]
    return {
        "now": cur.get("time"),
        "today": days[0]["date"] if days else None,
        "current": cur.get("uv_index"),
        "isDay": bool(cur.get("is_day", 1)),
        "hours": hours,
        "days": days,
    }


register(UVProvider())
