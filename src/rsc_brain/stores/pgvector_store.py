"""pgvector implementation of the frozen ``VectorStore`` interface (SPEC-03).

The permission filter — ``project_id`` and the caller's ``allowed_tags`` — lives **in the SQL
query**, never applied post-hoc in Python over already-fetched rows (FR-4.2 / FR-12.4). Empty
``allowed_tags`` matches nothing (a caller with no topic access sees no results). Cross-project
records are rejected before any write (AUDIT-003). Similarity is cosine over the HNSW index.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import cast

from sqlalchemy import Select, update
from sqlalchemy import select as sa_select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.config.models import ANCHORED_EMBEDDING_DIM
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope
from rsc_brain.stores.vector_store import VectorHit, VectorRecord


def build_search_statement(
    project_id: uuid.UUID, embedding: Sequence[float], allowed_tags: Sequence[str], k: int
) -> Select[tuple[uuid.UUID, float]]:
    """Build the scoped similarity query. Exposed so tests can assert the filter is in-query."""
    distance = models.Chunk.embedding.cosine_distance(list(embedding))
    statement = (
        sa_select(models.Chunk.id, (1 - distance).label("score"))
        .where(
            models.Chunk.project_id == project_id,
            models.Chunk.embedding.is_not(None),
            models.Chunk.tags.op("&&")(list(allowed_tags)),
        )
        .order_by(distance)
        .limit(k)
    )
    return cast("Select[tuple[uuid.UUID, float]]", statement)


class PgVectorStore:
    """Vector similarity over ``chunks.embedding`` (pgvector), scoped per project."""

    dimension: int = ANCHORED_EMBEDDING_DIM

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sm = sessionmaker

    async def upsert(self, scope: ProjectScope, records: Sequence[VectorRecord]) -> None:
        async with session_scope(self._sm) as session:
            for record in records:
                # Reject a record owned by another project before writing (AUDIT-003).
                scope.require_object(record)
                if len(record.embedding) != self.dimension:
                    raise ValueError(
                        f"embedding must be {self.dimension}-dim, got {len(record.embedding)}"
                    )
                await session.execute(
                    update(models.Chunk)
                    .where(
                        models.Chunk.id == uuid.UUID(record.chunk_id),
                        models.Chunk.project_id == uuid.UUID(scope.project_id),
                    )
                    .values(embedding=list(record.embedding), tags=list(record.tags))
                )

    async def search(
        self,
        scope: ProjectScope,
        embedding: Sequence[float],
        *,
        allowed_tags: frozenset[str],
        k: int,
    ) -> list[VectorHit]:
        statement = build_search_statement(
            uuid.UUID(scope.project_id), embedding, sorted(allowed_tags), k
        )
        async with self._sm() as session:
            rows = await session.execute(statement)
            return [VectorHit(chunk_id=str(cid), score=float(score)) for cid, score in rows.all()]
