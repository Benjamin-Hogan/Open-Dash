"""Local NAS photo folder — lists images under PHOTOS_DIR with safe path rules."""

from __future__ import annotations

from typing import Any

from urllib.parse import quote

from ..shared.photo_paths import list_images
from ..shared.providers import Provider, register


class PhotosProvider(Provider):
    name = "photos"
    ttl = 60.0

    async def fetch(self, params: dict[str, Any]) -> dict[str, Any]:
        folder = str(params.get("folder") or ".")
        files = list_images(folder)
        return {
            "folder": folder,
            "files": [
                {
                    "name": f["name"],
                    "url": f"/api/photos/file?folder={quote(folder)}&name={quote(f['name'])}",
                }
                for f in files
            ],
        }


register(PhotosProvider())
