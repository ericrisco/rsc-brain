"""Data-layer CLI commands (SPEC-03): migrate (backup/restore/forget added alongside)."""

from __future__ import annotations

import typer

from rsc_brain.cli._common import JSON_OPTION, emit_result
from rsc_brain.stores.relational.migrations import upgrade_to_head


def migrate(ctx: typer.Context, json_output: bool = JSON_OPTION) -> None:
    """Apply pending database migrations to head. Idempotent (re-run = no-op)."""
    upgrade_to_head()
    emit_result(
        ctx,
        json_output,
        {"status": "ok", "action": "migrate", "target": "head"},
        "brain migrate: database is at head.",
    )
