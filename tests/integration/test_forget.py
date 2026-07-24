"""Integration: `brain forget --document` hard-deletes + tombstones + audits (SPEC-03 AC-8)."""

from __future__ import annotations

import pytest
from sqlalchemy import text

from rsc_brain.cli.data import _forget_document
from rsc_brain.scope import Principal, PrincipalType, ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.graph_store import GraphNode
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker
from rsc_brain.stores.relational.store import PgRelationalStore

pytestmark = pytest.mark.integration


def _scope(project_id: str) -> ProjectScope:
    return Principal(id="u1", type=PrincipalType.HUMAN).scope_for(project_id)


async def test_forget_document_removes_all_traces_and_is_idempotent(migrated_dsn: str) -> None:
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    try:
        async with sessionmaker() as session:
            from rsc_brain.stores.relational import models

            project = models.Project(slug="forget-p", name="F")
            session.add(project)
            await session.commit()
            project_id = str(project.id)

        scope = _scope(project_id)
        repo = PgRelationalStore(sessionmaker).knowledge()
        graph = AgeGraphStore(sessionmaker)
        await graph.create_graph(scope)

        doc = await repo.create_document(scope, logical_id="d", checksum="c")
        await repo.add_chunk(scope, document_id=doc.document_id, text="body")
        await graph.upsert_nodes(
            scope,
            [GraphNode(id="n1", labels=frozenset({"Entity"}), properties={"source_document_id": doc.document_id})],
        )
        assert await repo.count_documents(scope) == 1
        assert await repo.count_chunks(scope) == 1

        result = await _forget_document(project_id, doc.document_id)
        assert result == {"deleted": 1, "tombstoned": 1}

        # Relational: document + cascaded chunks are gone.
        assert await repo.count_documents(scope) == 0
        assert await repo.count_chunks(scope) == 0

        # Graph: the derived node is tombstoned (no live nodes remain).
        live = await graph.run_cypher(
            scope, "MATCH (n) WHERE n.suppressed IS NULL RETURN count(n)", {}
        )
        assert live[0]["result"] == 0

        # Audited, no content retained.
        async with sessionmaker() as session:
            audited = await session.scalar(
                text("SELECT count(*) FROM audit_log WHERE action = 'forget_document'")
            )
            assert audited and audited >= 1

        # Idempotent: a second forget deletes/tombstones nothing.
        assert await _forget_document(project_id, doc.document_id) == {"deleted": 0, "tombstoned": 0}
    finally:
        await engine.dispose()
