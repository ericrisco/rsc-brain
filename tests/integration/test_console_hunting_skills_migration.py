"""Expand/rollback compatibility for the T008 hunting-directory schema."""

from __future__ import annotations

import asyncio
import uuid

import asyncpg
import pytest
from alembic import command

from rsc_brain.stores.relational.migrations import alembic_config, upgrade_to_head

pytestmark = pytest.mark.integration

PRE_EXPANSION_REVISION = "f3c8e2a91d47"


async def _connect(dsn: str) -> asyncpg.Connection:
    return await asyncpg.connect(dsn.replace("+asyncpg", ""))


async def _column_exists(dsn: str, table: str, column: str) -> bool:
    connection = await _connect(dsn)
    try:
        return bool(
            await connection.fetchval(
                "SELECT count(*) FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2",
                table,
                column,
            )
        )
    finally:
        await connection.close()


async def test_hunting_expansion_downgrades_and_old_writers_remain_compatible(
    migrated_dsn: str,
) -> None:
    """head → previous head → head, exercising an old writer while the expansion is absent."""
    assert await _column_exists(migrated_dsn, "hunts", "topics")
    assert await _column_exists(migrated_dsn, "persons", "version")

    project_id = uuid.uuid4()
    person_id = uuid.uuid4()
    hunt_id = uuid.uuid4()
    connection = await _connect(migrated_dsn)
    try:
        await connection.execute(
            "INSERT INTO projects (id, slug, name) VALUES ($1, $2, $3)",
            project_id,
            f"migration-{project_id.hex[:8]}",
            "Migration compatibility",
        )
    finally:
        await connection.close()

    try:
        await asyncio.to_thread(command.downgrade, alembic_config(), PRE_EXPANSION_REVISION)
        assert not await _column_exists(migrated_dsn, "hunts", "topics")
        assert not await _column_exists(migrated_dsn, "persons", "version")

        connection = await _connect(migrated_dsn)
        try:
            # This is the pre-T008 writer shape: neither expanded field is named.
            await connection.execute(
                "INSERT INTO persons (id, project_id, name) VALUES ($1, $2, $3)",
                person_id,
                project_id,
                "Legacy owner",
            )
            await connection.execute(
                "INSERT INTO hunts (id, project_id, state, question) VALUES ($1, $2, $3, $4)",
                hunt_id,
                project_id,
                "NO_OWNER",
                "Legacy question",
            )
        finally:
            await connection.close()
    finally:
        await asyncio.to_thread(upgrade_to_head)

    assert await _column_exists(migrated_dsn, "hunts", "topics")
    assert await _column_exists(migrated_dsn, "persons", "version")
    connection = await _connect(migrated_dsn)
    try:
        row = await connection.fetchrow(
            "SELECT h.topics, p.version FROM hunts h JOIN persons p ON p.id = $1 WHERE h.id = $2",
            person_id,
            hunt_id,
        )
        assert row is not None and list(row["topics"]) == [] and row["version"] == 1
        await connection.execute("DELETE FROM projects WHERE id = $1", project_id)
    finally:
        await connection.close()
