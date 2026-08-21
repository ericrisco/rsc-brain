"""Apache AGE implementation of the frozen ``GraphStore`` (SPEC-03).

**One physical graph per project** (FR-12.4): the graph name is derived from the project id
via :func:`graph_name` and is a validated identifier — the only value interpolated into SQL.
**All caller/user data flows through Cypher parameters** (AGE's ``cypher()`` third argument),
never string-interpolated: injection is impossible through node/edge values. Labels and edge
types are validated identifiers. Deletion is a **property tombstone** (``suppressed = true``)
so derived nodes/edges never vanish silently (plan §decisions).

AGE requires the graph name and the query text to be SQL *literals* (it rewrites ``cypher()``
at parse time), so they cannot be bind parameters — hence the validated-identifier discipline.
"""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.scope import ProjectScope
from rsc_brain.stores.graph_store import GraphEdge, GraphNode
from rsc_brain.stores.relational.database import maybe_session_scope

_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_SET_SEARCH_PATH = 'SET search_path = ag_catalog, "$user", public'
# Safety ceiling on how many neighbours a single subgraph query scans before Python paginates,
# so even a pathologically high-degree node can't unbound the fetch (SPEC-26 FR-13.8).
_NEIGHBORHOOD_SCAN_CAP = 5000


class UnsafeIdentifierError(ValueError):
    """Raised when a label/edge-type is not a safe identifier (would need interpolation)."""


class GraphMergeConflictError(RuntimeError):
    """Two live edges share an identity but carry different properties; merging would lose one."""


@dataclass(frozen=True, slots=True)
class GraphEdgeState:
    source_id: str
    target_id: str
    type: str
    properties: Mapping[str, object]

    @property
    def identity(self) -> tuple[str, str, str]:
        return (self.source_id, self.type, self.target_id)

    def as_json(self) -> dict[str, object]:
        return {
            "source_id": self.source_id,
            "target_id": self.target_id,
            "type": self.type,
            "properties": dict(self.properties),
        }

    @classmethod
    def from_json(cls, value: dict[str, object]) -> GraphEdgeState:
        properties = value.get("properties")
        return cls(
            source_id=str(value["source_id"]),
            target_id=str(value["target_id"]),
            type=str(value["type"]),
            properties=dict(properties) if isinstance(properties, dict) else {},
        )


@dataclass(frozen=True, slots=True)
class GraphNodeMergeState:
    exists: bool
    markers: Mapping[str, object]

    def as_json(self) -> dict[str, object]:
        return {"exists": self.exists, "markers": dict(self.markers)}

    @classmethod
    def from_json(cls, value: dict[str, object]) -> GraphNodeMergeState:
        markers = value.get("markers")
        return cls(
            exists=bool(value.get("exists", False)),
            markers=dict(markers) if isinstance(markers, dict) else {},
        )


def graph_name(project_id: str) -> str:
    """Deterministic, safe AGE graph name for a project (validates the uuid)."""
    return "p_" + uuid.UUID(project_id).hex


def edge_type(predicate: str) -> str:
    """Sanitize a predicate into a safe Cypher edge type (never interpolates raw text).

    Shared on purpose: the ingest pipeline writes relations with this transform and the retirement
    path (R27) has to match the same edge by name. Two copies of it would drift into a retirement
    that silently matches nothing.
    """
    cleaned = re.sub(r"[^A-Za-z0-9_]", "_", predicate.strip()) or "related_to"
    if not re.match(r"^[A-Za-z_]", cleaned):
        cleaned = f"r_{cleaned}"
    try:
        return safe_identifier(cleaned)
    except ValueError:  # pragma: no cover - defensive
        return "related_to"


def safe_identifier(value: str) -> str:
    """Return ``value`` if it is a safe Cypher identifier, else raise (no interpolation risk)."""
    if not _IDENTIFIER.match(value):
        raise UnsafeIdentifierError(f"unsafe identifier: {value!r}")
    return value


def _parse_agtype(raw: object) -> object:
    """Parse an agtype scalar/array/object string. Strips a trailing ``::vertex``/``::edge``."""
    if not isinstance(raw, str):
        return raw
    payload = raw.rsplit("::", 1)[0] if "::" in raw else raw
    try:
        return json.loads(payload)
    except json.JSONDecodeError:
        return raw


