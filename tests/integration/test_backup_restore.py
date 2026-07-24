"""Integration: `brain backup` → wipe → `brain restore` → verify round-trips (SPEC-03 AC-7).

Requires the PostgreSQL client tools (pg_dump/pg_restore) on PATH. They are absent on some dev
hosts, so this test skips locally and runs in CI (which installs postgresql-client-16). The
`brain` CLI is invoked as a subprocess to exercise the real command, not internals.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import uuid
from pathlib import Path

import pytest
from sqlalchemy import text

from rsc_brain.stores.relational.database import (
    DSN_ENV_VAR,
    make_engine,
    make_sessionmaker,
)

pytestmark = pytest.mark.integration

_PG_TOOLS = shutil.which("pg_dump") and shutil.which("pg_restore")
skip_without_pg_tools = pytest.mark.skipif(
    not _PG_TOOLS, reason="pg_dump/pg_restore not installed (runs in CI)"
)


def _brain(env: dict[str, str], *args: str) -> None:
    subprocess.run(["uv", "run", "brain", *args], env=env, check=True)


@skip_without_pg_tools
async def test_backup_restore_roundtrip(migrated_dsn: str, tmp_path: Path) -> None:
    slug = f"br-{uuid.uuid4().hex[:8]}"
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    try:
        async with sessionmaker() as session:
            from rsc_brain.stores.relational import models

            session.add(models.Project(slug=slug, name="Backup/Restore"))
            await session.commit()
    finally:
        await engine.dispose()

    env = {**os.environ, DSN_ENV_VAR: migrated_dsn}
    dump = tmp_path / "rsc-brain.dump"
    _brain(env, "backup", "--output", str(dump))
    assert dump.exists() and dump.stat().st_size > 0

    # Wipe the seeded row, then restore it from the dump.
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    try:
        async with sessionmaker() as session:
            await session.execute(text("DELETE FROM projects WHERE slug = :s"), {"s": slug})
            await session.commit()
    finally:
        await engine.dispose()

    _brain(env, "restore", str(dump))

    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    try:
        async with sessionmaker() as session:
            count = await session.scalar(
                text("SELECT count(*) FROM projects WHERE slug = :s"), {"s": slug}
            )
    finally:
        await engine.dispose()
    assert count == 1
