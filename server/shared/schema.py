"""Typed, versioned config domain model — the spine of the dashboard.

Design note: structural/common fields (id, grid, slideshow, schedule, version)
are strongly typed because those are where real bugs live (concurrency, broken
layouts, render crashes). *Type-specific* options live in ``Widget.settings`` — a
deliberately open bag — so adding a new widget type means adding one backend
provider + one frontend plugin, with no edits here. The frontend plugin's own
``schema`` drives validation/UX of that bag in the admin form.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class GridPos(BaseModel):
    model_config = ConfigDict(extra="forbid")
    x: int = 0
    y: int = 0
    w: int = Field(default=3, ge=1)
    h: int = Field(default=3, ge=1)


class Slide(BaseModel):
    """One slide in a slideshow widget — a mini-widget (type + settings)."""
    model_config = ConfigDict(extra="forbid")
    type: str
    title: str = ""
    settings: dict[str, Any] = Field(default_factory=dict)
    embed: "Embed | None" = None


class Slideshow(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    durationSeconds: int = Field(default=30, ge=2)
    slides: list[Slide] = Field(default_factory=list)


class Schedule(BaseModel):
    """Time-window visibility. ``days``: 0=Mon .. 6=Sun (empty = every day)."""
    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    start: str | None = None  # "HH:MM"
    end: str | None = None    # "HH:MM"
    days: list[int] = Field(default_factory=list)

    @field_validator("start", "end")
    @classmethod
    def _hhmm(cls, v: str | None) -> str | None:
        if v is None or v == "":
            return None
        parts = v.split(":")
        if len(parts) != 2:
            raise ValueError("time must be HH:MM")
        try:
            h, m = int(parts[0]), int(parts[1])
        except ValueError as exc:
            raise ValueError("time must be HH:MM") from exc
        if not (0 <= h <= 23 and 0 <= m <= 59):
            raise ValueError("time must be HH:MM")
        return f"{h:02d}:{m:02d}"

    @field_validator("days")
    @classmethod
    def _valid_days(cls, days: list[int]) -> list[int]:
        for d in days:
            if d < 0 or d > 6:
                raise ValueError("days must be integers 0–6 (Mon–Sun)")
        return days


class Availability(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = True


class Variant(BaseModel):
    """A named override set, so heavy embeds aren't pasted N times.

    ``overrides`` is shallow-merged over ``settings`` when the variant is active.
    """
    model_config = ConfigDict(extra="forbid")
    label: str = ""
    overrides: dict[str, Any] = Field(default_factory=dict)


class Embed(BaseModel):
    """iframe security/permission triplet, declared once per widget."""
    model_config = ConfigDict(extra="forbid")
    disableSandbox: bool = False
    referrerPolicy: str | None = None
    allow: str | None = None


class Widget(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1)
    type: str = Field(min_length=1)
    title: str = "Untitled"
    enabled: bool = True
    grid: GridPos = Field(default_factory=GridPos)
    # One refresh key for every widget type (the dual refreshSeconds/refreshMinutes
    # split in the original is gone). None = no auto-refresh.
    refreshSeconds: int | None = Field(default=None, ge=1)
    slideshow: Slideshow | None = None
    schedule: Schedule | None = None
    availability: Availability | None = None
    variants: list[Variant] = Field(default_factory=list)
    embed: Embed | None = None
    # Type-specific options (url, units, symbols, channelId, ...). Validated by
    # the owning plugin's schema, not here.
    settings: dict[str, Any] = Field(default_factory=dict)


class Theme(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["dark", "light", "auto"] = "dark"
    accent: str = "#4aa3ff"


class AlertSettings(BaseModel):
    """Auto-dismiss timing for banner alerts (seconds). 0 = keep until dismissed."""
    model_config = ConfigDict(extra="forbid")
    infoTtlSeconds: int = Field(default=90, ge=0)
    warningTtlSeconds: int = Field(default=0, ge=0)
    dangerTtlSeconds: int = Field(default=0, ge=0)


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = "Pi Dashboard"
    columns: int = Field(default=12, ge=1, le=48)
    rowHeightPx: int = Field(default=90, ge=20)
    gapPx: int = Field(default=12, ge=0)
    theme: Theme = Field(default_factory=Theme)
    alerts: AlertSettings = Field(default_factory=AlertSettings)


class Page(BaseModel):
    """A named layout. The slideshow rotates through pages."""
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1)
    name: str = "Page"
    # Per-page slideshow duration override; None = use rotation.defaultDurationSeconds.
    durationSeconds: int | None = Field(default=None, ge=2)
    # Time-window visibility for the whole page (same semantics as a widget's
    # schedule): outside the window the rotation skips it. None = always shown.
    schedule: Schedule | None = None
    widgets: list[Widget] = Field(default_factory=list)

    @field_validator("widgets")
    @classmethod
    def _unique_widget_ids(cls, widgets: list[Widget]) -> list[Widget]:
        seen: set[str] = set()
        for w in widgets:
            if w.id in seen:
                raise ValueError(f"duplicate widget id: {w.id!r}")
            seen.add(w.id)
        return widgets


class PageRotation(BaseModel):
    """Slideshow-mode config: cycle through pages on a timer."""
    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    defaultDurationSeconds: int = Field(default=30, ge=2)
    order: list[str] = Field(default_factory=list)  # explicit page-id order; empty = natural


class DashboardConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # Bumped on every successful write — drives optimistic concurrency (409 on stale).
    version: int = 1
    settings: Settings = Field(default_factory=Settings)
    pages: list[Page] = Field(default_factory=list)
    rotation: PageRotation = Field(default_factory=PageRotation)

    @field_validator("pages")
    @classmethod
    def _unique_page_ids(cls, pages: list[Page]) -> list[Page]:
        seen: set[str] = set()
        for p in pages:
            if p.id in seen:
                raise ValueError(f"duplicate page id: {p.id!r}")
            seen.add(p.id)
        return pages


# resolve the forward ref in Slide.embed
Slide.model_rebuild()
