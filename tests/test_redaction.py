"""Per-widget secret redaction + blank-preserve on save."""

from __future__ import annotations

from server.shared.redact import preserve_secrets, public_dump
from server.shared.schema import DashboardConfig, GridPos, Page, Widget


def _cfg_with_key(key: str) -> DashboardConfig:
    return DashboardConfig(
        version=1,
        pages=[
            Page(
                id="p1",
                name="Home",
                widgets=[
                    Widget(
                        id="op-1",
                        type="octoprint",
                        title="Printer",
                        grid=GridPos(),
                        settings={"url": "http://printer.local", "apiKey": key},
                    )
                ],
            )
        ],
    )


def test_public_dump_clears_api_key():
    dump = public_dump(_cfg_with_key("super-secret"))
    assert dump["pages"][0]["widgets"][0]["settings"]["apiKey"] == ""


def test_preserve_secrets_keeps_prior_when_blank():
    previous = _cfg_with_key("keep-me")
    incoming = _cfg_with_key("")
    preserve_secrets(incoming, previous)
    assert incoming.pages[0].widgets[0].settings["apiKey"] == "keep-me"


def test_preserve_secrets_allows_explicit_overwrite():
    previous = _cfg_with_key("old")
    incoming = _cfg_with_key("new-key")
    preserve_secrets(incoming, previous)
    assert incoming.pages[0].widgets[0].settings["apiKey"] == "new-key"
