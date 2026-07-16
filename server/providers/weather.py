"""Weather via Open-Meteo — keyless, so it works out of the box (better graceful
degradation than a key-gated API). Uses resolved geolocation unless the widget
passes lat/lon/units in its settings.
"""

from __future__ import annotations

from typing import Any

import httpx

from ..shared.geo import get_location
from ..shared.providers import Provider, register

_WMO = {
    0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Rime fog", 51: "Light drizzle", 53: "Drizzle",
    55: "Heavy drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain",
    71: "Light snow", 73: "Snow", 75: "Heavy snow", 80: "Showers",
    81: "Showers", 82: "Violent showers", 95: "Thunderstorm",
    96: "Thunderstorm + hail", 99: "Thunderstorm + hail",
}


class WeatherProvider(Provider):
    name = "weather"
    ttl = 600.0  # 10 min

    async def fetch(self, params: dict[str, Any]) -> dict[str, Any]:
        loc = await get_location()
        lat = float(params.get("lat") or loc["lat"])
        lon = float(params.get("lon") or loc["lon"])
        units = params.get("units", "imperial")  # imperial | metric
        temp_unit = "fahrenheit" if units == "imperial" else "celsius"
        wind_unit = "mph" if units == "imperial" else "kmh"
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(
                "https://api.open-meteo.com/v1/forecast",
                params={
                    "latitude": lat,
                    "longitude": lon,
                    "current": "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m",
                    "daily": "weather_code,temperature_2m_max,temperature_2m_min",
                    "temperature_unit": temp_unit,
                    "wind_speed_unit": wind_unit,
                    "timezone": "auto",
                    "forecast_days": 5,
                },
            )
            r.raise_for_status()
            d = r.json()
        cur = d.get("current", {})
        daily = d.get("daily", {})
        days = []
        for i, day in enumerate(daily.get("time", [])):
            code = daily["weather_code"][i]
            days.append({
                "date": day,
                "code": code,
                "summary": _WMO.get(code, "—"),
                "max": daily["temperature_2m_max"][i],
                "min": daily["temperature_2m_min"][i],
            })
        code = cur.get("weather_code")
        return {
            "location": {"city": loc.get("city"), "region": loc.get("region")},
            "units": units,
            "current": {
                "temp": cur.get("temperature_2m"),
                "feelsLike": cur.get("apparent_temperature"),
                "humidity": cur.get("relative_humidity_2m"),
                "wind": cur.get("wind_speed_10m"),
                "code": code,
                "summary": _WMO.get(code, "—"),
            },
            "forecast": days,
        }


register(WeatherProvider())
