"""Run the Node test files under tests/ as part of the pytest suite.

pytest only collects ``test_*.py``, so the ``.mjs`` smoke tests next to this
file were being run by nothing. This shells out to ``node`` for each one and
asserts a clean exit, so a single ``pytest`` covers both languages.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

TESTS_DIR = Path(__file__).parent
MJS_TESTS = sorted(TESTS_DIR.glob("test_*.mjs"))


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
@pytest.mark.parametrize("script", MJS_TESTS, ids=lambda p: p.name)
def test_node_suite(script: Path):
    proc = subprocess.run(
        ["node", str(script)],
        capture_output=True,
        text=True,
        cwd=TESTS_DIR.parent,
        timeout=60,
    )
    if proc.returncode != 0:
        pytest.fail(f"{script.name} failed:\n{proc.stdout}\n{proc.stderr}")
