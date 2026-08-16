"""Skill persistence (SPEC-20, FR-7.1/7.2) — project-scoped CRUD + graph-sync staleness.

Every method takes a ``ProjectScope`` and filters by ``scope.project_id`` in-query (FR-12.2). Only
``active`` skills are ever exposed by MCP; visibility follows the same tag rules as the rest of the
knowledge (FR-4.14). A knowledge mutation that touches an entity/topic a skill ``depends_on`` marks
that skill ``stale`` (a flag, not an archive — it stays servable).
"""

from __future__ import annotations

import datetime as dt
import hashlib
import uuid
from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.scope import ProjectScope
from rsc_brain.skills.frontmatter import SkillFrontmatter
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope
from rsc_brain.visibility import forbidden_topics, topic_clause


def _pid(scope: ProjectScope) -> uuid.UUID:
    return uuid.UUID(scope.project_id)


@dataclass(frozen=True, slots=True)
class SkillRow:
    id: str
    slug: str
    title: str
    description: str | None
    when_to_use: str | None
    when_not: str | None
    tags: tuple[str, ...]
    state: str
    owner_person_id: str | None
    depends_on: tuple[str, ...]
    body: str | None
    stale: bool
    version: int

    def frontmatter(self) -> SkillFrontmatter:
        return SkillFrontmatter(
            slug=self.slug,
            title=self.title,
            description=self.description,
            when_to_use=self.when_to_use,
            when_not=self.when_not,
            tags=list(self.tags),
            owner=self.owner_person_id,
            depends_on=list(self.depends_on),
            state=self.state,
            version=self.version,
        )


@dataclass(frozen=True, slots=True)
class SkillTransition:
    skill: SkillRow
    audit_correlation: str
    replayed: bool = False


class SkillNotFound(Exception):
    """The named skill is absent in the caller's project."""


class SkillVersionConflict(Exception):
    """The expected skill version is no longer current."""


class SkillValidationConflict(Exception):
    """A proposed skill cannot become active because its dependencies are invalid."""


def _row(skill: models.Skill) -> SkillRow:
    return SkillRow(
        id=str(skill.id),
        slug=skill.slug,
        title=skill.title,
        description=skill.description,
        when_to_use=skill.when_to_use,
        when_not=skill.when_not,
        tags=tuple(skill.tags),
        state=skill.state,
        owner_person_id=str(skill.owner_person_id) if skill.owner_person_id else None,
        depends_on=tuple(str(d) for d in skill.depends_on),
        body=skill.body,
        stale=skill.stale,
        version=skill.version,
    )


