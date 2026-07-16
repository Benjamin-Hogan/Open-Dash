"""End-to-end: blank apiKey on save keeps the prior key; public dump stays redacted."""

from __future__ import annotations

import pytest

from server.shared import config as config_store
from server.shared.redact import public_dump
from server.shared.schema import (
    DashboardConfig,
    GridPos,
    Page,
    Settings,
    Widget,
)


def _cfg_with_key(api_key: str, version: int = 1) -> DashboardConfig:
    return DashboardConfig(
        version=version,
        settings=Settings(title="t"),
        pages=[
            Page(
                id="p1",
                name="Home",
                widgets=[
                    Widget(
                        id="op1",
                        type="octoprint",
                        title="Printer",
                        grid=GridPos(x=0, y=0, w=4, h=3),
                        settings={"url": "http://192.168.1.50", "apiKey": api_key},
                    )
                ],
            )
        ],
    )


@pytest.mark.asyncio
async def test_save_config_preserves_blank_api_key(tmp_path, monkeypatch):
    monkeypatch.setattr(config_store, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config_store, "CONFIG_PATH", tmp_path / "dashboard.config.json")
    monkeypatch.setattr(config_store, "BACKUP_DIR", tmp_path / "backups")
    monkeypatch.setattr(config_store, "_cached", None)

    async def _noop_broadcast(*_a, **_k):
        return None

    monkeypatch.setattr("server.shared.events.broadcast", _noop_broadcast)

    first = _cfg_with_key("disk-secret", version=1)
    config_store._cached = first
    config_store._write_disk(first)

    incoming = _cfg_with_key("", version=1)
    saved = await config_store.save_config(incoming, base_version=1)
    assert saved.pages[0].widgets[0].settings["apiKey"] == "disk-secret"
    dump = public_dump(saved)
    assert dump["pages"][0]["widgets"][0]["settings"]["apiKey"] == ""
