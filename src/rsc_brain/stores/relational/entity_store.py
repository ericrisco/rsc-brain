"""Project-scoped entity + alias-merge persistence (SPEC-09, FR-1.9 P1).

The proposal queue (`entity_merge_proposals`) and the merge itself are both filtered by
``scope.project_id`` in-query, and :meth:`EntityStore.apply_merge` refuses to merge two entities
unless both belong to the same project (FR-12.4) — a merge can never cross a project boundary.
A merged duplicate is tombstoned via ``entities.merged_into`` (kept, never deleted) so the action
stays reversible + auditable.
"""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass, field

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope


def _pid(scope: ProjectScope) -> uuid.UUID:
    return uuid.UUID(scope.project_id)


def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


class CrossProjectMergeError(ValueError):
    """Raised if a merge is attempted across entities of different projects (FR-12.4)."""


@dataclass(frozen=True, slots=True)
class EntityRow:
    id: str
    name: str
    normalized_name: str
    type: str
    aliases: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True, slots=True)
class MergeResult:
    canonical_id: str
    duplicate_id: str
    canonical_name: str
    canonical_type: str
    duplicate_name: str
    moved_aliases: int


@dataclass(frozen=True, slots=True)
class ProposalRow:
    id: str
    canonical_entity_id: str
    duplicate_entity_id: str
    confidence: float
    method: str
    status: str
    reason: str | None


