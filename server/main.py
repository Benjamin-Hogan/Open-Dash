"""Dashboard app (:8082) — read-only data API + SSE + the static web/ frontend."""

from __future__ import annotations

from fastapi import FastAPI

from .api_routes import router as api_router
from .shared.config import WEB_DIR
from .shared.staticfiles import NoCacheStaticFiles

app = FastAPI(title="Pi Dashboard")
app.include_router(api_router)

# Static frontend last, so /api/* wins. html=True serves index.html at "/".
# NoCache so rebuilt modules are always picked up (revalidate via ETag → 304).
app.mount("/", NoCacheStaticFiles(directory=str(WEB_DIR), html=True), name="web")
