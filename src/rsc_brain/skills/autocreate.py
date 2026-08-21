"""Skill autocreation + autoarchive (SPEC-22, FR-7.3).

**Autocreate:** recurrent gaps (a query asked ≥ threshold times) whose topic has a registered owner
become a ``proposed`` skill routed to that owner — never exposed by MCP until the owner validates
it (``proposed`` skills are invisible to ``list_skills``). **Autoarchive:** an ``active`` skill with
no ``run_skill`` in the idle window prompts its owner (it is *never* archived without asking — the
owner archives via ``SkillStore.set_state``). Both notify through the SPEC-15 channel, once.

The periodic scheduling is a deploy-time procrastinate job (blocked-by-resource); these functions
are deterministic and tested with an injectable clock + channel.
"""

from __future__ import annotations

import datetime as dt
import re
import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.hunting.channels import Channel, OutboundMessage
from rsc_brain.hunting.directory import PersonDirectory, PersonRow
from rsc_brain.recall.gaps import query_hash
from rsc_brain.scope import ProjectScope
from rsc_brain.skills.frontmatter import SkillFrontmatter
from rsc_brain.skills.store import SkillStore
from rsc_brain.stores.relational import models

DEFAULT_CLUSTER_THRESHOLD = 3
DEFAULT_IDLE_DAYS = 60


def _pid(scope: ProjectScope) -> uuid.UUID:
    return uuid.UUID(scope.project_id)


def _slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return (slug or "skill")[:48]


async def propose_skills_from_gaps(
    sessionmaker: async_sessionmaker[AsyncSession],
    scope: ProjectScope,
    *,
    threshold: int = DEFAULT_CLUSTER_THRESHOLD,
    channel: Channel | None = None,
) -> list[str]:
    """Propose a ``proposed`` skill for each recurrent gap (count ≥ threshold) whose topic has an
    owner. Returns the newly-proposed slugs. Idempotent by slug (skips an existing one)."""
    directory = PersonDirectory(sessionmaker)
    store = SkillStore(sessionmaker)
    async with sessionmaker() as session:
        gaps = list(
            await session.scalars(
                select(models.Gap).where(
                    models.Gap.project_id == _pid(scope), models.Gap.count >= threshold
                )
            )
        )
    proposed: list[str] = []
    for gap in gaps:
        owner = await directory.route(scope, tuple(gap.topics))
        if owner is None:
            continue  # no owner → no proposal (a NO_OWNER gap stays a gap, promoted by hand)
        slug = _slugify(gap.query_text or f"gap-{gap.query_hash[:8]}")
        existing = await store.get(scope, slug)
        if existing is None:
            await store.create(
                scope,
                SkillFrontmatter(
                    slug=slug,
                    title=(gap.query_text or slug)[:80],
                    tags=list(gap.topics),
                    owner=owner.id,
                    state="proposed",
                ),
                body=(
                    f"Proposed from a recurrent question (asked {gap.count} times). "
                    "Review and complete."
                ),
                owner_person_id=owner.id,
            )
            proposed.append(slug)
        await _notify_proposed_skill(
            sessionmaker,
            scope,
            slug=slug,
            gap_text=gap.query_text,
            channel=channel,
        )
    return proposed