class EntityStore:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sm = sessionmaker

    async def list_active_entities(self, scope: ProjectScope) -> list[EntityRow]:
        """Live (non-merged) entities with their aliases, for the merge proposer."""
        async with self._sm() as session:
            entities = (
                await session.scalars(
                    select(models.Entity).where(
                        models.Entity.project_id == _pid(scope),
                        models.Entity.merged_into.is_(None),
                    )
                )
            ).all()
            aliases_by_entity: dict[str, list[str]] = {}
            alias_rows = await session.execute(
                select(models.EntityAlias.entity_id, models.EntityAlias.alias).where(
                    models.EntityAlias.project_id == _pid(scope)
                )
            )
            for entity_id, alias in alias_rows:
                aliases_by_entity.setdefault(str(entity_id), []).append(alias)
        return [
            EntityRow(
                id=str(e.id),
                name=e.name,
                normalized_name=e.normalized_name,
                type=e.type,
                aliases=tuple(aliases_by_entity.get(str(e.id), ())),
            )
            for e in entities
        ]

    async def create_proposal(
        self,
        scope: ProjectScope,
        *,
        canonical_id: str,
        duplicate_id: str,
        confidence: float,
        method: str,
        status: str,
        reason: str | None,
    ) -> tuple[str, bool]:
        """Insert a proposal; returns (id, created). If one already exists for the ordered pair,
        it is left untouched and ``created`` is False (idempotent re-proposing)."""
        async with session_scope(self._sm) as session:
            statement = (
                pg_insert(models.EntityMergeProposal)
                .values(
                    project_id=_pid(scope),
                    canonical_entity_id=uuid.UUID(canonical_id),
                    duplicate_entity_id=uuid.UUID(duplicate_id),
                    confidence=confidence,
                    method=method,
                    status=status,
                    resolved_at=_now() if status in {"auto_applied", "applied"} else None,
                    reason=reason,
                )
                .on_conflict_do_nothing(
                    index_elements=["project_id", "canonical_entity_id", "duplicate_entity_id"]
                )
                .returning(models.EntityMergeProposal.id)
            )
            inserted = await session.scalar(statement)
            if inserted is not None:
                return str(inserted), True
            existing = await session.scalar(
                select(models.EntityMergeProposal.id).where(
                    models.EntityMergeProposal.project_id == _pid(scope),
                    models.EntityMergeProposal.canonical_entity_id == uuid.UUID(canonical_id),
                    models.EntityMergeProposal.duplicate_entity_id == uuid.UUID(duplicate_id),
                )
            )
            return str(existing), False

    async def get_proposal(self, scope: ProjectScope, proposal_id: str) -> ProposalRow | None:
        async with self._sm() as session:
            row = await session.get(models.EntityMergeProposal, uuid.UUID(proposal_id))
            if row is None or row.project_id != _pid(scope):
                return None
            return self._to_proposal(row)

    async def list_proposals(
        self, scope: ProjectScope, *, status: str | None = None, limit: int = 100
    ) -> list[ProposalRow]:
        conditions = [models.EntityMergeProposal.project_id == _pid(scope)]
        if status is not None:
            conditions.append(models.EntityMergeProposal.status == status)
        async with self._sm() as session:
            rows = await session.scalars(
                select(models.EntityMergeProposal)
                .where(*conditions)
                .order_by(models.EntityMergeProposal.created_at.desc())
                .limit(limit)
            )
            return [self._to_proposal(r) for r in rows]

    async def set_proposal_status(
        self, scope: ProjectScope, proposal_id: str, *, status: str, resolved_by: str | None
    ) -> None:
        async with session_scope(self._sm) as session:
            await session.execute(
                update(models.EntityMergeProposal)
                .where(
                    models.EntityMergeProposal.id == uuid.UUID(proposal_id),
                    models.EntityMergeProposal.project_id == _pid(scope),
                )
                .values(status=status, resolved_by=resolved_by, resolved_at=_now())
            )

    async def apply_merge(
        self, scope: ProjectScope, *, canonical_id: str, duplicate_id: str, confidence: float
    ) -> MergeResult:
        """One transaction: move the duplicate's aliases onto the canonical entity, record the
        duplicate's name as a canonical alias, and tombstone the duplicate (``merged_into``).
        Refuses a cross-project merge. Idempotent: a second call for an already-merged duplicate
        just returns the result without further mutation."""
        async with session_scope(self._sm) as session:
            canonical = await session.get(models.Entity, uuid.UUID(canonical_id))
            duplicate = await session.get(models.Entity, uuid.UUID(duplicate_id))
            if canonical is None or duplicate is None:
                raise LookupError("entity not found")
            pid = _pid(scope)
            if canonical.project_id != pid or duplicate.project_id != pid:
                raise CrossProjectMergeError("cannot merge entities across projects")

            existing_aliases = set(
                (
                    await session.scalars(
                        select(models.EntityAlias.alias).where(
                            models.EntityAlias.project_id == pid,
                            models.EntityAlias.entity_id == canonical.id,
                        )
                    )
                ).all()
            )
            moved = 0
            if duplicate.merged_into is None:
                dup_aliases = (
                    await session.scalars(
                        select(models.EntityAlias).where(
                            models.EntityAlias.project_id == pid,
                            models.EntityAlias.entity_id == duplicate.id,
                        )
                    )
                ).all()
                for alias_row in dup_aliases:
                    if alias_row.alias in existing_aliases:
                        await session.delete(alias_row)  # canonical already has it → drop the dup
                    else:
                        alias_row.entity_id = canonical.id
                        existing_aliases.add(alias_row.alias)
                        moved += 1
                if duplicate.name not in existing_aliases:
                    session.add(
                        models.EntityAlias(
                            project_id=pid,
                            entity_id=canonical.id,
                            alias=duplicate.name,
                            confidence=confidence,
                            approved=True,
                        )
                    )
                duplicate.merged_into = canonical.id
            return MergeResult(
                canonical_id=canonical_id,
                duplicate_id=duplicate_id,
                canonical_name=canonical.name,
                canonical_type=canonical.type,
                duplicate_name=duplicate.name,
                moved_aliases=moved,
            )

    async def unmerge(self, scope: ProjectScope, duplicate_id: str) -> None:
        """Clear the ``merged_into`` tombstone (used by reject-after-apply / tests)."""
        async with session_scope(self._sm) as session:
            await session.execute(
                update(models.Entity)
                .where(
                    models.Entity.id == uuid.UUID(duplicate_id),
                    models.Entity.project_id == _pid(scope),
                )
                .values(merged_into=None)
            )

    async def aliases_of(self, scope: ProjectScope, entity_id: str) -> list[str]:
        async with self._sm() as session:
            rows = await session.scalars(
                select(models.EntityAlias.alias).where(
                    models.EntityAlias.project_id == _pid(scope),
                    models.EntityAlias.entity_id == uuid.UUID(entity_id),
                )
            )
            return list(rows)

    @staticmethod
    def _to_proposal(row: models.EntityMergeProposal) -> ProposalRow:
        return ProposalRow(
            id=str(row.id),
            canonical_entity_id=str(row.canonical_entity_id),
            duplicate_entity_id=str(row.duplicate_entity_id),
            confidence=float(row.confidence),
            method=row.method,
            status=row.status,
            reason=row.reason,
        )
