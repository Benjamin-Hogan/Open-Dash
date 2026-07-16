"""SSRF-safe HTTP GET for user-supplied feed URLs (iCal / RSS).

Blocks private/link-local/loopback/metadata targets, caps redirects and body
size. OctoPrint is intentionally NOT routed through this — printers live on
the LAN by design.
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

import httpx

MAX_BYTES = 2_000_000
MAX_REDIRECTS = 3


class UnsafeURLError(ValueError):
    """Raised when a URL must not be fetched."""


def _host_ips(hostname: str) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    infos = socket.getaddrinfo(hostname, None)
    out: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
    seen: set[str] = set()
    for info in infos:
        addr = info[4][0]
        if addr in seen:
            continue
        seen.add(addr)
        out.append(ipaddress.ip_address(addr))
    return out


def _is_blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return bool(
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    )


def assert_public_http_url(url: str) -> str:
    """Validate scheme + host; raise UnsafeURLError if the URL is unsafe."""
    raw = (url or "").strip()
    if not raw:
        raise UnsafeURLError("empty url")
    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https"):
        raise UnsafeURLError("only http/https urls are allowed")
    if not parsed.hostname:
        raise UnsafeURLError("url missing host")
    host = parsed.hostname
    # Literal IPs in the URL
    try:
        if _is_blocked_ip(ipaddress.ip_address(host)):
            raise UnsafeURLError("url targets a private or reserved address")
    except ValueError:
        pass  # hostname, not an IP literal
    try:
        for ip in _host_ips(host):
            if _is_blocked_ip(ip):
                raise UnsafeURLError("url resolves to a private or reserved address")
    except socket.gaierror as exc:
        raise UnsafeURLError(f"dns lookup failed: {exc}") from exc
    return raw


async def get_bytes(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    timeout: float = 10.0,
    max_bytes: int = MAX_BYTES,
) -> bytes:
    """GET a public URL with redirect re-validation and a body size cap."""
    current = assert_public_http_url(url)
    async with httpx.AsyncClient(timeout=timeout, headers=headers or {}, follow_redirects=False) as client:
        for _ in range(MAX_REDIRECTS + 1):
            r = await client.get(current)
            if r.is_redirect:
                loc = r.headers.get("location")
                if not loc:
                    raise UnsafeURLError("redirect without location")
                # Resolve relative redirects against the current URL
                current = assert_public_http_url(str(httpx.URL(current).join(loc)))
                continue
            r.raise_for_status()
            data = r.content
            if len(data) > max_bytes:
                raise UnsafeURLError(f"response exceeds {max_bytes} bytes")
            return data
    raise UnsafeURLError("too many redirects")


async def get_text(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    timeout: float = 10.0,
    max_bytes: int = MAX_BYTES,
) -> str:
    data = await get_bytes(url, headers=headers, timeout=timeout, max_bytes=max_bytes)
    return data.decode("utf-8", errors="replace")
