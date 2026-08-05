"""Heads-up strip aggregator — one fetch for weather, calendar, and print status."""

from __future__ import annotations

from typing import Any

from ..providers import ical as ical_mod
from ..providers import octoprint as octo_mod
from ..providers import weather as weather_mod
from ..shared.providers import Provider, register


class HeadsUpProvider(Provider):
    name = "heads-up"
    ttl = 30.0

    async def fetch(self, params: dict[str, Any]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if _truthy(params.get("showWeather")):
            try:
                out["weather"] = await weather_mod.WeatherProvider().fetch({
                    "units": params.get("units") or "imperial",
                    "lat": params.get("lat"),
                    "lon": params.get("lon"),
                })
            except Exception as exc:
                out["weatherError"] = str(exc)
        if _truthy(params.get("showCalendar")):
            url = params.get("icalUrl")
            if not url:
                url = _first_ical_url()
            if url:
                try:
                    data = await ical_mod.ICalProvider().fetch({
                        "url": url,
                        "count": "5",
                        "lookaheadDays": str(params.get("lookaheadDays") or 7),
                    })
                    out["calendar"] = _next_event(data.get("events") or [])
                except Exception as exc:
                    out["calendarError"] = str(exc)
        if _truthy(params.get("showPrint")):
            url = params.get("octoprintUrl")
            widget_id = params.get("widgetId")
            if not url:
                url, widget_id = _first_octoprint()
            if url:
                try:
                    op_params: dict[str, Any] = {"url": url}
                    if widget_id:
                        op_params["widgetId"] = widget_id
                    out["print"] = await octo_mod.OctoPrintProvider().fetch(op_params)
                except Exception as exc:
                    out["printError"] = str(exc)
        return out


def _truthy(v: Any) -> bool:
    if v is True:
        return True
    if v is None:
        return False
    return str(v).lower() in ("1", "true", "yes", "on")


def _first_ical_url() -> str | None:
    from ..shared import config as config_store

    for page in config_store.get_config().pages:
        for w in page.widgets:
            if w.type == "ical" and w.settings.get("url"):
                return str(w.settings["url"])
    return None


def _first_octoprint() -> tuple[str | None, str | None]:
    from ..shared import config as config_store

    for page in config_store.get_config().pages:
        for w in page.widgets:
            if w.type == "octoprint" and w.settings.get("url"):
                return str(w.settings["url"]), w.id
    return None, None


def _next_event(events: list[dict]) -> dict[str, Any] | None:
    import time

    now = time.time() * 1000
    upcoming = []
    for ev in events:
        start = ev.get("start")
        if not start:
            continue
        try:
            ts = _parse_iso(start)
        except Exception:
            continue
        if ts >= now:
            upcoming.append((ts, ev))
    if not upcoming:
        return None
    upcoming.sort(key=lambda x: x[0])
    _, ev = upcoming[0]
    return {"title": ev.get("title") or "Event", "start": ev.get("start"), "location": ev.get("location")}


def _parse_iso(value: str) -> float:
    from datetime import datetime, timezone

    v = value.strip()
    if len(v) == 10 and v[4] == "-":
        dt = datetime.strptime(v, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        return dt.timestamp() * 1000
    if v.endswith("Z"):
        dt = datetime.strptime(v.rstrip("Z"), "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
        return dt.timestamp() * 1000
    dt = datetime.fromisoformat(v)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp() * 1000


register(HeadsUpProvider())
