"""Parsing and filtering in the providers behind the ten newer widgets."""

from __future__ import annotations

import datetime as dt
import time

import pytest

from server.providers import earthquakes, ical, launches, on_this_day, service_status, tides, uv
from server.shared import config as config_store
from server.shared.schema import DashboardConfig


# ---- earthquakes -------------------------------------------------------------------

def test_distance_bearing_phoenix_to_ridgecrest():
    km, brg = earthquakes.distance_bearing(33.45, -112.07, 35.62, -117.67)
    assert 540 < km < 580  # ~350 mi
    assert 280 < brg < 300  # west-northwest


def _quake(mag, lat, lon, t, qid="q"):
    return {"id": qid, "properties": {"mag": mag, "place": "x", "time": t}, "geometry": {"coordinates": [lon, lat, 8.0]}}


def test_nearby_filters_radius_and_magnitude_newest_first():
    feats = [
        _quake(4.3, 35.62, -117.67, 3, "far-enough"),
        _quake(2.0, 33.5, -112.0, 5, "too-small"),
        _quake(3.0, 33.9, -112.1, 9, "close"),
        _quake(5.0, 40.0, -150.0, 7, "too-far"),
        _quake(None, 33.5, -112.0, 8, "no-mag"),
    ]
    out = earthquakes.nearby(feats, 33.45, -112.07, 800, 2.5)
    assert [q["id"] for q in out] == ["close", "far-enough"]
    assert out[0]["bearing"] in range(0, 20) or out[0]["bearing"] > 340


# ---- tides -------------------------------------------------------------------------

def test_parse_hilo_to_utc_instants():
    rows = [{"t": "2026-10-02 05:18", "v": "-0.213", "type": "L"}, {"t": "2026-10-02 11:36", "v": "3.81", "type": "H"},
            {"t": "bad", "v": "1", "type": "H"}]
    assert tides.parse_hilo(rows) == [
        {"time": "2026-10-02T05:18:00Z", "height": -0.21, "high": False},
        {"time": "2026-10-02T11:36:00Z", "height": 3.81, "high": True},
    ]


def test_nearest_station():
    stations = [{"id": "9410170", "name": "San Diego", "state": "CA", "lat": 32.71, "lon": -117.17},
                {"id": "9414290", "name": "San Francisco", "state": "CA", "lat": 37.81, "lon": -122.47}]
    s, km = tides.nearest(stations, 32.8, -117.2)
    assert s["id"] == "9410170" and km < 20
    _, far = tides.nearest(stations, 33.45, -112.07)  # Phoenix is inland
    assert far > 250


# ---- launches ------------------------------------------------------------------------

def test_launch_shape():
    row = {
        "id": "abc", "name": "Falcon 9 Block 5 | Starlink Group 10-28", "net": "2026-10-04T01:41:00Z",
        "status": {"abbrev": "Go", "name": "Go for Launch"},
        "launch_service_provider": {"name": "SpaceX"},
        "rocket": {"configuration": {"name": "Falcon 9"}},
        "mission": {"name": "Starlink Group 10-28"},
        "pad": {"name": "SLC-40", "location": {"name": "Cape Canaveral SFS, FL, USA"}},
        "probability": 70,
    }
    s = launches.shape(row)
    assert (s["rocket"], s["mission"], s["provider"], s["place"], s["status"]) == (
        "Falcon 9", "Starlink Group 10-28", "SpaceX", "Cape Canaveral SFS", "Go")
    bare = launches.shape({"name": "Electron | Owl for You", "net": "x"})
    assert (bare["rocket"], bare["mission"], bare["status"]) == ("Electron", "Owl for You", "TBD")


# ---- on this day --------------------------------------------------------------------

def test_on_this_day_shape_prefers_a_page_with_a_picture():
    item = {"text": "Guinea declares independence.", "year": 1958, "pages": [
        {"titles": {"normalized": "France"}},
        {"titles": {"normalized": "Guinea"}, "thumbnail": {"source": "https://upload.wikimedia.org/g.png"}},
    ]}
    assert on_this_day.shape(item) == {"year": 1958, "text": "Guinea declares independence.", "title": "Guinea",
                                       "image": "https://upload.wikimedia.org/g.png"}
    assert on_this_day.shape({"text": "", "year": 1}) is None
    assert on_this_day.shape({"text": "x", "pages": []}) is None


# ---- uv --------------------------------------------------------------------------------

