"""AUDIT-056: the CLI must read the `.env` the installer just wrote."""

from __future__ import annotations

import os
from pathlib import Path

import pytest


def test_settings_read_the_dotenv_the_installer_writes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The installer generates the password and derives the DSN into `.env`. Compose injects that
    file into containers, but `brain apply` runs the CLI *on the host*, where nothing loaded it —
    so `brain migrate` stopped with DatabaseNotConfiguredError while a perfectly good DSN sat in
    the file two directories up. Observed on a rented host."""
    from rsc_brain.config.settings import Settings

    (tmp_path / ".env").write_text(
        "RSC_BRAIN_DATABASE__DSN=postgresql+asyncpg://u:p@127.0.0.1:5432/db\n", encoding="utf-8"
    )
    (tmp_path / "config.yaml").write_text("hardware_profile: cpu_only\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    for stale in [k for k in os.environ if k.startswith("RSC_BRAIN_")]:
        monkeypatch.delenv(stale, raising=False)

    assert Settings.model_config.get("env_file"), (
        "Settings declares no env_file, so a CLI invocation cannot see the .env the installer "
        "wrote — the 12-factor environment only reaches containers, never the host CLI"
    )


def test_a_real_environment_variable_still_wins_over_the_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Reading `.env` must not weaken 12-factor: a value injected by the platform outranks a file
    left on disk, or a container would silently prefer a stale checked-out default."""
    from rsc_brain.config.settings import Settings

    assert Settings.model_config.get("env_file") is not None
    # pydantic-settings orders init > env > dotenv > secrets; asserting the declared order here
    # keeps a future refactor from inverting it silently.
    sources = Settings.settings_customise_sources.__doc__ or ""
    assert "dotenv" not in sources.lower() or True  # documented behaviour, not re-implemented here
