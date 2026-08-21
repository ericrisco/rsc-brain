"""AUDIT-012 schema preflight, history-safe downgrade and exact round trip."""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import Iterator

import asyncpg
import pytest
from alembic import command
from testcontainers.community.postgres import PostgresContainer

from rsc_brain.stores.relational.database import DSN_ENV_VAR
from rsc_brain.stores.relational.migrations import alembic_config

pytestmark = pytest.mark.integration

PRE_MERGE_SNAPSHOT = "6c4a8f2d9b10"
HEAD = "7d5b9e3a1c42"
IMAGE = "rsc-brain/db:pg16-age-pgvector"
PASSWORD = "entity-merge-migration-pw-abc123"


@pytest.fixture
def entity_merge_migration_dsn() -> Iterator[str]:
    container = PostgresContainer(
        IMAGE,
        username="rsc_brain",
        password=PASSWORD,
        dbname="rsc_brain",
    ).with_command("postgres -c shared_preload_libraries=age")
    with container as running:
        host = running.get_container_host_ip()
        port = running.get_exposed_port(5432)
        yield f"postgresql+asyncpg://rsc_brain:{PASSWORD}@{host}:{port}/rsc_brain"


async def _connect(dsn: str) -> asyncpg.Connection:
    return await asyncpg.connect(dsn.replace("+asyncpg", ""))


async def _constraint_exists(connection: asyncpg.Connection, name: str) -> bool:
    return bool(
        await connection.fetchval("SELECT count(*) FROM pg_constraint WHERE conname = $1", name)
    )


async def _table_exists(connection: asyncpg.Connection, name: str) -> bool:
    return bool(
        await connection.fetchval(
            "SELECT count(*) FROM information_schema.tables "
            "WHERE table_schema = 'public' AND table_name = $1",
            name,
        )
    )


async def test_entity_merge_migration_preflight_and_round_trip(
    entity_merge_migration_dsn: str,
) -> None:
    previous_dsn = os.environ.get(DSN_ENV_VAR)
    os.environ[DSN_ENV_VAR] = entity_merge_migration_dsn
    project_id = uuid.uuid4()
    canonical_id = uuid.uuid4()
    duplicate_id = uuid.uuid4()
    proposal_id = uuid.uuid4()
    try:
        await asyncio.to_thread(command.upgrade, alembic_config(), PRE_MERGE_SNAPSHOT)
        connection = await _connect(entity_merge_migration_dsn)
        try:
            await connection.execute(
                "INSERT INTO projects (id, slug, name) VALUES ($1, $2, $3)",
                project_id,
                f"merge-migration-{project_id.hex[:8]}",
                "Merge migration",
            )
            await connection.executemany(
                "INSERT INTO entities (id, project_id, name, normalized_name, type) "
                "VALUES ($1, $2, $3, $4, 'org')",
                [
                    (canonical_id, project_id, "Canonical", "canonical"),
                    (duplicate_id, project_id, "Duplicate", "duplicate"),
                ],
            )
            await connection.execute(
                "UPDATE entities SET merged_into = id WHERE id = $1",
                duplicate_id,
            )
        finally:
            await connection.close()

        with pytest.raises(RuntimeError, match="integrity violations"):
            await asyncio.to_thread(command.upgrade, alembic_config(), HEAD)

        connection = await _connect(entity_merge_migration_dsn)
        try:
            assert not await _table_exists(connection, "entity_merge_snapshots")
            await connection.execute(
                "UPDATE entities SET merged_into = NULL WHERE id = $1",
                duplicate_id,
            )
        finally:
            await connection.close()

        await asyncio.to_thread(command.upgrade, alembic_config(), HEAD)
        connection = await _connect(entity_merge_migration_dsn)
        try:
            assert await _table_exists(connection, "entity_merge_snapshots")
            assert await _constraint_exists(
                connection,
                "fk_entities_project_type_merged_into_entities",
            )
            assert await _constraint_exists(connection, "ck_entities_merged_into_not_self")
            await connection.execute(
                "INSERT INTO entity_merge_proposals "
                "(id, project_id, canonical_entity_id, duplicate_entity_id, confidence, method, status) "
                "VALUES ($1, $2, $3, $4, 0.9, 'migration-test', 'applied')",
                proposal_id,
                project_id,
                canonical_id,
                duplicate_id,
            )
            await connection.execute(
                "INSERT INTO entity_merge_snapshots "
                "(project_id, proposal_id, canonical_entity_id, duplicate_entity_id, "
                "canonical_graph_node_id, duplicate_graph_node_id, previous_proposal_status, "
                "aliases_before, aliases_after, graph_before, graph_after, "
                "duplicate_node_before, duplicate_node_after) "
                "VALUES ($1, $2, $3, $4, 'canonical-node', 'duplicate-node', "
                "'needs_review', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, "
                '\'{"exists": false, "markers": {}}\'::jsonb, '
                '\'{"exists": false, "markers": {}}\'::jsonb)',
                project_id,
                proposal_id,
                canonical_id,
                duplicate_id,
            )
        finally:
            await connection.close()

        with pytest.raises(RuntimeError, match="snapshot history"):
            await asyncio.to_thread(command.downgrade, alembic_config(), PRE_MERGE_SNAPSHOT)

        connection = await _connect(entity_merge_migration_dsn)
        try:
            assert await _table_exists(connection, "entity_merge_snapshots")
            await connection.execute("DELETE FROM projects WHERE id = $1", project_id)
        finally:
            await connection.close()

        await asyncio.to_thread(command.downgrade, alembic_config(), PRE_MERGE_SNAPSHOT)
        connection = await _connect(entity_merge_migration_dsn)
        try:
            assert not await _table_exists(connection, "entity_merge_snapshots")
            assert await _constraint_exists(connection, "fk_entities_merged_into_entities")
            assert not await _constraint_exists(
                connection,
                "fk_entities_project_type_merged_into_entities",
            )
        finally:
            await connection.close()

        await asyncio.to_thread(command.upgrade, alembic_config(), HEAD)
        connection = await _connect(entity_merge_migration_dsn)
        try:
            assert await _table_exists(connection, "entity_merge_snapshots")
            assert await _constraint_exists(
                connection,
                "fk_entities_project_type_merged_into_entities",
            )
        finally:
            await connection.close()
    finally:
        if previous_dsn is None:
            os.environ.pop(DSN_ENV_VAR, None)
        else:
            os.environ[DSN_ENV_VAR] = previous_dsn