def test_uv_shape():
    d = {"current": {"time": "2026-10-02T15:45", "uv_index": 6.2, "is_day": 1},
         "hourly": {"time": ["2026-10-02T00:00", "2026-10-02T01:00"], "uv_index": [0, 0.1]},
         "daily": {"time": ["2026-10-02", "2026-10-03"], "uv_index_max": [8.1, 9.0]}}
    s = uv.shape(d)
    assert s["today"] == "2026-10-02" and s["current"] == 6.2
    assert s["hours"][1] == {"time": "2026-10-02T01:00", "uv": 0.1}
    assert s["days"][1] == {"date": "2026-10-03", "max": 9.0}


# ---- service status ---------------------------------------------------------------------

def test_parse_target():
    assert service_status.parse_target("http://nas.local:5000") == ("http", "http://nas.local:5000", None)
    assert service_status.parse_target("192.168.1.1:53") == ("tcp", "192.168.1.1", 53)
    assert service_status.parse_target("tcp://router:22") == ("tcp", "router", 22)
    assert service_status.parse_target("homeassistant.local") == ("http", "http://homeassistant.local", None)
    assert service_status.parse_target("http://169.254.169.254/latest") is None
    assert service_status.parse_target("ftp://nas") is None
    assert service_status.parse_target("") is None


def test_history_blocks_keep_the_worst_state():
    key = "t|x"
    service_status._history.pop(key, None)
    service_status._since.pop(key, None)
    now = time.time()
    service_status.record(key, "up", now - 3500)
    service_status.record(key, "slow", now - 3400)
    service_status.record(key, "up", now - 100)
    service_status.record(key, "down", now - 30)
    b = service_status.blocks(key, now)
    assert len(b) == 12 and b[0] == "slow" and b[-1] == "down" and b[5] is None
    assert service_status._since[key] == ("down", now - 30)


@pytest.mark.asyncio
async def test_service_status_reads_targets_from_config_not_query(monkeypatch):
    cfg = DashboardConfig.model_validate({"pages": [{"id": "p", "name": "P", "widgets": [
        {"id": "w1", "type": "service-status",
         "settings": {"services": [{"name": "Router", "target": "127.0.0.1:1"}]}},
    ]}]})
    monkeypatch.setattr(config_store, "_cached", cfg)
    p = service_status.ServiceStatusProvider()
    out = await p.fetch({"widgetId": "w1", "target": "http://evil.example"})
    assert [s["name"] for s in out["services"]] == ["Router"]
    assert out["services"][0]["state"] == "down"
    assert (await p.fetch({"widgetId": "nope"}))["services"] == []


# ---- ical: zones, end times ---------------------------------------------------------------

ICS = r"""BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:Standup\, daily
DTSTART;TZID=America/New_York:20261026T090000
DTEND;TZID=America/New_York:20261026T091500
RRULE:FREQ=WEEKLY
END:VEVENT
BEGIN:VEVENT
SUMMARY:UTC thing
DTSTART:20261027T200000Z
DURATION:PT1H30M
END:VEVENT
BEGIN:VEVENT
SUMMARY:All day
DTSTART;VALUE=DATE:20261028
DTEND;VALUE=DATE:20261029
END:VEVENT
END:VCALENDAR"""


def test_ical_zones_durations_and_dst():
    evs = ical.parse_events(ical._unfold(ICS), dt.datetime(2026, 10, 25), dt.datetime(2026, 11, 3))
    by = {(e["summary"], e["start"]): e for e in evs}
    # 9 AM New York is 13:00Z before the clocks change on 1 Nov and 14:00Z after.
    assert by[("Standup, daily", "2026-10-26T13:00:00Z")]["end"] == "2026-10-26T13:15:00Z"
    assert ("Standup, daily", "2026-11-02T14:00:00Z") in by
    assert by[("UTC thing", "2026-10-27T20:00:00Z")]["end"] == "2026-10-27T21:30:00Z"
    allday = by[("All day", "2026-10-28T00:00:00")]
    assert allday["allDay"] and allday["end"] == "2026-10-29T00:00:00"
    assert [e["start"] for e in evs] == sorted(e["start"] for e in evs)


def test_ical_keeps_an_event_in_progress():
    lines = ical._unfold("BEGIN:VEVENT\nSUMMARY:Long\nDTSTART:20261002T100000Z\nDTEND:20261002T230000Z\nEND:VEVENT")
    evs = ical.parse_events(lines, dt.datetime(2026, 10, 2, 22), dt.datetime(2026, 10, 9))
    assert [e["summary"] for e in evs] == ["Long"]
