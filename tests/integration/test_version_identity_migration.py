"""Real downgrade/upgrade proof for AUDIT-014's identity-preserving schema."""

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
REVISION = "7d4e9a2c1b63"


def _previous_revision() -> str:
    parent = ScriptDirectory.from_config(alembic_config()).get_revision(REVISION).down_revision
    assert isinstance(parent, str)
    return parent


async def _connect(dsn: str) -> asyncpg.Connection:
    return await asyncpg.connect(dsn.replace("+asyncpg", ""))


async def test_legacy_claim_identity_round_trips_without_rewrite(migrated_dsn: str) -> None:
    project_id = uuid.uuid4()
    document_id = uuid.uuid4()
    chunk_id = uuid.uuid4()
    claim_id = uuid.uuid4()
    slug = f"migration-{project_id.hex[:10]}"

    try:
        await asyncio.to_thread(command.downgrade, alembic_config(), _previous_revision())
        connection = await _connect(migrated_dsn)
        try:
            await connection.execute(
                "INSERT INTO projects (id, slug, name) VALUES ($1, $2, $2)", project_id, slug
            )
            await connection.execute(
                "INSERT INTO documents "
                "(id, project_id, logical_id, checksum, status) VALUES ($1, $2, 'policy', $3, 'processed')",
                document_id,
                project_id,
                uuid.uuid4().hex,
            )
            await connection.execute(
                "INSERT INTO chunks (id, project_id, document_id, kind, text) "
                "VALUES ($1, $2, $3, 'prose', 'The SLA is 24 hours.')",
                chunk_id,
                project_id,
                document_id,
            )
            await connection.execute(
                "INSERT INTO claims (id, project_id, chunk_id, text, credibility, source_document_id) "
                "VALUES ($1, $2, $3, 'The SLA is 24 hours.', 0.77, $4)",
                claim_id,
                project_id,
                chunk_id,
                document_id,
            )
        finally:
            await connection.close()

        await asyncio.to_thread(upgrade_to_head)
        connection = await _connect(migrated_dsn)
        try:
            claim = await connection.fetchrow(
                "SELECT id, credibility FROM claims WHERE id = $1", claim_id
            )
            occurrence = await connection.fetchrow(
                "SELECT claim_id, document_id, chunk_id FROM claim_occurrences WHERE claim_id = $1",
                claim_id,
            )
            ordinal = await connection.fetchval(
                "SELECT ordinal FROM chunks WHERE id = $1", chunk_id
            )
            assert claim is not None and claim["id"] == claim_id
            assert float(claim["credibility"]) == 0.77
            assert occurrence == (claim_id, document_id, chunk_id)
            assert ordinal == 0
        finally:
            await connection.close()

        await asyncio.to_thread(command.downgrade, alembic_config(), _previous_revision())
        connection = await _connect(migrated_dsn)
        try:
            assert not await connection.fetchval("SELECT to_regclass('claim_occurrences')")
            assert not await connection.fetchval("SELECT to_regclass('claim_supersessions')")
            assert not await connection.fetchval(
                "SELECT count(*) FROM information_schema.columns "
                "WHERE table_name = 'chunks' AND column_name = 'ordinal'"
            )
            claim = await connection.fetchrow(
                "SELECT id, credibility FROM claims WHERE id = $1", claim_id
            )
            assert claim is not None and claim["id"] == claim_id
            assert float(claim["credibility"]) == 0.77
        finally:
            await connection.close()
    finally:
        await asyncio.to_thread(upgrade_to_head)
