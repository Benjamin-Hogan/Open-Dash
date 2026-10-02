"""Tide predictions from NOAA CO-OPS — keyless, US coasts and territories.

Returns the station's highs and lows from yesterday to two days out as UTC
instants; the display interpolates the curve between them (the standard
cosine method) so one small request draws the whole day.

With no station chosen it picks the prediction station nearest home, from
NOAA's station list (cached for a week). Homes far from any coast get
`station: null` and a reason, which the widget shows as its setup state.
"""

from __future__ import annotations

import datetime as dt
import re
import time
from typing import Any

import httpx

from ..shared.geo import get_location
from ..shared.providers import Provider, register
from .earthquakes import distance_bearing

_STATIONS = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions"
_PREDICTIONS = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
_NEAREST_MAX_KM = 250.0
_STATION_RE = re.compile(r"^[A-Za-z0-9]{5,10}$")
_HEADERS = {"User-Agent": "OpenDash/3 (+tides)"}

_station_cache: dict[str, Any] = {"at": 0.0, "list": []}


async def _stations(client: httpx.AsyncClient) -> list[dict[str, Any]]:
    if _station_cache["list"] and time.time() - _station_cache["at"] < 7 * 86400:
        return _station_cache["list"]
    r = await client.get(_STATIONS)
    r.raise_for_status()
    found = []
    for s in r.json().get("stations") or []:
        try:
            found.append({"id": str(s["id"]), "name": s.get("name") or "", "state": s.get("state") or "",
                          "lat": float(s["lat"]), "lon": float(s["lng"])})
        except (KeyError, TypeError, ValueError):
            continue
    _station_cache.update(at=time.time(), list=found)
    return found


def nearest(stations: list[dict[str, Any]], lat: float, lon: float) -> tuple[dict[str, Any] | None, float]:
    """The closest station and its distance in km. Exported for tests."""
    best, best_km = None, float("inf")
    for s in stations:
        km, _ = distance_bearing(lat, lon, s["lat"], s["lon"])
        if km < best_km:
            best, best_km = s, km
    return best, best_km


def parse_hilo(predictions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """NOAA hilo rows ({"t": "2026-10-02 05:18", "v": "-0.213", "type": "L"}, GMT)
    → [{"time": "2026-10-02T05:18:00Z", "height": -0.21, "high": False}]."""
    out = []
    for p in predictions or []:
        try:
            t = dt.datetime.strptime(p["t"], "%Y-%m-%d %H:%M")
            out.append({"time": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "height": round(float(p["v"]), 2), "high": str(p.get("type", "")).upper().startswith("H")})
        except (KeyError, TypeError, ValueError):
            continue
    return out


class TidesProvider(Provider):
    name = "tides"
    ttl = 3 * 3600.0  # predictions don't change

    async def fetch(self, params: dict[str, Any]) -> dict[str, Any]:
        station_id = str(params.get("station") or "").strip()
        units = "metric" if params.get("units") == "metric" else "english"
        async with httpx.AsyncClient(timeout=10.0, headers=_HEADERS) as client:
            station: dict[str, Any] | None = None
            if station_id:
                if not _STATION_RE.match(station_id):
                    return {"station": None, "reason": "bad-station", "events": []}
                try:
                    station = next((s for s in await _stations(client) if s["id"] == station_id), None)
                except httpx.HTTPError:
                    station = None
                station = station or {"id": station_id, "name": f"Station {station_id}", "state": ""}
            else:
                loc = await get_location()
                station, km = nearest(await _stations(client), float(loc["lat"]), float(loc["lon"]))
                if station is None or km > _NEAREST_MAX_KM:
                    return {"station": None, "reason": "no-station-nearby", "events": []}
            today = dt.datetime.now(dt.timezone.utc).date()
            r = await client.get(_PREDICTIONS, params={
                "begin_date": (today - dt.timedelta(days=1)).strftime("%Y%m%d"),
                "end_date": (today + dt.timedelta(days=2)).strftime("%Y%m%d"),
                "station": station["id"],
                "product": "predictions",
                "datum": "MLLW",
                "time_zone": "gmt",
                "interval": "hilo",
                "units": units,
                "application": "OpenDash",
                "format": "json",
            })
            r.raise_for_status()
            d = r.json()
        if "error" in d:
            return {"station": None, "reason": "bad-station", "events": []}
        return {
            "station": {"id": station["id"], "name": station.get("name") or "", "state": station.get("state") or ""},
            "units": "m" if units == "metric" else "ft",
            "events": parse_hilo(d.get("predictions") or []),
        }


register(TidesProvider())
