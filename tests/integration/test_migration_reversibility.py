"""The P0-A migrations are reversible (AUDIT-039/AUDIT-021, R12/R17).

A rollback path that has never executed is not a rollback path. These three revisions change
constraints and drop a column, and one of them collapses per-project counters back into a pooled
row — the kind of SQL that only tells you it is wrong when you need it. So the cycle is exercised:
head → before P0-A → head, asserting the schema arrives back in the constrained state both times.

Deliberately NOT here: the lock-budget and load behaviour of an ONLINE upgrade against a seeded
database. That is R49/R52, owned by task T019.
"""

from __future__ import annotations

import asyncio

import asyncpg
import pytest
from alembic import command

from rsc_brain.stores.relational.migrations import alembic_config, upgrade_to_head

pytestmark = pytest.mark.integration

#: The revision immediately before the P0-A batch.
BEFORE_P0A = "a7c3e1f9d248"

#: What the constrained schema must look like, in the catalogue rather than in the models.
QUALIFIED_FK = "fk_chunks_project_id_document_id_documents"
LEGACY_FK = "fk_chunks_document_id_documents"


async def _connect(dsn: str) -> asyncpg.Connection:
    return await asyncpg.connect(dsn.replace("+asyncpg", ""))


async def _constraint_exists(dsn: str, name: str) -> bool:
    conn = await _connect(dsn)
    try:
        return bool(
            await conn.fetchval("SELECT count(*) FROM pg_constraint WHERE conname = $1", name)
        )
    finally:
        await conn.close()


async def _column_exists(dsn: str, table: str, column: str) -> bool:
    conn = await _connect(dsn)
    try:
        return bool(
            await conn.fetchval(
                "SELECT count(*) FROM information_schema.columns "
                "WHERE table_name = $1 AND column_name = $2",
                table,
                column,
            )
        )
    finally:
        await conn.close()


async def test_the_p0a_batch_round_trips(migrated_dsn: str) -> None:
    """head → before P0-A → head, with the schema asserted at each stop.

    Alembic's env calls ``asyncio.run()``, so each command runs in a worker thread rather than
    nested in this loop (same reason ``test_migrate_is_idempotent`` does).
    """
    assert await _constraint_exists(migrated_dsn, QUALIFIED_FK)
    assert await _column_exists(migrated_dsn, "token_usage", "project_id")
    assert await _column_exists(migrated_dsn, "claims", "subject_entity_key")

    try:
        await asyncio.to_thread(command.downgrade, alembic_config(), BEFORE_P0A)

        # Down: the ID-only reference is back, the project column and the identity keys are gone.
        assert not await _constraint_exists(migrated_dsn, QUALIFIED_FK)
        assert await _constraint_exists(migrated_dsn, LEGACY_FK)
        assert not await _column_exists(migrated_dsn, "token_usage", "project_id")
        assert not await _column_exists(migrated_dsn, "claims", "subject_entity_key")
        assert not await _column_exists(migrated_dsn, "claims", "object_entity_key")
        # …and the pooled counter identity the old code upserted against is restored.
        assert await _constraint_exists(migrated_dsn, "uq_token_usage_capability_day")
    finally:
        # Always leave the container at head: every other test in the session shares it.
        await asyncio.to_thread(upgrade_to_head)

    assert await _constraint_exists(migrated_dsn, QUALIFIED_FK)
    assert not await _constraint_exists(migrated_dsn, LEGACY_FK)
    assert await _column_exists(migrated_dsn, "token_usage", "project_id")
    assert await _column_exists(migrated_dsn, "claims", "object_entity_key")
