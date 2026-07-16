"""OctoPrint job/printer status. The printer URL is a widget setting (it's not a
secret); the API key comes from secrets (OCTOPRINT_API_KEY) so it never sits in
the config document. Short TTL — print progress should feel live.

OctoPrint quirks handled here: /api/printer returns 409 while the printer is
disconnected (that's a valid "offline" state, not an error), and temps/job can
be partially null mid-connect. Webcam lives in a separate widget (stream URL).
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

import httpx

from ..shared import config as config_store
from ..shared import secrets
from ..shared.providers import Provider, register

_BLOCKED_HOSTS = frozenset({"metadata.google.internal", "169.254.169.254"})


def _lan_url_ok(base: str) -> str | None:
    """OctoPrint lives on the LAN — allow private hosts, block metadata / bad schemes."""
    parsed = urlparse(base)
    if parsed.scheme not in ("http", "https"):
        return "unsupported url scheme"
    host = (parsed.hostname or "").lower().rstrip(".")
    if not host or host in _BLOCKED_HOSTS:
        return "blocked url"
    return None


def _temp(block: dict | None) -> dict[str, Any] | None:
    if not isinstance(block, dict):
        return None
    return {"actual": block.get("actual"), "target": block.get("target")}


def _filament(block: dict | None) -> dict[str, Any] | None:
    """tool0 length (mm) + volume (cm³) from the job payload, if present."""
    if not isinstance(block, dict):
        return None
    tool = block.get("tool0")
    if not isinstance(tool, dict):
        return None
    length = tool.get("length")
    volume = tool.get("volume")
    if length is None and volume is None:
        return None
    return {"lengthMm": length, "volumeCm3": volume}


def normalize_base_url(url: str | None) -> str:
    """Accept bare hostnames like OctoPi.local — httpx requires a scheme."""
    base = str(url or "").strip().rstrip("/")
    if base and "://" not in base:
        base = "http://" + base
    return base


def _resolve_api_key(params: dict[str, Any]) -> str | None:
    """Per-widget key in config, else global OCTOPRINT_API_KEY from secrets/env."""
    wid = str(params.get("widgetId") or "").strip()
    if wid:
        for page in config_store.get_config().pages:
            for w in page.widgets:
                if w.id == wid and w.type == "octoprint":
                    key = str(w.settings.get("apiKey") or "").strip()
                    if key:
                        return key
                    break
    return secrets.get("OCTOPRINT_API_KEY")


class OctoPrintProvider(Provider):
    name = "octoprint"
    ttl = 5.0

    async def fetch(self, params: dict[str, Any]) -> dict[str, Any]:
        base = normalize_base_url(params.get("url"))
        if not base:
            return {"configured": False, "error": "no OctoPrint URL configured"}
        bad = _lan_url_ok(base)
        if bad:
            return {"configured": False, "error": bad}
        key = _resolve_api_key(params)
        if not key:
            return {
                "configured": False,
                "needsKey": True,
                "env": "OCTOPRINT_API_KEY",
                "error": "OctoPrint API key not set",
            }
        headers = {"X-Api-Key": key}

        try:
            async with httpx.AsyncClient(timeout=6.0, headers=headers) as client:
                job_r = await client.get(f"{base}/api/job")
                if job_r.status_code in (401, 403):
                    return {"configured": False, "error": "OctoPrint rejected the API key"}
                job = job_r.raise_for_status().json()

                printer: dict = {}
                pr = await client.get(f"{base}/api/printer")
                if pr.status_code == 409:
                    pass  # printer disconnected from OctoPrint — job state still valid
                else:
                    printer = pr.raise_for_status().json()

                conn: dict = {}
                cr = await client.get(f"{base}/api/connection")
                if cr.status_code < 400:
                    conn = cr.json()
        except httpx.ConnectError as exc:
            return {"configured": False, "error": _connect_error(base, exc)}
        except httpx.TimeoutException:
            return {"configured": False, "error": f"timed out reaching {base}"}

        progress = job.get("progress") or {}
        jobinfo = job.get("job") or {}
        fileinfo = jobinfo.get("file") or {}
        temps = printer.get("temperature") or {}
        flags = (printer.get("state") or {}).get("flags") or {}
        current = (conn.get("current") or {}) if isinstance(conn, dict) else {}
        return {
            "configured": True,
            "state": job.get("state") or "Unknown",
            "printing": bool(flags.get("printing") or (job.get("state") == "Printing")),
            "paused": bool(flags.get("paused") or flags.get("pausing")),
            "ready": bool(flags.get("ready")),
            "operational": bool(flags.get("operational")),
            "error": bool(flags.get("error") or flags.get("closedOrError")),
            "file": fileinfo.get("display") or fileinfo.get("name"),
            "completion": progress.get("completion"),          # 0-100 or None
            "timeLeft": progress.get("printTimeLeft"),          # seconds or None
            "timeElapsed": progress.get("printTime"),
            "estimatedTime": jobinfo.get("estimatedPrintTime"),
            "filament": _filament(jobinfo.get("filament")),
            "tool": _temp(temps.get("tool0")),
            "bed": _temp(temps.get("bed")),
            "connection": {
                "state": current.get("state"),
                "port": current.get("port"),
            },
        }


def _connect_error(base: str, exc: Exception) -> str:
    """DNS / connect failures — .local often works on a PC but not on the Pi."""
    msg = str(exc).lower()
    host = base.split("://", 1)[-1].split("/", 1)[0]
    if "name or service not known" in msg or "nodename nor servname" in msg or "getaddrinfo" in msg:
        hint = ""
        if host.endswith(".local"):
            hint = " — use the printer's IP instead (Pi often can't resolve .local)"
        return f"can't resolve {host}{hint}"
    return f"can't reach {base}"


register(OctoPrintProvider())
