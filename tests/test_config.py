"""Config load/save, migrations, backup path safety."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from server.shared import config as config_store
from server.shared import migrations
from server.shared.schema import (
    AlertSettings,
    DashboardConfig,
    LocationSettings,
    Page,
    PageCondition,
    Schedule,
    Settings,
)


def test_migrate_flat_widgets_to_pages():
    raw = {
        "version": 1,
        "settings": {"title": "T"},
        "widgets": [
            {"id": "c1", "type": "clock", "title": "Clock", "grid": {"x": 0, "y": 0, "w": 3, "h": 2}},
        ],
    }
    out = migrations.migrate(raw)
    assert "widgets" not in out
    assert len(out["pages"]) == 1
    assert out["pages"][0]["widgets"][0]["id"] == "c1"


def test_safe_backup_path_rejects_traversal():
    with pytest.raises(ValueError):
        config_store._safe_backup_path("../evil.json")
    with pytest.raises(ValueError):
        config_store._safe_backup_path("dashboard.config.v1.notastamp.json")


def test_schedule_hhmm_validation():
    Schedule(enabled=True, start="09:00", end="17:30", days=[0, 1])
    with pytest.raises(Exception):
        Schedule(enabled=True, start="9:00", end="17:30")
    with pytest.raises(Exception):
        Schedule(enabled=True, start="09:00", end="17:30", days=[7])


def test_location_and_alert_settings_defaults():
    s = Settings()
    assert s.location.lat is None and s.location.lon is None
    assert s.alerts.octoprintEnabled is True
    assert s.alerts.nwsEnabled is True
    assert s.alerts.spaceEnabled is True
    assert s.alerts.nwsMinSeverity == "info"
    assert s.alerts.kpThreshold == 6.0
    assert s.alerts.spaceTtlSeconds == 3600
    LocationSettings(lat=33.4, lon=-112.0, city="Phoenix", region="AZ")
    with pytest.raises(Exception):
        LocationSettings(lat=100.0, lon=0.0)
    with pytest.raises(Exception):
        AlertSettings(kpThreshold=10)
    with pytest.raises(Exception):
        AlertSettings(nwsMinSeverity="critical")  # type: ignore[arg-type]


def test_page_condition_defaults_and_bounds():
    c = PageCondition(enabled=True, type="octoprint")
    assert c.mode == "soft-join"
    assert c.priority == 50
    assert c.matchStates == ["printing"]
    assert c.leadMinutes == 30

    PageCondition(
        enabled=True,
        type="weather-alert",
        mode="force-override",
        priority=90,
        minSeverity="warning",
    )
    PageCondition(
        enabled=True,
        type="calendar-soon",
        sourceWidgetId="cal-1",
        leadMinutes=15,
        pollSeconds=5,
    )
    with pytest.raises(Exception):
        PageCondition(enabled=True, type="octoprint", priority=101)
    with pytest.raises(Exception):
        PageCondition(enabled=True, type="calendar-soon", leadMinutes=0)
    with pytest.raises(Exception):
        PageCondition(enabled=True, type="octoprint", pollSeconds=1)
    with pytest.raises(Exception):
        PageCondition(enabled=True, type="not-a-trigger")  # type: ignore[arg-type]


def test_page_condition_match_states_dedupe_and_default():
    c = PageCondition(enabled=True, type="octoprint", matchStates=["error", "printing", "error"])
    assert c.matchStates == ["error", "printing"]
    empty = PageCondition(enabled=True, type="octoprint", matchStates=[])
    assert empty.matchStates == ["printing"]


def test_page_accepts_condition():
    p = Page(
        id="page-print",
        name="Printing",
        condition=PageCondition(
            enabled=True,
            type="octoprint",
            mode="force-override",
            priority=50,
            sourceWidgetId="octo-1",
            matchStates=["printing", "paused"],
        ),
        widgets=[],
    )
    assert p.condition is not None
    assert p.condition.type == "octoprint"
    # Existing pages without condition stay valid.
    assert Page(id="page-1", name="Home", widgets=[]).condition is None


@pytest.mark.asyncio
async def test_save_config_version_conflict(tmp_path, monkeypatch):
    monkeypatch.setattr(config_store, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config_store, "CONFIG_PATH", tmp_path / "dashboard.config.json")
    monkeypatch.setattr(config_store, "BACKUP_DIR", tmp_path / "backups")
    monkeypatch.setattr(config_store, "_cached", DashboardConfig(version=3))

    from server.shared.config import StaleConfigError, save_config

    with pytest.raises(StaleConfigError):
        await save_config(DashboardConfig(version=2), base_version=2)


def test_corrupt_config_falls_back_to_seed(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    web = tmp_path / "web"
    web.mkdir()
    seed = {
        "version": 1,
        "settings": {"title": "Seeded"},
        "pages": [{"id": "page-1", "name": "Home", "widgets": []}],
        "rotation": {"enabled": False, "defaultDurationSeconds": 30, "order": []},
    }
    (web / "dashboard.seed.json").write_text(json.dumps(seed), encoding="utf-8")
    (data / "dashboard.config.json").write_text("{not json", encoding="utf-8")

    monkeypatch.setattr(config_store, "DATA_DIR", data)
    monkeypatch.setattr(config_store, "CONFIG_PATH", data / "dashboard.config.json")
    monkeypatch.setattr(config_store, "BACKUP_DIR", data / "backups")
    monkeypatch.setattr(config_store, "SEED_PATH", web / "dashboard.seed.json")
    monkeypatch.setattr(config_store, "_cached", None)

    cfg = config_store.load_config()
    assert cfg.settings.title == "Seeded"
    assert Path(config_store.CONFIG_PATH).exists()
