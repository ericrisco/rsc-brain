"""Integration: AGE graph is physically per-project; k-hop + tombstone (SPEC-03 AC-6/8)."""

from __future__ import annotations

import uuid

import pytest

from rsc_brain.scope import Principal, PrincipalType, ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.graph_store import GraphEdge, GraphNode
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker

pytestmark = pytest.mark.integration


def _scope(project_id: str) -> ProjectScope:
    return Principal(id="u1", type=PrincipalType.HUMAN).scope_for(project_id)


async def test_graph_isolation_khop_and_tombstone(migrated_dsn: str) -> None:
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    graph = AgeGraphStore(sessionmaker)
    scope_a = _scope(str(uuid.uuid4()))
    scope_b = _scope(str(uuid.uuid4()))
    try:
        await graph.create_graph(scope_a)
        await graph.create_graph(scope_b)

        await graph.upsert_nodes(
            scope_a,
            [
                GraphNode(
                    id="e1",
                    labels=frozenset({"Entity"}),
                    properties={"name": "Alice", "source_document_id": "doc1"},
                ),
                GraphNode(
                    id="e2",
                    labels=frozenset({"Entity"}),
                    properties={"name": "Bob", "source_document_id": "doc2"},
                ),
            ],
        )
        await graph.upsert_edges(
            scope_a, [GraphEdge(source_id="e1", target_id="e2", type="KNOWS", properties={})]
        )
        # Project B has a node with the SAME id in its own physical graph.
        await graph.upsert_nodes(
            scope_b,
            [GraphNode(id="e1", labels=frozenset({"Entity"}), properties={"name": "Other"})],
        )

        # k-hop in A reaches e2; project B's graph has no edges, so k-hop there is empty.
        hopped = await graph.k_hop(scope_a, ["e1"], k=2)
        assert {n.id for n in hopped} == {"e2"}
        assert await graph.k_hop(scope_b, ["e1"], k=2) == []

        # Physical isolation: A has 2 nodes, B has 1.
        assert (await graph.run_cypher(scope_a, "MATCH (n) RETURN count(n)", {}))[0]["result"] == 2
        assert (await graph.run_cypher(scope_b, "MATCH (n) RETURN count(n)", {}))[0]["result"] == 1

        # Tombstone the document behind e2 -> k-hop no longer returns it.
        suppressed = await graph.tombstone_document(scope_a, "doc2")
        assert suppressed == 1
        assert await graph.k_hop(scope_a, ["e1"], k=2) == []
    finally:
        await graph.drop_graph(scope_a)
        await graph.drop_graph(scope_b)
        await engine.dispose()
