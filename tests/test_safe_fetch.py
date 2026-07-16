"""SSRF guards for user-supplied feed URLs."""

from __future__ import annotations

import pytest

from server.shared.safe_fetch import UnsafeURLError, assert_public_http_url


def test_rejects_empty():
    with pytest.raises(UnsafeURLError):
        assert_public_http_url("")


def test_rejects_non_http_schemes():
    with pytest.raises(UnsafeURLError):
        assert_public_http_url("file:///etc/passwd")
    with pytest.raises(UnsafeURLError):
        assert_public_http_url("ftp://example.com/a")


def test_rejects_loopback_literal():
    with pytest.raises(UnsafeURLError):
        assert_public_http_url("http://127.0.0.1/secret")
    with pytest.raises(UnsafeURLError):
        assert_public_http_url("http://[::1]/")


def test_rejects_private_literal():
    with pytest.raises(UnsafeURLError):
        assert_public_http_url("http://192.168.1.1/feed.ics")
    with pytest.raises(UnsafeURLError):
        assert_public_http_url("http://10.0.0.5/rss")


def test_accepts_public_https(monkeypatch):
    import server.shared.safe_fetch as sf

    monkeypatch.setattr(sf, "_host_ips", lambda host: [__import__("ipaddress").ip_address("93.184.216.34")])
    assert assert_public_http_url("https://example.com/cal.ics").startswith("https://")
