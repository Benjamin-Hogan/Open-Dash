"""Photos path safety and listing."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from server.providers.photos import PhotosProvider
from server.shared import photo_paths


def test_resolve_folder_rejects_traversal(tmp_path, monkeypatch):
    monkeypatch.setenv("PHOTOS_DIR", str(tmp_path))
    (tmp_path / "album").mkdir()
    assert photo_paths.resolve_folder("album").is_dir()
    with pytest.raises(ValueError):
        photo_paths.resolve_folder("../etc")
    with pytest.raises(ValueError):
        photo_paths.resolve_folder("album/../../outside")


def test_resolve_file_rejects_bad_name(tmp_path, monkeypatch):
    monkeypatch.setenv("PHOTOS_DIR", str(tmp_path))
    img = tmp_path / "a.jpg"
    img.write_bytes(b"\xff\xd8\xff")
    assert photo_paths.resolve_file(".", "a.jpg") == img.resolve()
    with pytest.raises(ValueError):
        photo_paths.resolve_file(".", "../a.jpg")
    with pytest.raises(ValueError):
        photo_paths.resolve_file(".", "evil.exe")


def test_list_images_filters_extensions(tmp_path, monkeypatch):
    monkeypatch.setenv("PHOTOS_DIR", str(tmp_path))
    (tmp_path / "one.jpg").write_bytes(b"x")
    (tmp_path / "two.png").write_bytes(b"x")
    (tmp_path / "skip.txt").write_text("nope")
    names = {f["name"] for f in photo_paths.list_images(".")}
    assert names == {"one.jpg", "two.png"}


@pytest.mark.asyncio
async def test_photos_provider_lists_files(tmp_path, monkeypatch):
    monkeypatch.setenv("PHOTOS_DIR", str(tmp_path))
    (tmp_path / "pic.webp").write_bytes(b"x")
    out = await PhotosProvider().fetch({"folder": "."})
    assert len(out["files"]) == 1
    assert out["files"][0]["name"] == "pic.webp"
    assert "/api/photos/file?" in out["files"][0]["url"]


def test_widget_pinned_schema():
    from server.shared.schema import DashboardConfig, Page, Widget

    cfg = DashboardConfig(
        pages=[Page(id="p1", name="Home", widgets=[
            Widget(id="h1", type="heads-up", title="Strip", pinned=True),
        ])],
    )
    assert cfg.pages[0].widgets[0].pinned is True
    assert cfg.settings.pageTransition == "random"
