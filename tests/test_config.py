"""Config load/save, migrations, backups, and corrupt-file recovery."""

from __future__ import annotations

import json

import pytest

from server.shared import config as config_store
from server.shared import migrations
from server.shared.schema import DashboardConfig, Page, Settings, Widget


@pytest.fixture
def isolated_data(tmp_path, monkeypatch):
    monkeypatch.setattr(config_store, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config_store, "CONFIG_PATH", tmp_path / "dashboard.config.json")
    monkeypatch.setattr(config_store, "BACKUP_DIR", tmp_path / "backups")
    monkeypatch.setattr(config_store, "_cached", None)
    return tmp_path


def test_migrate_flat_widgets_to_pages():
    raw = {
        "version": 1,
        "settings": {"title": "Old"},
        "widgets": [
            {"id": "c1", "type": "clock", "title": "Clock", "grid": {"x": 0, "y": 0, "w": 3, "h": 2}},
        ],
    }
    migrated = migrations.migrate(raw)
    assert "widgets" not in migrated or not migrated.get("widgets")
    assert len(migrated["pages"]) == 1
    assert migrated["pages"][0]["widgets"][0]["id"] == "c1"
    cfg = DashboardConfig.model_validate(migrated)
    assert cfg.pages[0].widgets[0].type == "clock"


@pytest.mark.asyncio
async def test_save_config_version_conflict(isolated_data, monkeypatch):
    async def _noop_broadcast(*_a, **_k):
        return None

    monkeypatch.setattr("server.shared.events.broadcast", _noop_broadcast)

    cfg = DashboardConfig(version=3, settings=Settings(title="v3"), pages=[
        Page(id="p1", name="Home", widgets=[]),
    ])
    config_store._cached = cfg
    config_store._write_disk(cfg)

    with pytest.raises(config_store.StaleConfigError) as exc:
        await config_store.save_config(
            DashboardConfig(version=1, settings=Settings(title="stale")),
            base_version=1,
        )
    assert exc.value.current_version == 3


def test_safe_backup_path_rejects_traversal(isolated_data):
    with pytest.raises(ValueError, match="invalid backup name"):
        config_store._safe_backup_path("../evil.json")
    with pytest.raises(ValueError, match="invalid backup name"):
        config_store._safe_backup_path("dashboard.config.v1.notastamp.json")


def test_corrupt_config_falls_back_to_backup(isolated_data, monkeypatch):
    backup_dir = isolated_data / "backups"
    backup_dir.mkdir()
    good = DashboardConfig(
        version=7,
        settings=Settings(title="from-backup"),
        pages=[Page(id="p1", name="Home", widgets=[
            Widget(id="t1", type="text", title="Hi", settings={"text": "ok"}),
        ])],
    )
    name = "dashboard.config.v7.20260101T120000.json"
    (backup_dir / name).write_text(good.model_dump_json(indent=2), encoding="utf-8")

    # Seed path unused if backup recovers.
    monkeypatch.setattr(config_store, "SEED_PATH", isolated_data / "missing-seed.json")
    config_store.CONFIG_PATH.write_text("{not json", encoding="utf-8")

    loaded = config_store.load_config()
    assert loaded.settings.title == "from-backup"
    assert loaded.version == 7


def test_schedule_validators_reject_bad_times():
    from server.shared.schema import Schedule

    with pytest.raises(Exception):
        Schedule(enabled=True, start="25:00", end="10:00")
    with pytest.raises(Exception):
        Schedule(enabled=True, start="09:00", end="10:00", days=[7])
    s = Schedule(enabled=True, start="9:5", end="10:00", days=[0, 6])
    assert s.start == "09:05"
