"""Admin app (:8081) — the ONE write path plus cache controls and the admin UI.

Mutations go through a single version-gated `PUT /api/config`; there are no
granular per-widget endpoints. Reads/data come from the shared router so nothing
is duplicated against the dashboard app.

Security note: this app is unauthenticated by design (trusted LAN for v1). A
loud warning is logged at startup. Do not expose beyond the home network;
ADMIN_TOKEN remains future work.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .api_routes import router as api_router
from .shared import config as config_store
from .shared import events, secrets
from .shared.cache import cache
from .shared.config import WEB_DIR, StaleConfigError, save_config
from .shared.redact import public_dump
from .shared.schema import DashboardConfig
from .shared.staticfiles import NoCacheStaticFiles

log = logging.getLogger("dashboard.admin")

WIDGETS_DIR = WEB_DIR / "js" / "widgets"


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    log.warning(
        "Pi Dashboard admin is UNAUTHENTICATED and open to the LAN (CORS *). "
        "Trusted home network only for v1 — do not port-forward without auth."
    )
    yield


app = FastAPI(title="Pi Dashboard Admin", lifespan=_lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(api_router)


@app.put("/api/config")
async def put_config(new: DashboardConfig):
    """Save the whole config, gated on the version the client loaded.

    A bad widget fails validation here (422) and never reaches render. A stale
    version yields 409 so the admin can re-sync instead of silently clobbering.
    Per-widget secrets (e.g. OctoPrint apiKey) are preserved when blank and
    redacted in the response.
    """
    try:
        saved = await save_config(new, base_version=new.version)
    except StaleConfigError as exc:
        raise HTTPException(
            status_code=409,
            detail={"error": "stale_version", "currentVersion": exc.current_version},
        )
    return public_dump(saved)


class SecretsBody(BaseModel):
    values: dict[str, str]


@app.get("/api/secrets")
async def get_secrets():
    """Masked status only — never returns the stored key values."""
    return secrets.status()


@app.put("/api/secrets")
async def put_secrets(body: SecretsBody):
    secrets.set_many(body.values)
    cache.clear()                       # drop cached needs-key / stale results
    await events.broadcast("refresh", {})  # dashboards re-fetch with the new key
    return secrets.status()


@app.get("/api/backups")
async def list_backups():
    return {"backups": config_store.list_backups()}


class RestoreBody(BaseModel):
    name: str


@app.post("/api/backups/restore")
async def restore_backup(body: RestoreBody):
    try:
        saved = await config_store.restore_backup(body.name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return public_dump(saved)


@app.post("/api/cache/clear")
async def clear_cache():
    return {"cleared": cache.clear()}


@app.post("/api/alerts/test")
async def test_alert():
    """Fire a demo alert so banners can be checked from the admin."""
    from .shared import alerts

    return await alerts.push(
        "info", "🔔 Test alert", "If you can read this on the display, alerts work.",
        source="test",
    )


@app.post("/api/alerts/clear-all")
async def clear_all_alerts():
    """Dismiss every active banner on every display."""
    from .shared import alerts

    return {"cleared": await alerts.clear_all()}


@app.post("/api/refresh")
async def force_refresh():
    """Clear cached upstream data and tell dashboards to re-fetch now."""
    cleared = cache.clear()
    await events.broadcast("refresh", {})
    return {"cleared": cleared}


@app.post("/api/system/update")
async def system_update_now(background: BackgroundTasks):
    """Pull the current branch and restart in place so new commits take effect.

    The restart only happens when the pull actually moved HEAD, so a no-op
    update leaves the running process alone. It runs after the response is
    flushed, since it replaces this process.
    """
    from .shared import system_update

    try:
        result = await asyncio.to_thread(system_update.pull_current_branch)
    except system_update.UpdateError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    changed = result["sha"] != result["previousSha"]
    if changed:
        background.add_task(system_update.restart_process)
    return {**result, "restarting": changed}


# Serve the widget plugin modules same-origin so the admin can import the SAME
# registry the dashboard uses (schema-driven forms, no duplicated schema).
app.mount("/widgets", NoCacheStaticFiles(directory=str(WIDGETS_DIR)), name="widgets")
# Admin UI at root.
app.mount("/", NoCacheStaticFiles(directory=str(WEB_DIR.parent / "admin"), html=True), name="admin")
