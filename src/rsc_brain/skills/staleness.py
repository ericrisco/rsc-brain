"""Transactional skill-staleness outbox and durable owner delivery (AUDIT-018)."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable, Collection, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.hunting.channels import Channel, NullChannel, OutboundMessage
from rsc_brain.hunting.directory import PersonRow
from rsc_brain.hunting.quiet_hours import in_quiet_hours, next_allowed_at
from rsc_brain.ingest.entity_resolution import entity_id, normalize_name
from rsc_brain.scope import ProjectScope
from rsc_brain.skills.store import SkillStore
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope

_UNAVAILABLE_RETRY = dt.timedelta(minutes=15)
_MAX_BATCH = 100


def _pid(scope: ProjectScope) -> uuid.UUID:
    return uuid.UUID(scope.project_id)


async def mark_dependencies_stale_in_session(
    session: AsyncSession,
    scope: ProjectScope,
    dependency_ids: Collection[uuid.UUID],
    *,
    reason: str,
) -> list[str]:
    """Atomically flip intersecting active skills and enqueue one row per new transition."""
    touched = list(dict.fromkeys(dependency_ids))
    if not touched:
        return []
    candidates = (
        await session.scalars(
            select(models.Skill)
            .where(
                models.Skill.project_id == _pid(scope),
                models.Skill.state == "active",
                models.Skill.stale.is_(False),
                models.Skill.depends_on.op("&&")(touched),
            )
            .order_by(models.Skill.id)
            .with_for_update()
        )
    ).all()
    now = dt.datetime.now(dt.UTC)
    newly: list[str] = []
    for skill in candidates:
        skill.stale = True
        skill.stale_reason = reason
        skill.stale_at = now
        skill.stale_generation += 1
        skill.version += 1
        transition_key = str(uuid.uuid5(skill.id, f"stale-generation:{skill.stale_generation}"))
        if skill.owner_person_id is not None:
            session.add(
                models.SkillStaleNotification(
                    project_id=_pid(scope),
                    skill_id=skill.id,
                    owner_person_id=skill.owner_person_id,
                    generation=skill.stale_generation,
                    idempotency_key=transition_key,
                    state="pending",
                    next_attempt_at=now,
                )
            )
        try:
            user_id = uuid.UUID(scope.principal_id)
        except ValueError:
            user_id = None
        session.add(
            models.AuditLog(
                project_id=_pid(scope),
                user_id=user_id,
                principal_type=scope.principal_type.value,
                principal_id=scope.principal_id,
                on_behalf_of=scope.on_behalf_of,
                trace_id=transition_key,
                action="skill_stale",
                tool="knowledge_mutation",
                topics_used=list(skill.tags),
                result_count=skill.version,
                denied=False,
                resource_type="skill",
                resource_id=skill.id,
            )
        )
        newly.append(skill.slug)
    return newly


async def dependency_ids_for_claims(
    session: AsyncSession, scope: ProjectScope, claim_ids: Sequence[uuid.UUID]
) -> set[uuid.UUID]:
    """Map changed claim tags/endpoints to same-project Topic/Entity row identities."""
    if not claim_ids:
        return set()
    claims = (
        await session.execute(
            select(
                models.Claim.tags,
                models.Claim.subject,
                models.Claim.object,
                models.Claim.subject_entity_key,
                models.Claim.object_entity_key,
            ).where(
                models.Claim.project_id == _pid(scope),
                models.Claim.id.in_(claim_ids),
            )
        )
    ).all()
    tags = {tag for row in claims for tag in row.tags}
    keys = {
        key
        for row in claims
        for key in (row.subject_entity_key, row.object_entity_key)
        if key is not None
    }
    names = {normalize_name(name) for row in claims for name in (row.subject, row.object) if name}
    dependencies = set(
        await session.scalars(
            select(models.Topic.id).where(
                models.Topic.project_id == _pid(scope), models.Topic.slug.in_(tags)
            )
        )
    )
    if keys and names:
        entities = (
            await session.scalars(
                select(models.Entity).where(
                    models.Entity.project_id == _pid(scope),
                    models.Entity.normalized_name.in_(names),
                )
            )
        ).all()
        dependencies.update(row.id for row in entities if entity_id(row.type, row.name) in keys)
    return dependencies


async def mark_claims_stale_in_session(
    session: AsyncSession,
    scope: ProjectScope,
    claim_ids: Sequence[uuid.UUID],
    *,
    reason: str,
) -> list[str]:
    dependencies = await dependency_ids_for_claims(session, scope, claim_ids)
    return await mark_dependencies_stale_in_session(session, scope, dependencies, reason=reason)


async def mark_tags_and_entities_stale_in_session(
    session: AsyncSession,
    scope: ProjectScope,
    *,
    tags: Sequence[str] = (),
    entity_ids: Sequence[uuid.UUID] = (),
    reason: str,
) -> list[str]:
    dependencies = set(entity_ids)
    if tags:
        dependencies.update(
            await session.scalars(
                select(models.Topic.id).where(
                    models.Topic.project_id == _pid(scope), models.Topic.slug.in_(set(tags))
                )
            )
        )
    return await mark_dependencies_stale_in_session(session, scope, dependencies, reason=reason)


class SkillStaleNotificationDispatcher:
    """Drain fresh-to-stale outbox rows with concurrency-safe, retryable delivery."""

    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        channel: Channel,
        can_deliver: bool,
        clock: Callable[[], dt.datetime] | None = None,
    ) -> None:
        self._sm = sessionmaker
        self._channel = channel
        self._can_deliver = can_deliver
        self._clock = clock or (lambda: dt.datetime.now(dt.UTC))

    async def deliver_due(
        self, *, project_id: str | None = None, limit: int = _MAX_BATCH
    ) -> list[str]:
        """Deliver due rows and return their ids.

        Each external send happens while its outbox row is locked. Other workers use
        ``SKIP LOCKED`` and can progress on different rows but can never report a second successful
        send for this transition. The provider receives the same idempotency key on every retry.
        """
        delivered: list[str] = []
        for _ in range(max(0, min(limit, _MAX_BATCH))):
            now = self._clock()
            async with session_scope(self._sm) as session:
                conditions = [
                    models.SkillStaleNotification.state == "pending",
                    models.SkillStaleNotification.next_attempt_at <= now,
                ]
                if project_id is not None:
                    try:
                        wanted_project = uuid.UUID(project_id)
                    except ValueError:
                        return delivered
                    conditions.append(models.SkillStaleNotification.project_id == wanted_project)
                notice = await session.scalar(
                    select(models.SkillStaleNotification)
                    .where(*conditions)
                    .order_by(
                        models.SkillStaleNotification.next_attempt_at,
                        models.SkillStaleNotification.created_at,
                    )
                    .limit(1)
                    .with_for_update(skip_locked=True)
                )
                if notice is None:
                    break
                succeeded = await self._deliver_locked(session, notice, now)
                if succeeded:
                    delivered.append(str(notice.id))
        return delivered

    async def _deliver_locked(
        self,
        session: AsyncSession,
        notice: models.SkillStaleNotification,
        now: dt.datetime,
    ) -> bool:
        skill = await session.get(models.Skill, notice.skill_id)
        person = (
            await session.get(models.Person, notice.owner_person_id)
            if notice.owner_person_id is not None
            else None
        )
        if (
            skill is None
            or skill.project_id != notice.project_id
            or not skill.stale
            or skill.stale_generation != notice.generation
            or skill.owner_person_id != notice.owner_person_id
            or person is None
            or person.project_id != notice.project_id
        ):
            notice.state = "cancelled"
            return False
        owner = PersonRow(
            id=str(person.id),
            name=person.name,
            channels=dict(person.channels or {}),
            topics=tuple(person.topics),
            quiet_hours=dict(person.quiet_hours or {}),
            language=person.language,
            version=person.version,
        )
        if in_quiet_hours(owner, now):
            notice.next_attempt_at = next_allowed_at(owner, now)
            return False
        target = self._target(owner)
        if not self._can_deliver or target is None:
            notice.next_attempt_at = now + _UNAVAILABLE_RETRY
            notice.last_error = "delivery channel unavailable"
            return False
        notice.attempts += 1
        try:
            await self._channel.send(
                OutboundMessage(
                    channel="slack" if self._channel.name == "slack" else "email",
                    to=target,
                    subject=f"Skill '{skill.slug}' is stale",
                    body=(
                        f"The skill '{skill.slug}' depends on knowledge that changed "
                        f"({skill.stale_reason or 'knowledge changed'}). Please review it."
                    ),
                    idempotency_key=notice.idempotency_key,
                )
            )
        except Exception as exc:
            # Provider exceptions can contain request headers or response bodies. Persist only the
            # class, never the raw message; this field is operational metadata, not a secret sink.
            notice.last_error = f"{type(exc).__name__}: delivery failed"
            minutes = min(2 ** min(notice.attempts - 1, 6), 60)
            notice.next_attempt_at = now + dt.timedelta(minutes=minutes)
            return False
        notice.state = "delivered"
        notice.delivered_at = now
        notice.last_error = None
        session.add(
            models.AuditLog(
                project_id=notice.project_id,
                principal_type="agent",
                principal_id="worker",
                trace_id=notice.idempotency_key,
                action="skill_stale_notified",
                tool="worker",
                topics_used=list(skill.tags),
                result_count=notice.generation,
                denied=False,
                resource_type="skill",
                resource_id=skill.id,
            )
        )
        return True

    def _target(self, owner: PersonRow) -> str | None:
        key = "slack" if self._channel.name == "slack" else "email"
        value = owner.channels.get(key)
        return value if isinstance(value, str) and value.strip() else None


async def mark_stale_and_notify(
    sessionmaker: async_sessionmaker[AsyncSession],
    scope: ProjectScope,
    touched_ids: list[str],
    *,
    reason: str,
    channel: Channel | None = None,
) -> list[str]:
    """Compatibility adapter: persist first, then drain through the same durable dispatcher.

    Production knowledge writers call the transactional marker directly and the worker drains the
    outbox. A supplied channel keeps the historical helper useful for integration tests without a
    second, non-durable delivery implementation.
    """
    newly = await SkillStore(sessionmaker).mark_stale_for(scope, touched_ids, reason=reason)
    delivery = channel or NullChannel()
    await SkillStaleNotificationDispatcher(
        sessionmaker,
        channel=delivery,
        can_deliver=channel is not None,
    ).deliver_due(project_id=scope.project_id)
    return newly
