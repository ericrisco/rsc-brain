"""Skill persistence (SPEC-20, FR-7.1/7.2) — project-scoped CRUD + graph-sync staleness.

Every method takes a ``ProjectScope`` and filters by ``scope.project_id`` in-query (FR-12.2). Only
``active`` skills are ever exposed by MCP; visibility follows the same tag rules as the rest of the
knowledge (FR-4.14). A knowledge mutation that touches an entity/topic a skill ``depends_on`` marks
that skill ``stale`` (a flag, not an archive — it stays servable).
"""

from __future__ import annotations

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
from rsc_brain.visibility import fully_authorized_topic_clause


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
    okf_type: str
    okf_extensions: dict[str, object]

    def frontmatter(self) -> SkillFrontmatter:
        return SkillFrontmatter(
            concept_type=self.okf_type,
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
            extensions=self.okf_extensions,
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


class SkillOwnerNotFound(Exception):
    """The owner identifier is absent, ambiguous or belongs to another project.

    Those cases deliberately share one exception and message: a caller in project A must not learn
    that a supplied UUID or name is a real Person in project B.
    """

    def __init__(self) -> None:
        super().__init__("owner not found")


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
        okf_type=skill.okf_type,
        okf_extensions=dict(skill.okf_extensions),
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
            owner_identifier = owner_person_id or frontmatter.owner
            owner_id = await self._resolve_owner(session, scope, owner_identifier)
            skill = models.Skill(
                project_id=_pid(scope),
                slug=frontmatter.slug,
                title=frontmatter.title,
                description=frontmatter.description,
                when_to_use=frontmatter.when_to_use,
                when_not=frontmatter.when_not,
                tags=list(frontmatter.tags),
                state=frontmatter.state,
                owner_person_id=owner_id,
                depends_on=[uuid.UUID(d) for d in frontmatter.depends_on],
                body=body,
                version=frontmatter.version,
                okf_type=frontmatter.concept_type,
                okf_extensions=frontmatter.extensions,
            )
            session.add(skill)
            await session.flush()
            session.add(
                self._audit_row(
                    scope,
                    "skill_create",
                    str(uuid.uuid4()),
                    skill,
                )
            )
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
        """List console inventory rows only when every carried topic is authorized.

        Unlike ``list_all`` (an internal management primitive), this is safe to expose as a read
        model.  Unlike ``list_visible`` (the active-only execution catalogue), it preserves the
        caller's optional lifecycle-state filter.
        """
        query = (
            select(models.Skill)
            .where(
                models.Skill.project_id == _pid(scope),
                fully_authorized_topic_clause(models.Skill.tags, scope),
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
    ) -> SkillRow:
        async with session_scope(self._sm) as session:
            skill = await session.scalar(
                select(models.Skill)
                .where(models.Skill.project_id == _pid(scope), models.Skill.slug == slug)
                .with_for_update()
            )
            if skill is None:
                raise SkillNotFound
            if frontmatter.slug != slug or skill.version != frontmatter.version:
                raise SkillVersionConflict
            owner_id = await self._resolve_owner(session, scope, frontmatter.owner)
            was_stale = skill.stale
            skill.title = frontmatter.title
            skill.description = frontmatter.description
            skill.when_to_use = frontmatter.when_to_use
            skill.when_not = frontmatter.when_not
            skill.tags = list(frontmatter.tags)
            skill.owner_person_id = owner_id
            skill.depends_on = [uuid.UUID(d) for d in frontmatter.depends_on]
            skill.body = body
            skill.okf_type = frontmatter.concept_type
            skill.okf_extensions = frontmatter.extensions
            skill.stale = False  # editing is the owner's review/resolution
            skill.stale_reason = None
            skill.stale_at = None
            skill.version += 1
            await self._cancel_pending(session, skill)
            correlation = str(uuid.uuid4())
            session.add(self._audit_row(scope, "skill_update", correlation, skill))
            if was_stale:
                session.add(self._audit_row(scope, "skill_stale_resolved", correlation, skill))
            await session.flush()
            return _row(skill)

    async def set_state(self, scope: ProjectScope, slug: str, state: str) -> None:
        async with session_scope(self._sm) as session:
            skill = await session.scalar(
                select(models.Skill)
                .where(models.Skill.project_id == _pid(scope), models.Skill.slug == slug)
                .with_for_update()
            )
            if skill is None:
                raise SkillNotFound
            if skill.state == state:
                return
            skill.state = state
            skill.version += 1
            if state == "archived":
                await self._cancel_pending(session, skill)
            session.add(self._audit_row(scope, f"skill_{state}", str(uuid.uuid4()), skill))

    async def validate(
        self,
        scope: ProjectScope,
        slug: str,
        *,
        expected_version: int,
        idempotency_key: str,
    ) -> SkillTransition:
        """Validate once; same-key retries return the persisted transition after restarts."""
        correlation = self._command_correlation(
            scope, action="validate", slug=slug, idempotency_key=idempotency_key
        )
        lock_key = self._advisory_key(correlation)
        async with session_scope(self._sm) as session:
            await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": lock_key})
            prior = await session.scalar(
                select(models.AuditLog.id).where(
                    models.AuditLog.project_id == _pid(scope),
                    models.AuditLog.principal_id == scope.principal_id,
                    models.AuditLog.action == "skill_validate",
                    models.AuditLog.trace_id == correlation,
                )
            )
            skill = await session.scalar(
                select(models.Skill)
                .where(
                    models.Skill.project_id == _pid(scope),
                    models.Skill.slug == slug,
                    fully_authorized_topic_clause(models.Skill.tags, scope),
                )
                .with_for_update()
            )
            if skill is None:
                raise SkillNotFound
            if prior is not None:
                return SkillTransition(
                    skill=_row(skill), audit_correlation=correlation, replayed=True
                )
            if skill.version != expected_version or skill.state != "proposed":
                raise SkillVersionConflict
            if not await self._dependencies_exist(session, scope, skill.depends_on):
                raise SkillValidationConflict
            skill.state = "active"
            was_stale = skill.stale
            skill.stale = False
            skill.stale_reason = None
            skill.stale_at = None
            skill.version += 1
            session.add(self._audit_row(scope, "skill_validate", correlation, skill))
            if was_stale:
                await self._cancel_pending(session, skill)
                session.add(self._audit_row(scope, "skill_stale_resolved", correlation, skill))
            await session.flush()
            return SkillTransition(skill=_row(skill), audit_correlation=correlation)

    async def archive(
        self,
        scope: ProjectScope,
        slug: str,
        *,
        expected_version: int,
        idempotency_key: str,
        authorize_topics: bool = True,
    ) -> SkillTransition:
        """Archive once; same-key retries return the persisted outcome across app restarts."""
        correlation = self._command_correlation(
            scope, action="archive", slug=slug, idempotency_key=idempotency_key
        )
        lock_key = self._advisory_key(correlation)
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
            conditions = [
                models.Skill.project_id == _pid(scope),
                models.Skill.slug == slug,
            ]
            if authorize_topics:
                conditions.append(fully_authorized_topic_clause(models.Skill.tags, scope))
            skill = await session.scalar(select(models.Skill).where(*conditions).with_for_update())
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
            await self._cancel_pending(session, skill)
            session.add(self._audit_row(scope, "skill_archive", correlation, skill))
            await session.flush()
            return SkillTransition(skill=_row(skill), audit_correlation=correlation)

    @staticmethod
    def _command_correlation(
        scope: ProjectScope, *, action: str, slug: str, idempotency_key: str
    ) -> str:
        return str(
            uuid.uuid5(
                uuid.UUID(scope.project_id),
                f"skill-{action}:{scope.principal_id}:{slug}:{idempotency_key}",
            )
        )

    @staticmethod
    def _advisory_key(correlation: str) -> int:
        lock_digest = hashlib.sha256(correlation.encode()).digest()
        return int.from_bytes(lock_digest[:8], "big", signed=True)

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
            resource_type="skill",
            resource_id=skill.id,
        )

    async def mark_stale_for(
        self, scope: ProjectScope, touched_ids: Sequence[str], *, reason: str
    ) -> list[str]:
        """Mark every active skill whose ``depends_on`` intersects ``touched_ids`` as stale (once).
        Returns the slugs newly marked (so the caller notifies each owner exactly once, FR-7.2)."""
        touched = [uuid.UUID(i) for i in touched_ids if i]
        if not touched:
            return []
        from rsc_brain.skills.staleness import mark_dependencies_stale_in_session

        async with session_scope(self._sm) as session:
            return await mark_dependencies_stale_in_session(session, scope, touched, reason=reason)

    @staticmethod
    async def _resolve_owner(
        session: AsyncSession, scope: ProjectScope, identifier: str | None
    ) -> uuid.UUID | None:
        if identifier is None or not identifier.strip():
            return None
        try:
            parsed = uuid.UUID(identifier)
        except ValueError:
            parsed = None
        query = select(models.Person.id).where(models.Person.project_id == _pid(scope))
        if parsed is not None:
            matches = list(await session.scalars(query.where(models.Person.id == parsed).limit(2)))
        else:
            matches = list(
                await session.scalars(query.where(models.Person.name == identifier).limit(2))
            )
        if len(matches) != 1:
            raise SkillOwnerNotFound
        return matches[0]

    @staticmethod
    async def _cancel_pending(session: AsyncSession, skill: models.Skill) -> None:
        await session.execute(
            update(models.SkillStaleNotification)
            .where(
                models.SkillStaleNotification.project_id == skill.project_id,
                models.SkillStaleNotification.skill_id == skill.id,
                models.SkillStaleNotification.state == "pending",
            )
            .values(state="cancelled")
        )
