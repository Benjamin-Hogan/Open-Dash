"""Regression tests for banner alert TTL + dismiss lifecycle."""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import httpx
import pytest

from server.shared import alerts
from server.shared import config as config_store
from server.shared import geo
from server.shared.schema import AlertSettings, DashboardConfig, Settings


@pytest.fixture(autouse=True)
def _clean_alerts(monkeypatch):
    """Isolate each test from in-memory alert state and config."""
    alerts._active.clear()
    alerts._dismissed.clear()
    alerts._op_state.clear()
    alerts._kp_alerted = False
    cfg = DashboardConfig(
        settings=Settings(alerts=AlertSettings(
            infoTtlSeconds=90, warningTtlSeconds=0, dangerTtlSeconds=0,
        ))
    )
    monkeypatch.setattr(config_store, "_cached", cfg)
    yield
    alerts._active.clear()
    alerts._dismissed.clear()


def _nws_feature(*, event="Heat Advisory", severity="Moderate", hours=6, fid="alert-1"):
    expires = (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat()
    return {
        "id": fid,
        "properties": {
            "id": fid,
            "event": event,
            "headline": f"{event} in effect",
            "severity": severity,
            "expires": expires,
        },
    }


def _mock_nws(monkeypatch, features: list[dict]):
    monkeypatch.setattr(geo, "get_location", AsyncMock(return_value={"lat": 33.4, "lon": -112.0}))

    class FakeResp:
        def raise_for_status(self):
            return None

        def json(self):
            return {"features": features}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, url):
            return FakeResp()

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)


@pytest.mark.asyncio
async def test_info_alert_gets_expires_at_from_settings():
    a = await alerts.push("info", "t", "m", source="test")
    assert a["expiresAt"] is not None
    assert a["expiresAt"] == pytest.approx(time.time() + 90, abs=2)


@pytest.mark.asyncio
async def test_zero_ttl_means_no_auto_expire_until_dismissed():
    a = await alerts.push("warning", "t", "m", source="test")
    assert a["expiresAt"] is None
    assert any(x["id"] == a["id"] for x in alerts.active())
    await alerts._prune()
    assert any(x["id"] == a["id"] for x in alerts.active())


@pytest.mark.asyncio
async def test_clear_removes_alert_from_active():
    a = await alerts.push("danger", "t", "m", source="test")
    await alerts.clear(a["id"])
    assert alerts.active() == []


@pytest.mark.asyncio
async def test_reapply_ttls_updates_settings_based_alerts(monkeypatch):
    """Changing severity TTL must re-stamp expiresAt on already-active alerts."""
    a = await alerts.push("warning", "t", "m", source="test")
    assert a["expiresAt"] is None

    cfg = config_store.get_config()
    cfg.settings.alerts.warningTtlSeconds = 30
    monkeypatch.setattr(config_store, "_cached", cfg)

    await alerts.reapply_settings_ttls()
    updated = alerts._active[a["id"]]
    assert updated["expiresAt"] == pytest.approx(time.time() + 30, abs=2)


@pytest.mark.asyncio
async def test_reapply_does_not_override_explicit_ttl(monkeypatch):
    a = await alerts.push("warning", "t", "m", source="space", ttl=3600)
    original = a["expiresAt"]

    cfg = config_store.get_config()
    cfg.settings.alerts.warningTtlSeconds = 5
    monkeypatch.setattr(config_store, "_cached", cfg)

    await alerts.reapply_settings_ttls()
    assert alerts._active[a["id"]]["expiresAt"] == original


@pytest.mark.asyncio
async def test_prune_removes_expired():
    a = await alerts.push("info", "t", "m", source="test", ttl=1)
    alerts._active[a["id"]]["expiresAt"] = time.time() - 1
    await alerts._prune()
    assert alerts.active() == []


