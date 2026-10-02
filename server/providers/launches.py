"""Upcoming rocket launches from The Space Devs' Launch Library 2 — keyless.

The free tier allows 15 requests an hour per IP, so results are cached for
20 minutes and shared by every display; the countdown itself ticks on the
display. Times are UTC instants.
"""

from __future__ import annotations

from typing import Any

import httpx

from ..shared.providers import Provider, register

_URL = "https://ll.thespacedevs.com/2.2.0/launch/upcoming/"
_DONE = {"Success", "Failure", "Partial Failure"}


def _short_place(pad: dict[str, Any]) -> str:
    """"Cape Canaveral SFS, FL, USA" → "Cape Canaveral SFS"."""
    name = ((pad.get("location") or {}).get("name") or pad.get("name") or "").strip()
    return name.split(",")[0].strip()


def shape(row: dict[str, Any]) -> dict[str, Any]:
    """One LL2 launch → the widget's fields. Exported for tests."""
    name = row.get("name") or ""
    rocket_part, _, mission_part = name.partition("|")
    rocket = ((row.get("rocket") or {}).get("configuration") or {}).get("name") or rocket_part.strip()
    mission = (row.get("mission") or {}).get("name") or mission_part.strip() or name
    status = row.get("status") or {}
    lsp = row.get("launch_service_provider") or {}
    provider = lsp.get("abbrev") if len(lsp.get("name") or "") > 22 and lsp.get("abbrev") else lsp.get("name")
    return {
        "id": row.get("id"),
        "rocket": rocket,
        "mission": mission,
        "provider": provider or "",
        "place": _short_place(row.get("pad") or {}),
        "net": row.get("net"),  # best current launch time, UTC
        "windowStart": row.get("window_start"),
        "windowEnd": row.get("window_end"),
        "status": status.get("abbrev") or "TBD",  # Go, TBD, TBC, Hold, In Flight, Success...
        "statusName": status.get("name") or "",
        "probability": row.get("probability"),  # weather, % favourable
        "holdReason": row.get("holdreason") or "",
    }


class LaunchesProvider(Provider):
    name = "launches"
    ttl = 1200.0

    async def fetch(self, params: dict[str, Any]) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=12.0, headers={"User-Agent": "OpenDash/3 (+launches)"}) as client:
            r = await client.get(_URL, params={"limit": 8, "mode": "normal", "hide_recent_previous": "true"})
            r.raise_for_status()
            d = r.json()
        launches = [shape(x) for x in d.get("results") or []]
        return {"launches": [x for x in launches if x["status"] not in _DONE and x["net"]]}


register(LaunchesProvider())
