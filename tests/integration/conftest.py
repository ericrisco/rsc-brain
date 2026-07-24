"""Integration fixtures: a real Postgres 16 + Apache AGE + pgvector container (testcontainers).

Uses the product's own data image (`rsc-brain/db:pg16-age-pgvector`), so integration evidence
runs against the exact runtime the product ships — not a mock or vanilla Postgres.
"""

from __future__ import annotations

import os
from collections.abc import Iterator

import pytest
from alembic import command
from testcontainers.postgres import PostgresContainer

from rsc_brain.cli.data import alembic_config
from rsc_brain.stores.relational.database import DSN_ENV_VAR

_IMAGE = "rsc-brain/db:pg16-age-pgvector"
# >=16 chars and not a placeholder, so the image's password guard accepts it.
_PASSWORD = "testcontainers-strong-pw-abc123"


@pytest.fixture(scope="session")
def pg_dsn() -> Iterator[str]:
    """Start the AGE+pgvector container once per session; yield an async DSN."""
    container = PostgresContainer(
        _IMAGE, username="rsc_brain", password=_PASSWORD, dbname="rsc_brain"
    ).with_command("postgres -c shared_preload_libraries=age")
    with container as running:
        host = running.get_container_host_ip()
        port = running.get_exposed_port(5432)
        yield f"postgresql+asyncpg://rsc_brain:{_PASSWORD}@{host}:{port}/rsc_brain"


@pytest.fixture(scope="session")
def migrated_dsn(pg_dsn: str) -> Iterator[str]:
    """Apply migrations to head against the container; yield the DSN."""
    previous = os.environ.get(DSN_ENV_VAR)
    os.environ[DSN_ENV_VAR] = pg_dsn
    try:
        command.upgrade(alembic_config(), "head")
        yield pg_dsn
    finally:
        if previous is None:
            os.environ.pop(DSN_ENV_VAR, None)
        else:
            os.environ[DSN_ENV_VAR] = previous