@pytest.mark.asyncio
async def test_past_expires_filtered_from_active():
    a = await alerts.push("info", "t", "m", source="test", ttl=60)
    alerts._active[a["id"]]["expiresAt"] = time.time() - 5
    assert alerts.active() == []


@pytest.mark.asyncio
async def test_nws_dismiss_suppresses_repost(monkeypatch):
    """✕ must stick while NWS still lists the same alert — no ~5min bounce-back."""
    _mock_nws(monkeypatch, [_nws_feature(fid="heat-1")])
    await alerts._check_nws()
    aid = "nws-heat-1"
    assert any(a["id"] == aid for a in alerts.active())

    await alerts.clear(aid)
    assert alerts.active() == []

    await alerts._check_nws()
    assert alerts.active() == []
    assert aid in alerts._dismissed


@pytest.mark.asyncio
async def test_nws_ttl_expiry_suppresses_repost(monkeypatch):
    """Admin severity TTL must expire weather banners and not let the next poll revive them."""
    cfg = config_store.get_config()
    cfg.settings.alerts.warningTtlSeconds = 30
    monkeypatch.setattr(config_store, "_cached", cfg)

    _mock_nws(monkeypatch, [_nws_feature(severity="Moderate", hours=6, fid="heat-2")])
    await alerts._check_nws()
    aid = "nws-heat-2"
    a = alerts._active[aid]
    assert a["usesSettingsTtl"] is True
    assert a["expiresAt"] == pytest.approx(time.time() + 30, abs=2)

    alerts._active[aid]["expiresAt"] = time.time() - 1
    await alerts._prune()
    assert alerts.active() == []

    await alerts._check_nws()
    assert alerts.active() == []


@pytest.mark.asyncio
async def test_nws_zero_settings_ttl_falls_back_to_nws_expiry(monkeypatch):
    """Keep-until-dismissed settings still end when the official NWS expiry hits."""
    _mock_nws(monkeypatch, [_nws_feature(severity="Moderate", hours=6, fid="heat-3")])
    await alerts._check_nws()
    a = alerts._active["nws-heat-3"]
    assert a["usesSettingsTtl"] is True
    assert a["expiresAt"] == pytest.approx(time.time() + 6 * 3600, abs=5)
    assert a["hardExpiresAt"] == pytest.approx(a["expiresAt"], abs=1)


@pytest.mark.asyncio
async def test_nws_dismissed_clears_when_feed_drops_then_can_repost(monkeypatch):
    """Once NWS cancels an alert, a later reissue with the same id may alert again."""
    feat = _nws_feature(fid="heat-4")
    _mock_nws(monkeypatch, [feat])
    await alerts._check_nws()
    aid = "nws-heat-4"
    await alerts.clear(aid)
    assert aid in alerts._dismissed

    _mock_nws(monkeypatch, [])
    await alerts._check_nws()
    assert aid not in alerts._dismissed

    _mock_nws(monkeypatch, [feat])
    await alerts._check_nws()
    assert any(a["id"] == aid for a in alerts.active())


@pytest.mark.asyncio
async def test_reapply_caps_nws_alert_by_hard_expiry(monkeypatch):
    _mock_nws(monkeypatch, [_nws_feature(severity="Moderate", hours=1, fid="heat-5")])
    await alerts._check_nws()
    aid = "nws-heat-5"
    hard = alerts._active[aid]["hardExpiresAt"]

    cfg = config_store.get_config()
    cfg.settings.alerts.warningTtlSeconds = 10 * 3600  # longer than NWS expiry
    monkeypatch.setattr(config_store, "_cached", cfg)

    await alerts.reapply_settings_ttls()
    assert alerts._active[aid]["expiresAt"] == pytest.approx(hard, abs=2)


