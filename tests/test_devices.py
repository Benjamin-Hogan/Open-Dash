"""Device store: heartbeat upsert, remove, id validation surface."""

from __future__ import annotations

import pytest

from server.shared import devices as device_store


@pytest.fixture(autouse=True)
def _isolated_devices(tmp_path, monkeypatch):
    monkeypatch.setattr(device_store, "DATA_DIR", tmp_path)
    monkeypatch.setattr(device_store, "DEVICES_PATH", tmp_path / "devices.json")
    monkeypatch.setattr(device_store, "_devices", None)
    yield
    monkeypatch.setattr(device_store, "_devices", None)


@pytest.mark.asyncio
async def test_heartbeat_upserts_same_id_once():
    await device_store.heartbeat("dev-aaaa-bbbb-cccc-ddddeeee0001", "Kitchen", "1920×1080")
    await device_store.heartbeat("dev-aaaa-bbbb-cccc-ddddeeee0001", "Kitchen", "1920×1080")
    listed = device_store.list_all()
    assert len(listed) == 1
    assert listed[0]["id"] == "dev-aaaa-bbbb-cccc-ddddeeee0001"
    assert listed[0]["name"] == "Kitchen"


@pytest.mark.asyncio
async def test_remove_forgets_device():
    await device_store.heartbeat("dev-1", "A", "800×600")
    assert await device_store.remove("dev-1") is True
    assert device_store.list_all() == []
    assert await device_store.remove("dev-1") is False


@pytest.mark.asyncio
async def test_distinct_ids_are_distinct_rows():
    await device_store.heartbeat("id-one", "Display id-o", "100×100")
    await device_store.heartbeat("id-two", "Display id-t", "100×100")
    assert len(device_store.list_all()) == 2


@pytest.mark.asyncio
async def test_set_prefs_renames_display():
    await device_store.heartbeat("dev-rename", "Kitchen", "1920×1080")
    updated = await device_store.set_prefs("dev-rename", {"name": "Garage TV"})
    assert updated["name"] == "Garage TV"
    assert device_store.get("dev-rename")["name"] == "Garage TV"
