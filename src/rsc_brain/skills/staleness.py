"""Skill graph-sync notification (SPEC-20, FR-7.2).

When a knowledge mutation touches an entity/topic a skill ``depends_on``, the skill is marked
``stale`` (see :meth:`SkillStore.mark_stale_for`) and its owner is notified — **exactly once** per
transition, because ``mark_stale_for`` only returns skills newly flipped to stale. Notification
uses the SPEC-15 person directory + channel (respecting quiet hours is the channel's concern); the
live SMTP/Slack send is blocked-by-resource, exercised here through ``NullChannel``.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.hunting.channels import Channel, NullChannel, OutboundMessage
from rsc_brain.hunting.directory import PersonDirectory
from rsc_brain.scope import ProjectScope
from rsc_brain.skills.store import SkillStore


async def mark_stale_and_notify(
    sessionmaker: async_sessionmaker[AsyncSession],
    scope: ProjectScope,
    touched_ids: list[str],
    *,
    reason: str,
    channel: Channel | None = None,
) -> list[str]:
    """Mark every skill depending on ``touched_ids`` stale and notify each owner once. Returns the
    slugs newly marked stale."""
    channel = channel or NullChannel()
    store = SkillStore(sessionmaker)
    directory = PersonDirectory(sessionmaker)
    newly = await store.mark_stale_for(scope, touched_ids, reason=reason)
    for slug in newly:
        skill = await store.get(scope, slug)
        if skill is None or skill.owner_person_id is None:
            continue
        person = await directory.get(scope, skill.owner_person_id)
        email = (
            str(person.channels.get("email")) if person and person.channels.get("email") else None
        )
        if email is None:
            continue
        await channel.send(
            OutboundMessage(
                channel="email",
                to=email,
                subject=f"Skill '{slug}' is stale",
                body=f"The skill '{slug}' depends on knowledge that just changed ({reason}). "
                "Please review it.",
            )
        )
    return newly
