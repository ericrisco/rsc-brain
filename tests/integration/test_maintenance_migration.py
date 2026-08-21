"""The durable skill prompt marker is safe across rollback and roll-forward."""

from __future__ import annotations

import asyncio

import asyncpg
import pytest
from alembic import command
from alembic.script import ScriptDirectory

from rsc_brain.stores.relational.migrations import alembic_config, upgrade_to_head

pytestmark = pytest.mark.integration

#: The revision this migration expands from, read from the script directory rather than pinned:
#: the history gets re-chained whenever another migration lands first, and a hardcoded parent
#: silently turns this into a downgrade through unrelated migrations.
REVISION = "a7e4c2d91b63"


def _previous_revision() -> str:
    parent = ScriptDirectory.from_config(alembic_config()).get_revision(REVISION).down_revision
    assert isinstance(parent, str)
    return parent


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
        await asyncio.to_thread(command.downgrade, alembic_config(), _previous_revision())
        assert await _columns_exist(migrated_dsn) == set()
    finally:
        await asyncio.to_thread(upgrade_to_head)
    assert await _columns_exist(migrated_dsn) == expected
