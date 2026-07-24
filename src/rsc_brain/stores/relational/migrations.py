"""Alembic migration helpers, usable from both the CLI and the relational store."""

from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config as AlembicConfig

import rsc_brain.stores.relational as _relational


def alembic_config() -> AlembicConfig:
    """Alembic config pointing at the migrations packaged inside the product."""
    alembic_dir = Path(_relational.__file__).resolve().parent / "alembic"
    cfg = AlembicConfig()
    cfg.set_main_option("script_location", str(alembic_dir))
    return cfg


def upgrade_to_head() -> None:
    """Apply pending migrations to head. Idempotent (a second run is a no-op)."""
    command.upgrade(alembic_config(), "head")
