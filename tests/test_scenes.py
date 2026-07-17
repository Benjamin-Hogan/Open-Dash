"""Scene modes — schema validation and config compatibility."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from server.shared import migrations
from server.shared.schema import DashboardConfig, Scene, SceneThemeOverlay


def test_config_without_scenes_defaults():
    cfg = DashboardConfig.model_validate(
        {
            "version": 1,
            "settings": {"title": "T"},
            "pages": [{"id": "page-1", "name": "Home", "widgets": []}],
            "rotation": {"enabled": False, "defaultDurationSeconds": 30, "order": []},
        }
    )
    assert cfg.scenes == []
    assert cfg.activeSceneId is None
    assert cfg.sceneManualHold is False


def test_migrate_flat_widgets_still_works_with_scenes_absent():
    raw = {
        "version": 1,
        "settings": {"title": "T"},
        "widgets": [
            {"id": "c1", "type": "clock", "title": "Clock", "grid": {"x": 0, "y": 0, "w": 3, "h": 2}},
        ],
    }
    out = migrations.migrate(raw)
    cfg = DashboardConfig.model_validate(out)
    assert len(cfg.pages) == 1
    assert cfg.scenes == []


def test_scene_roundtrip():
    cfg = DashboardConfig.model_validate(
        {
            "version": 2,
            "settings": {"title": "T"},
            "pages": [
                {"id": "page-1", "name": "Home", "widgets": []},
                {"id": "page-print", "name": "Print", "widgets": []},
            ],
            "rotation": {"enabled": True, "defaultDurationSeconds": 20, "order": []},
            "scenes": [
                {
                    "id": "scene-morning",
                    "name": "Morning",
                    "pageIds": ["page-1"],
                    "theme": {"mode": "light", "accent": "#ffaa00"},
                    "variantLabel": "day",
                    "rotation": {"enabled": True, "defaultDurationSeconds": 15},
                    "schedule": {
                        "enabled": True,
                        "start": "06:00",
                        "end": "09:00",
                        "days": [0, 1, 2, 3, 4],
                    },
                },
                {
                    "id": "scene-print",
                    "name": "Print watch",
                    "pageIds": ["page-print"],
                },
            ],
            "activeSceneId": "scene-print",
            "sceneManualHold": True,
        }
    )
    assert len(cfg.scenes) == 2
    assert cfg.scenes[0].theme.mode == "light"
    assert cfg.scenes[0].variantLabel == "day"
    assert cfg.sceneManualHold is True
    dumped = cfg.model_dump()
    again = DashboardConfig.model_validate(dumped)
    assert again.activeSceneId == "scene-print"


def test_duplicate_scene_ids_rejected():
    with pytest.raises(ValidationError):
        DashboardConfig.model_validate(
            {
                "version": 1,
                "pages": [{"id": "page-1", "name": "Home", "widgets": []}],
                "scenes": [
                    {"id": "s1", "name": "A"},
                    {"id": "s1", "name": "B"},
                ],
            }
        )


def test_scene_theme_partial_overlay():
    sc = Scene.model_validate(
        {"id": "s", "name": "N", "theme": {"accent": "#112233"}}
    )
    assert isinstance(sc.theme, SceneThemeOverlay)
    assert sc.theme.mode is None
    assert sc.theme.accent == "#112233"


def test_empty_active_scene_id_becomes_none():
    cfg = DashboardConfig.model_validate(
        {
            "version": 1,
            "pages": [{"id": "page-1", "name": "Home", "widgets": []}],
            "activeSceneId": "",
        }
    )
    assert cfg.activeSceneId is None
