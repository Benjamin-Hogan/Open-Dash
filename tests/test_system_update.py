"""Admin system update: resolve repo + git pull helpers."""

from __future__ import annotations

from pathlib import Path

import pytest

from server.shared import system_update


def test_repo_dir_uses_repo_dir_env(tmp_path, monkeypatch):
    (tmp_path / ".git").mkdir()
    monkeypatch.setenv("REPO_DIR", str(tmp_path))
    assert system_update.repo_dir() == tmp_path


def test_repo_dir_rejects_env_without_git(tmp_path, monkeypatch):
    monkeypatch.setenv("REPO_DIR", str(tmp_path))
    with pytest.raises(system_update.UpdateError, match="not a git checkout"):
        system_update.repo_dir()


def test_repo_dir_falls_back_to_root(monkeypatch, tmp_path):
    monkeypatch.delenv("REPO_DIR", raising=False)
    monkeypatch.setattr(system_update, "ROOT", tmp_path)
    (tmp_path / ".git").mkdir()
    assert system_update.repo_dir() == tmp_path


def test_pull_current_branch_ff_only(monkeypatch, tmp_path):
    (tmp_path / ".git").mkdir()
    monkeypatch.setenv("REPO_DIR", str(tmp_path))

    calls: list[tuple[str, ...]] = []

    def fake_run_git(repo: Path, *args: str) -> str:
        assert repo == tmp_path
        calls.append(args)
        if args == ("rev-parse", "--abbrev-ref", "HEAD"):
            return "feat/test"
        if args == ("rev-parse", "--short", "HEAD"):
            return "abc1234" if len(calls) == 2 else "def5678"
        if args == ("pull", "--ff-only"):
            return "Updating abc1234..def5678"
        raise AssertionError(args)

    monkeypatch.setattr(system_update, "_run_git", fake_run_git)
    result = system_update.pull_current_branch()
    assert result["branch"] == "feat/test"
    assert result["previousSha"] == "abc1234"
    assert result["sha"] == "def5678"
    assert ("pull", "--ff-only") in calls


def test_pull_rejects_detached_head(monkeypatch, tmp_path):
    (tmp_path / ".git").mkdir()
    monkeypatch.setenv("REPO_DIR", str(tmp_path))
    monkeypatch.setattr(
        system_update,
        "_run_git",
        lambda repo, *args: "HEAD" if args[:2] == ("rev-parse", "--abbrev-ref") else "",
    )
    with pytest.raises(system_update.UpdateError, match="Detached HEAD"):
        system_update.pull_current_branch()


def test_run_git_surfaces_stderr(monkeypatch, tmp_path):
    class FakeProc:
        returncode = 1
        stdout = ""
        stderr = "fatal: not a git repository"

    monkeypatch.setattr(
        system_update.subprocess,
        "run",
        lambda *a, **k: FakeProc(),
    )
    with pytest.raises(system_update.UpdateError, match="not a git repository"):
        system_update._run_git(tmp_path, "status")
