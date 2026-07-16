"""Local Raspberry Pi stats — CPU temp, load, memory. No external API, no key.

Reads Linux /proc and /sys on the Pi; degrades to nulls on other platforms (dev
machines) so the widget renders a sensible "n/a" instead of crashing.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

from ..shared.providers import Provider, register

_prev_cpu: tuple[int, int] | None = None  # (idle, total)


def _cpu_temp_c() -> float | None:
    p = Path("/sys/class/thermal/thermal_zone0/temp")
    try:
        return round(int(p.read_text().strip()) / 1000.0, 1)
    except Exception:
        return None


def _cpu_percent() -> float | None:
    global _prev_cpu
    try:
        fields = Path("/proc/stat").read_text().splitlines()[0].split()[1:]
        nums = list(map(int, fields))
        idle = nums[3] + (nums[4] if len(nums) > 4 else 0)
        total = sum(nums)
        if _prev_cpu is not None:
            d_idle = idle - _prev_cpu[0]
            d_total = total - _prev_cpu[1]
            _prev_cpu = (idle, total)
            if d_total > 0:
                return round((1 - d_idle / d_total) * 100, 1)
        _prev_cpu = (idle, total)
    except Exception:
        return None
    return None


def _mem() -> dict[str, Any]:
    try:
        info = {}
        for line in Path("/proc/meminfo").read_text().splitlines():
            k, _, v = line.partition(":")
            info[k] = int(v.strip().split()[0])  # kB
        total = info["MemTotal"]
        avail = info.get("MemAvailable", info["MemFree"])
        used = total - avail
        return {
            "totalMb": round(total / 1024),
            "usedMb": round(used / 1024),
            "percent": round(used / total * 100, 1),
        }
    except Exception:
        return {"totalMb": None, "usedMb": None, "percent": None}


def _uptime_seconds() -> float | None:
    try:
        return float(Path("/proc/uptime").read_text().split()[0])
    except Exception:
        return None


class PiStatsProvider(Provider):
    name = "pi-stats"
    ttl = 3.0

    async def fetch(self, params: dict[str, Any]) -> dict[str, Any]:
        load1 = None
        try:
            load1 = round(os.getloadavg()[0], 2)
        except (OSError, AttributeError):
            pass
        return {
            "tempC": _cpu_temp_c(),
            "cpuPercent": _cpu_percent(),
            "load1": load1,
            "memory": _mem(),
            "uptimeSeconds": _uptime_seconds(),
            "ts": time.time(),
        }


register(PiStatsProvider())
