"""Regression tests for banner alert TTL + dismiss lifecycle."""

from __future__ import annotations

import time

import pytest

from server.shared import alerts
from server.shared import config as config_store
from server.shared.schema import AlertSettings, DashboardConfig, Settings


@pytest.fixture(autouse=True)
def _clean_alerts(monkeypatch):
    """Isolate each test from in-memory alert state and config."""
    alerts._active.clear()
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
