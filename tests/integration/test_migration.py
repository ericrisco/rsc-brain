"""Integration tests for the initial migration against real Postgres+AGE+pgvector (SPEC-03)."""

from __future__ import annotations

import asyncio

import asyncpg
import pytest

from rsc_brain.stores.relational.migrations import upgrade_to_head

pytestmark = pytest.mark.integration

# Knowledge/operation tables that MUST carry a NOT NULL project_id + composite index (FR-12.2).
KNOWLEDGE_TABLES = [
    "sources",
    "documents",
    "chunks",
    "claims",
    "entities",
    "entity_aliases",
    "topics",
    "persons",
    "gaps",
    "hunts",
    "skills",
    "audit_log",
    "ingest_errors",
]


async def _connect(dsn: str) -> asyncpg.Connection:
    return await asyncpg.connect(dsn.replace("+asyncpg", ""))


async def test_extensions_present(migrated_dsn: str) -> None:
    conn = await _connect(migrated_dsn)
    try:
        rows = await conn.fetch(
            "SELECT extname FROM pg_extension WHERE extname IN ('age', 'vector')"
        )
    finally:
        await conn.close()
    assert {r["extname"] for r in rows} == {"age", "vector"}


async def test_knowledge_tables_have_notnull_project_id(migrated_dsn: str) -> None:
    conn = await _connect(migrated_dsn)
    try:
        for table in KNOWLEDGE_TABLES:
            nullable = await conn.fetchval(
                "SELECT is_nullable FROM information_schema.columns "
                "WHERE table_name = $1 AND column_name = 'project_id'",
                table,
            )
            assert nullable == "NO", f"{table}.project_id must be NOT NULL"
    finally:
        await conn.close()


async def test_knowledge_tables_have_project_id_leading_index(migrated_dsn: str) -> None:
    conn = await _connect(migrated_dsn)
    try:
        for table in KNOWLEDGE_TABLES:
            defs = await conn.fetch("SELECT indexdef FROM pg_indexes WHERE tablename = $1", table)
            assert any("(project_id" in d["indexdef"] for d in defs), (
                f"{table} needs a composite index beginning at project_id"
            )
    finally:
        await conn.close()


async def test_embedding_columns_are_1024_dim(migrated_dsn: str) -> None:
    conn = await _connect(migrated_dsn)
    try:
        for table in ("chunks", "claims"):
            typ = await conn.fetchval(
                "SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a "
                "JOIN pg_class c ON c.oid = a.attrelid "
                "WHERE c.relname = $1 AND a.attname = 'embedding'",
                table,
            )
            assert typ == "vector(1024)", f"{table}.embedding must be vector(1024), got {typ}"
    finally:
        await conn.close()


async def test_documents_unique_project_checksum(migrated_dsn: str) -> None:
    conn = await _connect(migrated_dsn)
    try:
        exists = await conn.fetchval(
            "SELECT count(*) FROM pg_indexes WHERE tablename = 'documents' "
            "AND indexdef LIKE '%UNIQUE%project_id%checksum%'"
        )
    finally:
        await conn.close()
    assert exists == 1


async def test_migrate_is_idempotent(migrated_dsn: str) -> None:
    # Re-running upgrade head against an at-head database is a clean no-op. Run in a worker
    # thread because Alembic's async env calls asyncio.run(), which cannot nest in this loop.
    await asyncio.to_thread(upgrade_to_head)
    conn = await _connect(migrated_dsn)
    try:
        version = await conn.fetchval("SELECT version_num FROM alembic_version")
    finally:
        await conn.close()
    assert version  # a single head revision is recorded
