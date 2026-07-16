"""In-process Server-Sent Events hub.

Both FastAPI apps share this module-global set of subscriber queues — which is
exactly why the two apps must run in one process. An admin write calls
`broadcast(...)`; every connected dashboard `EventSource` receives it and
live-reloads with no page refresh.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

# subscriber queues; each connected client owns one
_subscribers: set[asyncio.Queue] = set()

PING_INTERVAL_SECONDS = 25


async def broadcast(event: str, data: Any | None = None) -> None:
    """Push an event to every connected subscriber."""
    payload = {"event": event, "data": data}
    for q in list(_subscribers):
        try:
            q.put_nowait(payload)
        except asyncio.QueueFull:
            pass


async def stream():
    """Async generator yielding SSE-formatted bytes for one client.

    Yields a `connected` event immediately, then forwards broadcasts, emitting a
    comment ping every PING_INTERVAL_SECONDS to keep the connection alive.
    """
    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    _subscribers.add(q)
    try:
        yield _format("connected", {})
        while True:
            try:
                msg = await asyncio.wait_for(q.get(), timeout=PING_INTERVAL_SECONDS)
            except asyncio.TimeoutError:
                yield ": ping\n\n"  # SSE comment — keeps proxies/clients alive
                continue
            yield _format(msg["event"], msg["data"])
    finally:
        _subscribers.discard(q)


def _format(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def subscriber_count() -> int:
    return len(_subscribers)
