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
    raw = _strip_widget_availability(raw)
    return raw


def _flat_widgets_to_pages(raw: dict[str, Any]) -> dict[str, Any]:
    """v1 shape had a top-level `widgets` list; wrap it into a single page."""
    if "pages" not in raw and "widgets" in raw:
        raw = dict(raw)
        raw["pages"] = [
            {"id": "page-1", "name": "Home", "widgets": raw.pop("widgets")}
        ]
    return raw


def _strip_widget_availability(raw: dict[str, Any]) -> dict[str, Any]:
    """Drop unfinished Widget.availability — never consumed at runtime."""
    pages = raw.get("pages")
    if not isinstance(pages, list):
        return raw
    changed = False
    new_pages: list[Any] = []
    for page in pages:
        if not isinstance(page, dict):
            new_pages.append(page)
            continue
        widgets = page.get("widgets")
        if not isinstance(widgets, list):
            new_pages.append(page)
            continue
        new_widgets = []
        page_changed = False
        for w in widgets:
            if isinstance(w, dict) and "availability" in w:
                w = {k: v for k, v in w.items() if k != "availability"}
                page_changed = True
                changed = True
            new_widgets.append(w)
        if page_changed:
            page = dict(page)
            page["widgets"] = new_widgets
        new_pages.append(page)
    if not changed:
        return raw
    out = dict(raw)
    out["pages"] = new_pages
    return out
