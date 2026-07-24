"""Frozen ``GraphStore`` interface (Apache AGE). Implemented in SPEC-03.

One graph per project (FR-12.4): the project is selected from the
:class:`~rsc_brain.scope.ProjectScope`, never from a caller-supplied id. Cypher is always
parameterized. The interface deliberately hides the backend so the store can be swapped to
Kuzu if the v0.2 k-hop benchmark (D1/SPEC-09) requires it.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Protocol

from rsc_brain.scope import ProjectScope


@dataclass(frozen=True, slots=True)
class GraphNode:
    id: str
    labels: frozenset[str] = field(default_factory=frozenset)
    properties: Mapping[str, object] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class GraphEdge:
    source_id: str
    target_id: str
    type: str
    properties: Mapping[str, object] = field(default_factory=dict)


class GraphStore(Protocol):
    """Property-graph storage with k-hop expansion, scoped to one project."""

    async def upsert_nodes(self, scope: ProjectScope, nodes: Sequence[GraphNode]) -> None: ...

    async def upsert_edges(self, scope: ProjectScope, edges: Sequence[GraphEdge]) -> None: ...

    async def k_hop(
        self, scope: ProjectScope, start_ids: Sequence[str], *, k: int
    ) -> list[GraphNode]:
        """Return the k-hop neighbourhood of ``start_ids`` within ``scope``'s graph."""
        ...

    async def run_cypher(
        self, scope: ProjectScope, cypher: str, params: Mapping[str, object]
    ) -> list[Mapping[str, object]]:
        """Run a parameterized Cypher query against ``scope``'s project graph."""
        ...
