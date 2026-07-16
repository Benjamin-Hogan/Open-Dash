"""Per-device display prefs — a small JSON store the shared config can't express.

``schema.Settings`` (columns, rowHeightPx, gapPx, theme) is ONE document served
to every display, so it can't say "the little kitchen screen needs smaller rows
and text than the living-room TV". This store holds that per-DEVICE overlay:
a uiScale (scales layout metrics + fonts together) and a fontScale (text-only
trim), keyed by a client-generated deviceId kept in the browser's localStorage.

Writes broadcast a ``device-prefs`` SSE event so a change made from the admin (or
another tab) applies live on the target display with no reload — same hub the
config live-reload uses (see events.py, app.js).
"""

from __future__ import annotations

import asyncio
import json
import os
import time

from .config import DATA_DIR

DEVICES_PATH = DATA_DIR / "devices.json"

# Clamp ranges (kept in sync with the client HUD and the admin panel).
UI_MIN, UI_MAX = 0.5, 2.0
FONT_MIN, FONT_MAX = 0.6, 1.8

_lock = asyncio.Lock()
_devices: dict[str, dict] | None = None


def _all() -> dict[str, dict]:
    """Lazily load the store from disk (once)."""
    global _devices
    if _devices is None:
        try:
            _devices = json.loads(DEVICES_PATH.read_text("utf-8")) if DEVICES_PATH.exists() else {}
        except Exception:
            _devices = {}
    return _devices


def _write() -> None:
    """Atomic write (temp file + os.replace), mirroring config.py's approach."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = DEVICES_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(_devices, indent=2), "utf-8")
    os.replace(tmp, DEVICES_PATH)


def _clamp(value: object, lo: float, hi: float, default: float) -> float:
    try:
        v = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    return round(max(lo, min(hi, v)), 3)


def _norm(raw: dict) -> dict:
    """Normalize a stored record into the public prefs shape."""
    pages = raw.get("pages")
    return {
        "name": str(raw.get("name") or ""),
        "uiScale": _clamp(raw.get("uiScale", 1.0), UI_MIN, UI_MAX, 1.0),
        "fontScale": _clamp(raw.get("fontScale", 1.0), FONT_MIN, FONT_MAX, 1.0),
        # page ids this display shows; [] = all pages (the default)
        "pages": [str(p) for p in pages] if isinstance(pages, list) else [],
        "viewport": str(raw.get("viewport") or ""),
        "lastSeen": float(raw.get("lastSeen") or 0),
    }


def get(device_id: str) -> dict:
    """Prefs for one device (defaults if unknown), with its id attached."""
    return {"id": device_id, **_norm(_all().get(device_id, {}))}


def list_all() -> list[dict]:
    """Every known device, most-recently-seen first."""
    out = [{"id": did, **_norm(rec)} for did, rec in _all().items()]
    out.sort(key=lambda d: d["lastSeen"], reverse=True)
    return out


async def heartbeat(device_id: str, name: str | None, viewport: str | None) -> dict:
    """Register/refresh a device on load & resize. Never touches its scale prefs."""
    async with _lock:
        rec = _all().setdefault(device_id, {})
        if name is not None and name != "":
            rec["name"] = name
        if viewport is not None:
            rec["viewport"] = viewport
        rec["lastSeen"] = time.time()
        _write()
    return get(device_id)


async def set_prefs(device_id: str, patch: dict) -> dict:
    """Apply a scale/name change (from the HUD or the admin) and push it live."""
    from . import events  # local import avoids an import cycle at module load

    async with _lock:
        rec = _all().setdefault(device_id, {})
        if "uiScale" in patch:
            rec["uiScale"] = _clamp(patch["uiScale"], UI_MIN, UI_MAX, rec.get("uiScale", 1.0))
        if "fontScale" in patch:
            rec["fontScale"] = _clamp(patch["fontScale"], FONT_MIN, FONT_MAX, rec.get("fontScale", 1.0))
        if patch.get("name") is not None:
            rec["name"] = str(patch["name"])
        if isinstance(patch.get("pages"), list):
            rec["pages"] = [str(p) for p in patch["pages"]]
        rec.setdefault("lastSeen", time.time())
        _write()
    prefs = get(device_id)
    await events.broadcast("device-prefs", prefs)
    return prefs


async def remove(device_id: str) -> bool:
    """Forget a device. Returns True if it was present."""
    async with _lock:
        existed = device_id in _all()
        if existed:
            _all().pop(device_id, None)
            _write()
        return existed
