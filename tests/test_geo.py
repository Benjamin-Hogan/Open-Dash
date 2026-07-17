"""Home-location override vs IP / Phoenix fallback."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from server.shared import geo
from server.shared import config as config_store
from server.shared.schema import DashboardConfig, LocationSettings, Settings


@pytest.fixture(autouse=True)
def _clean_geo(monkeypatch):
    geo.invalidate()
    cfg = DashboardConfig(settings=Settings())
    monkeypatch.setattr(config_store, "_cached", cfg)
    yield
    geo.invalidate()


@pytest.mark.asyncio
async def test_config_override_wins_over_ip(monkeypatch):
    cfg = config_store.get_config()
    cfg.settings.location = LocationSettings(lat=40.7, lon=-74.0, city="NYC", region="NY")
    monkeypatch.setattr(config_store, "_cached", cfg)
    # If IP were consulted this would fail / return something else.
    monkeypatch.setattr(geo, "_resolved", {**geo.FALLBACK, "source": "ip"})

    loc = await geo.get_location()
    assert loc["lat"] == pytest.approx(40.7)
    assert loc["lon"] == pytest.approx(-74.0)
    assert loc["city"] == "NYC"
    assert loc["source"] == "config"


@pytest.mark.asyncio
async def test_partial_lat_lon_falls_through_to_ip_cache(monkeypatch):
    cfg = config_store.get_config()
    cfg.settings.location = LocationSettings(lat=40.7, lon=None, city="NYC")
    monkeypatch.setattr(config_store, "_cached", cfg)
    monkeypatch.setattr(geo, "_resolved", {"lat": 1.0, "lon": 2.0, "city": "IP", "region": "X", "source": "ip"})

    loc = await geo.get_location()
    assert loc["source"] == "ip"
    assert loc["lat"] == 1.0


@pytest.mark.asyncio
async def test_invalidate_clears_ip_cache(monkeypatch):
    monkeypatch.setattr(geo, "_resolved", dict(geo.FALLBACK))
    geo.invalidate()
    assert geo._resolved is None


@pytest.mark.asyncio
async def test_fallback_when_ip_fails(monkeypatch):
    async def boom(*_a, **_k):
        raise RuntimeError("no network")

    class BoomClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        get = boom

    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", BoomClient)
    loc = await geo.get_location()
    assert loc["lat"] == geo.FALLBACK["lat"]
    assert loc["source"] == "fallback"
