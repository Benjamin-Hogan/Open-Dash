"""iCal (.ics) agenda — keyless. Fetches a public calendar feed and returns the
upcoming events within a lookahead window, expanding the common recurrence rules
(DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT, UNTIL, weekly BYDAY).

This is a pragmatic parser, not a full RFC 5545 implementation: it covers the
rules real personal/shared calendars use (weekly meetings, monthly bills, yearly
birthdays) and ignores exotica (EXDATE, BYSETPOS, etc.).
"""

from __future__ import annotations

import calendar
import datetime as dt
from typing import Any

import httpx

from ..shared.providers import Provider, register

_WINDOW_DAYS = 60
_MAX_OCCURRENCES = 200          # safety cap per recurring event
_WEEKDAYS = {"MO": 0, "TU": 1, "WE": 2, "TH": 3, "FR": 4, "SA": 5, "SU": 6}


def _unfold(text: str) -> list[str]:
    """RFC 5545 line unfolding: continuation lines start with space/tab."""
    out: list[str] = []
    for raw in text.splitlines():
        if raw[:1] in (" ", "\t") and out:
            out[-1] += raw[1:]
        else:
            out.append(raw)
    return out


def _parse_dt(value: str) -> tuple[dt.datetime, bool]:
    """Return (datetime, all_day). All-day values are 'YYYYMMDD'."""
    v = value.strip()
    if len(v) == 8 and v.isdigit():
        d = dt.datetime.strptime(v, "%Y%m%d")
        return d, True
    z = v.endswith("Z")
    d = dt.datetime.strptime(v.rstrip("Z"), "%Y%m%dT%H%M%S")
    if z:
        d = d.replace(tzinfo=dt.timezone.utc)
    return d, False


def _add_months(d: dt.datetime, months: int) -> dt.datetime:
    m = d.month - 1 + months
    year = d.year + m // 12
    month = m % 12 + 1
    day = min(d.day, calendar.monthrange(year, month)[1])  # clamp Jan 31 -> Feb 28/29
    return d.replace(year=year, month=month, day=day)


def _expand(start: dt.datetime, rrule: dict, win_start: dt.datetime, win_end: dt.datetime) -> list[dt.datetime]:
    freq = rrule.get("FREQ")
    if not freq:
        return [start]
    interval = int(rrule.get("INTERVAL", 1) or 1)
    count = int(rrule["COUNT"]) if "COUNT" in rrule else None
    until = None
    if "UNTIL" in rrule:
        try:
            until, _ = _parse_dt(rrule["UNTIL"])
        except Exception:
            until = None
    bydays = [_WEEKDAYS[x] for x in rrule.get("BYDAY", "").split(",") if x in _WEEKDAYS]

    occ: list[dt.datetime] = []
    cur = start
    emitted = 0
    guard = 0
    while guard < 5000:
        guard += 1
        if cur > win_end:
            break
        if until and _naive(cur) > _naive(until):
            break

        candidates: list[dt.datetime]
        if freq == "WEEKLY" and bydays:
            week0 = cur - dt.timedelta(days=cur.weekday())
            candidates = [week0 + dt.timedelta(days=wd) for wd in bydays]
        else:
            candidates = [cur]

        for c in sorted(candidates):
            if c < start:
                continue
            if c < win_start:
                continue
            if c > win_end or (until and _naive(c) > _naive(until)):
                continue
            occ.append(c)
            emitted += 1
            if count and emitted >= count:
                return occ[:_MAX_OCCURRENCES]
            if len(occ) >= _MAX_OCCURRENCES:
                return occ

        if freq == "DAILY":
            cur = cur + dt.timedelta(days=interval)
        elif freq == "WEEKLY":
            cur = cur + dt.timedelta(weeks=interval)
        elif freq == "MONTHLY":
            cur = _add_months(cur, interval)
        elif freq == "YEARLY":
            try:
                cur = cur.replace(year=cur.year + interval)
            except ValueError:
                cur = cur.replace(year=cur.year + interval, day=28)
        else:
            break
    return occ


def _naive(d: dt.datetime) -> dt.datetime:
    return d.replace(tzinfo=None) if d.tzinfo else d


class ICalProvider(Provider):
    name = "ical"
    ttl = 1800.0  # 30 min

    async def fetch(self, params: dict[str, Any]) -> dict[str, Any]:
        url = str(params.get("url", "")).strip()
        count = int(params.get("count") or 10)
        if not url:
            return {"events": [], "error": "no url"}
        headers = {"User-Agent": "PiDashboard/3 (+ical)"}
        async with httpx.AsyncClient(timeout=10.0, headers=headers, follow_redirects=True) as client:
            r = await client.get(url)
            r.raise_for_status()
            lines = _unfold(r.text)

        now = dt.datetime.utcnow()
        win_start = now - dt.timedelta(days=1)
        win_end = now + dt.timedelta(days=_WINDOW_DAYS)

        events: list[dict[str, Any]] = []
        in_ev = False
        summary = ""
        start = None
        all_day = False
        rrule: dict = {}
        for line in lines:
            if line == "BEGIN:VEVENT":
                in_ev, summary, start, all_day, rrule = True, "", None, False, {}
            elif line == "END:VEVENT":
                if start is not None:
                    for occ in _expand(start, rrule, win_start, win_end):
                        events.append({
                            "summary": summary or "(no title)",
                            "start": _naive(occ).isoformat(),
                            "allDay": all_day,
                        })
                in_ev = False
            elif in_ev:
                name, _, val = line.partition(":")
                key = name.split(";")[0].upper()
                if key == "SUMMARY":
                    summary = val.strip()
                elif key == "DTSTART":
                    try:
                        start, all_day = _parse_dt(val)
                    except Exception:
                        start = None
                elif key == "RRULE":
                    rrule = dict(
                        kv.split("=", 1) for kv in val.strip().split(";") if "=" in kv
                    )

        events = [e for e in events if e["start"] >= _naive(win_start).isoformat()]
        events.sort(key=lambda e: e["start"])
        return {"events": events[:count]}


register(ICalProvider())
