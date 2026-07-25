"""Alias-merge end-to-end against the real container (SPEC-09 AC#5, FR-1.9/FR-12.4).

Seeds relational entities + aliases and their AGE graph nodes/edges, then exercises the
propose → queue → confirm/reject flow: a confirmed merge re-points relational aliases AND graph
edges onto the canonical entity, tombstones the duplicate, and writes an audit row; a rejected
proposal changes nothing. A cross-project merge is refused.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Sequence

import pytest

from rsc_brain.audit import query_audit_raw
from rsc_brain.config.models import KnowledgeConfig
from rsc_brain.ingest.entity_resolution import entity_id
from rsc_brain.knowledge.entity_merge import DeterministicMergeProposer, EntityMergeService
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.graph_store import GraphEdge, GraphNode
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.entity_store import CrossProjectMergeError, EntityStore

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration


async def _insert_entity(
    harness: Harness, scope: ProjectScope, name: str, etype: str, aliases: Sequence[str] = ()
) -> str:
    async with harness.sm() as session:
        entity = models.Entity(
            project_id=uuid.UUID(scope.project_id),
            name=name,
            normalized_name=name.casefold(),
            type=etype,
        )
        session.add(entity)
        await session.flush()
        for alias in aliases:
            session.add(
                models.EntityAlias(
                    project_id=uuid.UUID(scope.project_id), entity_id=entity.id, alias=alias
                )
            )
        await session.commit()
        return str(entity.id)


def _node(name: str, etype: str) -> GraphNode:
    return GraphNode(
        id=str(entity_id(etype, name)), labels=frozenset({"Entity"}), properties={"name": name}
    )


def _build_service(harness: Harness, *, auto_apply: float) -> EntityMergeService:
    return EntityMergeService(
        store=EntityStore(harness.sm),
        graph=AgeGraphStore(harness.sm),
        proposer=DeterministicMergeProposer(min_similarity=0.82),
        sessionmaker=harness.sm,
        config=KnowledgeConfig(merge_auto_apply_confidence=auto_apply),
    )


async def _count(
    graph: AgeGraphStore, scope: ProjectScope, cypher: str, params: dict[str, object]
) -> int:
    rows = await graph.run_cypher(scope, cypher, params)
    value = rows[0]["result"] if rows else 0
    return value if isinstance(value, int) else 0


async def test_confirm_repoints_aliases_and_graph_edges(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    graph = AgeGraphStore(harness.sm)
    scope = harness.scope(await harness.setup_project(unique_slug("merge"), topics=[]))
    etype = "org"

    canonical = await _insert_entity(harness, scope, "Acme Corporation", etype, aliases=["ACME"])
    duplicate = await _insert_entity(harness, scope, "Acme Corporaton", etype)  # typo

    canon_node = str(entity_id(etype, "Acme Corporation"))
    dup_node = str(entity_id(etype, "Acme Corporaton"))
    neighbour_out = str(entity_id(etype, "Widget Div"))
    neighbour_in = str(entity_id("person", "Jane"))
    await graph.create_graph(scope)
    await graph.upsert_nodes(
        scope,
        [
            _node("Acme Corporation", etype),
            _node("Acme Corporaton", etype),
            _node("Widget Div", etype),
            _node("Jane", "person"),
        ],
    )
    await graph.upsert_edges(
        scope,
        [
            GraphEdge(source_id=dup_node, target_id=neighbour_out, type="RELATED"),
            GraphEdge(source_id=neighbour_in, target_id=dup_node, type="MENTIONS"),
        ],
    )

    service = _build_service(harness, auto_apply=0.99)  # typo sim < 0.99 → queued, not auto
    summary = await service.propose(scope)
    assert len(summary.queued) == 1
    assert summary.auto_applied == []

    outcome = await service.confirm(scope, summary.queued[0])
    assert outcome.status == "applied"
    assert outcome.repointed_edges == 2

    # Relational: only the canonical entity survives; the duplicate name is now an alias.
    active = await EntityStore(harness.sm).list_active_entities(scope)
    assert [e.id for e in active] == [canonical]
    assert set(active[0].aliases) == {"ACME", "Acme Corporaton"}
    async with harness.sm() as session:
        dup_row = await session.get(models.Entity, uuid.UUID(duplicate))
        assert dup_row is not None and str(dup_row.merged_into) == canonical

    # Graph: edges re-pointed onto the canonical node; the duplicate node is tombstoned.
    assert (
        await _count(
            graph,
            scope,
            "MATCH ({id: $c})-[r:RELATED]->({id: $n}) RETURN count(r) AS result",
            {"c": canon_node, "n": neighbour_out},
        )
        == 1
    )
    assert (
        await _count(
            graph,
            scope,
            "MATCH ({id: $n})-[r:MENTIONS]->({id: $c}) RETURN count(r) AS result",
            {"c": canon_node, "n": neighbour_in},
        )
        == 1
    )
    suppressed = await graph.run_cypher(
        scope, "MATCH (n {id: $d}) RETURN n.suppressed AS result", {"d": dup_node}
    )
    assert suppressed[0]["result"] is True

    # Audit: exactly one entity_merge row.
    audit_rows = await query_audit_raw(harness.sm, scope.project_id, action="entity_merge")
    assert len(audit_rows) == 1


async def test_auto_apply_on_exact_surface_form(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    scope = harness.scope(await harness.setup_project(unique_slug("merge"), topics=[]))
    # The duplicate lists the canonical's name as an alias ⇒ similarity 1.0 ≥ auto-apply.
    canonical = await _insert_entity(harness, scope, "Acme Corporation", "org", aliases=["x", "y"])
    await _insert_entity(harness, scope, "Acme Inc", "org", aliases=["Acme Corporation"])

    summary = await _build_service(harness, auto_apply=0.97).propose(scope)
    assert len(summary.auto_applied) == 1
    assert summary.queued == []
    active = await EntityStore(harness.sm).list_active_entities(scope)
    assert [e.id for e in active] == [canonical]


async def test_reject_changes_nothing(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    scope = harness.scope(await harness.setup_project(unique_slug("merge"), topics=[]))
    await _insert_entity(harness, scope, "Globex Corporation", "org", aliases=["one", "two"])
    await _insert_entity(harness, scope, "Globex Corporaton", "org")

    service = _build_service(harness, auto_apply=0.99)
    summary = await service.propose(scope)
    outcome = await service.reject(scope, summary.queued[0])
    assert outcome.status == "rejected"

    active = await EntityStore(harness.sm).list_active_entities(scope)
    assert len(active) == 2  # nothing merged
    proposal = await EntityStore(harness.sm).get_proposal(scope, summary.queued[0])
    assert proposal is not None and proposal.status == "rejected"
    audit_rows = await query_audit_raw(harness.sm, scope.project_id, action="entity_merge_reject")
    assert len(audit_rows) == 1


async def test_merge_never_crosses_project(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    scope_a = harness.scope(await harness.setup_project(unique_slug("merge-a"), topics=[]))
    scope_b = harness.scope(await harness.setup_project(unique_slug("merge-b"), topics=[]))
    entity_a = await _insert_entity(harness, scope_a, "Acme", "org")
    entity_b = await _insert_entity(harness, scope_b, "Acme", "org")

    with pytest.raises(CrossProjectMergeError):
        await EntityStore(harness.sm).apply_merge(
            scope_a, canonical_id=entity_a, duplicate_id=entity_b, confidence=1.0
        )
