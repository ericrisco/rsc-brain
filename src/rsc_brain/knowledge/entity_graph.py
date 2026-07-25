"""Entity subgraph service (SPEC-26 FR-13.8, AUDIT-035 R16): permission-first and bounded.

The entry point is always ONE entity (never "the whole graph" — the Gurú lesson). Two properties
have to hold together, and used not to:

* **permission-first.** Authority is applied to the whole candidate neighbourhood BEFORE anything is
  counted or paged. The old order — page in the graph, filter in Python — meant the ``total``
  announced neighbours the caller could not see, pages came back short or empty depending on where
  hidden neighbours happened to sort, and revoking a topic left the total unchanged.
* **identity, not name.** A claim's endpoint is authorized by the deterministic entity identity
  ``entity_id(type, name)`` — the same value the graph node carries. Names are ambiguous: two
  entities can share a normalized name and differ by type, and a visible claim about one must never
  authorize the other. For claims written before that identity was recorded, a name still authorizes
  — but only when it resolves to exactly one candidate identity. An ambiguous name authorizes
  nothing, which is the safe direction.

An entity the caller cannot see any claim about is reported exactly like one that does not exist
(FR-4.3).
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
from rsc_brain.stores.graph_store import GraphNode
from rsc_brain.stores.relational import models

#: Hard ceiling on one page, regardless of what the caller asks for (FR-13.8).
MAX_PAGE = 200


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
    total: int  # the AUTHORIZED neighbour count — never the physical one (R16)
    offset: int
    limit: int


async def _authorized_keys(
    session: AsyncSession, scope: ProjectScope, forbidden: frozenset[str], candidates: list[str]
) -> set[str]:
    """Which of these entity identities the caller may see a claim about (identity-keyed)."""
    if not candidates:
        return set()
    keys = [uuid.UUID(c) for c in candidates if _is_uuid(c)]
    if not keys:
        return set()
    subject_hits = await session.scalars(
        select(models.Claim.subject_entity_key).where(
            claim_visibility_clause(scope, forbidden), models.Claim.subject_entity_key.in_(keys)
        )
    )
    object_hits = await session.scalars(
        select(models.Claim.object_entity_key).where(
            claim_visibility_clause(scope, forbidden), models.Claim.object_entity_key.in_(keys)
        )
    )
    return {str(k) for k in [*subject_hits, *object_hits] if k is not None}


async def _authorized_names(
    session: AsyncSession, scope: ProjectScope, forbidden: frozenset[str], names: list[str]
) -> set[str]:
    """Which of these names appear in a visible claim whose matching ENDPOINT carries no key.

    The fallback for endpoints written before identities were recorded. Each endpoint is judged on
    its own: a claim may state the identity of its object and only name its subject. Once an endpoint
    states which identity it is about, its name must not authorize a different one.
    """
    if not names:
        return set()
    subject_hits = await session.scalars(
        select(models.Claim.subject).where(
            claim_visibility_clause(scope, forbidden),
            models.Claim.subject_entity_key.is_(None),
            models.Claim.subject.in_(names),
        )
    )
    object_hits = await session.scalars(
        select(models.Claim.object).where(
            claim_visibility_clause(scope, forbidden),
            models.Claim.object_entity_key.is_(None),
            models.Claim.object.in_(names),
        )
    )
    return {n for n in [*subject_hits, *object_hits] if n is not None}


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True


def _node_name(node: GraphNode) -> str:
    return str(node.properties.get("name", ""))


async def _ambiguous_names(
    session: AsyncSession, scope: ProjectScope, names: list[str]
) -> set[str]:
    """Names that more than one entity identity in the PROJECT answers to.

    Deliberately not "more than one of the candidates": if the project holds a second identity with
    the same normalized name, a keyless claim naming it is evidence about either one, even when only
    one of them happens to be a neighbour of this centre. Measuring ambiguity over the neighbourhood
    instead would authorize whichever identity the traversal reached, on evidence that may have been
    about the other.
    """
    if not names:
        return set()
    rows = await session.execute(
        select(models.Entity.normalized_name, func.count())
        .where(
            models.Entity.project_id == uuid.UUID(scope.project_id),
            models.Entity.normalized_name.in_([normalize_name(n) for n in names]),
        )
        .group_by(models.Entity.normalized_name)
        .having(func.count() > 1)
    )
    collisions = {normalized for normalized, _ in rows.all()}
    return {name for name in names if normalize_name(name) in collisions}


async def _authorize(
    sessionmaker: async_sessionmaker[AsyncSession],
    scope: ProjectScope,
    forbidden: frozenset[str],
    candidates: list[GraphNode],
) -> list[GraphNode]:
    """The candidate neighbours this caller may see, in the candidates' deterministic order."""
    if not candidates:
        return []
    names = sorted({n for n in (_node_name(node) for node in candidates) if n})
    async with sessionmaker() as session:
        by_key = await _authorized_keys(session, scope, forbidden, [n.id for n in candidates])
        ambiguous = await _ambiguous_names(session, scope, names)
        # A name only speaks for an identity when exactly one identity answers to it.
        by_name = await _authorized_names(
            session, scope, forbidden, [n for n in names if n not in ambiguous]
        )
    return [n for n in candidates if n.id in by_key or _node_name(n) in by_name]


