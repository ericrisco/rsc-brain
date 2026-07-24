"""Recall-time ontology seam (SPEC-24, FR-17.5). Off by default; NEVER touches permissions.

The retriever holds an optional ``OntologyRecall``. When the project's ``ontology.enabled`` is false
(the default) ``expand_query_labels`` returns nothing and recall is byte-for-byte the base pipeline.
When enabled it returns the extra labels a query should also match (bounded ``rdfs:subClassOf`` +
``skos:broader/narrower`` expansion, depth from settings). The retriever feeds those through its
OWN visibility-filtered lexical search, so the deterministic tag-based permission cut (FR-17.8) is
applied to the expanded set exactly as to the base set — the ontology never decides visibility.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.ontology.ingest import OntologyIngest
from rsc_brain.scope import ProjectScope


class OntologyRecall:
    """Query-expansion labels from the active ontology; empty when the layer is off."""

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        # Reuse the ingest loader's cached, fingerprinted index so recall never re-parses.
        self._ontology = OntologyIngest(sessionmaker)

    async def expand_query_labels(self, scope: ProjectScope, query: str) -> list[str]:
        index = await self._ontology.index_for(scope)
        if index is None:
            return []
        settings = await self._ontology.settings_for(scope)
        return sorted(index.expand_query_labels(query, depth=settings.inference_depth))
