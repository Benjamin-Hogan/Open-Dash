"""End-to-end: blank apiKey on save keeps the prior key; public dump stays redacted."""

from __future__ import annotations

import pytest

from server.shared import config as config_store
from server.shared.redact import preserve_secrets, public_dump
from server.shared.schema import (
    DashboardConfig,
    GridPos,
    Page,
    Settings,
    Slide,
    Slideshow,
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


def _cfg_with_slides(slides: list[Slide]) -> DashboardConfig:
    return DashboardConfig(
        version=1,
        settings=Settings(title="t"),
        pages=[
            Page(
                id="p1",
                name="Home",
                widgets=[
                    Widget(
                        id="show1",
                        type="slideshow",
                        title="Rotating",
                        grid=GridPos(x=0, y=0, w=6, h=4),
                        slideshow=Slideshow(enabled=True, slides=slides),
                    )
                ],
            )
        ],
    )


def _slide(sid: str, api_key: str) -> Slide:
    return Slide(id=sid, type="octoprint", title=sid, settings={"apiKey": api_key})


def test_preserve_secrets_covers_slideshow_slides():
    previous = _cfg_with_slides([_slide("s-a", "key-a")])
    incoming = _cfg_with_slides([_slide("s-a", "")])

    preserve_secrets(incoming, previous)

    assert incoming.pages[0].widgets[0].slideshow.slides[0].settings["apiKey"] == "key-a"


def test_preserve_secrets_follows_slides_across_a_reorder():
    """The regression test for index-keyed carry-over.

    Two slides swap position with both keys blanked by the redacted GET. Each
    key must land back on its own slide, not on whatever now sits at its index.
    """
    previous = _cfg_with_slides([_slide("s-a", "key-a"), _slide("s-b", "key-b")])
    incoming = _cfg_with_slides([_slide("s-b", ""), _slide("s-a", "")])

    preserve_secrets(incoming, previous)

    slides = incoming.pages[0].widgets[0].slideshow.slides
    assert [s.id for s in slides] == ["s-b", "s-a"]
    assert slides[0].settings["apiKey"] == "key-b"
    assert slides[1].settings["apiKey"] == "key-a"


def test_preserve_secrets_falls_back_to_position_for_id_less_slides():
    """A config posted by a client older than Slide.id still keeps its key."""
    previous = _cfg_with_slides([Slide(type="octoprint", settings={"apiKey": "key-x"})])
    incoming = _cfg_with_slides([Slide(type="octoprint", settings={"apiKey": ""})])

    preserve_secrets(incoming, previous)

    assert incoming.pages[0].widgets[0].slideshow.slides[0].settings["apiKey"] == "key-x"


def test_public_dump_still_scrubs_slide_secrets():
    cfg = _cfg_with_slides([_slide("s-a", "key-a")])
    dump = public_dump(cfg)
    slides = dump["pages"][0]["widgets"][0]["slideshow"]["slides"]
    assert slides[0]["settings"]["apiKey"] == ""