def _assignments(
    alias: str, props: Mapping[str, object], prefix: str
) -> tuple[str, dict[str, object]]:
    """Build a parameterized SET clause: property keys are validated identifiers, values are
    Cypher parameters. AGE 1.6.0 does not accept a map-valued parameter in ``SET += $map``,
    so each property becomes ``alias.key = $paramN``."""
    clauses: list[str] = []
    params: dict[str, object] = {}
    for index, key in enumerate(sorted(props)):
        safe_identifier(key)
        name = f"{prefix}{index}"
        clauses.append(f"{alias}.{key} = ${name}")
        params[name] = props[key]
    return ", ".join(clauses), params


class AgeGraphStore:
    """Property-graph storage over Apache AGE, one graph per project."""

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sm = sessionmaker

    async def _prepare(self, session: AsyncSession) -> None:
        await session.execute(text("LOAD 'age'"))
        await session.execute(text(_SET_SEARCH_PATH))

    async def _cypher(
        self,
        session: AsyncSession,
        graph: str,
        cypher: str,
        params: Mapping[str, object] | None,
        columns: str,
    ) -> Sequence[Sequence[object]]:
        # graph + cypher are literals (AGE requirement); user data goes only through :params.
        if params:
            # literals — they cannot be bind parameters. Both are ours: `graph` is
            # `"p_" + UUID(project_id).hex` (so a non-UUID never reaches here) and every interpolation
            # inside `cypher` goes through `safe_identifier`/`edge_type`. Caller data travels only as
            # `:params`, JSON-encoded.
            sql = f"SELECT * FROM ag_catalog.cypher('{graph}', $$ {cypher} $$, :params) AS ({columns})"  # noqa: S608
            result = await session.execute(text(sql), {"params": json.dumps(dict(params))})
        else:
            sql = f"SELECT * FROM ag_catalog.cypher('{graph}', $$ {cypher} $$) AS ({columns})"  # noqa: S608
            result = await session.execute(text(sql))
        return result.all()

    async def create_graph(
        self, scope: ProjectScope, *, session: AsyncSession | None = None
    ) -> None:
        """Create this project's graph if absent (accompanies project creation).

        Takes an optional ``session`` so a caller can make its relational and graph writes ONE
        transaction (R35) — the graph lives in the same database, so there is no reason for the two
        halves of one operation to be able to disagree.
        """
        graph = graph_name(scope.project_id)
        async with maybe_session_scope(self._sm, session) as work:
            await self._prepare(work)
            exists = await work.scalar(
                text("SELECT count(*) FROM ag_catalog.ag_graph WHERE name = :n"), {"n": graph}
            )
            if not exists:
                await work.execute(text(f"SELECT ag_catalog.create_graph('{graph}')"))

    async def drop_graph(self, scope: ProjectScope) -> None:
        graph = graph_name(scope.project_id)
        async with self._sm() as session:
            await self._prepare(session)
            exists = await session.scalar(
                text("SELECT count(*) FROM ag_catalog.ag_graph WHERE name = :n"), {"n": graph}
            )
            if exists:
                await session.execute(text(f"SELECT ag_catalog.drop_graph('{graph}', true)"))
            await session.commit()

    async def upsert_nodes(
        self,
        scope: ProjectScope,
        nodes: Sequence[GraphNode],
        *,
        session: AsyncSession | None = None,
    ) -> None:
        graph = graph_name(scope.project_id)
        async with maybe_session_scope(self._sm, session) as work:
            await self._prepare(work)
            for node in nodes:
                label = safe_identifier(next(iter(sorted(node.labels))) if node.labels else "Node")
                set_frag, set_params = _assignments("n", dict(node.properties), "p")
                cypher = f"MERGE (n:{label} {{id: $id}})"
                if set_frag:
                    cypher += f" SET {set_frag}"
                await self._cypher(work, graph, cypher, {"id": node.id, **set_params}, "v agtype")

    async def upsert_edges(
        self,
        scope: ProjectScope,
        edges: Sequence[GraphEdge],
        *,
        session: AsyncSession | None = None,
    ) -> None:
        graph = graph_name(scope.project_id)
        async with maybe_session_scope(self._sm, session) as work:
            await self._prepare(work)
            for edge in edges:
                etype = safe_identifier(edge.type)
                set_frag, set_params = _assignments("r", dict(edge.properties), "p")
                cypher = f"MATCH (a {{id: $src}}), (b {{id: $dst}}) MERGE (a)-[r:{etype}]->(b)"
                if set_frag:
                    cypher += f" SET {set_frag}"
                await self._cypher(
                    work,
                    graph,
                    cypher,
                    {"src": edge.source_id, "dst": edge.target_id, **set_params},
                    "v agtype",
                )

    async def set_relations_retired(
        self,
        scope: ProjectScope,
        relations: Sequence[GraphEdge],
        *,
        retired: bool,
        session: AsyncSession | None = None,
    ) -> None:
        """Mark (or unmark) relations as superseded, so graph reads stop serving retired facts (R27).

        A superseded claim used to keep a live AGE relation: the graph answered with a fact the
        relational store had retired, and nothing on either side said which was right. The relation
        is flagged, never deleted — FR-5.5's never-delete rule applies to the graph too, and reverting
        a correction has to be able to bring the fact back.
        """
        if not relations:
            return
        graph = graph_name(scope.project_id)
        async with maybe_session_scope(self._sm, session) as work:
            await self._prepare(work)
            exists = await work.scalar(
                text("SELECT count(*) FROM ag_catalog.ag_graph WHERE name = :n"), {"n": graph}
            )
            if not exists:
                return
            for rel in relations:
                etype = safe_identifier(rel.type)
                action = "SET r.superseded = true" if retired else "REMOVE r.superseded"
                await self._cypher(
                    work,
                    graph,
                    f"MATCH (a {{id: $src}})-[r:{etype}]->(b {{id: $dst}}) {action}",
                    {"src": rel.source_id, "dst": rel.target_id},
                    "v agtype",
                )

    async def k_hop(
        self, scope: ProjectScope, start_ids: Sequence[str], *, k: int
    ) -> list[GraphNode]:
        """Nodes reachable within ``k`` directed hops, never through a retired relation (R27).

        Expanded one hop at a time rather than with a variable-length pattern: the filter has to be
        "this relation is not superseded", and AGE has neither path variables nor ``ALL``/``NONE`` over
        an edge list, while an inline ``{superseded: false}`` property map would also drop every live
        relation (they carry no such property — absent is what live MEANS here). ``k`` is small and
        configured, so the extra round trips are bounded, and each hop carries the same scan cap.
        """
        graph = graph_name(scope.project_id)
        depth = int(k)
        if depth < 1 or not start_ids:
            return []
        cypher = (
            "MATCH (a)-[r]->(b) WHERE a.id IN $ids AND b.suppressed IS NULL "
            "AND r.superseded IS NULL "
            "RETURN DISTINCT b.id AS id, labels(b) AS labels, properties(b) AS props "
            f"LIMIT {_NEIGHBORHOOD_SCAN_CAP}"
        )
        seen: dict[str, GraphNode] = {}
        frontier = list(dict.fromkeys(start_ids))
        async with self._sm() as session:
            await self._prepare(session)
            for _ in range(depth):
                if not frontier:
                    break
                rows = await self._cypher(
                    session,
                    graph,
                    cypher,
                    {"ids": frontier},
                    "id agtype, labels agtype, props agtype",
                )
                frontier = []
                for row in rows:
                    node = self._node_from_row(row)
                    if node.id not in seen:
                        seen[node.id] = node
                        frontier.append(node.id)
        return list(seen.values())

    async def neighborhood_candidates(self, scope: ProjectScope, start_id: str) -> list[GraphNode]:
        """Every distinct 1-hop neighbour of ``start_id``, unpaginated and deterministically ordered.

        R16: pagination and counting used to happen HERE, before any permission was applied, so the
        total announced hidden neighbours and pages shrank wherever a hidden neighbour happened to
        sort. The physical neighbourhood is therefore only the *candidate set* now; the caller
        authorizes it and pages the authorized result (see
        :func:`rsc_brain.knowledge.entity_graph.entity_neighborhood`).

        Work stays bounded by ``_NEIGHBORHOOD_SCAN_CAP``: a high-degree node cannot make this
        unbounded, and the caller reports when the cap was reached rather than silently truncating.
        """
        graph = graph_name(scope.project_id)
        if not await self._graph_exists_by_name(graph):
            return []
        async with self._sm() as session:
            await self._prepare(session)
            # AGE cannot ORDER BY inside a WITH/DISTINCT projection, so ordering is applied here,
            # deterministically by node id, which is what makes offset paging stable.
            node_rows = await self._cypher(
                session,
                graph,
                "MATCH (a)-[r]-(b) WHERE a.id = $start AND b.suppressed IS NULL "
                "AND r.superseded IS NULL "
                "RETURN DISTINCT b.id AS id, labels(b) AS labels, properties(b) AS props "
                f"LIMIT {_NEIGHBORHOOD_SCAN_CAP}",
                {"start": start_id},
                "id agtype, labels agtype, props agtype",
            )
        return sorted((self._node_from_row(row) for row in node_rows), key=lambda n: n.id)

    async def edges_between(
        self, scope: ProjectScope, start_id: str, neighbour_ids: Sequence[str]
    ) -> list[GraphEdge]:
        """Edges between the centre and exactly these neighbours — never any others.

        Called with the AUTHORIZED page only, so an edge cannot disclose a neighbour the page does
        not contain.
        """
        ids = list(neighbour_ids)
        if not ids:
            return []
        graph = graph_name(scope.project_id)
        if not await self._graph_exists_by_name(graph):
            return []
        async with self._sm() as session:
            await self._prepare(session)
            edge_rows = await self._cypher(
                session,
                graph,
                # The direction clause is parenthesised as a whole: AND binds tighter than OR, so
                # `superseded IS NULL AND (fwd) OR (rev)` would leave the reverse direction unfiltered.
                "MATCH (a)-[r]->(b) WHERE r.superseded IS NULL "
                "AND ((a.id = $start AND b.id IN $ids) OR (b.id = $start AND a.id IN $ids)) "
                "RETURN a.id AS s, type(r) AS t, b.id AS o",
                {"start": start_id, "ids": ids},
                "s agtype, t agtype, o agtype",
            )
        return [
            GraphEdge(
                source_id=str(_parse_agtype(s)),
                target_id=str(_parse_agtype(o)),
                type=str(_parse_agtype(t)),
            )
            for s, t, o in edge_rows
        ]

    def _node_from_row(self, row: Sequence[object]) -> GraphNode:
        node_id, labels, props = row
        parsed_labels = _parse_agtype(labels)
        parsed_props = _parse_agtype(props)
        return GraphNode(
            id=str(_parse_agtype(node_id)),
            labels=frozenset(parsed_labels) if isinstance(parsed_labels, list) else frozenset(),
            properties=parsed_props if isinstance(parsed_props, dict) else {},
        )

    async def _graph_exists_by_name(self, graph: str) -> bool:
        async with self._sm() as session:
            await self._prepare(session)
            return await self._graph_exists(session, graph)

    async def _graph_exists(self, session: AsyncSession, graph: str) -> bool:
        count = await session.scalar(
            text("SELECT count(*) FROM ag_catalog.ag_graph WHERE name = :n"), {"n": graph}
        )
        return bool(count)

    async def tombstone_document(self, scope: ProjectScope, document_id: str) -> int:
        """Mark all nodes derived from a document as suppressed. Returns the count (0 if the
        project graph does not exist yet — a safe no-op for forget)."""
        graph = graph_name(scope.project_id)
        cypher = (
            "MATCH (n) WHERE n.source_document_id = $doc AND n.suppressed IS NULL "
            "SET n.suppressed = true RETURN count(n) AS c"
        )
        async with self._sm() as session:
            await self._prepare(session)
            if not await self._graph_exists(session, graph):
                return 0
            rows = await self._cypher(session, graph, cypher, {"doc": document_id}, "c agtype")
            await session.commit()
        if not rows:
            return 0
        parsed = _parse_agtype(rows[0][0])
        return parsed if isinstance(parsed, int) else 0

    async def tombstone_nodes(self, scope: ProjectScope, node_ids: Sequence[str]) -> int:
        """Suppress specific nodes by id (SPEC-22 GDPR forget --entity). k-hop skips suppressed
        nodes, and the tombstone means re-resolving the same uuid5 never silently revives it."""
        if not node_ids:
            return 0
        graph = graph_name(scope.project_id)
        cypher = (
            "MATCH (n) WHERE n.id IN $ids AND n.suppressed IS NULL "
            "SET n.suppressed = true RETURN count(n) AS c"
        )
        async with self._sm() as session:
            await self._prepare(session)
            if not await self._graph_exists(session, graph):
                return 0
            rows = await self._cypher(session, graph, cypher, {"ids": list(node_ids)}, "c agtype")
            await session.commit()
        if not rows:
            return 0
        parsed = _parse_agtype(rows[0][0])
        return parsed if isinstance(parsed, int) else 0

    async def merge_nodes(
        self,
        scope: ProjectScope,
        canonical_id: str,
        duplicate_id: str,
        *,
        merge_id: str | None = None,
        session: AsyncSession | None = None,
    ) -> int:
        """Re-point every edge of the duplicate node onto the canonical node, then tombstone the
        duplicate (``suppressed = true`` + ``merged_into``). Original edges become non-traversable
        history; canonical copies preserve direction and every property. Returns affected edges.

        Self-loops and edges already between the two nodes are dropped (never a canonical→canonical
        edge). The duplicate is kept (tombstoned, not deleted) so a merge stays reversible and
        auditable — consistent with the store's tombstone discipline. No-op if the graph is absent.
        """
        if canonical_id == duplicate_id:
            return 0
        graph = graph_name(scope.project_id)
        async with maybe_session_scope(self._sm, session) as work:
            await self._prepare(work)
            if not await self._graph_exists(work, graph):
                return 0
            node_before = await self.merge_marker_state(scope, duplicate_id, session=work)
            if node_before.exists and node_before.markers:
                raise GraphMergeConflictError("duplicate node already carries merge state")
            before = await self.active_incident_edges(
                scope, (canonical_id, duplicate_id), session=work
            )
            by_identity = {edge.identity: edge for edge in before}
            duplicate_edges = [
                edge for edge in before if duplicate_id in (edge.source_id, edge.target_id)
            ]
            copies: list[GraphEdgeState] = []
            for edge in duplicate_edges:
                source = canonical_id if edge.source_id == duplicate_id else edge.source_id
                target = canonical_id if edge.target_id == duplicate_id else edge.target_id
                if source in (target, duplicate_id) or target == duplicate_id:
                    continue
                copy = GraphEdgeState(source, target, edge.type, dict(edge.properties))
                existing = by_identity.get(copy.identity)
                if existing is not None:
                    if dict(existing.properties) != dict(copy.properties):
                        raise GraphMergeConflictError(
                            "edge identity collision has conflicting properties"
                        )
                    continue
                by_identity[copy.identity] = copy
                copies.append(copy)

            for edge in copies:
                await self._activate_edge(work, graph, edge)
            correlation = merge_id or "legacy-merge"
            for edge in duplicate_edges:
                await self._retire_edge(work, graph, edge, correlation)
            await self._cypher(
                work,
                graph,
                "MATCH (n {id: $dup}) SET n.suppressed = true, n.merged_into = $canon",
                {"dup": duplicate_id, "canon": canonical_id},
                "v agtype",
            )
        return len(duplicate_edges)

    async def active_incident_edges(
        self,
        scope: ProjectScope,
        node_ids: Sequence[str],
        *,
        session: AsyncSession | None = None,
    ) -> tuple[GraphEdgeState, ...]:
        ids = list(dict.fromkeys(node_ids))
        if not ids:
            return ()
        graph = graph_name(scope.project_id)
        async with maybe_session_scope(self._sm, session) as work:
            await self._prepare(work)
            if not await self._graph_exists(work, graph):
                return ()
            rows = await self._cypher(
                work,
                graph,
                "MATCH (a)-[r]->(b) WHERE r.superseded IS NULL "
                "AND (a.id IN $ids OR b.id IN $ids) "
                "RETURN a.id AS s, type(r) AS t, b.id AS o, properties(r) AS p",
                {"ids": ids},
                "s agtype, t agtype, o agtype, p agtype",
            )
        edges: list[GraphEdgeState] = []
        for source, etype, target, properties in rows:
            parsed = _parse_agtype(properties)
            edges.append(
                GraphEdgeState(
                    source_id=str(_parse_agtype(source)),
                    target_id=str(_parse_agtype(target)),
                    type=str(_parse_agtype(etype)),
                    properties=parsed if isinstance(parsed, dict) else {},
                )
            )
        return tuple(
            sorted(
                edges,
                key=lambda edge: (
                    edge.source_id,
                    edge.type,
                    edge.target_id,
                    json.dumps(dict(edge.properties), sort_keys=True),
                ),
            )
        )

    async def merge_marker_state(
        self,
        scope: ProjectScope,
        node_id: str,
        *,
        session: AsyncSession | None = None,
    ) -> GraphNodeMergeState:
        graph = graph_name(scope.project_id)
        async with maybe_session_scope(self._sm, session) as work:
            await self._prepare(work)
            if not await self._graph_exists(work, graph):
                return GraphNodeMergeState(False, {})
            rows = await self._cypher(
                work,
                graph,
                "MATCH (n {id: $id}) RETURN properties(n) AS p",
                {"id": node_id},
                "p agtype",
            )
        if not rows:
            return GraphNodeMergeState(False, {})
        properties = _parse_agtype(rows[0][0])
        if not isinstance(properties, dict):
            return GraphNodeMergeState(True, {})
        markers = {
            key: properties[key] for key in ("suppressed", "merged_into") if key in properties
        }
        return GraphNodeMergeState(True, markers)

    async def restore_merged_nodes(
        self,
        scope: ProjectScope,
        canonical_id: str,
        duplicate_id: str,
        *,
        before: Sequence[GraphEdgeState],
        expected_after: Sequence[GraphEdgeState],
        node_before: GraphNodeMergeState,
        expected_node_after: GraphNodeMergeState,
        merge_id: str,
        reversal_id: str,
        session: AsyncSession,
    ) -> None:
        current = await self.active_incident_edges(
            scope, (canonical_id, duplicate_id), session=session
        )
        if current != tuple(expected_after):
            raise GraphMergeConflictError("active graph changed after merge")
        current_node = await self.merge_marker_state(scope, duplicate_id, session=session)
        if current_node != expected_node_after:
            raise GraphMergeConflictError("merge node markers changed after merge")
        graph = graph_name(scope.project_id)
        await self._prepare(session)
        if not await self._graph_exists(session, graph):
            if before or expected_after:
                raise GraphMergeConflictError("graph disappeared after merge")
            return
        before_by_id = {edge.identity: edge for edge in before}
        after_by_id = {edge.identity: edge for edge in expected_after}
        for identity in sorted(set(after_by_id) - set(before_by_id)):
            await self._retire_created_edge(
                session,
                graph,
                after_by_id[identity],
                reversal_id,
            )
        for edge in before:
            if duplicate_id in (edge.source_id, edge.target_id):
                await self._reactivate_edge(session, graph, edge, merge_id)
        await self._cypher(
            session,
            graph,
            "MATCH (n {id: $dup}) REMOVE n.suppressed, n.merged_into",
            {"dup": duplicate_id},
            "v agtype",
        )
        restored = await self.active_incident_edges(
            scope, (canonical_id, duplicate_id), session=session
        )
        if restored != tuple(before):
            raise GraphMergeConflictError("graph could not be restored to its merge snapshot")
        restored_node = await self.merge_marker_state(scope, duplicate_id, session=session)
        if restored_node != node_before:
            raise GraphMergeConflictError("merge node markers could not be restored")

    async def _activate_edge(self, session: AsyncSession, graph: str, edge: GraphEdgeState) -> None:
        etype = safe_identifier(edge.type)
        set_frag, set_params = _assignments("r", edge.properties, "p")
        cypher = (
            f"MATCH (a {{id: $src}}), (b {{id: $dst}}) CREATE (a)-[r:{etype}]->(b) "
            "REMOVE r.superseded, r.merge_superseded_by, r.merge_reversed_by"
        )
        if set_frag:
            cypher += f" SET {set_frag}"
        await self._cypher(
            session,
            graph,
            cypher,
            {"src": edge.source_id, "dst": edge.target_id, **set_params},
            "v agtype",
        )

    async def _retire_edge(
        self, session: AsyncSession, graph: str, edge: GraphEdgeState, correlation: str
    ) -> None:
        etype = safe_identifier(edge.type)
        await self._cypher(
            session,
            graph,
            f"MATCH (a {{id: $src}})-[r:{etype}]->(b {{id: $dst}}) "
            "WHERE r.superseded IS NULL "
            "SET r.superseded = true, r.merge_superseded_by = $merge",
            {"src": edge.source_id, "dst": edge.target_id, "merge": correlation},
            "v agtype",
        )

    async def _reactivate_edge(
        self,
        session: AsyncSession,
        graph: str,
        edge: GraphEdgeState,
        merge_id: str,
    ) -> None:
        etype = safe_identifier(edge.type)
        await self._cypher(
            session,
            graph,
            f"MATCH (a {{id: $src}})-[r:{etype}]->(b {{id: $dst}}) "
            "WHERE r.merge_superseded_by = $merge "
            "REMOVE r.superseded, r.merge_superseded_by, r.merge_reversed_by",
            {"src": edge.source_id, "dst": edge.target_id, "merge": merge_id},
            "v agtype",
        )

    async def _retire_created_edge(
        self,
        session: AsyncSession,
        graph: str,
        edge: GraphEdgeState,
        reversal_id: str,
    ) -> None:
        etype = safe_identifier(edge.type)
        await self._cypher(
            session,
            graph,
            f"MATCH (a {{id: $src}})-[r:{etype}]->(b {{id: $dst}}) "
            "WHERE r.superseded IS NULL "
            "SET r.superseded = true, r.merge_reversed_by = $reversal "
            "REMOVE r.merge_superseded_by",
            {
                "src": edge.source_id,
                "dst": edge.target_id,
                "reversal": reversal_id,
            },
            "v agtype",
        )

    async def relation_triples(
        self, scope: ProjectScope, *, limit: int = 1000
    ) -> list[tuple[str, str, str]]:
        """Live ``(source, type, target)`` triples of relations that came from a document (R35).

        Bounded and read-only: the two-store divergence report needs the graph's own view of what it
        asserts, and ``run_cypher`` returns a single column per row. Provenance edges (``SUPERSEDES``,
        ``CORRECTED_BY``) are excluded — they record decisions, not facts, so no claim asserts them.
        """
        graph = graph_name(scope.project_id)
        if not await self._graph_exists_by_name(graph):
            return []
        async with self._sm() as session:
            await self._prepare(session)
            rows = await self._cypher(
                session,
                graph,
                "MATCH (a)-[r]->(b) WHERE r.superseded IS NULL AND r.source_document_id IS NOT NULL "
                f"RETURN a.id AS s, type(r) AS t, b.id AS o LIMIT {int(limit)}",
                {},
                "s agtype, t agtype, o agtype",
            )
        return [
            (str(_parse_agtype(row[0])), str(_parse_agtype(row[1])), str(_parse_agtype(row[2])))
            for row in rows
        ]

    async def run_cypher(
        self, scope: ProjectScope, cypher: str, params: Mapping[str, object]
    ) -> list[Mapping[str, object]]:
        """Run a parameterized Cypher query returning a single ``result`` value per row."""
        graph = graph_name(scope.project_id)
        async with self._sm() as session:
            await self._prepare(session)
            rows = await self._cypher(session, graph, cypher, params, "result agtype")
            await session.commit()
        return [{"result": _parse_agtype(row[0])} for row in rows]
