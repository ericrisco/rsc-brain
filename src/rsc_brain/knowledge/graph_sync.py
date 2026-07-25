"""Keep the graph's relations in step with the relational store's temporal state (AUDIT-018 / R27).

Superseding a claim closed it in Postgres and left its AGE relation current. The two stores then
answered differently about the same fact — recall said the SLA is 48 hours, a graph expansion said 72
— and nothing on either side told a reader which one had been retired. Worse, the graph is the store
an agent walks when it wants context, so the retired fact was the one most likely to be quoted.

Retirement is a flag, never a delete: FR-5.5's never-delete rule holds for the graph too, and
reverting a correction has to be able to bring the fact back exactly as it was.
"""

from __future__ import annotations

from collections.abc import Sequence

from rsc_brain.scope import ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore, edge_type
from rsc_brain.stores.graph_store import GraphEdge
from rsc_brain.stores.relational.knowledge_store import KnowledgeStore


class GraphSync:
    """Applies a claim's temporal state to the relation it asserts."""

    def __init__(self, *, store: KnowledgeStore, graph: AgeGraphStore) -> None:
        self._store = store
        self._graph = graph

    async def retire_claims(self, scope: ProjectScope, claim_ids: Sequence[str]) -> int:
        """Retire the relations asserted ONLY by these (now superseded) claims.

        A relation still asserted by a live claim stays live: two documents can say the same thing,
        and superseding one of them does not retract the fact.
        """
        keys = await self._store.claim_relation_keys(scope, claim_ids)
        if not keys:
            return 0
        still_live = await self._store.live_relation_keys(scope, keys)
        orphaned = [k for k in dict.fromkeys(keys) if k not in still_live]
        await self._graph.set_relations_retired(scope, _edges(orphaned), retired=True)
        return len(orphaned)

    async def reactivate_claims(self, scope: ProjectScope, claim_ids: Sequence[str]) -> int:
        """Un-retire the relations these (reactivated) claims assert — the reverse of a revert."""
        keys = await self._store.claim_relation_keys(scope, claim_ids)
        live = await self._store.live_relation_keys(scope, keys)
        revived = [k for k in dict.fromkeys(keys) if k in live]
        await self._graph.set_relations_retired(scope, _edges(revived), retired=False)
        return len(revived)


def _edges(keys: Sequence[tuple[str, str, str]]) -> list[GraphEdge]:
    """Relation keys as the edges the writer created — same predicate transform, or no match."""
    return [
        GraphEdge(source_id=subject, target_id=obj, type=edge_type(predicate))
        for subject, predicate, obj in keys
    ]
