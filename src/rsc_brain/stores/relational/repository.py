"""Frozen ``RelationalStore`` + ``KnowledgeRepository`` interfaces. Implemented in SPEC-03.

Hard rule (FR-12.4, PR auto-reject surface): **every** knowledge repository method takes a
:class:`~rsc_brain.scope.ProjectScope` as its first argument. A knowledge query without a
scope does not type-check — the project can never be supplied independently of the
authenticated identity (AUDIT-003).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from rsc_brain.scope import ProjectScope


@dataclass(frozen=True, slots=True)
class DocumentRef:
    """Minimal project-owned document reference (full model: SPEC-03)."""

    document_id: str
    project_id: str


class KnowledgeRepository(Protocol):
    """Project-scoped access to knowledge tables. SPEC-03 adds the concrete methods."""

    async def count_documents(self, scope: ProjectScope) -> int:
        """Number of documents visible within ``scope``'s project."""
        ...

    async def get_document(self, scope: ProjectScope, document_id: str) -> DocumentRef | None:
        """Fetch a document within ``scope``'s project, or ``None`` if absent/forbidden.

        Forbidden and absent are indistinguishable to the caller (FR-4.3).
        """
        ...


class RelationalStore(Protocol):
    """The relational source of truth. ``migrate`` is a separate step from boot (D18)."""

    async def migrate(self) -> None:
        """Apply pending migrations idempotently (``brain migrate``)."""
        ...

    def knowledge(self) -> KnowledgeRepository:
        """Return the project-scoped knowledge repository."""
        ...
