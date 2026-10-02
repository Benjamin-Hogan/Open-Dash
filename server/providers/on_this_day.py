"""Wikipedia's "On this day" selected anniversaries — keyless.

The display passes its own month and day (its midnight, not the server's), and
gets back short items: year, the sentence, and the main article's title and
thumbnail when it has one.
"""

from __future__ import annotations

import re
from typing import Any

import httpx

from ..shared.providers import Provider, register

_URL = "https://api.wikimedia.org/feed/v1/wikipedia/{lang}/onthisday/selected/{mm}/{dd}"
_LANG = re.compile(r"^[a-z]{2,3}$")


def shape(item: dict[str, Any]) -> dict[str, Any] | None:
    """One feed item → {year, text, title, image}. Exported for tests."""
    text = (item.get("text") or "").strip()
    year = item.get("year")
    if not text or not isinstance(year, int):
        return None
    pages = item.get("pages") or []
    # The first page with a picture is usually the subject; the rest are links.
    pic = next((p for p in pages if (p.get("thumbnail") or {}).get("source")), None)
    lead = pic or (pages[0] if pages else {})
    return {
        "year": year,
        "text": text,
        "title": ((lead.get("titles") or {}).get("normalized")) or lead.get("title") or "",
        "image": (pic.get("thumbnail") or {}).get("source") if pic else None,
    }


class OnThisDayProvider(Provider):
    name = "on-this-day"
    ttl = 6 * 3600.0

    async def fetch(self, params: dict[str, Any]) -> dict[str, Any]:
        try:
            month = max(1, min(12, int(params.get("month") or 1)))
            day = max(1, min(31, int(params.get("day") or 1)))
        except (TypeError, ValueError):
            month, day = 1, 1
        lang = str(params.get("lang") or "en").lower()
        if not _LANG.match(lang):
            lang = "en"
        url = _URL.format(lang=lang, mm=f"{month:02d}", dd=f"{day:02d}")
        async with httpx.AsyncClient(timeout=10.0, headers={"User-Agent": "OpenDash/3 (+on-this-day)"}) as client:
            r = await client.get(url)
            r.raise_for_status()
            d = r.json()
        items = [x for x in (shape(i) for i in d.get("selected") or []) if x]
        return {"month": month, "day": day, "items": items}


register(OnThisDayProvider())
