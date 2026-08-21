"""Upgrade/downgrade evidence for durable OKF skill extensions (AUDIT-015)."""

from __future__ import annotations

import asyncio
import uuid

import asyncpg
import pytest
from alembic import command
from alembic.script import ScriptDirectory

from rsc_brain.stores.relational.migrations import alembic_config, upgrade_to_head

pytestmark = pytest.mark.integration

#: The revision this migration expands from, read from the script directory rather than
#: pinned: the history gets re-chained whenever another migration lands first, and a
#: hardcoded parent silently turns this into a downgrade through unrelated migrations.
REVISION = "a7e1c9d4f260"


def _previous_revision() -> str:
    parent = ScriptDirectory.from_config(alembic_config()).get_revision(REVISION).down_revision
    assert isinstance(parent, str)
    return parent


async def _connect(dsn: str) -> asyncpg.Connection:
    return await asyncpg.connect(dsn.replace("+asyncpg", ""))


async def _column_exists(dsn: str, column: str) -> bool:
    connection = await _connect(dsn)
    try:
        return bool(
            await connection.fetchval(
                "SELECT count(*) FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = 'skills' AND column_name = $1",
                column,
            )
        )
    finally:
        await connection.close()


async def test_okf_extension_storage_is_reversible_and_backfills_legacy_rows(
    migrated_dsn: str,
) -> None:
    assert await _column_exists(migrated_dsn, "okf_type")
    assert await _column_exists(migrated_dsn, "okf_extensions")

    project_id = uuid.uuid4()
    skill_id = uuid.uuid4()
    try:
        await asyncio.to_thread(command.downgrade, alembic_config(), _previous_revision())
        assert not await _column_exists(migrated_dsn, "okf_type")
        assert not await _column_exists(migrated_dsn, "okf_extensions")

        connection = await _connect(migrated_dsn)
        try:
            await connection.execute(
                "INSERT INTO projects (id, slug, name) VALUES ($1, $2, $3)",
                project_id,
                f"okf-migration-{project_id.hex[:8]}",
                "OKF migration",
            )
            await connection.execute(
                "INSERT INTO skills (id, project_id, slug, title, state) VALUES ($1, $2, $3, $4, $5)",
                skill_id,
                project_id,
                "legacy",
                "Legacy skill",
                "active",
            )
        finally:
            await connection.close()

        await asyncio.to_thread(upgrade_to_head)
        connection = await _connect(migrated_dsn)
        try:
            row = await connection.fetchrow(
                "SELECT okf_type, okf_extensions::text FROM skills WHERE id = $1", skill_id
            )
            assert row is not None
            assert row["okf_type"] == "Skill"
            assert row["okf_extensions"] == "{}"
        finally:
            await connection.close()
    finally:
        await asyncio.to_thread(upgrade_to_head)
        connection = await _connect(migrated_dsn)
        try:
            await connection.execute("DELETE FROM projects WHERE id = $1", project_id)
        finally:
            await connection.close()
