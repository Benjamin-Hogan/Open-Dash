"""Alert engine — turns provider data into push notifications on the displays.

A background loop watches three sources and broadcasts an ``alert`` SSE event
when something newsworthy happens; dashboards render it as a banner overlay
(see app.js). Active alerts are also kept here so a display that (re)connects
can catch up via GET /api/alerts.

Sources (all silent when unconfigured — no keys, no printer, no location):
- **OctoPrint**: state *transitions* (started / complete / error), not states —
  so a print that's been running for an hour doesn't re-alert every tick.
  Printer URLs are discovered from octoprint widgets in the config.
- **NWS** (api.weather.gov): official severe-weather alerts for the resolved
  location — Dust Storm Warning, Severe Thunderstorm Warning, etc. Keyless.
- **Space weather**: Kp >= 6 (geomagnetic storm) via the existing provider.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Any

import httpx

log = logging.getLogger("dashboard.alerts")

TICK_SECONDS = 20          # octoprint transition checks
SLOW_EVERY = 15            # NWS + Kp every 15 ticks (~5 min)

_active: dict[str, dict] = {}      # id -> alert
_op_state: dict[str, dict] = {}    # printer url -> {state, completion}
_kp_alerted = False


def active() -> list[dict]:
    """Current, unexpired alerts (newest first)."""
    now = time.time()
    out = [a for a in _active.values() if not a.get("expiresAt") or a["expiresAt"] > now]
    out.sort(key=lambda a: a["ts"], reverse=True)
    return out


def _default_ttl(severity: str) -> float | None:
    """Configured auto-dismiss for a severity; None = keep until dismissed."""
    from . import config as config_store

    cfg = config_store.get_config().settings.alerts
    sec = {
        "info": cfg.infoTtlSeconds,
        "warning": cfg.warningTtlSeconds,
        "danger": cfg.dangerTtlSeconds,
    }.get(severity, cfg.infoTtlSeconds)
    return float(sec) if sec > 0 else None


async def push(severity: str, title: str, message: str, *, source: str,
               alert_id: str | None = None, ttl: float | None = None) -> dict:
    """Register an alert and broadcast it to every display.

    ``ttl=None`` means "use severity settings". An explicit ``ttl`` (including
    from NWS / space weather) is left alone when alert settings change later.
    """
    from . import events

    sev = severity if severity in ("info", "warning", "danger") else "info"
    uses_settings_ttl = ttl is None
    if uses_settings_ttl:
        ttl = _default_ttl(sev)
    aid = alert_id or f"{source}-{int(time.time() * 1000)}"
    alert = {
        "id": aid,
        "severity": sev,
        "title": title,
        "message": message,
        "source": source,
        "ts": time.time(),
        "expiresAt": (time.time() + ttl) if ttl else None,
        "usesSettingsTtl": uses_settings_ttl,
    }
    _active[aid] = alert
    await events.broadcast("alert", alert)
    log.info("alert [%s] %s: %s", severity, title, message)
    return alert


async def clear(alert_id: str) -> bool:
    """Dismiss one alert on every display. Returns True if it was active."""
    from . import events

    if _active.pop(alert_id, None):
        await events.broadcast("alert-cleared", {"id": alert_id})
        return True
    return False


async def reapply_settings_ttls() -> None:
    """Re-stamp expiresAt for alerts that follow severity TTL settings.

    Called after admin saves new auto-dismiss timings so already-visible banners
    pick up the new values instead of sticking forever with the old expiresAt.
    """
    from . import events

    now = time.time()
    for aid, a in list(_active.items()):
        # Explicit False = caller passed ttl= (NWS/space). Missing key = legacy
        # in-memory alert from before this flag existed — treat as settings-based.
        if a.get("usesSettingsTtl") is False:
            continue
        ttl = _default_ttl(a.get("severity") or "info")
        new_exp = (now + ttl) if ttl else None
        if a.get("expiresAt") == new_exp:
            continue
        a["expiresAt"] = new_exp
        if new_exp is not None and new_exp <= now:
            await clear(aid)
        else:
            # Re-broadcast so clients reset their local auto-dismiss timers.
            await events.broadcast("alert", a)


async def _prune() -> None:
    from . import events

    now = time.time()
    for aid in [k for k, a in _active.items() if a.get("expiresAt") and a["expiresAt"] <= now]:
        if _active.pop(aid, None):
            await events.broadcast("alert-cleared", {"id": aid})


# ---- OctoPrint: state transitions ---------------------------------------------

def _octoprint_targets() -> list[dict[str, str]]:
    """Printer URLs + optional per-widget keys from octoprint widgets (deduped by URL)."""
    from . import config as config_store

    targets: list[dict[str, str]] = []
    seen: set[str] = set()
    for page in config_store.get_config().pages:
        for w in page.widgets:
            if w.type != "octoprint":
                continue
            from ..providers.octoprint import normalize_base_url

            u = normalize_base_url(w.settings.get("url"))
            if not u or u in seen:
                continue
            seen.add(u)
            targets.append({
                "url": u,
                "widgetId": w.id,
            })
    return targets


def _fmt_eta(seconds: Any) -> str:
    try:
        s = int(seconds)
    except (TypeError, ValueError):
        return ""
    h, m = divmod(s // 60, 60)
    return f" · ~{h}h {m:02d}m left" if h else f" · ~{m}m left"


async def _check_octoprint() -> None:
    from . import providers

    provider = providers.get("octoprint")
    if provider is None:
        return
    for target in _octoprint_targets():
        url = target["url"]
        try:
            d = await provider.fetch(target)
        except Exception:
            continue  # unreachable — the widget shows offline; don't alert-spam
        if not d.get("configured"):
            continue
        prev = _op_state.get(url)
        state, comp, file = d.get("state") or "", d.get("completion"), d.get("file") or "print"
        _op_state[url] = {"state": state, "completion": comp}
        if prev is None:
            continue  # first observation — establish a baseline, transitions only
        was, was_comp = prev["state"], prev["completion"]
        if state == "Printing" and was != "Printing":
            await push("info", "🖨 Print started", f"{file}{_fmt_eta(d.get('timeLeft'))}",
                       source="octoprint")
        elif was == "Printing" and state == "Operational" and (was_comp or 0) >= 99:
            await push("info", "✅ Print complete", file, source="octoprint")
        elif was == "Printing" and ("error" in state.lower() or "offline" in state.lower()):
            await push("danger", "🖨 Print problem", f"{file} — printer reports: {state}",
                       source="octoprint")


# ---- NWS severe weather ---------------------------------------------------------

_NWS_SEVERITY = {"Extreme": "danger", "Severe": "danger", "Moderate": "warning"}


async def _check_nws() -> None:
    from . import geo

    try:
        loc = await geo.get_location()
        lat, lon = loc.get("lat"), loc.get("lon")
        if lat is None or lon is None:
            return
        async with httpx.AsyncClient(
            timeout=10.0, headers={"User-Agent": "pi-dashboard (github.com/pi-dashboard)"}
        ) as client:
            r = await client.get(f"https://api.weather.gov/alerts/active?point={lat},{lon}")
            r.raise_for_status()
            features = r.json().get("features", [])
    except Exception as exc:
        log.debug("NWS check failed: %s", exc)
        return

    seen_now: set[str] = set()
    for f in features:
        p = f.get("properties") or {}
        aid = "nws-" + str(f.get("id") or p.get("id") or "")
        seen_now.add(aid)
        if aid in _active:
            continue
        expires = None
        try:
            expires = datetime.fromisoformat(p["expires"]).astimezone(timezone.utc).timestamp() - time.time()
        except Exception:
            pass
        await push(
            _NWS_SEVERITY.get(p.get("severity"), "info"),
            f"⚠ {p.get('event', 'Weather alert')}",
            p.get("headline") or p.get("event") or "",
            source="nws", alert_id=aid, ttl=max(expires or 0, 300),
        )
    # NWS alerts that got cancelled upstream: clear our banner too
    for aid in [k for k in _active if k.startswith("nws-") and k not in seen_now]:
        await clear(aid)


# ---- space weather: geomagnetic storm -----------------------------------------

async def _check_kp() -> None:
    global _kp_alerted
    from . import providers
    from .cache import cache

    provider = providers.get("space-weather")
    if provider is None:
        return
    try:
        key = provider.cache_key({})
        d = cache.get(key)
        if d is None:
            d = await provider.fetch({})
            cache.set(key, d, provider.ttl)
    except Exception:
        return
    kp = float(d.get("kp") or 0)
    if kp >= 6 and not _kp_alerted:
        _kp_alerted = True
        await push("warning", "🌌 Geomagnetic storm", f"Kp {kp:g} — {d.get('aurora', '')}",
                   source="space", ttl=3600)
    elif kp < 5:
        _kp_alerted = False


# ---- engine loop ----------------------------------------------------------------

async def engine() -> None:
    """Run forever; started from server.run alongside the GIF refresher."""
    tick = 0
    while True:
        try:
            await _prune()
            await _check_octoprint()
            if tick % SLOW_EVERY == 0:
                await _check_nws()
                await _check_kp()
        except Exception:
            log.exception("alert engine tick failed")
        tick += 1
        await asyncio.sleep(TICK_SECONDS)
