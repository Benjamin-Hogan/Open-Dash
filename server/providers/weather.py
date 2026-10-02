"""Weather via Open-Meteo — keyless, so it works out of the box (better graceful
degradation than a key-gated API). Uses resolved geolocation unless the widget
passes lat/lon/units in its settings.

Feeds Weather (current + days + a few hours), Next 24 hours (hourly
temperature and chance of rain), Wind (direction, gusts) and Week ahead. Times are the location's local wall
clock ("2026-10-01T18:00"), with `today` and `now` in the same terms, so the
display never has to guess a timezone to label "Today" or "9 PM".
"""

from __future__ import annotations

from typing import Any

import httpx

from ..shared.geo import get_location
from ..shared.providers import Provider, register

_WMO = {
    0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Rime fog", 51: "Light drizzle", 53: "Drizzle",
    55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
    71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
    80: "Showers", 81: "Showers", 82: "Violent showers", 85: "Snow showers", 86: "Snow showers",
    95: "Thunderstorm", 96: "Thunderstorm + hail", 99: "Thunderstorm + hail",
}

HOURS = 25  # now + the next 24 hours


def _at(seq: list | None, i: int) -> Any:
    return seq[i] if seq and i < len(seq) else None


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
                    "current": "temperature_2m,apparent_temperature,relative_humidity_2m,"
                               "weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day",
                    "daily": "weather_code,temperature_2m_max,temperature_2m_min,"
                             "precipitation_probability_max,sunrise,sunset",
                    "hourly": "temperature_2m,precipitation_probability,weather_code,is_day,"
                              "wind_speed_10m,wind_direction_10m,wind_gusts_10m",
                    "forecast_hours": HOURS,
                    "temperature_unit": temp_unit,
                    "wind_speed_unit": wind_unit,
                    "timezone": "auto",
                    "forecast_days": 7,  # Weather shows five; Week ahead shows seven
                },
            )
            r.raise_for_status()
            d = r.json()
        cur = d.get("current", {})
        daily = d.get("daily", {})
        hourly = d.get("hourly", {})

        days = []
        for i, day in enumerate(daily.get("time", [])):
            code = _at(daily.get("weather_code"), i)
            days.append({
                "date": day,  # local calendar date, "YYYY-MM-DD"
                "code": code,
                "summary": _WMO.get(code, "—"),
                "max": _at(daily.get("temperature_2m_max"), i),
                "min": _at(daily.get("temperature_2m_min"), i),
                "rain": _at(daily.get("precipitation_probability_max"), i),
                "sunrise": _at(daily.get("sunrise"), i),
                "sunset": _at(daily.get("sunset"), i),
            })

        hours = []
        for i, t in enumerate(hourly.get("time", [])[:HOURS]):
            hours.append({
                "time": t,  # local wall clock, "YYYY-MM-DDTHH:MM"
                "temp": _at(hourly.get("temperature_2m"), i),
                "rain": _at(hourly.get("precipitation_probability"), i),
                "code": _at(hourly.get("weather_code"), i),
                "isDay": bool(_at(hourly.get("is_day"), i)),
                "wind": _at(hourly.get("wind_speed_10m"), i),
                "windDir": _at(hourly.get("wind_direction_10m"), i),
                "gust": _at(hourly.get("wind_gusts_10m"), i),
            })

        code = cur.get("weather_code")
        return {
            "location": {"city": loc.get("city"), "region": loc.get("region"), "lat": lat, "lon": lon},
            "units": units,
            "today": days[0]["date"] if days else None,
            "now": cur.get("time"),
            "utcOffsetSeconds": d.get("utc_offset_seconds"),
            "current": {
                "temp": cur.get("temperature_2m"),
                "feelsLike": cur.get("apparent_temperature"),
                "humidity": cur.get("relative_humidity_2m"),
                "wind": cur.get("wind_speed_10m"),
                "windUnit": wind_unit,
                "windDir": cur.get("wind_direction_10m"),  # degrees the wind comes FROM
                "gust": cur.get("wind_gusts_10m"),
                "code": code,
                "isDay": bool(cur.get("is_day", 1)),
                "summary": _WMO.get(code, "—"),
                "rain": hours[0]["rain"] if hours else None,
            },
            "forecast": days,
            "hourly": hours,
        }


register(WeatherProvider())
