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


def preserve_secrets(new: DashboardConfig, previous: DashboardConfig) -> None:
    """In-place: copy prior secret settings when the incoming value is blank."""
    prev_by_id = {w.id: w for p in previous.pages for w in p.widgets}
    for page in new.pages:
        for w in page.widgets:
            old = prev_by_id.get(w.id)
            if old is None:
                continue
            for key in SECRET_SETTING_KEYS:
                if not str(w.settings.get(key) or "").strip():
                    prev = old.settings.get(key)
                    if prev:
                        w.settings[key] = prev
