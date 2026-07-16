"""SSRF-hardened HTTP GET for user-supplied URLs (ical / rss / similar).

Blocks private/link-local/loopback/metadata ranges, non-http(s) schemes,
unlimited redirects, and oversized bodies. Callers get text/bytes back or raise.
"""

from __future__ import annotations

import ipaddress
import logging
import socket
from typing import Any
from urllib.parse import urlparse

import httpx

log = logging.getLogger("dashboard.safe_fetch")

MAX_REDIRECTS = 3
DEFAULT_MAX_BYTES = 2_000_000  # 2 MiB


class UnsafeURLError(ValueError):
    """Raised when a URL fails the SSRF allowlist checks."""


def _host_ips(hostname: str) -> list[ipaddress._BaseAddress]:
    infos = socket.getaddrinfo(hostname, None)
    out: list[ipaddress._BaseAddress] = []
    seen: set[str] = set()
    for info in infos:
        addr = info[4][0]
        if addr in seen:
            continue
        seen.add(addr)
        out.append(ipaddress.ip_address(addr))
    return out


def assert_public_url(url: str, *, allow_http: bool = True) -> str:
    """Validate scheme + host; reject private/reserved destinations.

    Returns the normalized URL string. DNS is resolved here so literal IPs and
    hostnames that point at LAN/metadata ranges are both blocked.
    """
    raw = (url or "").strip()
    if not raw:
        raise UnsafeURLError("empty url")
    parsed = urlparse(raw)
    scheme = (parsed.scheme or "").lower()
    if scheme not in ("http", "https"):
        raise UnsafeURLError(f"unsupported scheme: {scheme or '(none)'}")
    if scheme == "http" and not allow_http:
        raise UnsafeURLError("http not allowed")
    host = parsed.hostname
    if not host:
        raise UnsafeURLError("missing host")
    # Block obvious local names without waiting on DNS.
    lowered = host.lower().rstrip(".")
    if lowered in ("localhost", "metadata.google.internal") or lowered.endswith(".local"):
        raise UnsafeURLError(f"blocked host: {host}")
    try:
        ips = _host_ips(host)
    except socket.gaierror as exc:
        raise UnsafeURLError(f"cannot resolve host: {host}") from exc
    if not ips:
        raise UnsafeURLError(f"cannot resolve host: {host}")
    for ip in ips:
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            raise UnsafeURLError(f"blocked address: {ip}")
        # Cloud metadata (link-local-ish) — explicit for clarity.
        if str(ip) in ("169.254.169.254", "fd00:ec2::254"):
            raise UnsafeURLError(f"blocked address: {ip}")
    return raw


async def safe_get(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    timeout: float = 10.0,
    max_bytes: int = DEFAULT_MAX_BYTES,
    allow_http: bool = True,
) -> httpx.Response:
    """GET ``url`` with redirect re-validation and a response size cap."""
    current = assert_public_url(url, allow_http=allow_http)
    async with httpx.AsyncClient(timeout=timeout, headers=headers or {}, follow_redirects=False) as client:
        for _ in range(MAX_REDIRECTS + 1):
            resp = await client.get(current)
            if resp.is_redirect:
                loc = resp.headers.get("location")
                if not loc:
                    raise UnsafeURLError("redirect without Location")
                # Relative redirects resolve against the current URL.
                current = str(httpx.URL(current).join(loc))
                assert_public_url(current, allow_http=allow_http)
                continue
            resp.raise_for_status()
            # Cap body size (content already buffered by httpx for small responses).
            content = resp.content
            if len(content) > max_bytes:
                raise UnsafeURLError(f"response exceeds {max_bytes} bytes")
            return resp
    raise UnsafeURLError("too many redirects")


def clamp_count(raw: Any, default: int = 10, *, lo: int = 1, hi: int = 50) -> int:
    try:
        n = int(raw)
    except (TypeError, ValueError):
        n = default
    return max(lo, min(hi, n))
