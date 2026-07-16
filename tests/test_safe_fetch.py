"""SSRF allowlist checks for user-supplied fetch URLs."""

from __future__ import annotations

import pytest

from server.shared.safe_fetch import UnsafeURLError, assert_public_url, clamp_count


def test_rejects_empty_and_bad_schemes():
    with pytest.raises(UnsafeURLError):
        assert_public_url("")
    with pytest.raises(UnsafeURLError):
        assert_public_url("file:///etc/passwd")
    with pytest.raises(UnsafeURLError):
        assert_public_url("ftp://example.com/a")


def test_rejects_localhost_and_local_tld():
    with pytest.raises(UnsafeURLError):
        assert_public_url("http://localhost/foo")
    with pytest.raises(UnsafeURLError):
        assert_public_url("http://printer.local/api")
    with pytest.raises(UnsafeURLError):
        assert_public_url("http://metadata.google.internal/")


def test_rejects_loopback_and_private_literal_ips():
    with pytest.raises(UnsafeURLError):
        assert_public_url("http://127.0.0.1/")
    with pytest.raises(UnsafeURLError):
        assert_public_url("http://192.168.1.10/feed")
    with pytest.raises(UnsafeURLError):
        assert_public_url("http://10.0.0.5/")
    with pytest.raises(UnsafeURLError):
        assert_public_url("http://169.254.169.254/latest/meta-data/")


def test_allows_public_https_host(monkeypatch):
    import server.shared.safe_fetch as sf

    def fake_getaddrinfo(host, _port):
        assert host == "example.com"
        return [(None, None, None, None, ("93.184.216.34", 0))]

    monkeypatch.setattr(sf.socket, "getaddrinfo", fake_getaddrinfo)
    assert assert_public_url("https://example.com/calendar.ics") == "https://example.com/calendar.ics"


def test_clamp_count_bounds():
    assert clamp_count(None, 10) == 10
    assert clamp_count("3", 10) == 3
    assert clamp_count(0, 10) == 1
    assert clamp_count(999, 10) == 50
    assert clamp_count("nope", 12) == 12