class SkillStore:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sm = sessionmaker

    async def create(
        self,
        scope: ProjectScope,
        frontmatter: SkillFrontmatter,
        body: str,
        *,
        owner_person_id: str | None = None,
    ) -> str:
        async with session_scope(self._sm) as session:
            skill = models.Skill(
                project_id=_pid(scope),
                slug=frontmatter.slug,
                title=frontmatter.title,
                description=frontmatter.description,
                when_to_use=frontmatter.when_to_use,
                when_not=frontmatter.when_not,
                tags=list(frontmatter.tags),
                state=frontmatter.state,
                owner_person_id=uuid.UUID(owner_person_id) if owner_person_id else None,
                depends_on=[uuid.UUID(d) for d in frontmatter.depends_on],
                body=body,
                version=frontmatter.version,
            )
            session.add(skill)
            await session.flush()
            return str(skill.id)

    async def get(self, scope: ProjectScope, slug: str) -> SkillRow | None:
        async with self._sm() as session:
            skill = await session.scalar(
                select(models.Skill).where(
                    models.Skill.project_id == _pid(scope), models.Skill.slug == slug
                )
            )
            return _row(skill) if skill is not None else None

    async def list_all(self, scope: ProjectScope, *, state: str | None = None) -> list[SkillRow]:
        query = (
            select(models.Skill)
            .where(models.Skill.project_id == _pid(scope))
            .order_by(models.Skill.slug)
        )
        if state is not None:
            query = query.where(models.Skill.state == state)
        async with self._sm() as session:
            return [_row(s) for s in await session.scalars(query)]

    async def list_authorized(
        self, scope: ProjectScope, *, state: str | None = None
    ) -> list[SkillRow]:
        """All lifecycle states visible under the caller's complete topic authority."""
        forbidden = await forbidden_topics(self._sm, scope)
        query = (
            select(models.Skill)
            .where(
                models.Skill.project_id == _pid(scope),
                topic_clause(models.Skill.tags, scope, forbidden),
            )
            .order_by(models.Skill.slug)
        )
        if state is not None:
            query = query.where(models.Skill.state == state)
        async with self._sm() as session:
            return [_row(skill) for skill in await session.scalars(query)]

    async def list_visible(self, scope: ProjectScope, forbidden: frozenset[str]) -> list[SkillRow]:
        """Active skills whose tag-set the caller may see (FR-4.14): overlaps ``allowed_topics`` and
        carries no forbidden sensitive tag the caller doesn't own."""
        allowed = sorted(scope.allowed_topics)
        forbidden_here = sorted(forbidden - scope.allowed_topics)
        query = (
            select(models.Skill)
            .where(
                models.Skill.project_id == _pid(scope),
                models.Skill.state == "active",
                models.Skill.tags.op("&&")(allowed),
            )
            .order_by(models.Skill.slug)
        )
        if forbidden_here:
            query = query.where(~models.Skill.tags.op("&&")(forbidden_here))
        async with self._sm() as session:
            return [_row(s) for s in await session.scalars(query)]

    async def update(
        self, scope: ProjectScope, slug: str, frontmatter: SkillFrontmatter, body: str
    ) -> None:
        async with session_scope(self._sm) as session:
            await session.execute(
                update(models.Skill)
                .where(models.Skill.project_id == _pid(scope), models.Skill.slug == slug)
                .values(
                    title=frontmatter.title,
                    description=frontmatter.description,
                    when_to_use=frontmatter.when_to_use,
                    when_not=frontmatter.when_not,
                    tags=list(frontmatter.tags),
                    depends_on=[uuid.UUID(d) for d in frontmatter.depends_on],
                    body=body,
                    stale=False,  # editing resolves staleness (the owner reviewed it)
                    stale_reason=None,
                    stale_at=None,
                    version=models.Skill.version + 1,
                )
            )

    async def set_state(self, scope: ProjectScope, slug: str, state: str) -> None:
        async with session_scope(self._sm) as session:
            await session.execute(
                update(models.Skill)
                .where(models.Skill.project_id == _pid(scope), models.Skill.slug == slug)
                .values(state=state)
            )

    async def validate(
        self, scope: ProjectScope, slug: str, *, expected_version: int
    ) -> SkillTransition:
        """Validate dependencies and atomically promote one proposed skill to active."""
        correlation = str(uuid.uuid4())
        forbidden = await forbidden_topics(self._sm, scope)
        async with session_scope(self._sm) as session:
            skill = await session.scalar(
                select(models.Skill)
                .where(
                    models.Skill.project_id == _pid(scope),
                    models.Skill.slug == slug,
                    topic_clause(models.Skill.tags, scope, forbidden),
                )
                .with_for_update()
            )
            if skill is None:
                raise SkillNotFound
            if skill.version != expected_version or skill.state != "proposed":
                raise SkillVersionConflict
            if not await self._dependencies_exist(session, scope, skill.depends_on):
                raise SkillValidationConflict
            skill.state = "active"
            skill.stale = False
            skill.stale_reason = None
            skill.stale_at = None
            skill.version += 1
            session.add(self._audit_row(scope, "skill_validate", correlation, skill))
            await session.flush()
            return SkillTransition(skill=_row(skill), audit_correlation=correlation)

    async def archive(
        self,
        scope: ProjectScope,
        slug: str,
        *,
        expected_version: int,
        idempotency_key: str,
    ) -> SkillTransition:
        """Archive once; same-key retries return the persisted outcome across app restarts."""
        correlation = str(
            uuid.uuid5(
                uuid.UUID(scope.project_id),
                f"skill-archive:{scope.principal_id}:{slug}:{idempotency_key}",
            )
        )
        lock_digest = hashlib.sha256(correlation.encode()).digest()
        lock_key = int.from_bytes(lock_digest[:8], "big", signed=True)
        forbidden = await forbidden_topics(self._sm, scope)
        async with session_scope(self._sm) as session:
            await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": lock_key})
            prior = await session.scalar(
                select(models.AuditLog.id).where(
                    models.AuditLog.project_id == _pid(scope),
                    models.AuditLog.principal_id == scope.principal_id,
                    models.AuditLog.action == "skill_archive",
                    models.AuditLog.trace_id == correlation,
                )
            )
            skill = await session.scalar(
                select(models.Skill)
                .where(
                    models.Skill.project_id == _pid(scope),
                    models.Skill.slug == slug,
                    topic_clause(models.Skill.tags, scope, forbidden),
                )
                .with_for_update()
            )
            if skill is None:
                raise SkillNotFound
            if prior is not None:
                return SkillTransition(
                    skill=_row(skill), audit_correlation=correlation, replayed=True
                )
            if skill.version != expected_version or skill.state == "archived":
                raise SkillVersionConflict
            skill.state = "archived"
            skill.version += 1
            session.add(self._audit_row(scope, "skill_archive", correlation, skill))
            await session.flush()
            return SkillTransition(skill=_row(skill), audit_correlation=correlation)

    @staticmethod
    async def _dependencies_exist(
        session: AsyncSession, scope: ProjectScope, dependencies: Sequence[uuid.UUID]
    ) -> bool:
        wanted = set(dependencies)
        if not wanted:
            return True
        topic_ids = set(
            await session.scalars(
                select(models.Topic.id).where(
                    models.Topic.project_id == _pid(scope), models.Topic.id.in_(wanted)
                )
            )
        )
        entity_ids = set(
            await session.scalars(
                select(models.Entity.id).where(
                    models.Entity.project_id == _pid(scope), models.Entity.id.in_(wanted)
                )
            )
        )
        return wanted <= topic_ids | entity_ids

    @staticmethod
    def _audit_row(
        scope: ProjectScope, action: str, correlation: str, skill: models.Skill
    ) -> models.AuditLog:
        try:
            user_id = uuid.UUID(scope.principal_id)
        except ValueError:
            user_id = None
        return models.AuditLog(
            project_id=_pid(scope),
            user_id=user_id,
            principal_type=scope.principal_type.value,
            principal_id=scope.principal_id,
            on_behalf_of=scope.on_behalf_of,
            trace_id=correlation,
            action=action,
            tool="console",
            topics_used=list(skill.tags),
            result_count=skill.version,
            denied=False,
        )

    async def mark_stale_for(
        self, scope: ProjectScope, touched_ids: Sequence[str], *, reason: str
    ) -> list[str]:
        """Mark every active skill whose ``depends_on`` intersects ``touched_ids`` as stale (once).
        Returns the slugs newly marked (so the caller notifies each owner exactly once, FR-7.2)."""
        touched = [uuid.UUID(i) for i in touched_ids if i]
        if not touched:
            return []
        async with session_scope(self._sm) as session:
            candidates = await session.scalars(
                select(models.Skill).where(
                    models.Skill.project_id == _pid(scope),
                    models.Skill.state == "active",
                    models.Skill.stale.is_(False),
                    models.Skill.depends_on.op("&&")(touched),
                )
            )
            newly: list[str] = []
            now = dt.datetime.now(dt.UTC)
            for skill in candidates:
                skill.stale = True
                skill.stale_reason = reason
                skill.stale_at = now
                newly.append(skill.slug)
            return newly
