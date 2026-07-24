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

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.scope import ProjectScope
from rsc_brain.stores.graph_store import GraphEdge, GraphNode

_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_SET_SEARCH_PATH = 'SET search_path = ag_catalog, "$user", public'


class UnsafeIdentifierError(ValueError):
    """Raised when a label/edge-type is not a safe identifier (would need interpolation)."""


def graph_name(project_id: str) -> str:
    """Deterministic, safe AGE graph name for a project (validates the uuid)."""
    return "p_" + uuid.UUID(project_id).hex


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
            sql = f"SELECT * FROM ag_catalog.cypher('{graph}', $$ {cypher} $$, :params) AS ({columns})"
            result = await session.execute(text(sql), {"params": json.dumps(dict(params))})
        else:
            sql = f"SELECT * FROM ag_catalog.cypher('{graph}', $$ {cypher} $$) AS ({columns})"
            result = await session.execute(text(sql))
        return result.all()

    async def create_graph(self, scope: ProjectScope) -> None:
        """Create this project's graph if absent (accompanies project creation)."""
        graph = graph_name(scope.project_id)
        async with self._sm() as session:
            await self._prepare(session)
            exists = await session.scalar(
                text("SELECT count(*) FROM ag_catalog.ag_graph WHERE name = :n"), {"n": graph}
            )
            if not exists:
                await session.execute(text(f"SELECT ag_catalog.create_graph('{graph}')"))
            await session.commit()

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

    async def upsert_nodes(self, scope: ProjectScope, nodes: Sequence[GraphNode]) -> None:
        graph = graph_name(scope.project_id)
        async with self._sm() as session:
            await self._prepare(session)
            for node in nodes:
                label = safe_identifier(next(iter(sorted(node.labels))) if node.labels else "Node")
                set_frag, set_params = _assignments("n", dict(node.properties), "p")
                cypher = f"MERGE (n:{label} {{id: $id}})"
                if set_frag:
                    cypher += f" SET {set_frag}"
                await self._cypher(session, graph, cypher, {"id": node.id, **set_params}, "v agtype")
            await session.commit()

    async def upsert_edges(self, scope: ProjectScope, edges: Sequence[GraphEdge]) -> None:
        graph = graph_name(scope.project_id)
        async with self._sm() as session:
            await self._prepare(session)
            for edge in edges:
                etype = safe_identifier(edge.type)
                set_frag, set_params = _assignments("r", dict(edge.properties), "p")
                cypher = f"MATCH (a {{id: $src}}), (b {{id: $dst}}) MERGE (a)-[r:{etype}]->(b)"
                if set_frag:
                    cypher += f" SET {set_frag}"
                await self._cypher(
                    session,
                    graph,
                    cypher,
                    {"src": edge.source_id, "dst": edge.target_id, **set_params},
                    "v agtype",
                )
            await session.commit()

    async def k_hop(
        self, scope: ProjectScope, start_ids: Sequence[str], *, k: int
    ) -> list[GraphNode]:
        graph = graph_name(scope.project_id)
        depth = int(k)  # validated int; AGE needs the range as a literal
        if depth < 1:
            return []
        cypher = (
            f"MATCH (a)-[*1..{depth}]->(b) WHERE a.id IN $ids AND b.suppressed IS NULL "
            "RETURN DISTINCT b.id AS id, labels(b) AS labels, properties(b) AS props"
        )
        async with self._sm() as session:
            await self._prepare(session)
            rows = await self._cypher(
                session,
                graph,
                cypher,
                {"ids": list(start_ids)},
                "id agtype, labels agtype, props agtype",
            )
        nodes: list[GraphNode] = []
        for node_id, labels, props in rows:
            parsed_labels = _parse_agtype(labels)
            parsed_props = _parse_agtype(props)
            nodes.append(
                GraphNode(
                    id=str(_parse_agtype(node_id)),
                    labels=frozenset(parsed_labels)
                    if isinstance(parsed_labels, list)
                    else frozenset(),
                    properties=parsed_props if isinstance(parsed_props, dict) else {},
                )
            )
        return nodes

    async def tombstone_document(self, scope: ProjectScope, document_id: str) -> int:
        """Mark all nodes derived from a document as suppressed. Returns the count."""
        graph = graph_name(scope.project_id)
        cypher = (
            "MATCH (n) WHERE n.source_document_id = $doc AND n.suppressed IS NULL "
            "SET n.suppressed = true RETURN count(n) AS c"
        )
        async with self._sm() as session:
            await self._prepare(session)
            rows = await self._cypher(session, graph, cypher, {"doc": document_id}, "c agtype")
            await session.commit()
        if not rows:
            return 0
        parsed = _parse_agtype(rows[0][0])
        return parsed if isinstance(parsed, int) else 0

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
