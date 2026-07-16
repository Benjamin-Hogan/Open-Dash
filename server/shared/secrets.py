"""API-key store, settable from the admin panel.

Keys live in data/secrets.json (NOT under web/, so never statically served) and
are only ever read server-side by providers. The admin can read *status* (which
keys are set, masked) but the plaintext values are never returned to any client.

Precedence: an environment variable wins over the stored value, so a deployment
can still inject keys without the file.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from .config import DATA_DIR

SECRETS_PATH = DATA_DIR / "secrets.json"

# The keys the UI knows how to manage.
KNOWN_KEYS = {
    "FINNHUB_API_KEY": "Stocks (Finnhub)",
    "YOUTUBE_API_KEY": "YouTube live",
    "OCTOPRINT_API_KEY": "OctoPrint (3D printer)",
}

_cache: dict[str, str] | None = None


def _load() -> dict[str, str]:
    global _cache
    if _cache is None:
        try:
            _cache = json.loads(SECRETS_PATH.read_text(encoding="utf-8"))
        except Exception:
            _cache = {}
    return _cache


def get(key: str) -> str | None:
    """Resolve a key: environment variable first, then the stored file."""
    return os.environ.get(key) or _load().get(key) or None


def set_many(values: dict[str, str]) -> None:
    """Store/overwrite keys. Empty string clears a stored key."""
    global _cache
    data = dict(_load())
    for k, v in values.items():
        if k not in KNOWN_KEYS:
            continue
        if v:
            data[k] = v
        else:
            data.pop(k, None)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = SECRETS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(tmp, SECRETS_PATH)
    _cache = data


def status() -> dict[str, dict]:
    """Masked status for the admin UI — never the actual values."""
    stored = _load()
    out: dict[str, dict] = {}
    for key, label in KNOWN_KEYS.items():
        env = bool(os.environ.get(key))
        filed = bool(stored.get(key))
        out[key] = {
            "label": label,
            "set": env or filed,
            "source": "env" if env else ("file" if filed else None),
            "editable": not env,  # env-injected keys can't be overridden from the UI
        }
    return out
