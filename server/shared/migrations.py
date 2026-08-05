"""Config migrations — upgrade older config shapes to the current one on load.

This is what makes the `version` field earn its keep: an existing
`data/dashboard.config.json` written before "pages" existed keeps working.
Migrations are pure dict→dict transforms applied before Pydantic validation.
"""

from __future__ import annotations

import uuid
from typing import Any


def migrate(raw: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return raw
    raw = _flat_widgets_to_pages(raw)
    raw = _strip_widget_availability(raw)
    raw = _merge_embed_into_settings(raw)
    raw = _backfill_slide_ids(raw)
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


def _map_widgets(raw: dict[str, Any], fn: Any) -> dict[str, Any]:
    """Apply ``fn(widget_dict) -> widget_dict | None`` to every widget in place.

    ``fn`` returns a replacement dict when it changed something, else None. The
    input is never mutated; only touched pages/widgets are copied.
    """
    pages = raw.get("pages")
    if not isinstance(pages, list):
        return raw
    changed = False
    new_pages: list[Any] = []
    for page in pages:
        widgets = page.get("widgets") if isinstance(page, dict) else None
        if not isinstance(widgets, list):
            new_pages.append(page)
            continue
        new_widgets: list[Any] = []
        page_changed = False
        for w in widgets:
            replacement = fn(w) if isinstance(w, dict) else None
            if replacement is not None:
                w = replacement
                page_changed = True
            new_widgets.append(w)
        if page_changed:
            page = {**page, "widgets": new_widgets}
            changed = True
        new_pages.append(page)
    if not changed:
        return raw
    return {**raw, "pages": new_pages}


def _merge_embed_into_settings(raw: dict[str, Any]) -> dict[str, Any]:
    """Fold the removed ``embed`` model into ``settings``.

    ``embed`` used to hold the iframe triplet and — because iframe.js read it
    first — silently outranked the ``settings`` copies the admin actually wrote.
    Settings won: variant overrides merge into settings, so a scene can flip
    sandbox per-scene. This is mandatory, not cosmetic: ``extra="forbid"`` would
    reject any surviving ``embed`` key. Existing settings win over the legacy
    values, since those are what the admin has been writing all along.
    """

    def fold(node: dict[str, Any]) -> dict[str, Any] | None:
        embed = node.get("embed")
        if "embed" not in node:
            return None
        out = {k: v for k, v in node.items() if k != "embed"}
        if isinstance(embed, dict):
            settings = dict(out.get("settings") or {})
            for key in ("disableSandbox", "referrerPolicy", "allow"):
                if embed.get(key) is not None and settings.get(key) in (None, ""):
                    settings[key] = embed[key]
            out["settings"] = settings
        return out

    def per_widget(w: dict[str, Any]) -> dict[str, Any] | None:
        folded = fold(w)
        base = folded if folded is not None else w
        slideshow = base.get("slideshow")
        slides = slideshow.get("slides") if isinstance(slideshow, dict) else None
        if isinstance(slides, list):
            new_slides = [fold(s) or s if isinstance(s, dict) else s for s in slides]
            if any(a is not b for a, b in zip(new_slides, slides)):
                base = {**base, "slideshow": {**slideshow, "slides": new_slides}}
                return base
        return folded

    return _map_widgets(raw, per_widget)


def _backfill_slide_ids(raw: dict[str, Any]) -> dict[str, Any]:
    """Give every slide a stable id so per-slide secrets survive a reorder."""

    def per_widget(w: dict[str, Any]) -> dict[str, Any] | None:
        slideshow = w.get("slideshow")
        if not isinstance(slideshow, dict):
            return None
        slides = slideshow.get("slides")
        if not isinstance(slides, list):
            return None
        new_slides: list[Any] = []
        changed = False
        for s in slides:
            if isinstance(s, dict) and not str(s.get("id") or "").strip():
                s = {**s, "id": f"slide-{uuid.uuid4().hex[:8]}"}
                changed = True
            new_slides.append(s)
        if not changed:
            return None
        return {**w, "slideshow": {**slideshow, "slides": new_slides}}

    return _map_widgets(raw, per_widget)
