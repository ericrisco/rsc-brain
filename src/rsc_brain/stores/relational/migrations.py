"""Alembic migration helpers, usable from both the CLI and the relational store."""

from __future__ import annotations

from dataclasses import dataclass
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


@dataclass(frozen=True, slots=True)
class SchemaState:
    """What the database is stamped at, and what this code expects (T022 re-audit).

    Three gates claimed "the schema is at head" while checking only that ``alembic_version`` had a ROW:
    the init container R49 added, the post-restore verification R41 added, and the readiness probe. On a
    fresh install the table is empty until the migration stamps it, so all three worked. On an UPGRADE the
    row is already there from the previous version — so the init container passed instantly and api/worker
    started against the old schema, which is the ordering failure R49 exists to prevent, on the path R49
    was about.

    One definition, so three gates cannot drift into three different answers.
    """

    stamped: str | None
    head: str | None

    @property
    def at_head(self) -> bool:
        return self.stamped is not None and self.head is not None and self.stamped == self.head

    def explain(self) -> str:
        if self.stamped is None:
            return "the schema has never been migrated (alembic_version is empty)"
        if self.at_head:
            return f"schema at head ({self.head})"
        return f"schema is at {self.stamped}, this build expects {self.head}"


def head_revision() -> str | None:
    """The revision this build's migrations end at."""
    from alembic.script import ScriptDirectory

    heads = ScriptDirectory.from_config(alembic_config()).get_heads()
    # A linear history has exactly one head. More than one means an un-merged branch, which no gate
    # should call "ready" — reporting None makes `at_head` false rather than guessing which one counts.
    return heads[0] if len(heads) == 1 else None


def schema_state(dsn: str | None = None) -> SchemaState:
    """Compare what the database is stamped at against this build's head. Synchronous by design:
    every caller is either a CLI command or a readiness check, and neither needs an event loop for it."""
    from sqlalchemy import create_engine, text

    from rsc_brain.stores.relational.database import resolve_dsn

    url = (dsn or resolve_dsn()).replace("+asyncpg", "+psycopg")
    engine = create_engine(url)
    try:
        with engine.connect() as connection:
            stamped = connection.execute(text("SELECT version_num FROM alembic_version")).scalar()
    except Exception:
        stamped = None
    finally:
        engine.dispose()
    return SchemaState(stamped=str(stamped) if stamped else None, head=head_revision())


def upgrade_to_head() -> None:
    """Apply pending migrations to head. Idempotent (a second run is a no-op).

    Runs with a bounded ``lock_timeout`` (R52): a migration that cannot take its lock fails instead of
    queueing in front of every reader.
    """
    command.upgrade(alembic_config(), "head")
