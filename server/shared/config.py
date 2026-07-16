"""Single source of truth for the dashboard config.

ONE write path (`save_config`): version-gated (optimistic concurrency, 409 on
stale), atomic (temp file + os.replace), with a real timestamped backup. The
in-memory `DashboardConfig` is the hot copy used to serve reads; disk is only
persistence and is re-read solely at startup.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .schema import DashboardConfig

log = logging.getLogger("dashboard.config")

ROOT = Path(__file__).resolve().parents[2]
WEB_DIR = ROOT / "web"
# Config + backups live OUTSIDE web/ so they are never statically served (the
# document holds secrets like API keys). Frontends read it only via /api/config.
DATA_DIR = Path(os.environ.get("DATA_DIR", ROOT / "data"))
CONFIG_PATH = DATA_DIR / "dashboard.config.json"
BACKUP_DIR = DATA_DIR / "backups"
SEED_PATH = WEB_DIR / "dashboard.seed.json"  # shipped starter config
MAX_BACKUPS = 50

# Setting keys that must never leave the server via GET /api/config.
PASSWORD_SETTING_KEYS = frozenset({"apiKey"})

_lock = asyncio.Lock()
_cached: DashboardConfig | None = None


class StaleConfigError(Exception):
    """Raised when a save is attempted against an out-of-date version."""

    def __init__(self, current_version: int) -> None:
        self.current_version = current_version
        super().__init__(f"config has moved on to version {current_version}")


def _write_disk(cfg: DashboardConfig) -> None:
    """Atomic write: serialize to a temp file in the same dir, then os.replace."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    payload = cfg.model_dump_json(indent=2, exclude_none=True)
    tmp = CONFIG_PATH.with_suffix(".json.tmp")
    tmp.write_text(payload, encoding="utf-8")
    os.replace(tmp, CONFIG_PATH)  # atomic on the same filesystem


def _backup(cfg: DashboardConfig) -> None:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    name = f"dashboard.config.v{cfg.version}.{stamp}.json"
    (BACKUP_DIR / name).write_text(
        cfg.model_dump_json(indent=2, exclude_none=True), encoding="utf-8"
    )
    # prune oldest beyond MAX_BACKUPS — by mtime, NOT filename: version numbers
    # aren't zero-padded, so a lexicographic sort ranks "v99" above "v280" and
    # would delete the newest backups.
    backups = sorted(BACKUP_DIR.glob("dashboard.config.*.json"), key=lambda p: p.stat().st_mtime)
    for old in backups[:-MAX_BACKUPS]:
        old.unlink(missing_ok=True)


def _validate_raw(raw: dict[str, Any]) -> DashboardConfig:
    from . import migrations

    return DashboardConfig.model_validate(migrations.migrate(raw))


def _load_seed() -> DashboardConfig:
    if SEED_PATH.exists():
        return _validate_raw(json.loads(SEED_PATH.read_text(encoding="utf-8")))
    return DashboardConfig()


