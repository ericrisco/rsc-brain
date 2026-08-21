"""The durable skill prompt marker is safe across rollback and roll-forward."""

from __future__ import annotations

import asyncio

import asyncpg
import pytest
from alembic import command

from rsc_brain.stores.relational.migrations import alembic_config, upgrade_to_head

pytestmark = pytest.mark.integration

PRE_MAINTENANCE_REVISION = "6c4a8f2d9b10"


async def _columns_exist(dsn: str) -> set[str]:
    connection = await asyncpg.connect(dsn.replace("+asyncpg", ""))
    try:
        rows = await connection.fetch(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = 'skills' "
            "AND column_name = ANY($1::text[])",
            ["idle_prompted_at", "proposal_notified_at"],
        )
        return {str(row["column_name"]) for row in rows}
    finally:
        await connection.close()


async def test_idle_prompt_marker_downgrades_and_upgrades(migrated_dsn: str) -> None:
    expected = {"idle_prompted_at", "proposal_notified_at"}
    assert await _columns_exist(migrated_dsn) == expected
    try:
        await asyncio.to_thread(command.downgrade, alembic_config(), PRE_MAINTENANCE_REVISION)
        assert await _columns_exist(migrated_dsn) == set()
    finally:
        await asyncio.to_thread(upgrade_to_head)
    assert await _columns_exist(migrated_dsn) == expected
