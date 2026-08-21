"""AUDIT-012 merge invariants, graph fidelity, atomicity and reversal on real PG/AGE."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Callable, Mapping, Sequence

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError

from rsc_brain.audit import query_audit_raw
from rsc_brain.ingest.entity_resolution import entity_id
from rsc_brain.knowledge import entity_merge as merge_module
from rsc_brain.knowledge.entity_merge import EntityMergeService, MergeCandidate
from rsc_brain.review.states import PROPOSAL_OPEN
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore, GraphMergeConflictError
from rsc_brain.stores.graph_store import GraphEdge, GraphNode
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.entity_store import (
    CrossProjectMergeError,
    EntityStore,
    MergeInvariantError,
    MergeReversalConflictError,
)

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration


async def _insert_entity(
    harness: Harness,
    scope: ProjectScope,
    name: str,
    etype: str,
    aliases: Sequence[str] = (),
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
                    project_id=uuid.UUID(scope.project_id),
                    entity_id=entity.id,
                    alias=alias,
                    confidence=0.8,
                    approved=True,
                )
            )
        await session.commit()
        return str(entity.id)


def _node(name: str, etype: str) -> GraphNode:
    return GraphNode(
        id=str(entity_id(etype, name)),
        labels=frozenset({"Entity"}),
        properties={"name": name, "type": etype},
    )


def _service(harness: Harness) -> EntityMergeService:
    return EntityMergeService(
        store=EntityStore(harness.sm),
        graph=AgeGraphStore(harness.sm),
        sessionmaker=harness.sm,
    )


async def _proposal(store: EntityStore, scope: ProjectScope, canonical: str, duplicate: str) -> str:
    proposal_id, created = await store.create_proposal(
        scope,
        canonical_id=canonical,
        duplicate_id=duplicate,
        confidence=0.95,
        method="deterministic",
        status=PROPOSAL_OPEN,
        reason="test",
    )
    assert created
    return proposal_id


async def _edge_properties(
    graph: AgeGraphStore,
    scope: ProjectScope,
    source: str,
    target: str,
    edge_type: str,
) -> Mapping[str, object] | None:
    rows = await graph.run_cypher(
        scope,
        f"MATCH (a {{id: $s}})-[r:{edge_type}]->(b {{id: $o}}) "
        "WHERE r.superseded IS NULL RETURN properties(r) AS result",
        {"s": source, "o": target},
    )
    value = rows[0]["result"] if rows else None
    return value if isinstance(value, dict) else None


async def _active_incident_count(graph: AgeGraphStore, scope: ProjectScope, node_id: str) -> int:
    rows = await graph.run_cypher(
        scope,
        "MATCH (a)-[r]-(b) WHERE r.superseded IS NULL AND (a.id = $id OR b.id = $id) "
        "RETURN count(r) AS result",
        {"id": node_id},
    )
    value = rows[0]["result"] if rows else 0
    return value if isinstance(value, int) else 0


async def _snapshot_count(harness: Harness, scope: ProjectScope, proposal_id: str) -> int:
    async with harness.sm() as session:
        count = await session.scalar(
            select(func.count())
            .select_from(models.EntityMergeSnapshot)
            .where(
                models.EntityMergeSnapshot.project_id == uuid.UUID(scope.project_id),
                models.EntityMergeSnapshot.proposal_id == uuid.UUID(proposal_id),
            )
        )
    return int(count or 0)


async def test_self_and_cross_type_are_rejected_before_proposal_persistence(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    scope = harness.scope(await harness.setup_project(unique_slug("merge-integrity"), topics=[]))
    org = await _insert_entity(harness, scope, "Mercury", "org")
    planet = await _insert_entity(harness, scope, "Mercury planet", "planet")
    store = EntityStore(harness.sm)

    with pytest.raises(MergeInvariantError, match="distinct"):
        await _proposal(store, scope, org, org)
    with pytest.raises(MergeInvariantError, match="same type"):
        await _proposal(store, scope, org, planet)

    async with harness.sm() as session:
        count = await session.scalar(
            select(func.count())
            .select_from(models.EntityMergeProposal)
            .where(models.EntityMergeProposal.project_id == uuid.UUID(scope.project_id))
        )
    assert count == 0


async def test_database_refuses_self_cross_type_and_cross_project_tombstones(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    scope_a = harness.scope(await harness.setup_project(unique_slug("merge-raw-a"), topics=[]))
    scope_b = harness.scope(await harness.setup_project(unique_slug("merge-raw-b"), topics=[]))
    org_a = await _insert_entity(harness, scope_a, "Raw A", "org")
    planet_a = await _insert_entity(harness, scope_a, "Raw planet", "planet")
    org_b = await _insert_entity(harness, scope_b, "Raw B", "org")

    for duplicate, canonical in ((org_a, org_a), (planet_a, org_a), (org_a, org_b)):
        async with harness.sm() as session:
            with pytest.raises(IntegrityError):
                await session.execute(
                    update(models.Entity)
                    .where(models.Entity.id == uuid.UUID(duplicate))
                    .values(merged_into=uuid.UUID(canonical))
                )
                await session.commit()
            await session.rollback()

    async with harness.sm() as session:
        merged = await session.scalar(
            select(func.count())
            .select_from(models.Entity)
            .where(
                models.Entity.id.in_([uuid.UUID(org_a), uuid.UUID(planet_a), uuid.UUID(org_b)]),
                models.Entity.merged_into.is_not(None),
            )
        )
    assert merged == 0


async def test_database_refuses_self_and_cross_project_proposals(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    scope_a = harness.scope(await harness.setup_project(unique_slug("proposal-raw-a"), topics=[]))
    scope_b = harness.scope(await harness.setup_project(unique_slug("proposal-raw-b"), topics=[]))
    entity_a = await _insert_entity(harness, scope_a, "Proposal A", "org")
    entity_b = await _insert_entity(harness, scope_b, "Proposal B", "org")

    for canonical, duplicate in ((entity_a, entity_a), (entity_a, entity_b)):
        async with harness.sm() as session:
            session.add(
                models.EntityMergeProposal(
                    project_id=uuid.UUID(scope_a.project_id),
                    canonical_entity_id=uuid.UUID(canonical),
                    duplicate_entity_id=uuid.UUID(duplicate),
                    confidence=0.9,
                    method="raw-test",
                    status=PROPOSAL_OPEN,
                )
            )
            with pytest.raises(IntegrityError):
                await session.commit()
            await session.rollback()

    assert await EntityStore(harness.sm).list_proposals(scope_a) == []

    with pytest.raises(CrossProjectMergeError):
        await EntityStore(harness.sm).create_proposal(
            scope_a,
            canonical_id=entity_a,
            duplicate_id=entity_b,
            confidence=0.9,
            method="service-test",
            status=PROPOSAL_OPEN,
            reason="must not disclose foreign identity",
        )
    assert await EntityStore(harness.sm).list_proposals(scope_a) == []


async def test_confirm_preserves_edge_properties_retires_duplicate_and_reverse_restores_all(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    scope = harness.scope(await harness.setup_project(unique_slug("merge-integrity"), topics=[]))
    canonical = await _insert_entity(harness, scope, "Acme Corporation", "org", ["ACME"])
    duplicate = await _insert_entity(harness, scope, "Acme Corporaton", "org", ["Acme typo"])
    graph = AgeGraphStore(harness.sm)
    canon_node = str(entity_id("org", "Acme Corporation"))
    dup_node = str(entity_id("org", "Acme Corporaton"))
    out_node = str(entity_id("org", "Widget"))
    in_node = str(entity_id("person", "Jane"))
    await graph.create_graph(scope)
    await graph.upsert_nodes(
        scope,
        [
            _node("Acme Corporation", "org"),
            _node("Acme Corporaton", "org"),
            _node("Widget", "org"),
            _node("Jane", "person"),
        ],
    )
    out_props = {"source_document_id": "doc-1", "weight": 0.7}
    in_props = {"note": "inbound", "rank": 3}
    await graph.upsert_edges(
        scope,
        [
            GraphEdge(dup_node, out_node, "RELATED", out_props),
            GraphEdge(in_node, dup_node, "MENTIONS", in_props),
        ],
    )
    store = EntityStore(harness.sm)
    proposal_id = await _proposal(store, scope, canonical, duplicate)
    service = _service(harness)

    outcome = await service.confirm(scope, proposal_id)
    assert outcome.status == "applied"
    assert await _edge_properties(graph, scope, canon_node, out_node, "RELATED") == out_props
    assert await _edge_properties(graph, scope, in_node, canon_node, "MENTIONS") == in_props
    assert await _active_incident_count(graph, scope, dup_node) == 0

    reversed_outcome = await service.reverse(scope, proposal_id)
    assert reversed_outcome.status == "reversed"
    assert set(await store.aliases_of(scope, canonical)) == {"ACME"}
    assert set(await store.aliases_of(scope, duplicate)) == {"Acme typo"}
    assert await _edge_properties(graph, scope, dup_node, out_node, "RELATED") == out_props
    assert await _edge_properties(graph, scope, in_node, dup_node, "MENTIONS") == in_props
    assert await _edge_properties(graph, scope, canon_node, out_node, "RELATED") is None
    async with harness.sm() as session:
        row = await session.get(models.Entity, uuid.UUID(duplicate))
    assert row is not None and row.merged_into is None
    proposal = await store.get_proposal(scope, proposal_id)
    assert proposal is not None and proposal.status == PROPOSAL_OPEN
    async with harness.sm() as session:
        first_snapshot = await session.scalar(
            select(models.EntityMergeSnapshot).where(
                models.EntityMergeSnapshot.proposal_id == uuid.UUID(proposal_id)
            )
        )
    assert first_snapshot is not None
    merge_audit = await query_audit_raw(harness.sm, scope.project_id, action="entity_merge")
    reverse_audit = await query_audit_raw(harness.sm, scope.project_id, action="entity_unmerge")
    assert [row["trace_id"] for row in merge_audit] == [str(first_snapshot.id)]
    assert [row["trace_id"] for row in reverse_audit] == [str(first_snapshot.id)]

    reapplied = await service.confirm(scope, proposal_id)
    assert reapplied.status == "applied"
    assert await _snapshot_count(harness, scope, proposal_id) == 2
    assert len(await query_audit_raw(harness.sm, scope.project_id, action="entity_merge")) == 2


async def test_audit_failure_rolls_back_relational_graph_proposal_and_audit(
    build_harness: Callable[..., Harness], monkeypatch: pytest.MonkeyPatch
) -> None:
    harness = build_harness()
    scope = harness.scope(await harness.setup_project(unique_slug("merge-integrity"), topics=[]))
    canonical = await _insert_entity(harness, scope, "Globex Corporation", "org")
    duplicate = await _insert_entity(harness, scope, "Globex Corporaton", "org")
    graph = AgeGraphStore(harness.sm)
    canon_node = str(entity_id("org", "Globex Corporation"))
    dup_node = str(entity_id("org", "Globex Corporaton"))
    other = str(entity_id("org", "Other"))
    await graph.create_graph(scope)
    await graph.upsert_nodes(
        scope,
        [
            _node("Globex Corporation", "org"),
            _node("Globex Corporaton", "org"),
            _node("Other", "org"),
        ],
    )
    await graph.upsert_edges(scope, [GraphEdge(dup_node, other, "RELATED", {"v": 1})])
    store = EntityStore(harness.sm)
    proposal_id = await _proposal(store, scope, canonical, duplicate)

    async def explode(*_args: object, **_kwargs: object) -> int:
        raise RuntimeError("audit sink failed")

    monkeypatch.setattr(merge_module, "record_audit_in_session", explode)
    with pytest.raises(RuntimeError, match="audit sink failed"):
        await _service(harness).confirm(scope, proposal_id)

    proposal = await store.get_proposal(scope, proposal_id)
    assert proposal is not None and proposal.status == PROPOSAL_OPEN
    async with harness.sm() as session:
        dup = await session.get(models.Entity, uuid.UUID(duplicate))
    assert dup is not None and dup.merged_into is None
    assert await _edge_properties(graph, scope, dup_node, other, "RELATED") == {"v": 1}
    assert await _edge_properties(graph, scope, canon_node, other, "RELATED") is None
    assert await query_audit_raw(harness.sm, scope.project_id, action="entity_merge") == []

    monkeypatch.undo()
    retry = await _service(harness).confirm(scope, proposal_id)
    assert retry.status == "applied"
    assert await _snapshot_count(harness, scope, proposal_id) == 1
    assert len(await query_audit_raw(harness.sm, scope.project_id, action="entity_merge")) == 1
    assert await _edge_properties(graph, scope, dup_node, other, "RELATED") is None
    assert await _edge_properties(graph, scope, canon_node, other, "RELATED") == {"v": 1}


async def test_conflicting_same_identity_edge_properties_fail_without_mutation(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    scope = harness.scope(await harness.setup_project(unique_slug("merge-integrity"), topics=[]))
    canonical = await _insert_entity(harness, scope, "Initech Corporation", "org")
    duplicate = await _insert_entity(harness, scope, "Initech Corporaton", "org")
    graph = AgeGraphStore(harness.sm)
    canon_node = str(entity_id("org", "Initech Corporation"))
    dup_node = str(entity_id("org", "Initech Corporaton"))
    other = str(entity_id("org", "TPS"))
    await graph.create_graph(scope)
    await graph.upsert_nodes(
        scope,
        [
            _node("Initech Corporation", "org"),
            _node("Initech Corporaton", "org"),
            _node("TPS", "org"),
        ],
    )
    await graph.upsert_edges(
        scope,
        [
            GraphEdge(canon_node, other, "RELATED", {"version": 1}),
            GraphEdge(dup_node, other, "RELATED", {"version": 2}),
        ],
    )
    store = EntityStore(harness.sm)
    proposal_id = await _proposal(store, scope, canonical, duplicate)

    with pytest.raises(GraphMergeConflictError):
        await _service(harness).confirm(scope, proposal_id)

    assert await _edge_properties(graph, scope, canon_node, other, "RELATED") == {"version": 1}
    assert await _edge_properties(graph, scope, dup_node, other, "RELATED") == {"version": 2}
    proposal = await store.get_proposal(scope, proposal_id)
    assert proposal is not None and proposal.status == PROPOSAL_OPEN


async def test_reverse_refuses_later_graph_drift_without_partial_restore(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    scope = harness.scope(await harness.setup_project(unique_slug("merge-integrity"), topics=[]))
    canonical = await _insert_entity(harness, scope, "Umbrella Corporation", "org")
    duplicate = await _insert_entity(harness, scope, "Umbrella Corporaton", "org")
    graph = AgeGraphStore(harness.sm)
    canon_node = str(entity_id("org", "Umbrella Corporation"))
    dup_node = str(entity_id("org", "Umbrella Corporaton"))
    first = str(entity_id("org", "First"))
    later = str(entity_id("org", "Later"))
    await graph.create_graph(scope)
    await graph.upsert_nodes(
        scope,
        [
            _node("Umbrella Corporation", "org"),
            _node("Umbrella Corporaton", "org"),
            _node("First", "org"),
            _node("Later", "org"),
        ],
    )
    await graph.upsert_edges(scope, [GraphEdge(dup_node, first, "RELATED", {"v": 1})])
    store = EntityStore(harness.sm)
    proposal_id = await _proposal(store, scope, canonical, duplicate)
    service = _service(harness)
    assert (await service.confirm(scope, proposal_id)).status == "applied"
    await graph.upsert_edges(scope, [GraphEdge(canon_node, later, "RELATED", {"v": 2})])

    with pytest.raises(MergeReversalConflictError, match="graph changed"):
        await service.reverse(scope, proposal_id)

    async with harness.sm() as session:
        dup = await session.get(models.Entity, uuid.UUID(duplicate))
    assert dup is not None and str(dup.merged_into) == canonical
    assert await _edge_properties(graph, scope, canon_node, later, "RELATED") == {"v": 2}


async def test_merge_node_markers_are_stale_checked_before_apply_and_reverse(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    scope = harness.scope(await harness.setup_project(unique_slug("merge-node-drift"), topics=[]))
    canonical = await _insert_entity(harness, scope, "Soylent Corporation", "org")
    duplicate = await _insert_entity(harness, scope, "Soylent Corporaton", "org")
    graph = AgeGraphStore(harness.sm)
    duplicate_node = str(entity_id("org", "Soylent Corporaton"))
    await graph.create_graph(scope)
    await graph.upsert_nodes(
        scope,
        [_node("Soylent Corporation", "org"), _node("Soylent Corporaton", "org")],
    )
    await graph.run_cypher(
        scope,
        "MATCH (n {id: $id}) SET n.suppressed = true RETURN n.suppressed AS result",
        {"id": duplicate_node},
    )
    store = EntityStore(harness.sm)
    proposal_id = await _proposal(store, scope, canonical, duplicate)
    service = _service(harness)

    with pytest.raises(GraphMergeConflictError, match="already carries merge state"):
        await service.confirm(scope, proposal_id)
    proposal = await store.get_proposal(scope, proposal_id)
    assert proposal is not None and proposal.status == PROPOSAL_OPEN

    await graph.run_cypher(
        scope,
        "MATCH (n {id: $id}) REMOVE n.suppressed RETURN n.id AS result",
        {"id": duplicate_node},
    )
    assert (await service.confirm(scope, proposal_id)).status == "applied"
    await graph.run_cypher(
        scope,
        "MATCH (n {id: $id}) SET n.merged_into = $later RETURN n.merged_into AS result",
        {"id": duplicate_node, "later": "later-graph-write"},
    )

    with pytest.raises(MergeReversalConflictError, match="graph node changed"):
        await service.reverse(scope, proposal_id)
    async with harness.sm() as session:
        duplicate_row = await session.get(models.Entity, uuid.UUID(duplicate))
    assert duplicate_row is not None and str(duplicate_row.merged_into) == canonical
    marker = await graph.merge_marker_state(scope, duplicate_node)
    assert marker.markers["merged_into"] == "later-graph-write"


async def test_reverse_refuses_later_alias_drift_without_partial_restore(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    scope = harness.scope(await harness.setup_project(unique_slug("merge-alias-drift"), topics=[]))
    canonical = await _insert_entity(harness, scope, "Wayne Enterprises", "org", ["Wayne"])
    duplicate = await _insert_entity(harness, scope, "Wayne Enterprise", "org", ["Wayne typo"])
    store = EntityStore(harness.sm)
    proposal_id = await _proposal(store, scope, canonical, duplicate)
    service = _service(harness)
    assert (await service.confirm(scope, proposal_id)).status == "applied"

    async with harness.sm() as session:
        session.add(
            models.EntityAlias(
                project_id=uuid.UUID(scope.project_id),
                entity_id=uuid.UUID(canonical),
                alias="later alias",
                approved=True,
            )
        )
        await session.commit()

    with pytest.raises(MergeReversalConflictError, match="aliases changed"):
        await service.reverse(scope, proposal_id)

    async with harness.sm() as session:
        duplicate_row = await session.get(models.Entity, uuid.UUID(duplicate))
    assert duplicate_row is not None and str(duplicate_row.merged_into) == canonical
    assert "later alias" in await store.aliases_of(scope, canonical)


async def test_equal_edge_collision_deduplicates_once_and_reverses_losslessly(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    scope = harness.scope(await harness.setup_project(unique_slug("merge-edge-dedupe"), topics=[]))
    canonical = await _insert_entity(harness, scope, "Stark Industries", "org")
    duplicate = await _insert_entity(harness, scope, "Stark Industry", "org")
    graph = AgeGraphStore(harness.sm)
    canonical_node = str(entity_id("org", "Stark Industries"))
    duplicate_node = str(entity_id("org", "Stark Industry"))
    other = str(entity_id("org", "Arc Reactor"))
    properties = {"source_document_id": "doc-equal", "strength": 1}
    await graph.create_graph(scope)
    await graph.upsert_nodes(
        scope,
        [
            _node("Stark Industries", "org"),
            _node("Stark Industry", "org"),
            _node("Arc Reactor", "org"),
        ],
    )
    await graph.upsert_edges(
        scope,
        [
            GraphEdge(canonical_node, other, "OWNS", properties),
            GraphEdge(duplicate_node, other, "OWNS", properties),
        ],
    )
    proposal_id = await _proposal(EntityStore(harness.sm), scope, canonical, duplicate)
    service = _service(harness)

    assert (await service.confirm(scope, proposal_id)).status == "applied"
    active = await graph.active_incident_edges(scope, (canonical_node, duplicate_node))
    assert [edge.identity for edge in active].count((canonical_node, "OWNS", other)) == 1
    assert all(duplicate_node not in (edge.source_id, edge.target_id) for edge in active)

    assert (await service.reverse(scope, proposal_id)).status == "reversed"
    assert await _edge_properties(graph, scope, canonical_node, other, "OWNS") == properties
    assert await _edge_properties(graph, scope, duplicate_node, other, "OWNS") == properties


async def test_concurrent_confirm_and_reverse_each_commit_exactly_once(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    scope = harness.scope(await harness.setup_project(unique_slug("merge-race"), topics=[]))
    canonical = await _insert_entity(harness, scope, "Cyberdyne Systems", "org")
    duplicate = await _insert_entity(harness, scope, "Cyberdyne System", "org")
    proposal_id = await _proposal(EntityStore(harness.sm), scope, canonical, duplicate)
    service = _service(harness)

    confirms = await asyncio.gather(
        service.confirm(scope, proposal_id),
        service.confirm(scope, proposal_id),
    )
    assert sorted(outcome.status for outcome in confirms) == ["applied", "refused"]
    assert await _snapshot_count(harness, scope, proposal_id) == 1
    assert len(await query_audit_raw(harness.sm, scope.project_id, action="entity_merge")) == 1

    reversals = await asyncio.gather(
        service.reverse(scope, proposal_id),
        service.reverse(scope, proposal_id),
    )
    assert sorted(outcome.status for outcome in reversals) == ["refused", "reversed"]
    assert len(await query_audit_raw(harness.sm, scope.project_id, action="entity_unmerge")) == 1


async def test_concurrent_auto_candidate_retries_converge_on_one_proposal_and_effect(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    scope = harness.scope(await harness.setup_project(unique_slug("merge-auto-race"), topics=[]))
    canonical = await _insert_entity(harness, scope, "Massive Dynamic", "org")
    duplicate = await _insert_entity(harness, scope, "Massive Dynamc", "org")
    candidate = MergeCandidate(canonical, duplicate, 0.99, "concurrent auto candidate")
    service = _service(harness)

    outcomes = await asyncio.gather(
        service.apply_candidate(scope, candidate),
        service.apply_candidate(scope, candidate),
    )
    assert sorted(outcome.status for outcome in outcomes) == ["applied", "refused"]
    proposals = await EntityStore(harness.sm).list_proposals(scope)
    assert len(proposals) == 1
    assert await _snapshot_count(harness, scope, proposals[0].id) == 1
    assert len(await query_audit_raw(harness.sm, scope.project_id, action="entity_merge")) == 1
