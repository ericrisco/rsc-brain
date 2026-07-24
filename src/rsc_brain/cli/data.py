"""Data-layer CLI commands (SPEC-03): migrate (backup/restore/forget added alongside)."""

from __future__ import annotations

from pathlib import Path

import typer
from alembic import command
from alembic.config import Config as AlembicConfig

import rsc_brain.stores.relational as _relational
from rsc_brain.cli._common import JSON_OPTION, emit_result


def alembic_config() -> AlembicConfig:
    """Alembic config pointing at the migrations packaged inside the product."""
    alembic_dir = Path(_relational.__file__).resolve().parent / "alembic"
    cfg = AlembicConfig()
    cfg.set_main_option("script_location", str(alembic_dir))
    return cfg


def migrate(ctx: typer.Context, json_output: bool = JSON_OPTION) -> None:
    """Apply pending database migrations to head. Idempotent (re-run = no-op)."""
    command.upgrade(alembic_config(), "head")
    emit_result(
        ctx,
        json_output,
        {"status": "ok", "action": "migrate", "target": "head"},
        "brain migrate: database is at head.",
    )
