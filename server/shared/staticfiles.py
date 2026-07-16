"""StaticFiles that always revalidates.

Default StaticFiles sends ETag/Last-Modified but no Cache-Control, so browsers
apply *heuristic* freshness and can serve a stale ES module after an image
rebuild without revalidating — the frontend silently runs old code. `no-cache`
forces a conditional request every time; the ETag still yields a cheap 304 when
nothing changed, so this is free on a LAN but always picks up new builds. Exactly
what a live-reloading kiosk wants.
"""

from __future__ import annotations

from fastapi.staticfiles import StaticFiles


class NoCacheStaticFiles(StaticFiles):
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response
