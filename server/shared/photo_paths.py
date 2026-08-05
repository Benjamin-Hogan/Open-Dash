"""Safe path resolution for the local photos gallery."""

from __future__ import annotations

import os
from pathlib import Path

ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}


def photos_root() -> Path:
    return Path(os.environ.get("PHOTOS_DIR", "/app/photos")).resolve()


def resolve_folder(folder: str) -> Path:
    """Resolve a folder path under PHOTOS_DIR; reject traversal."""
    root = photos_root()
    root.mkdir(parents=True, exist_ok=True)
    raw = (folder or ".").strip().replace("\\", "/")
    while raw.startswith("./"):
        raw = raw[2:]
    raw = raw.strip("/")
    target = (root / raw).resolve() if raw else root
    if target != root and not str(target).startswith(str(root) + os.sep):
        raise ValueError("folder escapes photos root")
    return target


def resolve_file(folder: str, name: str) -> Path:
    """Resolve a single file under PHOTOS_DIR/folder; reject traversal."""
    if not name or name != Path(name).name:
        raise ValueError("invalid file name")
    parent = resolve_folder(folder)
    path = (parent / name).resolve()
    root = photos_root()
    if not str(path).startswith(str(root) + os.sep) and path != root:
        raise ValueError("file escapes photos root")
    if path.suffix.lower() not in ALLOWED_EXTENSIONS:
        raise ValueError("unsupported file type")
    return path


def list_images(folder: str) -> list[dict[str, str]]:
    """Return image metadata for a folder relative to PHOTOS_DIR."""
    try:
        target = resolve_folder(folder)
    except ValueError:
        return []
    if not target.is_dir():
        return []
    files: list[dict[str, str]] = []
    for entry in sorted(target.iterdir()):
        if not entry.is_file():
            continue
        if entry.suffix.lower() not in ALLOWED_EXTENSIONS:
            continue
        files.append({"name": entry.name})
    return files
