"""Space weather via NOAA SWPC — keyless. Planetary K-index (geomagnetic
activity) plus a simple aurora-likelihood read.
"""

from __future__ import annotations

from typing import Any

import httpx

from ..shared.providers import Provider, register

_KP_URL = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json"


def _parse_series(rows: list) -> list[dict]:
    """Full [{t, kp}] series. Tolerant of both NOAA shapes: array-of-objects and
    array-of-arrays (whose first row is the header)."""
    out: list[dict] = []
    if not rows:
        return out
    if isinstance(rows[0], dict):  # [{time_tag, Kp, ...}, ...]
        for r in rows:
            try:
                out.append({"t": r.get("time_tag"), "kp": float(r.get("Kp") or r.get("kp") or 0)})
            except (TypeError, ValueError):
                continue
        return out
    header = rows[0]
    idx = header.index("Kp") if "Kp" in header else 1
    for r in rows[1:]:
        try:
            out.append({"t": r[0], "kp": float(r[idx])})
        except (TypeError, ValueError, IndexError):
            continue
    return out


def _aurora_label(kp: float) -> str:
    if kp >= 7:
        return "Strong — aurora likely at mid-latitudes"
    if kp >= 5:
        return "Active — storm; aurora possible"
    if kp >= 4:
        return "Unsettled"
    return "Quiet"


class SpaceWeatherProvider(Provider):
    name = "space-weather"
    ttl = 900.0  # 15 min

    async def fetch(self, params: dict[str, Any]) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(_KP_URL)
            r.raise_for_status()
            rows = r.json()
        series = _parse_series(rows)
        kp = series[-1]["kp"] if series else 0.0
        observed = series[-1]["t"] if series else None
        return {
            "kp": kp,
            "observedAt": observed,
            "aurora": _aurora_label(kp),
            # last 24 observations (~3-hour cadence upstream, but the JSON feed is
            # minutely-ish; the widget thins it) — powers the history bars
            "history": series[-24:],
        }


register(SpaceWeatherProvider())
