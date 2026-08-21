"""AUDIT-107 correction snapshot migration round-trip against real PostgreSQL."""

from __future__ import annotations

import asyncio
import uuid

import asyncpg
import pytest
from alembic import command

from rsc_brain.stores.relational.migrations import alembic_config, upgrade_to_head

pytestmark = pytest.mark.integration

PRE_SNAPSHOT_REVISION = "6c4a8f2d9b10"
SNAPSHOT_COLUMNS = (
    "target_valid_from_before",
    "target_valid_to_before",
    "validity_snapshot_captured_at",
    "lifecycle_error",
    "reverted_by",
)


async def _connect(dsn: str) -> asyncpg.Connection:
    return await asyncpg.connect(dsn.replace("+asyncpg", ""))


async def _columns(dsn: str) -> set[str]:
    connection = await _connect(dsn)
    try:
        rows = await connection.fetch(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = 'corrections'"
        )
        return {str(row["column_name"]) for row in rows}
    finally:
        await connection.close()


async def test_correction_snapshot_schema_round_trips_and_legacy_rows_stay_uncaptured(
    migrated_dsn: str,
) -> None:
    project_id, claim_id, correction_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    assert set(SNAPSHOT_COLUMNS) <= await _columns(migrated_dsn)
    connection = await _connect(migrated_dsn)
    try:
        await connection.execute(
            "INSERT INTO projects (id, slug, name) VALUES ($1, $2, $3)",
            project_id,
            f"snapshot-{project_id.hex[:8]}",
            "Correction snapshot migration",
        )
        await connection.execute(
            "INSERT INTO claims (id, project_id, text) VALUES ($1, $2, $3)",
            claim_id,
            project_id,
            "Legacy claim",
        )
        await connection.execute(
            "INSERT INTO corrections (id, project_id, target_claim, status) "
            "VALUES ($1, $2, $3, $4)",
            correction_id,
            project_id,
            claim_id,
            "applied",
        )
    finally:
        await connection.close()

    try:
        await asyncio.to_thread(command.downgrade, alembic_config(), PRE_SNAPSHOT_REVISION)
        assert set(SNAPSHOT_COLUMNS).isdisjoint(await _columns(migrated_dsn))
    finally:
        await asyncio.to_thread(upgrade_to_head)

    assert set(SNAPSHOT_COLUMNS) <= await _columns(migrated_dsn)
    connection = await _connect(migrated_dsn)
    try:
        row = await connection.fetchrow(
            "SELECT target_valid_from_before, target_valid_to_before, "
            "validity_snapshot_captured_at, lifecycle_error, reverted_by "
            "FROM corrections WHERE id = $1",
            correction_id,
        )
        assert row is not None
        assert all(row[column] is None for column in SNAPSHOT_COLUMNS)
        await connection.execute("DELETE FROM projects WHERE id = $1", project_id)
    finally:
        await connection.close()