async def _notify_proposed_skill(
    sessionmaker: async_sessionmaker[AsyncSession],
    scope: ProjectScope,
    *,
    slug: str,
    gap_text: str | None,
    channel: Channel | None,
) -> bool:
    """Deliver a proposal notification once, while leaving a failed send retryable."""
    if channel is None:
        return False
    directory = PersonDirectory(sessionmaker)
    async with sessionmaker.begin() as session:
        skill = await session.scalar(
            select(models.Skill)
            .where(
                models.Skill.project_id == _pid(scope),
                models.Skill.slug == slug,
                models.Skill.state == "proposed",
            )
            .with_for_update()
        )
        if skill is None or skill.proposal_notified_at is not None or skill.owner_person_id is None:
            return False
        owner = await directory.get(scope, str(skill.owner_person_id))
        destination = _notification_route(owner, channel) if owner else None
        if destination is None:
            return False
        route, target = destination
        await channel.send(
            OutboundMessage(
                channel=route,
                to=target,
                subject=f"Proposed skill '{slug}' needs review",
                body=f"A recurrent question suggests a skill: {gap_text!r}. Validate it.",
            )
        )
        skill.proposal_notified_at = dt.datetime.now(dt.UTC)
        session.add(
            models.AuditLog(
                project_id=_pid(scope),
                principal_type=scope.principal_type.value,
                principal_id=scope.principal_id,
                action="skill_proposal_notified",
                tool="maintenance",
                query_hash=query_hash(f"skill:{slug}"),
                topics_used=list(skill.tags),
                result_count=1,
            )
        )
        return True


async def prompt_idle_skills(
    sessionmaker: async_sessionmaker[AsyncSession],
    scope: ProjectScope,
    *,
    idle_days: int = DEFAULT_IDLE_DAYS,
    now: dt.datetime | None = None,
    channel: Channel | None = None,
) -> list[str]:
    """Prompt the owner of every ``active`` skill unused for ``idle_days`` (no ``run_skill`` audit
    in the window). Returns the prompted slugs. **Never archives** — the owner decides (FR-7.3)."""
    moment = now or dt.datetime.now(dt.UTC)
    cutoff = moment - dt.timedelta(days=idle_days)
    directory = PersonDirectory(sessionmaker)
    store = SkillStore(sessionmaker)
    prompted: list[str] = []
    for skill in await store.list_all(scope, state="active"):
        skill_hash = query_hash(f"skill:{skill.slug}")
        async with sessionmaker.begin() as session:
            live = await session.scalar(
                select(models.Skill)
                .where(
                    models.Skill.id == uuid.UUID(skill.id),
                    models.Skill.project_id == _pid(scope),
                    models.Skill.state == "active",
                )
                .with_for_update()
            )
            if live is None:
                continue
            last_run = await session.scalar(
                select(func.max(models.AuditLog.ts)).where(
                    models.AuditLog.project_id == _pid(scope),
                    models.AuditLog.action == "run_skill",
                    models.AuditLog.query_hash == skill_hash,
                )
            )
            if (last_run is not None and last_run >= cutoff) or live.owner_person_id is None:
                continue
            if live.idle_prompted_at is not None and (
                last_run is None or live.idle_prompted_at >= last_run
            ):
                continue
            owner = await directory.get(scope, str(live.owner_person_id))
            if owner is None or channel is None:
                continue
            destination = _notification_route(owner, channel)
            if destination is None:
                continue
            route, target = destination
            await channel.send(
                OutboundMessage(
                    channel=route,
                    to=target,
                    subject=f"Skill '{skill.slug}' looks unused",
                    body=(
                        f"'{skill.slug}' has had no use in {idle_days} days. Archive it, or keep it?"
                    ),
                )
            )
            live.idle_prompted_at = moment
            session.add(
                models.AuditLog(
                    project_id=_pid(scope),
                    principal_type=scope.principal_type.value,
                    principal_id=scope.principal_id,
                    action="skill_idle_prompted",
                    tool="maintenance",
                    query_hash=skill_hash,
                    topics_used=list(skill.tags),
                    result_count=1,
                    ts=moment,
                )
            )
            prompted.append(skill.slug)
    return prompted


def _notification_route(person: PersonRow, channel: Channel) -> tuple[str, str] | None:
    """Resolve an owner address against the configured transport, not an unrelated field."""
    channels = person.channels
    if channel.name == "smtp":
        email = channels.get("email")
        return ("email", str(email)) if email else None
    if channel.name == "slack":
        return "slack", str(channels.get("slack") or "")
    email = channels.get("email")
    if email:
        return "email", str(email)
    slack = channels.get("slack")
    if slack:
        return "slack", str(slack)
    return None
