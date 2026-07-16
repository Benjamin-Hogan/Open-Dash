"""YouTube live resolver with quota-aware two-tier caching — the most
quota-sensitive code in the project.

YouTube Data API quota: `search.list` costs 100 units, `videos.list` costs 1.
So we remember a channel's current live videoId and *re-verify it cheaply*
(videos.list, 1u) on subsequent calls, only paying for the expensive search
(100u) when we have nothing cached or the remembered video is no longer live.

The frontend detects "dead" embeds (YouTube serves a static page, no player
error fires) and calls DELETE /api/data/youtube-live/{channelId} to bust the
remembered id — `invalidate()` below.
"""

from __future__ import annotations

from typing import Any

import httpx

from ..shared import secrets
from ..shared.cache import cache
from ..shared.providers import Provider, register

_BASE = "https://www.googleapis.com/youtube/v3"
_MEMORY_TTL = 3600.0  # remember a live videoId for up to an hour between verifies


def _api_key() -> str | None:
    return secrets.get("YOUTUBE_API_KEY")


def _mem_key(channel_id: str) -> str:
    return f"yt:live:{channel_id}"


class YouTubeLiveProvider(Provider):
    name = "youtube-live"
    ttl = 0.0  # bypass generic-route caching; we manage our own two-tier cache

    async def fetch(self, params: dict[str, Any]) -> dict[str, Any]:
        key = _api_key()
        channel_id = str(params.get("channelId", "")).strip()
        if not key:
            return {"needsKey": True, "env": "YOUTUBE_API_KEY"}
        if not channel_id:
            return {"error": "missing channelId"}

        async with httpx.AsyncClient(timeout=8.0) as client:
            remembered = cache.get(_mem_key(channel_id))
            if remembered:
                # cheap re-verify (1 unit)
                if await self._still_live(client, key, remembered):
                    cache.set(_mem_key(channel_id), remembered, _MEMORY_TTL)
                    return {"videoId": remembered, "live": True, "source": "verify"}
                cache.invalidate(_mem_key(channel_id))
            # expensive discovery (100 units) only when nothing usable is cached
            video_id = await self._discover_live(client, key, channel_id)
            if video_id:
                cache.set(_mem_key(channel_id), video_id, _MEMORY_TTL)
                return {"videoId": video_id, "live": True, "source": "search"}
            return {"videoId": None, "live": False}

    async def _still_live(self, client: httpx.AsyncClient, key: str, video_id: str) -> bool:
        try:
            r = await client.get(f"{_BASE}/videos", params={
                "part": "snippet", "id": video_id, "key": key})
            r.raise_for_status()
            items = r.json().get("items", [])
            if not items:
                return False
            return items[0]["snippet"].get("liveBroadcastContent") == "live"
        except Exception:
            return False

    async def _discover_live(self, client: httpx.AsyncClient, key: str, channel_id: str) -> str | None:
        try:
            r = await client.get(f"{_BASE}/search", params={
                "part": "snippet", "channelId": channel_id,
                "eventType": "live", "type": "video", "key": key})
            r.raise_for_status()
            items = r.json().get("items", [])
            if not items:
                return None
            return items[0]["id"]["videoId"]
        except Exception:
            return None

    def invalidate(self, channel_id: str) -> bool:
        return cache.invalidate(_mem_key(channel_id))


register(YouTubeLiveProvider())
