"""AUDIT-018 expand/downgrade compatibility for the durable stale outbox."""

from __future__ import annotations

import asyncio
import uuid

import asyncpg
import pytest
from alembic import command

from rsc_brain.stores.relational.migrations import alembic_config, upgrade_to_head

pytestmark = pytest.mark.integration

PRE_OUTBOX_REVISION = "6c4a8f2d9b10"


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


async def _table_exists(dsn: str, table: str) -> bool:
    connection = await _connect(dsn)
    try:
        return bool(await connection.fetchval("SELECT to_regclass($1)", f"public.{table}"))
    finally:
        await connection.close()


async def test_stale_outbox_migration_is_reversible_and_accepts_the_previous_writer(
    migrated_dsn: str,
) -> None:
    assert await _column_exists(migrated_dsn, "skills", "stale_generation")
    assert await _column_exists(migrated_dsn, "audit_log", "resource_id")
    assert await _table_exists(migrated_dsn, "skill_stale_notifications")
    project_id = uuid.uuid4()
    skill_id = uuid.uuid4()

    try:
        await asyncio.to_thread(command.downgrade, alembic_config(), PRE_OUTBOX_REVISION)
        assert not await _column_exists(migrated_dsn, "skills", "stale_generation")
        assert not await _table_exists(migrated_dsn, "skill_stale_notifications")
        connection = await _connect(migrated_dsn)
        try:
            await connection.execute(
                "INSERT INTO projects (id, slug, name) VALUES ($1, $2, $3)",
                project_id,
                f"outbox-migration-{project_id.hex[:8]}",
                "Outbox migration",
            )
            # Exact previous-head writer: it names none of the expansion columns.
            await connection.execute(
                "INSERT INTO skills (id, project_id, slug, title, state) "
                "VALUES ($1, $2, $3, $4, $5)",
                skill_id,
                project_id,
                "legacy-skill",
                "Legacy skill",
                "active",
            )
        finally:
            await connection.close()
    finally:
        await asyncio.to_thread(upgrade_to_head)

    connection = await _connect(migrated_dsn)
    try:
        row = await connection.fetchrow(
            "SELECT stale_generation FROM skills WHERE project_id = $1 AND id = $2",
            project_id,
            skill_id,
        )
        assert row is not None and row["stale_generation"] == 0
        await connection.execute("DELETE FROM projects WHERE id = $1", project_id)
    finally:
        await connection.close()
