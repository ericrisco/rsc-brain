"""Project-scoped entity + alias-merge persistence (SPEC-09, FR-1.9 P1).

The proposal queue (`entity_merge_proposals`) and the merge itself are both filtered by
``scope.project_id`` in-query, and :meth:`EntityStore.apply_merge` refuses to merge two entities
unless both belong to the same project (FR-12.4) — a merge can never cross a project boundary.
A merged duplicate is tombstoned via ``entities.merged_into`` (kept, never deleted) so the action
stays reversible + auditable.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field

from sqlalchemy import and_, delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import aliased

from rsc_brain.review.states import PROPOSAL_OPEN
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import maybe_session_scope, session_scope


def _pid(scope: ProjectScope) -> uuid.UUID:
    return uuid.UUID(scope.project_id)


class CrossProjectMergeError(ValueError):
    """Raised if a merge is attempted across entities of different projects (FR-12.4)."""


class MergeInvariantError(ValueError):
    """A pair cannot enter the merge lifecycle without loss or tenant safety."""


class MergeReversalConflictError(RuntimeError):
    """Reversal would overwrite state written after the merge."""


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


@dataclass(frozen=True, slots=True)
class AliasState:
    id: str
    entity_id: str
    alias: str
    confidence: float | None
    approved: bool

    def as_json(self) -> dict[str, object]:
        return {
            "id": self.id,
            "entity_id": self.entity_id,
            "alias": self.alias,
            "confidence": self.confidence,
            "approved": self.approved,
        }

    @classmethod
    def from_json(cls, value: dict[str, object]) -> AliasState:
        confidence = value.get("confidence")
        return cls(
            id=str(value["id"]),
            entity_id=str(value["entity_id"]),
            alias=str(value["alias"]),
            confidence=(float(confidence) if isinstance(confidence, (int, float, str)) else None),
            approved=bool(value["approved"]),
        )


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

    async def active_entities_by_ids(
        self, scope: ProjectScope, entity_ids: Sequence[str]
    ) -> list[EntityRow]:
        """Return only live, project-owned members of ``entity_ids`` with their aliases."""
        ids = [uuid.UUID(value) for value in dict.fromkeys(entity_ids)]
        if not ids:
            return []
        async with self._sm() as session:
            entities = list(
                (
                    await session.scalars(
                        select(models.Entity)
                        .where(
                            models.Entity.project_id == _pid(scope),
                            models.Entity.id.in_(ids),
                            models.Entity.merged_into.is_(None),
                        )
                        .order_by(models.Entity.id)
                    )
                ).all()
            )
            aliases_by_entity: dict[str, list[str]] = {}
            alias_rows = await session.execute(
                select(models.EntityAlias.entity_id, models.EntityAlias.alias).where(
                    models.EntityAlias.project_id == _pid(scope),
                    models.EntityAlias.entity_id.in_(ids),
                )
            )
            for entity_id, alias in alias_rows:
                aliases_by_entity.setdefault(str(entity_id), []).append(alias)
        return [
            EntityRow(
                id=str(entity.id),
                name=entity.name,
                normalized_name=entity.normalized_name,
                type=entity.type,
                aliases=tuple(aliases_by_entity.get(str(entity.id), ())),
            )
            for entity in entities
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
        """Validate then insert one open proposal; invalid pairs never become observable."""
        if status != PROPOSAL_OPEN:
            raise MergeInvariantError("every merge proposal must start in needs_review")
        if canonical_id == duplicate_id:
            raise MergeInvariantError("merge entities must be distinct")
        async with session_scope(self._sm) as session:
            existing = await self._existing_proposal_id(
                scope,
                canonical_id=canonical_id,
                duplicate_id=duplicate_id,
                session=session,
            )
            if existing is not None:
                return str(existing), False
            try:
                await self.validate_pair(
                    scope,
                    canonical_id=canonical_id,
                    duplicate_id=duplicate_id,
                    session=session,
                )
            except MergeInvariantError:
                existing = await self._existing_proposal_id(
                    scope,
                    canonical_id=canonical_id,
                    duplicate_id=duplicate_id,
                    session=session,
                )
                if existing is not None:
                    return str(existing), False
                raise
            statement = (
                pg_insert(models.EntityMergeProposal)
                .values(
                    project_id=_pid(scope),
                    canonical_entity_id=uuid.UUID(canonical_id),
                    duplicate_entity_id=uuid.UUID(duplicate_id),
                    confidence=confidence,
                    method=method,
                    status=status,
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
            existing = await self._existing_proposal_id(
                scope,
                canonical_id=canonical_id,
                duplicate_id=duplicate_id,
                session=session,
            )
            if existing is None:
                raise RuntimeError("proposal insert conflicted without an observable matching row")
            return str(existing), False

    async def _existing_proposal_id(
        self,
        scope: ProjectScope,
        *,
        canonical_id: str,
        duplicate_id: str,
        session: AsyncSession,
    ) -> uuid.UUID | None:
        canonical = aliased(models.Entity)
        duplicate = aliased(models.Entity)
        existing: uuid.UUID | None = await session.scalar(
            select(models.EntityMergeProposal.id)
            .join(
                canonical,
                and_(
                    canonical.project_id == models.EntityMergeProposal.project_id,
                    canonical.id == models.EntityMergeProposal.canonical_entity_id,
                ),
            )
            .join(
                duplicate,
                and_(
                    duplicate.project_id == models.EntityMergeProposal.project_id,
                    duplicate.id == models.EntityMergeProposal.duplicate_entity_id,
                ),
            )
            .where(
                models.EntityMergeProposal.project_id == _pid(scope),
                models.EntityMergeProposal.canonical_entity_id == uuid.UUID(canonical_id),
                models.EntityMergeProposal.duplicate_entity_id == uuid.UUID(duplicate_id),
                canonical.type == duplicate.type,
            )
        )
        return existing

    async def get_proposal(self, scope: ProjectScope, proposal_id: str) -> ProposalRow | None:
        canonical = aliased(models.Entity)
        duplicate = aliased(models.Entity)
        async with self._sm() as session:
            row = await session.scalar(
                select(models.EntityMergeProposal)
                .join(
                    canonical,
                    and_(
                        canonical.project_id == models.EntityMergeProposal.project_id,
                        canonical.id == models.EntityMergeProposal.canonical_entity_id,
                    ),
                )
                .join(
                    duplicate,
                    and_(
                        duplicate.project_id == models.EntityMergeProposal.project_id,
                        duplicate.id == models.EntityMergeProposal.duplicate_entity_id,
                    ),
                )
                .where(
                    models.EntityMergeProposal.id == uuid.UUID(proposal_id),
                    models.EntityMergeProposal.project_id == _pid(scope),
                    canonical.type == duplicate.type,
                )
            )
            if row is None:
                return None
            return self._to_proposal(row)

    async def list_proposals(
        self, scope: ProjectScope, *, status: str | None = None, limit: int = 100
    ) -> list[ProposalRow]:
        conditions = [models.EntityMergeProposal.project_id == _pid(scope)]
        if status is not None:
            conditions.append(models.EntityMergeProposal.status == status)
        canonical = aliased(models.Entity)
        duplicate = aliased(models.Entity)
        async with self._sm() as session:
            rows = await session.scalars(
                select(models.EntityMergeProposal)
                .join(
                    canonical,
                    and_(
                        canonical.project_id == models.EntityMergeProposal.project_id,
                        canonical.id == models.EntityMergeProposal.canonical_entity_id,
                    ),
                )
                .join(
                    duplicate,
                    and_(
                        duplicate.project_id == models.EntityMergeProposal.project_id,
                        duplicate.id == models.EntityMergeProposal.duplicate_entity_id,
                    ),
                )
                .where(*conditions)
                .where(canonical.type == duplicate.type)
                .order_by(models.EntityMergeProposal.created_at.desc())
                .limit(limit)
            )
            return [self._to_proposal(r) for r in rows]

    async def apply_merge(
        self,
        scope: ProjectScope,
        *,
        canonical_id: str,
        duplicate_id: str,
        confidence: float,
        session: AsyncSession | None = None,
    ) -> MergeResult:
        """Low-level relational half of the service-owned atomic merge.

        Move aliases, add the duplicate name, and tombstone the duplicate. The pair is locked and
        revalidated here even when proposal creation already validated it; stale state between those
        moments must fail before mutation.

        R35: takes an optional ``session`` so the relational merge and the GRAPH merge commit together.
        Separately, a failure between them left an entity tombstoned as merged while its graph identity
        never was — and the proposal still open, so a curator was asked to decide it again.
        """
        async with maybe_session_scope(self._sm, session) as session:
            canonical, duplicate = await self.validate_pair(
                scope,
                canonical_id=canonical_id,
                duplicate_id=duplicate_id,
                session=session,
                lock=True,
            )
            pid = _pid(scope)

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
            await session.flush()
            return MergeResult(
                canonical_id=canonical_id,
                duplicate_id=duplicate_id,
                canonical_name=canonical.name,
                canonical_type=canonical.type,
                duplicate_name=duplicate.name,
                moved_aliases=moved,
            )

    async def unmerge(self, scope: ProjectScope, duplicate_id: str) -> None:
        """Unsafe legacy seam: reversal needs the snapshot-owning service, never one column."""
        del scope, duplicate_id
        raise MergeReversalConflictError("use EntityMergeService.reverse for a complete reversal")

    async def validate_pair(
        self,
        scope: ProjectScope,
        *,
        canonical_id: str,
        duplicate_id: str,
        session: AsyncSession,
        lock: bool = False,
    ) -> tuple[models.Entity, models.Entity]:
        if canonical_id == duplicate_id:
            raise MergeInvariantError("merge entities must be distinct")
        ids = sorted((uuid.UUID(canonical_id), uuid.UUID(duplicate_id)), key=str)
        statement = (
            select(models.Entity).where(models.Entity.id.in_(ids)).order_by(models.Entity.id)
        )
        if lock:
            statement = statement.with_for_update()
        rows = list((await session.scalars(statement)).all())
        if len(rows) != 2:
            raise LookupError("entity not found")
        by_id = {row.id: row for row in rows}
        canonical = by_id[uuid.UUID(canonical_id)]
        duplicate = by_id[uuid.UUID(duplicate_id)]
        pid = _pid(scope)
        if canonical.project_id != pid or duplicate.project_id != pid:
            raise CrossProjectMergeError("cannot merge entities across projects")
        if canonical.type != duplicate.type:
            raise MergeInvariantError("merge entities must have the same type")
        if canonical.merged_into is not None:
            raise MergeInvariantError("canonical entity is no longer active")
        if duplicate.merged_into is not None:
            raise MergeInvariantError("duplicate entity is no longer active")
        return canonical, duplicate

    async def alias_states(
        self, scope: ProjectScope, entity_ids: Sequence[str], *, session: AsyncSession
    ) -> tuple[AliasState, ...]:
        ids = [uuid.UUID(value) for value in entity_ids]
        rows = (
            await session.scalars(
                select(models.EntityAlias)
                .where(
                    models.EntityAlias.project_id == _pid(scope),
                    models.EntityAlias.entity_id.in_(ids),
                )
                .order_by(models.EntityAlias.id)
            )
        ).all()
        return tuple(
            AliasState(
                id=str(row.id),
                entity_id=str(row.entity_id),
                alias=row.alias,
                confidence=float(row.confidence) if row.confidence is not None else None,
                approved=bool(row.approved),
            )
            for row in rows
        )

    async def restore_alias_states(
        self,
        scope: ProjectScope,
        *,
        canonical_id: str,
        duplicate_id: str,
        before: Sequence[AliasState],
        expected_after: Sequence[AliasState],
        session: AsyncSession,
    ) -> None:
        canonical, duplicate = await self.locked_applied_pair(
            scope,
            canonical_id=canonical_id,
            duplicate_id=duplicate_id,
            session=session,
        )
        current = await self.alias_states(scope, (canonical_id, duplicate_id), session=session)
        if current != tuple(expected_after):
            raise MergeReversalConflictError("aliases changed after merge")
        await session.execute(
            delete(models.EntityAlias).where(
                models.EntityAlias.project_id == _pid(scope),
                models.EntityAlias.entity_id.in_((canonical.id, duplicate.id)),
            )
        )
        await session.flush()
        for state in before:
            session.add(
                models.EntityAlias(
                    id=uuid.UUID(state.id),
                    project_id=_pid(scope),
                    entity_id=uuid.UUID(state.entity_id),
                    alias=state.alias,
                    confidence=state.confidence,
                    approved=state.approved,
                )
            )
        duplicate.merged_into = None
        await session.flush()

    async def locked_applied_pair(
        self,
        scope: ProjectScope,
        *,
        canonical_id: str,
        duplicate_id: str,
        session: AsyncSession,
    ) -> tuple[models.Entity, models.Entity]:
        ids = sorted((uuid.UUID(canonical_id), uuid.UUID(duplicate_id)), key=str)
        rows = list(
            (
                await session.scalars(
                    select(models.Entity)
                    .where(models.Entity.id.in_(ids))
                    .order_by(models.Entity.id)
                    .with_for_update()
                )
            ).all()
        )
        if len(rows) != 2:
            raise LookupError("entity not found")
        by_id = {row.id: row for row in rows}
        canonical = by_id[uuid.UUID(canonical_id)]
        duplicate = by_id[uuid.UUID(duplicate_id)]
        if canonical.project_id != _pid(scope) or duplicate.project_id != _pid(scope):
            raise CrossProjectMergeError("cannot merge entities across projects")
        if canonical.type != duplicate.type:
            raise MergeReversalConflictError("entity type changed after merge")
        if canonical.merged_into is not None:
            raise MergeReversalConflictError("canonical entity changed after merge")
        if duplicate.merged_into != canonical.id:
            raise MergeReversalConflictError("entity merge state changed after merge")
        return canonical, duplicate

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
