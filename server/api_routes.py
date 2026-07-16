"""Read + data routes shared by BOTH apps.

Defined once here and included by the dashboard app and the admin app, so there
is no copy-pasted route drift between them. The generic `/api/data/{provider}`
route replaces the per-widget endpoints the original duplicated across files.
"""

from __future__ import annotations

import logging
import os
import re

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .providers import stocks as stocks_mod
from .providers import youtube as youtube_mod
from .shared import alerts as alerts_store
from .shared import config as config_store
from .shared import devices as device_store
from .shared import events, providers
from .shared.cache import cache
from .shared.config import WEB_DIR
from .shared.redact import public_dump

log = logging.getLogger("dashboard.api")

router = APIRouter(prefix="/api")

_DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def _require_device_id(device_id: str) -> str:
    if not _DEVICE_ID_RE.fullmatch(device_id):
        raise HTTPException(status_code=400, detail="invalid device id")
    return device_id


def _asset_version() -> str:
    """Max mtime across the served frontend — changes whenever a build ships new
    files, so clients can detect a new build and hard-reload (see app.js)."""
    latest = 0.0
    for f in WEB_DIR.rglob("*"):
        if f.is_file():
            latest = max(latest, f.stat().st_mtime)
    return str(int(latest))


_VERSION = _asset_version()


@router.get("/version")
async def version():
    return {"version": _VERSION}


@router.get("/gif/{source}")
async def gif(source: str):
    """Serve a server-built animated GIF for a space-weather imagery source."""
    from fastapi.responses import FileResponse

    from . import gifs

    if source not in gifs.SOURCES:
        raise HTTPException(status_code=404, detail="unknown source")
    path = await gifs.ensure(source)
    if not path:
        raise HTTPException(status_code=502, detail="gif unavailable")
    return FileResponse(
        path, media_type="image/gif",
        headers={"Cache-Control": f"max-age={int(gifs.TTL)}"},
    )


@router.get("/gif")
async def gif_list():
    from . import gifs

    return {"sources": list(gifs.SOURCES.keys())}


@router.get("/health")
async def health():
    cfg = config_store.get_config()
    return {"ok": True, "configVersion": cfg.version}


@router.get("/meta")
async def meta():
    """Ports + product stance for admin preview / UI banners."""
    return {
        "adminPort": int(os.environ.get("ADMIN_PORT", "8081")),
        "dashboardPort": int(os.environ.get("DASHBOARD_PORT", "8082")),
        "auth": "lan-open",
    }


@router.get("/config")
async def get_config():
    return public_dump(config_store.get_config())


# --- per-device display prefs (uiScale / fontScale) ---------------------------
# Included by BOTH apps, sharing one in-process store: the dashboard heartbeats
# and self-serves prefs here; the admin lists/edits the same devices. See
# shared/devices.py for why these live outside the shared config.

class DeviceHeartbeat(BaseModel):
    name: str | None = None
    viewport: str | None = None


class DevicePrefsBody(BaseModel):
    uiScale: float | None = None
    fontScale: float | None = None
    name: str | None = None
    pages: list[str] | None = None  # page ids this display shows; empty = all


@router.get("/devices")
async def list_devices():
    return {"devices": device_store.list_all()}


@router.get("/devices/{device_id}")
async def get_device(device_id: str):
    return device_store.get(_require_device_id(device_id))


@router.post("/devices/{device_id}/heartbeat")
async def device_heartbeat(device_id: str, body: DeviceHeartbeat):
    return await device_store.heartbeat(_require_device_id(device_id), body.name, body.viewport)


@router.put("/devices/{device_id}/prefs")
async def set_device_prefs(device_id: str, body: DevicePrefsBody):
    return await device_store.set_prefs(
        _require_device_id(device_id), body.model_dump(exclude_none=True)
    )


# --- alerts (engine in shared/alerts.py; displays catch up here on connect) ----

@router.get("/alerts")
async def get_alerts():
    return {"alerts": alerts_store.active()}


@router.delete("/alerts/{alert_id}")
async def dismiss_alert(alert_id: str):
    """Dismiss a banner on every display (✕ and auto-dismiss both land here)."""
    cleared = await alerts_store.clear(alert_id)
    return {"cleared": cleared, "id": alert_id}


@router.get("/events")
async def events_stream():
    from fastapi.responses import StreamingResponse

    return StreamingResponse(
        events.stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --- specific data routes (declared before the generic catch-all) -------------

@router.get("/data/stocks/search")
async def stocks_search(q: str):
    if not q.strip():
        return {"results": []}
    return await stocks_mod.StocksProvider().search(q)  # uses env key internally


@router.delete("/data/youtube-live/{channel_id}")
async def youtube_invalidate(channel_id: str):
    """Frontend calls this when it detects a dead embed (see widget plugin)."""
    provider = providers.get("youtube-live")
    removed = isinstance(provider, youtube_mod.YouTubeLiveProvider) and provider.invalidate(channel_id)
    return {"invalidated": bool(removed)}


# --- generic provider route ---------------------------------------------------

@router.get("/data/{provider_name}")
async def get_data(provider_name: str, request: Request):
    provider = providers.get(provider_name)
    if provider is None:
        raise HTTPException(status_code=404, detail=f"unknown provider: {provider_name}")
    params = dict(request.query_params)
    key = provider.cache_key(params)
    if provider.ttl > 0:
        cached = cache.get(key)
        if cached is not None:
            return cached
    try:
        result = await provider.fetch(params)
    except Exception as exc:  # upstream failure → 502, don't crash the app
        log.warning("%s fetch failed: %s", provider_name, exc)
        raise HTTPException(status_code=502, detail=f"{provider_name} fetch failed")
    if provider.ttl > 0:
        cache.set(key, result, provider.ttl)
    return result
