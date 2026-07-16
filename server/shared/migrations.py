"""Config migrations — upgrade older config shapes to the current one on load.

This is what makes the `version` field earn its keep: an existing
`data/dashboard.config.json` written before "pages" existed keeps working.
Migrations are pure dict→dict transforms applied before Pydantic validation.
"""

from __future__ import annotations

from typing import Any


def migrate(raw: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return raw
    raw = _flat_widgets_to_pages(raw)
    return raw


def _flat_widgets_to_pages(raw: dict[str, Any]) -> dict[str, Any]:
    """v1 shape had a top-level `widgets` list; wrap it into a single page."""
    if "pages" not in raw and "widgets" in raw:
        raw = dict(raw)
        raw["pages"] = [
            {"id": "page-1", "name": "Home", "widgets": raw.pop("widgets")}
        ]
    return raw
