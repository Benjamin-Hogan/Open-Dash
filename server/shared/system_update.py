"""Pull the current git branch and restart the process in-place.

Used by the admin "Update" control so a Pi/LAN deploy can pick up new commits
without a manual tear-down / pull / redeploy cycle.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import time
from pathlib import Path

from .config import ROOT

log = logging.getLogger("dashboard.update")

_GIT_TIMEOUT_S = 120


class UpdateError(Exception):
    """Raised when git is unavailable or pull cannot complete cleanly."""


def repo_dir() -> Path:
    """Resolve the git working tree (host checkout or Docker `/repo` mount)."""
    env = os.environ.get("REPO_DIR")
    if env:
        path = Path(env)
        if not (path / ".git").exists():
            raise UpdateError(f"REPO_DIR={path} is not a git checkout (.git missing)")
        return path
    if (ROOT / ".git").exists():
        return ROOT
    docker_mount = Path("/repo")
    if (docker_mount / ".git").exists():
        return docker_mount
    raise UpdateError(
        "No git checkout found. For Docker, mount the repo at /repo "
        "(compose sets REPO_DIR=/repo)."
    )


def _run_git(repo: Path, *args: str) -> str:
    try:
        proc = subprocess.run(
            ["git", "-C", str(repo), *args],
            capture_output=True,
            text=True,
            timeout=_GIT_TIMEOUT_S,
            check=False,
        )
    except FileNotFoundError as exc:
        raise UpdateError("git is not installed on this host/container") from exc
    except subprocess.TimeoutExpired as exc:
        raise UpdateError(f"git {' '.join(args)} timed out") from exc
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or f"exit {proc.returncode}").strip()
        raise UpdateError(detail)
    return (proc.stdout or "").strip()


def pull_current_branch() -> dict[str, str]:
    """`git pull --ff-only` on the current branch. Returns branch/sha/output."""
    repo = repo_dir()
    branch = _run_git(repo, "rev-parse", "--abbrev-ref", "HEAD")
    if branch == "HEAD":
        raise UpdateError("Detached HEAD — check out a branch before updating")
    before = _run_git(repo, "rev-parse", "--short", "HEAD")
    output = _run_git(repo, "pull", "--ff-only")
    after = _run_git(repo, "rev-parse", "--short", "HEAD")
    log.info("pulled %s: %s → %s", branch, before, after)
    return {
        "branch": branch,
        "sha": after,
        "previousSha": before,
        "output": output or "Already up to date.",
    }


def restart_process(*, delay_s: float = 0.8) -> None:
    """Replace this process with a fresh `python -m server.run` after a short delay.

    The delay lets the HTTP response finish flushing before exec. Works under
    Docker (compose restart policy is a fallback if exec fails) and local runs.
    """
    time.sleep(delay_s)
    log.info("restarting process after update")
    os.execv(sys.executable, [sys.executable, "-m", "server.run"])
