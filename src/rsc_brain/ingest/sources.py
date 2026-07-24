"""Source management (FR-1.13): a project-scoped façade over source CRUD with policy/type
validation. A ``Source`` carries the D13 categorization policy that governs whether ingested
documents publish automatically or hold for human approval.
"""

from __future__ import annotations

from collections.abc import Sequence

from rsc_brain.ingest.types import SourcePolicy, SourceType
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational.ingest_repository import IngestRepository, SourceRow


class SourceService:
    def __init__(self, repository: IngestRepository) -> None:
        self._repo = repository

    async def create(
        self,
        scope: ProjectScope,
        *,
        name: str,
        type_: str = SourceType.FOLDER.value,
        policy: str = SourcePolicy.LLM.value,
        default_tags: Sequence[str] = (),
        review_if_sensitive: bool = True,
        curators: Sequence[str] = (),
    ) -> str:
        # Validate against the enums so an invalid policy/type never reaches the DB.
        SourceType(type_)
        SourcePolicy(policy)
        return await self._repo.create_source(
            scope,
            name=name,
            type_=type_,
            policy=policy,
            default_tags=default_tags,
            review_if_sensitive=review_if_sensitive,
            curators=curators,
        )

    async def list(self, scope: ProjectScope) -> list[SourceRow]:
        return await self._repo.list_sources(scope)

    async def ensure_default(self, scope: ProjectScope) -> SourceRow:
        return await self._repo.ensure_default_source(scope)
