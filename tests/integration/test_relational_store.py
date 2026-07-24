"""Integration: RelationalStore CRUD + hard multiproject isolation (SPEC-03 AC-3/4)."""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.scope import Principal, PrincipalType, ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker
from rsc_brain.stores.relational.store import PgRelationalStore

pytestmark = pytest.mark.integration


def _scope(project_id: str) -> ProjectScope:
    return Principal(id="u1", type=PrincipalType.HUMAN).scope_for(project_id)


async def _seed_projects(sessionmaker: async_sessionmaker[AsyncSession]) -> tuple[str, str]:
    async with sessionmaker() as session:
        a = models.Project(slug="proj-a", name="Project A")
        b = models.Project(slug="proj-b", name="Project B")
        session.add_all([a, b])
        await session.commit()
        return str(a.id), str(b.id)


async def test_crud_and_multiproject_isolation(migrated_dsn: str) -> None:
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    try:
        project_a, project_b = await _seed_projects(sessionmaker)
        scope_a, scope_b = _scope(project_a), _scope(project_b)
        repo = PgRelationalStore(sessionmaker).knowledge()

        # The same checksum may exist in two projects (FR-12.6): unique is per-project.
        doc_a = await repo.create_document(scope_a, logical_id="d1", checksum="shared-sum")
        doc_b = await repo.create_document(scope_b, logical_id="d1", checksum="shared-sum")

        # Each scope sees only its own document (disjoint corpora).
        assert await repo.count_documents(scope_a) == 1
        assert await repo.count_documents(scope_b) == 1
        assert [d.document_id for d in await repo.list_documents(scope_a)] == [doc_a.document_id]
        assert [d.document_id for d in await repo.list_documents(scope_b)] == [doc_b.document_id]

        # Same-project read succeeds; cross-project read is indistinguishable from not-found.
        assert await repo.get_document(scope_a, doc_a.document_id) is not None
        assert await repo.get_document(scope_b, doc_a.document_id) is None

        # A chunk written under scope A is counted only under scope A.
        await repo.add_chunk(scope_a, document_id=doc_a.document_id, text="hello")
        assert await repo.count_chunks(scope_a) == 1
        assert await repo.count_chunks(scope_b) == 0
    finally:
        await engine.dispose()


async def test_duplicate_checksum_within_project_is_rejected(migrated_dsn: str) -> None:
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    try:
        async with sessionmaker() as session:
            project = models.Project(slug="proj-dup", name="Dup")
            session.add(project)
            await session.commit()
            scope = _scope(str(project.id))
        repo = PgRelationalStore(sessionmaker).knowledge()
        await repo.create_document(scope, logical_id="d1", checksum="dup")
        with pytest.raises(Exception):  # unique(project_id, checksum) violated  # noqa: B017
            await repo.create_document(scope, logical_id="d2", checksum="dup")
    finally:
        await engine.dispose()