@pytest.mark.asyncio
async def test_reapply_migrates_legacy_nws_explicit_ttl(monkeypatch):
    """Pre-fix NWS rows (explicit ttl) should pick up admin settings on save."""
    a = await alerts.push(
        "warning", "⚠ Heat Advisory", "Hot",
        source="nws", alert_id="nws-legacy", ttl=6 * 3600,
    )
    assert a["usesSettingsTtl"] is False
    hard = a["expiresAt"]

    cfg = config_store.get_config()
    cfg.settings.alerts.warningTtlSeconds = 45
    monkeypatch.setattr(config_store, "_cached", cfg)

    await alerts.reapply_settings_ttls()
    updated = alerts._active["nws-legacy"]
    assert updated["usesSettingsTtl"] is True
    assert updated["hardExpiresAt"] == pytest.approx(hard, abs=2)
    assert updated["expiresAt"] == pytest.approx(time.time() + 45, abs=2)


@pytest.mark.asyncio
async def test_nws_disabled_skips_poll(monkeypatch):
    cfg = config_store.get_config()
    cfg.settings.alerts.nwsEnabled = False
    monkeypatch.setattr(config_store, "_cached", cfg)
    _mock_nws(monkeypatch, [_nws_feature(fid="heat-off")])
    await alerts._check_nws()
    assert alerts.active() == []


@pytest.mark.asyncio
async def test_nws_min_severity_filters_info(monkeypatch):
    cfg = config_store.get_config()
    cfg.settings.alerts.nwsMinSeverity = "warning"
    monkeypatch.setattr(config_store, "_cached", cfg)
    # Unknown NWS severity maps to info — should be filtered.
    _mock_nws(monkeypatch, [_nws_feature(severity="Minor", fid="minor-1")])
    await alerts._check_nws()
    assert alerts.active() == []

    _mock_nws(monkeypatch, [_nws_feature(severity="Moderate", fid="mod-1")])
    await alerts._check_nws()
    assert any(a["id"] == "nws-mod-1" for a in alerts.active())


@pytest.mark.asyncio
async def test_space_disabled_skips_kp(monkeypatch):
    cfg = config_store.get_config()
    cfg.settings.alerts.spaceEnabled = False
    monkeypatch.setattr(config_store, "_cached", cfg)

    class FakeProvider:
        name = "space-weather"
        ttl = 900.0

        def cache_key(self, params):
            return "space"

        async def fetch(self, params):
            return {"kp": 9, "aurora": "extreme"}

    from server.shared import providers
    from server.shared.cache import cache

    monkeypatch.setattr(providers, "get", lambda name: FakeProvider() if name == "space-weather" else None)
    cache.clear()
    await alerts._check_kp()
    assert alerts.active() == []


@pytest.mark.asyncio
async def test_kp_threshold_and_space_ttl_zero_uses_warning_settings(monkeypatch):
    cfg = config_store.get_config()
    cfg.settings.alerts.kpThreshold = 5
    cfg.settings.alerts.spaceTtlSeconds = 0
    cfg.settings.alerts.warningTtlSeconds = 120
    monkeypatch.setattr(config_store, "_cached", cfg)

    class FakeProvider:
        name = "space-weather"
        ttl = 900.0

        def cache_key(self, params):
            return "space"

        async def fetch(self, params):
            return {"kp": 5.5, "aurora": "active"}

    from server.shared import providers
    from server.shared.cache import cache

    monkeypatch.setattr(providers, "get", lambda name: FakeProvider() if name == "space-weather" else None)
    cache.clear()
    await alerts._check_kp()
    assert len(alerts.active()) == 1
    a = alerts.active()[0]
    assert a["usesSettingsTtl"] is True
    assert a["expiresAt"] == pytest.approx(time.time() + 120, abs=2)


@pytest.mark.asyncio
async def test_clear_all_dismisses_every_alert():
    await alerts.push("info", "a", "1", source="test", alert_id="t-1")
    await alerts.push("warning", "b", "2", source="test", alert_id="t-2")
    n = await alerts.clear_all()
    assert n == 2
    assert alerts.active() == []
