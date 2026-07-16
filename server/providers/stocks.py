"""Stocks/markets via Finnhub (free tier). Supports BOTH symbol search (for the
admin ticker picker) and batch quotes for a configured watchlist.

Needs FINNHUB_API_KEY. Without it, returns a friendly needs-key signal so the
widget shows guidance instead of crashing the grid.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from ..shared import secrets
from ..shared.providers import Provider, register

_BASE = "https://finnhub.io/api/v1"
_YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart"

# Sparkline history comes from Yahoo's keyless chart API (Finnhub candles are now
# premium-only). Map the widget's range to a sensible sampling interval.
_RANGE_INTERVAL = {"1d": "5m", "5d": "30m", "1mo": "1d", "6mo": "1d", "1y": "1wk"}


def _api_key() -> str | None:
    return secrets.get("FINNHUB_API_KEY")


class StocksProvider(Provider):
    name = "stocks"
    ttl = 60.0

    async def fetch(self, params: dict[str, Any]) -> dict[str, Any]:
        key = _api_key()
        symbols = [s.strip().upper() for s in str(params.get("symbols", "")).split(",") if s.strip()]
        if not key:
            return {"needsKey": True, "env": "FINNHUB_API_KEY", "quotes": []}
        if not symbols:
            return {"needsKey": False, "quotes": []}
        quotes = []
        async with httpx.AsyncClient(timeout=8.0) as client:
            for sym in symbols[:25]:
                try:
                    r = await client.get(f"{_BASE}/quote", params={"symbol": sym, "token": key})
                    r.raise_for_status()
                    q = r.json()
                    quotes.append({
                        "symbol": sym,
                        "price": q.get("c"),
                        "change": q.get("d"),
                        "changePercent": q.get("dp"),
                        "high": q.get("h"),
                        "low": q.get("l"),
                        "prevClose": q.get("pc"),
                    })
                except Exception:
                    quotes.append({"symbol": sym, "error": True})

        # Optional sparkline history (chart view only) — fetched concurrently so N
        # tickers don't add up serially. Keyless Yahoo source, bounded to 12.
        if str(params.get("chart", "")).lower() in ("1", "true"):
            rng = str(params.get("range", "1mo"))
            if rng not in _RANGE_INTERVAL:
                rng = "1mo"
            series = await self._histories([q["symbol"] for q in quotes[:12]], rng)
            for q in quotes:
                if q["symbol"] in series:
                    q["series"] = series[q["symbol"]]
            return {"needsKey": False, "quotes": quotes, "range": rng}
        return {"needsKey": False, "quotes": quotes}

    async def _histories(self, symbols: list[str], rng: str) -> dict[str, list[float]]:
        interval = _RANGE_INTERVAL[rng]
        headers = {"User-Agent": "Mozilla/5.0 (compatible; PiDashboard)"}
        out: dict[str, list[float]] = {}
        async with httpx.AsyncClient(timeout=8.0, headers=headers) as client:
            async def one(sym: str) -> None:
                try:
                    r = await client.get(f"{_YAHOO}/{sym}", params={"range": rng, "interval": interval})
                    r.raise_for_status()
                    res = r.json()["chart"]["result"][0]
                    closes = res["indicators"]["quote"][0]["close"]
                    pts = [c for c in closes if c is not None]
                    if len(pts) >= 2:
                        out[sym] = pts[-120:]  # cap points for a compact sparkline
                except Exception:
                    pass
            await asyncio.gather(*(one(s) for s in symbols))
        return out

    async def search(self, query: str) -> dict[str, Any]:
        """Symbol/name lookup powering the admin ticker picker."""
        key = _api_key()
        if not key:
            return {"needsKey": True, "env": "FINNHUB_API_KEY", "results": []}
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(f"{_BASE}/search", params={"q": query, "token": key})
            r.raise_for_status()
            data = r.json()
        results = [
            {"symbol": it.get("symbol"), "description": it.get("description"), "type": it.get("type")}
            for it in data.get("result", [])[:20]
            if it.get("symbol")
        ]
        return {"needsKey": False, "results": results}


register(StocksProvider())
