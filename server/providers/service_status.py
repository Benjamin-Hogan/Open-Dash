"""Home-lab service checks — is the NAS / Home Assistant / router up?

The list of things to check lives in the widget's settings and is read from
the config here, by widget id: the display can't make the Pi probe arbitrary
addresses by editing a query string. Like OctoPrint, LAN hosts are allowed by
design; cloud metadata endpoints are not.

Targets are http(s) URLs (any response under 500 counts as up: a login page's
401 still means the service is answering) or "host:port" for a plain TCP
connect. Certificates aren't verified: this is a liveness check, nothing is
sent, and home-lab services mostly use self-signed ones.

The provider remembers each target's recent results in memory, for the
"down for 12 min" line and the last hour as twelve 5-minute blocks.
"""

from __future__ import annotations

import asyncio
import time
from collections import deque
from typing import Any
from urllib.parse import urlparse

import httpx

from ..shared import config as config_store
from ..shared.providers import Provider, register

_BLOCKED_HOSTS = frozenset({"metadata.google.internal", "169.254.169.254", "metadata"})
_MAX_SERVICES = 24
_TIMEOUT = 5.0
_BUCKET_S = 300
_BUCKETS = 12
_RANK = {"up": 0, "slow": 1, "down": 2}

# target -> deque[(epoch seconds, state)]; target -> epoch seconds the current state began
_history: dict[str, deque] = {}
_since: dict[str, tuple[str, float]] = {}


def parse_target(raw: str) -> tuple[str, str, int | None] | None:
    """→ ("http", url, None) or ("tcp", host, port); None when unusable."""
    t = (raw or "").strip()
    if not t:
        return None
    if t.startswith("tcp://"):
        t = t[6:]
    elif "://" in t:
        p = urlparse(t)
        host = (p.hostname or "").lower().rstrip(".")
        if p.scheme not in ("http", "https") or not host or host in _BLOCKED_HOSTS:
            return None
        return ("http", t, None)
    host, sep, port = t.rpartition(":")
    if sep and port.isdigit() and host:
        host = host.strip("[]").lower().rstrip(".")
        if host in _BLOCKED_HOSTS or not 0 < int(port) < 65536:
            return None
        return ("tcp", host, int(port))
    # A bare hostname: treat as a web page on it.
    return parse_target("http://" + t)


async def _check(client: httpx.AsyncClient, target: tuple[str, str, int | None]) -> tuple[bool, float | None]:
    kind, where, port = target
    t0 = time.perf_counter()
    try:
        if kind == "tcp":
            _, writer = await asyncio.wait_for(asyncio.open_connection(where, port), _TIMEOUT)
            writer.close()
            ok = True
        else:
            r = await client.get(where)
            ok = r.status_code < 500
    except (OSError, asyncio.TimeoutError, httpx.HTTPError):
        return False, None
    return ok, (time.perf_counter() - t0) * 1000 if ok else None


def record(key: str, state: str, now: float) -> None:
    hist = _history.setdefault(key, deque(maxlen=400))
    hist.append((now, state))
    prev = _since.get(key)
    if prev is None or prev[0] != state:
        _since[key] = (state, now)


def blocks(key: str, now: float) -> list[str | None]:
    """The last hour as 12 five-minute blocks, oldest first: the worst state
    seen in each, or None when nothing was checked then."""
    out: list[str | None] = [None] * _BUCKETS
    for ts, state in _history.get(key, ()):
        age = now - ts
        if age < 0 or age >= _BUCKET_S * _BUCKETS:
            continue
        i = _BUCKETS - 1 - int(age // _BUCKET_S)
        if out[i] is None or _RANK[state] > _RANK[out[i]]:
            out[i] = state
    return out


def _services_for(widget_id: str) -> tuple[list[dict[str, Any]], float]:
    for page in config_store.get_config().pages:
        for w in page.widgets:
            if w.id == widget_id and w.type == "service-status":
                s = w.settings or {}
                try:
                    slow = max(50.0, float(s.get("slowMs") or 1000))
                except (TypeError, ValueError):
                    slow = 1000.0
                return list(s.get("services") or [])[:_MAX_SERVICES], slow
    return [], 1000.0


class ServiceStatusProvider(Provider):
    name = "service-status"
    ttl = 30.0

    async def fetch(self, params: dict[str, Any]) -> dict[str, Any]:
        widget_id = str(params.get("widgetId") or "").strip()
        services, slow_ms = _services_for(widget_id) if widget_id else ([], 1000.0)
        rows = []
        for s in services:
            if not isinstance(s, dict):
                continue
            raw = str(s.get("target") or "").strip()
            name = str(s.get("name") or "").strip() or raw
            rows.append((name, raw, parse_target(raw)))
        if not rows:
            return {"services": [], "checkedAt": time.time() * 1000}

        async with httpx.AsyncClient(timeout=_TIMEOUT, verify=False, follow_redirects=True,
                                     headers={"User-Agent": "OpenDash/3 (+status)"}) as client:
            results = await asyncio.gather(*[
                _check(client, t) if t else asyncio.sleep(0, (False, None)) for _, _, t in rows
            ])
        now = time.time()
        out = []
        for (name, raw, target), (ok, ms) in zip(rows, results):
            state = "down" if not ok else "slow" if ms is not None and ms > slow_ms else "up"
            key = f"{widget_id}|{raw}"
            if target:
                record(key, state, now)
            out.append({
                "name": name,
                "state": state if target else "invalid",
                "ms": round(ms) if ms is not None else None,
                "since": _since.get(key, (state, now))[1] * 1000,
                "history": blocks(key, now),
            })
        return {"services": out, "checkedAt": now * 1000, "slowMs": slow_ms}


register(ServiceStatusProvider())