def _try_newest_backup() -> DashboardConfig | None:
    if not BACKUP_DIR.exists():
        return None
    backups = sorted(BACKUP_DIR.glob("dashboard.config.*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for path in backups:
        try:
            return _validate_raw(json.loads(path.read_text(encoding="utf-8")))
        except Exception as exc:
            log.warning("skipping corrupt backup %s: %s", path.name, exc)
    return None


def load_config() -> DashboardConfig:
    """Load + validate from disk at startup; seed a default if absent.

    Corrupt primary config falls back to the newest valid backup, then the
    shipped seed — so a bad write can't brick the process.
    """
    global _cached
    if CONFIG_PATH.exists():
        try:
            raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            _cached = _validate_raw(raw)
        except Exception as exc:
            log.error("corrupt config at %s (%s); trying backup/seed", CONFIG_PATH, exc)
            recovered = _try_newest_backup()
            if recovered is None:
                recovered = _load_seed()
                log.error("no usable backup — loaded seed defaults")
            else:
                log.error("recovered config from newest backup (version %s)", recovered.version)
            _cached = recovered
            _write_disk(_cached)
    elif SEED_PATH.exists():
        _cached = _load_seed()  # first run: ship a starter
    else:
        _cached = DashboardConfig()
    if not CONFIG_PATH.exists():
        _write_disk(_cached)
    return _cached


def get_config() -> DashboardConfig:
    """Return the hot in-memory config (loads on first access)."""
    if _cached is None:
        return load_config()
    return _cached


def _redact_settings(settings: dict[str, Any]) -> None:
    for key in PASSWORD_SETTING_KEYS:
        if settings.get(key):
            settings[key] = ""


def redact_config_dump(cfg: DashboardConfig) -> dict[str, Any]:
    """Public API dump — strips per-widget secrets (e.g. OctoPrint apiKey)."""
    dump = cfg.model_dump(exclude_none=True)
    for page in dump.get("pages") or []:
        for widget in page.get("widgets") or []:
            settings = widget.get("settings")
            if isinstance(settings, dict):
                _redact_settings(settings)
            slideshow = widget.get("slideshow")
            if isinstance(slideshow, dict):
                for slide in slideshow.get("slides") or []:
                    ss = slide.get("settings")
                    if isinstance(ss, dict):
                        _redact_settings(ss)
    return dump


def preserve_blank_secrets(new: DashboardConfig, previous: DashboardConfig) -> None:
    """Keep prior password settings when the client sends a blank value.

    Matches the admin password-field UX (leave blank to keep). Mutates ``new``.
    """
    prev_by_id = {w.id: w for page in previous.pages for w in page.widgets}
    for page in new.pages:
        for widget in page.widgets:
            old = prev_by_id.get(widget.id)
            if old is None:
                continue
            for key in PASSWORD_SETTING_KEYS:
                incoming = str(widget.settings.get(key) or "").strip()
                if incoming:
                    continue
                prior = old.settings.get(key)
                if prior:
                    widget.settings[key] = prior


_BACKUP_RE = re.compile(r"dashboard\.config\.v(\d+)\.(\d{8}T\d{6})\.json")


def list_backups() -> list[dict]:
    """Available config backups, newest first."""
    out: list[dict] = []
    if not BACKUP_DIR.exists():
        return out
    for p in BACKUP_DIR.glob("dashboard.config.*.json"):
        m = _BACKUP_RE.match(p.name)
        if not m:
            continue
        stamp = m.group(2)
        iso = datetime.strptime(stamp, "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc).isoformat()
        out.append({"name": p.name, "version": int(m.group(1)), "savedAt": iso, "size": p.stat().st_size})
    out.sort(key=lambda b: b["savedAt"], reverse=True)
    return out


def _safe_backup_path(name: str) -> Path:
    if not _BACKUP_RE.match(name):  # also blocks path traversal (no slashes match)
        raise ValueError("invalid backup name")
    p = BACKUP_DIR / name
    if not p.exists():
        raise ValueError("backup not found")
    return p


async def restore_backup(name: str) -> DashboardConfig:
    """Validate a backup and make it the current config (bumps version, keeps the
    current one in the backup history via the normal write path)."""
    raw = json.loads(_safe_backup_path(name).read_text(encoding="utf-8"))
    cfg = _validate_raw(raw)
    return await save_config(cfg, base_version=get_config().version)


async def save_config(new: DashboardConfig, *, base_version: int) -> DashboardConfig:
    """Persist `new`, gated on `base_version` matching the current version.

    On success: bumps version, atomic-writes, backs up, updates the hot copy,
    and broadcasts `config-changed` over SSE. Raises StaleConfigError on a
    version mismatch (caller should surface a 409).
    """
    global _cached
    # Local import avoids a circular dependency at module load time.
    from . import events

    alerts_changed = False
    async with _lock:
        current = get_config()
        if base_version != current.version:
            raise StaleConfigError(current.version)
        preserve_blank_secrets(new, current)
        alerts_changed = current.settings.alerts != new.settings.alerts
        new.version = current.version + 1
        _write_disk(new)
        _backup(new)
        _cached = new
    await events.broadcast("config-changed", {"version": new.version})
    if alerts_changed:
        # Existing banners keep the old expiresAt unless we re-stamp them —
        # otherwise changing TTL in admin looks like "alerts never go away".
        from . import alerts
        await alerts.reapply_settings_ttls()
    return new