async def entity_neighborhood(
    sessionmaker: async_sessionmaker[AsyncSession],
    graph: AgeGraphStore,
    scope: ProjectScope,
    *,
    name: str,
    limit: int = 25,
    offset: int = 0,
) -> NeighborhoodView | None:
    """The bounded, authorized neighbourhood of the named entity.

    ``None`` when the entity is absent OR the caller can see no claim about it — the two are
    indistinguishable from outside (FR-4.3).
    """
    forbidden = await sensitive_tags(sessionmaker, scope.project_id) - scope.allowed_topics
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
        node_id = str(entity_id(entity.type, entity.name))
        entry_visible = await session.scalar(
            select(func.count())
            .select_from(models.Claim)
            .where(
                claim_visibility_clause(scope, forbidden),
                or_(
                    models.Claim.subject_entity_key == uuid.UUID(node_id),
                    models.Claim.object_entity_key == uuid.UUID(node_id),
                    # A keyless endpoint still authorizes the centre by name — per endpoint, since a
                    # claim may key one side and only name the other. The centre was selected BY
                    # name, so it is already resolved to one entity row.
                    (models.Claim.subject_entity_key.is_(None))
                    & (models.Claim.subject == entity.name),
                    (models.Claim.object_entity_key.is_(None))
                    & (models.Claim.object == entity.name),
                ),
            )
        )
        if not entry_visible:
            return None  # exists but invisible to this caller ⇒ treated as absent

    page = min(max(1, int(limit)), MAX_PAGE)
    skip = max(0, int(offset))

    # Authorize the WHOLE candidate set, then count, then page. Every observable — total, page
    # density, continuation — is derived from the authorized set only (R16).
    candidates = await graph.neighborhood_candidates(scope, node_id)
    authorized = await _authorize(sessionmaker, scope, forbidden, candidates)
    total = len(authorized)
    page_nodes = authorized[skip : skip + page]

    edges = await graph.edges_between(scope, node_id, [n.id for n in page_nodes])
    visible_ids = {node_id, *(n.id for n in page_nodes)}
    return NeighborhoodView(
        center=GraphNodeView(
            id=node_id, name=entity.name, type=entity.type, anchored=entity.ontology_valid
        ),
        neighbors=[
            GraphNodeView(
                id=n.id,
                name=_node_name(n) or n.id,
                type=str(n.properties.get("type", "")),
                anchored=False,
            )
            for n in page_nodes
        ],
        edges=[
            GraphEdgeView(source=e.source_id, target=e.target_id, type=e.type)
            for e in edges
            if e.source_id in visible_ids and e.target_id in visible_ids
        ],
        total=total,
        offset=skip,
        limit=page,
    )
