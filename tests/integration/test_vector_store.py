"""Integration: pgvector search is project- and tag-scoped in-query (SPEC-03 AC-5)."""

from __future__ import annotations

import pytest

from rsc_brain.scope import CrossProjectScopeError, Principal, PrincipalType, ProjectScope
from rsc_brain.stores.pgvector_store import PgVectorStore
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker
from rsc_brain.stores.relational.store import PgRelationalStore
from rsc_brain.stores.vector_store import VectorRecord

pytestmark = pytest.mark.integration

_E1 = [1.0] + [0.0] * 1023
_E2 = [0.0] * 1023 + [1.0]


def _scope(project_id: str) -> ProjectScope:
    return Principal(id="u1", type=PrincipalType.HUMAN).scope_for(project_id)


async def test_vector_search_is_project_and_tag_scoped(migrated_dsn: str) -> None:
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    try:
        async with sessionmaker() as session:
            pa = models.Project(slug="vec-a", name="A")
            pb = models.Project(slug="vec-b", name="B")
            session.add_all([pa, pb])
            await session.commit()
            project_a, project_b = str(pa.id), str(pb.id)

        scope_a, scope_b = _scope(project_a), _scope(project_b)
        repo = PgRelationalStore(sessionmaker).knowledge()
        vectors = PgVectorStore(sessionmaker)

        doc_a = await repo.create_document(scope_a, logical_id="d", checksum="a")
        chunk_a = await repo.add_chunk(scope_a, document_id=doc_a.document_id, text="alpha")
        doc_b = await repo.create_document(scope_b, logical_id="d", checksum="b")
        chunk_b = await repo.add_chunk(scope_b, document_id=doc_b.document_id, text="beta")

        await vectors.upsert(
            scope_a,
            [VectorRecord(chunk_id=chunk_a, project_id=project_a, embedding=_E1, tags=frozenset({"hr"}))],
        )
        await vectors.upsert(
            scope_b,
            [VectorRecord(chunk_id=chunk_b, project_id=project_b, embedding=_E1, tags=frozenset({"hr"}))],
        )

        # Each scope only ever sees its own project's chunk (disjoint corpora).
        hits_a = await vectors.search(scope_a, _E1, allowed_tags=frozenset({"hr"}), k=10)
        assert [h.chunk_id for h in hits_a] == [chunk_a]
        hits_b = await vectors.search(scope_b, _E1, allowed_tags=frozenset({"hr"}), k=10)
        assert [h.chunk_id for h in hits_b] == [chunk_b]

        # Tag filter excludes chunks whose tags don't overlap the caller's allowed set.
        assert await vectors.search(scope_a, _E1, allowed_tags=frozenset({"finance"}), k=10) == []
        # No allowed tags => no results.
        assert await vectors.search(scope_a, _E1, allowed_tags=frozenset(), k=10) == []

    finally:
        await engine.dispose()


async def test_cross_project_upsert_is_rejected(migrated_dsn: str) -> None:
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    try:
        async with sessionmaker() as session:
            project = models.Project(slug="vec-x", name="X")
            session.add(project)
            await session.commit()
            scope = _scope(str(project.id))
        vectors = PgVectorStore(sessionmaker)
        foreign = VectorRecord(
            chunk_id="00000000-0000-0000-0000-000000000000",
            project_id="11111111-1111-1111-1111-111111111111",
            embedding=_E1,
            tags=frozenset(),
        )
        with pytest.raises(CrossProjectScopeError):
            await vectors.upsert(scope, [foreign])
    finally:
        await engine.dispose()
