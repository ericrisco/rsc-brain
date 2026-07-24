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

from rsc_brain.hunting.channels import Channel, NullChannel, OutboundMessage
from rsc_brain.hunting.directory import PersonDirectory
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
    channel = channel or NullChannel()
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
        if await store.get(scope, slug) is not None:
            continue
        await store.create(
            scope,
            SkillFrontmatter(
                slug=slug,
                title=(gap.query_text or slug)[:80],
                tags=list(gap.topics),
                owner=owner.id,
                state="proposed",
            ),
            body=f"Proposed from a recurrent question (asked {gap.count} times). Review and complete.",
            owner_person_id=owner.id,
        )
        proposed.append(slug)
        email = owner.channels.get("email")
        if email:
            await channel.send(
                OutboundMessage(
                    channel="email",
                    to=str(email),
                    subject=f"Proposed skill '{slug}' needs review",
                    body=f"A recurrent question suggests a skill: {gap.query_text!r}. Validate it.",
                )
            )
    return proposed


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
    channel = channel or NullChannel()
    moment = now or dt.datetime.now(dt.UTC)
    cutoff = moment - dt.timedelta(days=idle_days)
    directory = PersonDirectory(sessionmaker)
    store = SkillStore(sessionmaker)
    prompted: list[str] = []
    for skill in await store.list_all(scope, state="active"):
        async with sessionmaker() as session:
            recent = await session.scalar(
                select(func.count())
                .select_from(models.AuditLog)
                .where(
                    models.AuditLog.project_id == _pid(scope),
                    models.AuditLog.action == "run_skill",
                    models.AuditLog.query_hash == query_hash(f"skill:{skill.slug}"),
                    models.AuditLog.ts >= cutoff,
                )
            )
        if int(recent or 0) > 0 or skill.owner_person_id is None:
            continue
        owner = await directory.get(scope, skill.owner_person_id)
        email = owner.channels.get("email") if owner else None
        if email:
            await channel.send(
                OutboundMessage(
                    channel="email",
                    to=str(email),
                    subject=f"Skill '{skill.slug}' looks unused",
                    body=f"'{skill.slug}' has had no use in {idle_days} days. Archive it, or keep it?",
                )
            )
        prompted.append(skill.slug)
    return prompted
