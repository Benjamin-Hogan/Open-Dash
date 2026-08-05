"""Redact / preserve per-widget secrets that live in Widget.settings.

Global keys live in secrets.json and are already masked. OctoPrint (and any
future) per-widget ``apiKey`` values must never leave via GET /api/config, and
blank password fields on save must keep the previous value.
"""

from __future__ import annotations

from typing import Any

from .schema import DashboardConfig

SECRET_SETTING_KEYS = frozenset({"apiKey"})


def _scrub_settings(settings: dict[str, Any] | None) -> None:
    if not settings:
        return
    for key in SECRET_SETTING_KEYS:
        if settings.get(key):
            settings[key] = ""


def public_dump(cfg: DashboardConfig) -> dict[str, Any]:
    """model_dump with secret setting values cleared for API responses."""
    data = cfg.model_dump(exclude_none=True)
    for page in data.get("pages") or []:
        for w in page.get("widgets") or []:
            _scrub_settings(w.get("settings"))
            slides = (w.get("slideshow") or {}).get("slides") or []
            for slide in slides:
                _scrub_settings(slide.get("settings"))
    return data


def _carry_over(settings: dict[str, Any], old_settings: dict[str, Any]) -> None:
    for key in SECRET_SETTING_KEYS:
        if not str(settings.get(key) or "").strip():
            prev = old_settings.get(key)
            if prev:
                settings[key] = prev


def _slides(widget: Any) -> list[Any]:
    return list(getattr(widget.slideshow, "slides", None) or [])


def preserve_secrets(new: DashboardConfig, previous: DashboardConfig) -> None:
    """In-place: copy prior secret settings when the incoming value is blank.

    Slides are matched on ``Slide.id`` rather than list position, so reordering
    a slideshow can't shift one slide's key onto another. Slides written before
    ids existed fall back to position (migrations backfills them on load, so
    this only covers a config posted straight from an older client).
    """
    prev_by_id = {w.id: w for p in previous.pages for w in p.widgets}
    for page in new.pages:
        for w in page.widgets:
            old = prev_by_id.get(w.id)
            if old is None:
                continue
            _carry_over(w.settings, old.settings)

            old_slides = _slides(old)
            if not old_slides:
                continue
            old_by_id = {s.id: s for s in old_slides if s.id}
            for i, slide in enumerate(_slides(w)):
                match = old_by_id.get(slide.id) if slide.id else None
                if match is None and not slide.id and i < len(old_slides):
                    match = old_slides[i]
                if match is not None:
                    _carry_over(slide.settings, match.settings)
