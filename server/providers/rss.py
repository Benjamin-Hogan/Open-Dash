"""RSS / Atom feed reader — keyless. Fetched and parsed server-side (browsers
can't fetch arbitrary feeds cross-origin). Extracts title, link, date, a plain
-text description, an image (Media RSS / enclosure / first <img> in the body),
and author."""

from __future__ import annotations

import html
import re
import xml.etree.ElementTree as ET
from typing import Any

import httpx

from ..shared.providers import Provider, register

_ATOM = "{http://www.w3.org/2005/Atom}"
_MEDIA = "{http://search.yahoo.com/mrss/}"
_CONTENT = "{http://purl.org/rss/1.0/modules/content/}"
_DC = "{http://purl.org/dc/elements/1.1/}"

_TAG_RE = re.compile(r"<[^>]+>")
_IMG_RE = re.compile(r'<img[^>]+src=["\']([^"\']+)["\']', re.I)
_WS_RE = re.compile(r"\s+")


def _text(el: ET.Element | None) -> str:
    return (el.text or "").strip() if el is not None else ""


def _strip_html(s: str, limit: int = 320) -> str:
    if not s:
        return ""
    txt = html.unescape(_TAG_RE.sub(" ", s))
    txt = _WS_RE.sub(" ", txt).strip()
    return txt[:limit].rstrip() + "…" if len(txt) > limit else txt


def _first_img(*html_blobs: str) -> str:
    for blob in html_blobs:
        if blob:
            m = _IMG_RE.search(blob)
            if m:
                return html.unescape(m.group(1))
    return ""


def _extract_image(it: ET.Element, body_html: str) -> str:
    # Media RSS: prefer the widest media:content image, else media:thumbnail
    best, best_w = "", -1
    for mc in it.findall(_MEDIA + "content"):
        url = mc.get("url", "")
        typ = mc.get("type", "")
        medium = mc.get("medium", "")
        if not url:
            continue
        if medium == "image" or typ.startswith("image") or re.search(r"\.(jpe?g|png|webp|gif)", url, re.I):
            w = int(mc.get("width") or 0)
            if w > best_w:
                best, best_w = url, w
    if best:
        return best
    thumb = it.find(_MEDIA + "thumbnail")
    if thumb is not None and thumb.get("url"):
        return thumb.get("url")
    # RSS enclosure
    for enc in it.findall("enclosure"):
        if enc.get("type", "").startswith("image") and enc.get("url"):
            return enc.get("url")
    # Atom enclosure link
    for ln in it.findall(_ATOM + "link"):
        if ln.get("rel") == "enclosure" and (ln.get("type", "")).startswith("image") and ln.get("href"):
            return ln.get("href")
    # last resort: first <img> inside the HTML body
    return _first_img(body_html)


class RSSProvider(Provider):
    name = "rss"
    ttl = 600.0  # 10 min

    async def fetch(self, params: dict[str, Any]) -> dict[str, Any]:
        url = str(params.get("url", "")).strip()
        count = int(params.get("count") or 12)
        if not url:
            return {"items": [], "error": "no url"}
        headers = {"User-Agent": "PiDashboard/3 (+rss)"}
        async with httpx.AsyncClient(timeout=10.0, headers=headers, follow_redirects=True) as client:
            r = await client.get(url)
            r.raise_for_status()
            root = ET.fromstring(r.content)

        items: list[dict[str, Any]] = []
        channel = root.find("channel")
        if channel is not None:  # RSS 2.0
            feed_title = _text(channel.find("title"))
            feed_image = ""
            img_el = channel.find("image")
            if img_el is not None:
                feed_image = _text(img_el.find("url"))
            for it in channel.findall("item"):
                desc = _text(it.find("description"))
                content = _text(it.find(_CONTENT + "encoded"))
                items.append({
                    "title": _text(it.find("title")),
                    "link": _text(it.find("link")),
                    "published": _text(it.find("pubDate")),
                    "author": _text(it.find(_DC + "creator")) or _text(it.find("author")),
                    "description": _strip_html(desc or content),
                    "image": _extract_image(it, content or desc),
                })
        else:  # Atom
            feed_title = _text(root.find(_ATOM + "title"))
            feed_image = _text(root.find(_ATOM + "logo")) or _text(root.find(_ATOM + "icon"))
            for it in root.findall(_ATOM + "entry"):
                link = ""
                for ln in it.findall(_ATOM + "link"):
                    if ln.get("rel", "alternate") == "alternate" and ln.get("href"):
                        link = ln.get("href"); break
                if not link:
                    le = it.find(_ATOM + "link")
                    link = le.get("href") if le is not None else ""
                summary = _text(it.find(_ATOM + "summary")) or _text(it.find(_ATOM + "content"))
                items.append({
                    "title": _text(it.find(_ATOM + "title")),
                    "link": link,
                    "published": _text(it.find(_ATOM + "updated")) or _text(it.find(_ATOM + "published")),
                    "author": _text(it.find(f"{_ATOM}author/{_ATOM}name")),
                    "description": _strip_html(summary),
                    "image": _extract_image(it, summary),
                })
        return {"feedTitle": feed_title, "feedImage": feed_image, "items": items[:count]}


register(RSSProvider())
