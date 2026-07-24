"""Entity subgraph service (SPEC-26, FR-13.8): a bounded, permission-scoped neighborhood viewer.

The entry point is always ONE entity (never "the whole graph" — the Gurú lesson). Hard per-page
limits live in the graph store's Cypher, not the client. Permissions (FR-4.2/4.3): the entry entity
is visible only if the caller can see ≥1 claim referencing it (zero ⇒ indistinguishable from
non-existent); neighbours are filtered the same way, so a forbidden-topic entity never leaks through
the graph edges either.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.ingest.entity_resolution import entity_id, normalize_name
from rsc_brain.recall.permissions import claim_visibility_clause, sensitive_tags
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational import models


@dataclass(frozen=True, slots=True)
class GraphNodeView:
    id: str
    name: str
    type: str
    anchored: bool


@dataclass(frozen=True, slots=True)
class GraphEdgeView:
    source: str
    target: str
    type: str


@dataclass(frozen=True, slots=True)
class NeighborhoodView:
    center: GraphNodeView
    neighbors: list[GraphNodeView]
    edges: list[GraphEdgeView]
    total: int  # total neighbours in the graph (pre-permission upper bound), for pagination
    offset: int
    limit: int


async def _visible_names(
    session: AsyncSession,
    scope: ProjectScope,
    forbidden: frozenset[str],
    names: list[str],
) -> set[str]:
    """The subset of ``names`` that appear as subject/object of at least one claim the caller may
    see. The permission cut is entirely in-query (FR-4.2), so nothing forbidden is ever fetched."""
    if not names:
        return set()
    subject_hits = await session.scalars(
        select(models.Claim.subject).where(
            claim_visibility_clause(scope, forbidden), models.Claim.subject.in_(names)
        )
    )
    object_hits = await session.scalars(
        select(models.Claim.object).where(
            claim_visibility_clause(scope, forbidden), models.Claim.object.in_(names)
        )
    )
    return {n for n in [*subject_hits, *object_hits] if n is not None}


async def entity_neighborhood(
    sessionmaker: async_sessionmaker[AsyncSession],
    graph: AgeGraphStore,
    scope: ProjectScope,
    *,
    name: str,
    limit: int = 25,
    offset: int = 0,
) -> NeighborhoodView | None:
    """The bounded neighbourhood of the named entity, or None if it is absent OR the caller cannot
    see any of its claims (both indistinguishable, FR-4.3)."""
    forbidden = await sensitive_tags(sessionmaker, scope.project_id)
    async with sessionmaker() as session:
        entity = await session.scalar(
            select(models.Entity)
            .where(
                models.Entity.project_id == uuid.UUID(scope.project_id),
                models.Entity.normalized_name == normalize_name(name),
                models.Entity.merged_into.is_(None),
            )
            .limit(1)
        )
        if entity is None:
            return None
        entry_visible = await session.scalar(
            select(func.count())
            .select_from(models.Claim)
            .where(
                claim_visibility_clause(scope, forbidden),
                or_(models.Claim.subject == entity.name, models.Claim.object == entity.name),
            )
        )
        if not entry_visible:
            return None  # entity exists but is invisible to this caller ⇒ treat as absent

    node_id = str(entity_id(entity.type, entity.name))
    nodes, edges, total = await graph.neighborhood(scope, node_id, limit=limit, offset=offset)

    # Keep only neighbours the caller may see claims for (0 leaks through the graph, FR-4.3).
    async with sessionmaker() as session:
        allowed = await _visible_names(
            session, scope, forbidden, [str(n.properties.get("name", "")) for n in nodes]
        )
    kept = [n for n in nodes if str(n.properties.get("name", "")) in allowed]
    kept_ids = {n.id for n in kept}
    neighbors = [
        GraphNodeView(
            id=n.id,
            name=str(n.properties.get("name", n.id)),
            type=str(n.properties.get("type", "")),
            anchored=False,
        )
        for n in kept
    ]
    edge_views = [
        GraphEdgeView(source=e.source_id, target=e.target_id, type=e.type)
        for e in edges
        if e.source_id in {node_id, *kept_ids} and e.target_id in {node_id, *kept_ids}
    ]
    center = GraphNodeView(
        id=node_id, name=entity.name, type=entity.type, anchored=entity.ontology_valid
    )
    return NeighborhoodView(
        center=center,
        neighbors=neighbors,
        edges=edge_views,
        total=total,
        offset=max(0, offset),
        limit=min(max(1, limit), 200),
    )
