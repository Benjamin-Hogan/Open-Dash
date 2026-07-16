"""Per-widget secrets must not leave GET /api/config; blank PUT keeps prior."""

from __future__ import annotations

import pytest

from server.shared import config as config_store
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


def test_redact_strips_api_key_from_dump():
    cfg = _cfg_with_key("super-secret")
    dump = config_store.redact_config_dump(cfg)
    assert dump["pages"][0]["widgets"][0]["settings"]["apiKey"] == ""
    # In-memory config is untouched.
    assert cfg.pages[0].widgets[0].settings["apiKey"] == "super-secret"


def test_preserve_blank_secrets_keeps_prior_key():
    previous = _cfg_with_key("keep-me", version=1)
    incoming = _cfg_with_key("", version=1)
    config_store.preserve_blank_secrets(incoming, previous)
    assert incoming.pages[0].widgets[0].settings["apiKey"] == "keep-me"


def test_preserve_does_not_override_new_key():
    previous = _cfg_with_key("old-key", version=1)
    incoming = _cfg_with_key("new-key", version=1)
    config_store.preserve_blank_secrets(incoming, previous)
    assert incoming.pages[0].widgets[0].settings["apiKey"] == "new-key"


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
    dump = config_store.redact_config_dump(saved)
    assert dump["pages"][0]["widgets"][0]["settings"]["apiKey"] == ""
