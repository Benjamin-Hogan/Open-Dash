"""Server-side animated-GIF builder for space-weather imagery.

Fetches NOAA SWPC animation frame lists, downloads a downsampled set of frames,
and assembles a real animated GIF (Pillow) cached on disk. Encoding runs in a
worker thread so the event loop stays responsive; only sources actually requested
by a dashboard are (re)built, on a TTL, by a small background refresher.
"""

from __future__ import annotations

import asyncio
import datetime
import io
import logging
import os
import re
import time
from pathlib import Path

import httpx
from PIL import Image

from .shared.config import DATA_DIR

log = logging.getLogger("gifs")

_SWPC = "https://services.swpc.noaa.gov"
_SDO = "https://sdo.gsfc.nasa.gov/assets/img/browse"
GIF_DIR = DATA_DIR / "gifs"

# slug -> source spec. Two kinds:
#   swpc: a NOAA SWPC animation JSON frame list
#   sdo:  SDO dated browse directories listing per-timestamp images by suffix
# The frontend (space-imagery.js) uses the same slugs.
SOURCES: dict[str, dict] = {
    "aurora-north": {"kind": "swpc", "path": "/products/animations/ovation_north_24h.json"},
    "aurora-south": {"kind": "swpc", "path": "/products/animations/ovation_south_24h.json"},
    "lasco-c2": {"kind": "swpc", "path": "/products/animations/lasco-c2.json"},
    "lasco-c3": {"kind": "swpc", "path": "/products/animations/lasco-c3.json"},
    "suvi-094": {"kind": "swpc", "path": "/products/animations/suvi-primary-094.json"},
    "suvi-131": {"kind": "swpc", "path": "/products/animations/suvi-primary-131.json"},
    "suvi-171": {"kind": "swpc", "path": "/products/animations/suvi-primary-171.json"},
    "suvi-195": {"kind": "swpc", "path": "/products/animations/suvi-primary-195.json"},
    "suvi-284": {"kind": "swpc", "path": "/products/animations/suvi-primary-284.json"},
    "suvi-304": {"kind": "swpc", "path": "/products/animations/suvi-primary-304.json"},
    "enlil": {"kind": "swpc", "path": "/products/animations/enlil.json"},
    "sunspots": {"kind": "sdo", "suffix": "512_HMIIC"},  # white-light continuum
}

MAX_FRAMES = 36
MAX_SIZE = 480       # px, longest side — keeps GIFs a few MB, fine on a Pi
FRAME_MS = 120
TTL = 600.0          # rebuild a GIF at most every 10 min
_RECENT = 1800.0     # keep refreshing sources requested within this window

_locks: dict[str, asyncio.Lock] = {}
_requested: dict[str, float] = {}


def path_for(slug: str) -> Path:
    return GIF_DIR / f"{slug}.gif"


def _fresh(slug: str) -> bool:
    p = path_for(slug)
    return p.exists() and (time.time() - p.stat().st_mtime) < TTL


async def ensure(slug: str) -> Path | None:
    """Return a fresh GIF path for the slug, building if needed. Marks it viewed."""
    _requested[slug] = time.time()
    return await _provide(slug)


async def _provide(slug: str) -> Path | None:
    if _fresh(slug):
        return path_for(slug)
    lock = _locks.setdefault(slug, asyncio.Lock())
    async with lock:
        if _fresh(slug):  # built while we waited on the lock
            return path_for(slug)
        try:
            await _build(slug)
        except Exception as e:
            log.warning("gif build failed for %s: %s", slug, e)
            p = path_for(slug)
            return p if p.exists() else None  # serve a stale copy if we have one
    return path_for(slug)


async def _build(slug: str) -> None:
    spec = SOURCES[slug]
    headers = {"User-Agent": "PiDashboard/3 (+space-imagery)"}
    async with httpx.AsyncClient(timeout=25.0, headers=headers) as client:
        if spec["kind"] == "swpc":
            urls = await _swpc_urls(client, spec["path"])
        elif spec["kind"] == "sdo":
            urls = await _sdo_urls(client, spec["suffix"])
        else:
            raise RuntimeError(f"unknown source kind: {spec['kind']}")
        urls = _downsample(urls, MAX_FRAMES)
        if len(urls) < 2:
            raise RuntimeError("no frames available")
        blobs = [b for b in await _fetch_all(client, urls) if b]
    if len(blobs) < 2:
        raise RuntimeError("frame downloads failed")
    GIF_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path_for(slug).with_suffix(".tmp.gif")
    await asyncio.to_thread(_encode, blobs, tmp)
    os.replace(tmp, path_for(slug))  # atomic publish
    log.info("built gif %s (%d frames)", slug, len(blobs))


async def _swpc_urls(client: httpx.AsyncClient, path: str) -> list[str]:
    r = await client.get(_SWPC + path)
    r.raise_for_status()
    rows = r.json()
    return [_SWPC + row["url"] for row in rows if isinstance(row, dict) and row.get("url")]


async def _sdo_urls(client: httpx.AsyncClient, suffix: str) -> list[str]:
    """Collect per-timestamp frames from SDO's dated browse directories (yesterday
    + today) by filename suffix, e.g. '512_HMIIC' for the white-light continuum."""
    now = datetime.datetime.now(datetime.timezone.utc)
    pat = re.compile(r"\d{8}_\d{6}_" + re.escape(suffix) + r"\.jpg")
    urls: list[str] = []
    for delta in (1, 0):  # yesterday then today, chronological
        d = now - datetime.timedelta(days=delta)
        base = f"{_SDO}/{d:%Y/%m/%d}/"
        try:
            r = await client.get(base)
            r.raise_for_status()
        except Exception:
            continue
        names = sorted(set(pat.findall(r.text)))
        urls += [base + n for n in names]
    return urls


def _downsample(items: list, n: int) -> list:
    if len(items) <= n:
        return items
    step = len(items) / n
    return [items[int(i * step)] for i in range(n - 1)] + [items[-1]]


async def _fetch_all(client: httpx.AsyncClient, urls: list[str]) -> list[bytes | None]:
    async def one(u: str) -> bytes | None:
        try:
            r = await client.get(u)
            r.raise_for_status()
            return r.content
        except Exception:
            return None
    return await asyncio.gather(*(one(u) for u in urls))


def _encode(blobs: list[bytes], out: Path) -> None:
    """CPU-bound: decode, resize, quantize, write GIF. Runs in a worker thread."""
    frames: list[Image.Image] = []
    for b in blobs:
        try:
            im = Image.open(io.BytesIO(b)).convert("RGB")
        except Exception:
            continue
        im.thumbnail((MAX_SIZE, MAX_SIZE))
        frames.append(im.quantize(colors=128, method=Image.MEDIANCUT))
    if len(frames) < 2:
        raise RuntimeError("frame decode failed")
    frames[0].save(
        out, save_all=True, append_images=frames[1:],
        duration=FRAME_MS, loop=0, optimize=True, disposal=2,
    )


async def refresher() -> None:
    """Keep recently-viewed GIFs fresh without rebuilding the whole catalog."""
    while True:
        await asyncio.sleep(60)
        now = time.time()
        for slug, last in list(_requested.items()):
            if now - last <= _RECENT and not _fresh(slug):
                try:
                    await _provide(slug)  # rebuild without resetting "viewed"
                except Exception:
                    pass
