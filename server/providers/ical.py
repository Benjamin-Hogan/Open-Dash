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
import re
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ..shared.providers import Provider, register
from ..shared.safe_fetch import UnsafeURLError, get_text

_DEFAULT_WINDOW_DAYS = 60
_MAX_WINDOW_DAYS = 366
_MAX_OCCURRENCES = 200          # safety cap per recurring event
_MAX_EVENTS = 50
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


def _parse_dt(value: str, tzid: str | None = None) -> tuple[dt.datetime, bool, dt.tzinfo | None]:
    """Return (naive wall-clock datetime, all_day, zone).

    The zone is UTC for "...Z" values, the TZID's zone when it's one Python
    knows, else None (floating: the display's own clock). Recurrences expand on
    the naive wall clock, so a weekly 9 AM meeting stays at 9 AM across DST.
    """
    v = value.strip()
    if len(v) == 8 and v.isdigit():
        return dt.datetime.strptime(v, "%Y%m%d"), True, None
    z = v.endswith("Z")
    d = dt.datetime.strptime(v.rstrip("Z")[:15], "%Y%m%dT%H%M%S")
    if z:
        return d, False, dt.timezone.utc
    if tzid:
        try:
            return d, False, ZoneInfo(tzid.strip('"'))
        except (ZoneInfoNotFoundError, ValueError):
            pass
    return d, False, None


def _parse_duration(value: str) -> dt.timedelta | None:
    """RFC 5545 DURATION: P1D, PT1H30M, P1W."""
    m = re.fullmatch(r"([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?", value.strip())
    if not m:
        return None
    sign, w, d, h, mi, sec = m.groups()
    td = dt.timedelta(weeks=int(w or 0), days=int(d or 0), hours=int(h or 0), minutes=int(mi or 0), seconds=int(sec or 0))
    return -td if sign == "-" else td


def _stamp(d: dt.datetime, all_day: bool, zone: dt.tzinfo | None) -> str:
    """ISO text for the display: UTC with "Z" when the instant is known, else
    the floating wall clock (all-day dates, floating times)."""
    if all_day or zone is None:
        return d.isoformat()
    return d.replace(tzinfo=zone).astimezone(dt.timezone.utc).replace(tzinfo=None).isoformat() + "Z"


def _utc_key(d: dt.datetime, all_day: bool, zone: dt.tzinfo | None) -> dt.datetime:
    """Naive UTC for filtering and sorting; floating times use the server's zone."""
    if all_day or zone is None:
        return d.astimezone(dt.timezone.utc).replace(tzinfo=None)
    return d.replace(tzinfo=zone).astimezone(dt.timezone.utc).replace(tzinfo=None)


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
            until, _, _ = _parse_dt(rrule["UNTIL"])
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
        try:
            count = max(1, min(_MAX_EVENTS, int(params.get("count") or 10)))
        except (TypeError, ValueError):
            count = 10
        try:
            window_days = int(params.get("lookaheadDays") or _DEFAULT_WINDOW_DAYS)
        except (TypeError, ValueError):
            window_days = _DEFAULT_WINDOW_DAYS
        window_days = max(1, min(_MAX_WINDOW_DAYS, window_days))
        if not url:
            return {"events": [], "error": "no url"}
        headers = {"User-Agent": "PiDashboard/3 (+ical)"}
        try:
            text = await get_text(url, headers=headers, timeout=10.0)
        except UnsafeURLError as exc:
            return {"events": [], "error": str(exc)}
        lines = _unfold(text)

        now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
        win_start = now - dt.timedelta(days=1)
        win_end = now + dt.timedelta(days=window_days)
        return {"events": parse_events(lines, win_start, win_end)[:count], "lookaheadDays": window_days}


def parse_events(lines: list[str], win_start: dt.datetime, win_end: dt.datetime) -> list[dict[str, Any]]:
    """Expand VEVENTs into occurrences overlapping [win_start, win_end] (naive UTC).

    Each event has `start` and `end` as ISO text: "...Z" for a known instant,
    plain for all-day dates and floating times. `end` is exclusive (an all-day
    event on the 3rd ends on the 4th), as in iCal.
    """
    # Expansion runs on wall clocks; a day of slack either side covers any zone.
    slack = dt.timedelta(days=1)
    events: list[dict[str, Any]] = []
    in_ev = False
    ev: dict[str, Any] = {}
    for line in lines:
        if line == "BEGIN:VEVENT":
            in_ev, ev = True, {"summary": "", "location": "", "start": None, "end": None, "duration": None, "rrule": {}}
        elif line == "END:VEVENT":
            in_ev = False
            start = ev["start"]
            if start is None:
                continue
            s_dt, all_day, zone = start
            if ev["end"] is not None:
                length = ev["end"][0] - s_dt
            elif ev["duration"] is not None:
                length = ev["duration"]
            else:
                length = dt.timedelta(days=1) if all_day else dt.timedelta(0)
            if length < dt.timedelta(0):
                length = dt.timedelta(0)
            for occ in _expand(s_dt, ev["rrule"], win_start - slack - length, win_end + slack):
                end = occ + length
                if _utc_key(end if length else occ, all_day, zone) < win_start or _utc_key(occ, all_day, zone) > win_end:
                    continue
                events.append({
                    "summary": ev["summary"] or "(no title)",
                    "start": _stamp(occ, all_day, zone),
                    "end": _stamp(end, all_day, zone),
                    "allDay": all_day,
                    "location": ev["location"],
                    "_key": _utc_key(occ, all_day, zone),
                })
        elif in_ev:
            name, _, val = line.partition(":")
            head = name.split(";")
            key = head[0].upper()
            tzid = next((p.split("=", 1)[1] for p in head[1:] if p.upper().startswith("TZID=")), None)
            if key == "SUMMARY":
                ev["summary"] = _text(val)
            elif key == "LOCATION":
                ev["location"] = _text(val)
            elif key in ("DTSTART", "DTEND"):
                try:
                    ev["start" if key == "DTSTART" else "end"] = _parse_dt(val, tzid)
                except Exception:
                    pass
            elif key == "DURATION":
                ev["duration"] = _parse_duration(val)
            elif key == "RRULE":
                ev["rrule"] = dict(kv.split("=", 1) for kv in val.strip().split(";") if "=" in kv)

    events.sort(key=lambda e: e["_key"])
    for e in events:
        del e["_key"]
    return events


def _text(val: str) -> str:
    """Unescape iCal TEXT (\\, \\; \\, \\n)."""
    return re.sub(r"\\([\\;,nN])", lambda m: "\n" if m.group(1) in "nN" else m.group(1), val).strip()


register(ICalProvider())
