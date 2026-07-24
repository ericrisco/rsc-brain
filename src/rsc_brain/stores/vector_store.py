"""Frozen ``VectorStore`` interface (pgvector). Implemented in SPEC-03.

The permission + project + tag filter lives **in the query** (FR-4.2 / FR-12.4): callers
pass a :class:`~rsc_brain.scope.ProjectScope` and the caller's allowed tags, never a bare
``project_id``. Implementations must reject any record whose ``project_id`` differs from the
scope via :meth:`ProjectScope.require_object` before writing.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Protocol

from rsc_brain.config.models import ANCHORED_EMBEDDING_DIM
from rsc_brain.scope import ProjectScope


@dataclass(frozen=True, slots=True)
class VectorRecord:
    """A chunk embedding to store. ``project_id`` makes it project-owned."""

    chunk_id: str
    project_id: str
    embedding: Sequence[float]
    tags: frozenset[str] = field(default_factory=frozenset)


@dataclass(frozen=True, slots=True)
class VectorHit:
    chunk_id: str
    score: float


class VectorStore(Protocol):
    """Vector similarity storage/retrieval with in-query permission filtering."""

    #: Anchored embedding dimension (FR-9.4); implementations validate against it.
    dimension: int = ANCHORED_EMBEDDING_DIM

    async def upsert(self, scope: ProjectScope, records: Sequence[VectorRecord]) -> None:
        """Insert/replace embeddings. Rejects records outside ``scope``'s project."""
        ...

    async def search(
        self,
        scope: ProjectScope,
        embedding: Sequence[float],
        *,
        allowed_tags: frozenset[str],
        k: int,
    ) -> list[VectorHit]:
        """Top-k search restricted to ``scope``'s project and ``allowed_tags`` in the query."""
        ...
