"""Launch both FastAPI apps in ONE asyncio process.

They must share a process: the SSE hub, the TTL cache, and the hot config copy
are all in-process module globals. Splitting them into two processes/containers
would silently break live-reload and double the cache.
"""

from __future__ import annotations

import asyncio
import logging
import os

import uvicorn

from .shared import config, providers


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    config.load_config()        # validate + seed config, populate hot copy
    providers.load_builtin()    # register data providers

    host = os.environ.get("HOST", "0.0.0.0")
    admin_port = int(os.environ.get("ADMIN_PORT", "8081"))
    dash_port = int(os.environ.get("DASHBOARD_PORT", "8082"))

    # imported after load so they bind to populated singletons
    from .admin_app import app as admin_app
    from .main import app as dashboard_app

    servers = [
        uvicorn.Server(uvicorn.Config(admin_app, host=host, port=admin_port, log_level="info")),
        uvicorn.Server(uvicorn.Config(dashboard_app, host=host, port=dash_port, log_level="info")),
    ]

    async def serve_all() -> None:
        from . import gifs
        from .shared import alerts

        asyncio.create_task(gifs.refresher())  # keep viewed imagery GIFs fresh
        asyncio.create_task(alerts.engine())   # watch octoprint / NWS / Kp → SSE alerts
        await asyncio.gather(*(s.serve() for s in servers))

    logging.getLogger("dashboard").info(
        "admin :%s  ·  dashboard :%s", admin_port, dash_port
    )
    asyncio.run(serve_all())


if __name__ == "__main__":
    main()
