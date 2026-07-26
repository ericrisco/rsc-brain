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


#: How long a migration may WAIT for a lock before giving up, in milliseconds (AUDIT-049 / R52).
#: Without a bound, a migration blocked behind a long transaction waits forever — and its pending lock
#: request queues AHEAD of every later reader, so one stuck migration stops the product. Failing fast is
#: recoverable: the operator retries when the blocking transaction is gone.
MIGRATION_LOCK_TIMEOUT_MS = 5_000

#: How long a single migration STATEMENT may run. Generous enough for a real index build, short enough
#: that an upgrade cannot hang an instance indefinitely.
MIGRATION_STATEMENT_TIMEOUT_MS = 900_000


def migration_server_settings() -> dict[str, str]:
    """Connection settings every migration runs under. One definition, applied by ``env.py``.

    Applied at CONNECT time, not as statements on the open connection: a ``SET`` issued before Alembic
    begins its transaction opens an implicit one that Alembic's commit does not close, so the migration
    runs and is silently rolled back when the connection closes.
    """
    return {
        "lock_timeout": str(MIGRATION_LOCK_TIMEOUT_MS),
        "statement_timeout": str(MIGRATION_STATEMENT_TIMEOUT_MS),
    }


def upgrade_to_head() -> None:
    """Apply pending migrations to head. Idempotent (a second run is a no-op).

    Runs with a bounded ``lock_timeout`` (R52): a migration that cannot take its lock fails instead of
    queueing in front of every reader.
    """
    command.upgrade(alembic_config(), "head")
