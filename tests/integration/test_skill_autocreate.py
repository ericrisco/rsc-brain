"""Skill autocreation + autoarchive-prompt (SPEC-22, FR-7.3) against the real container."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable

import pytest

from rsc_brain.hunting.channels import NullChannel
from rsc_brain.hunting.directory import PersonDirectory
from rsc_brain.recall.gaps import GAP_STATUS_OPEN, query_hash
from rsc_brain.skills.autocreate import prompt_idle_skills, propose_skills_from_gaps
from rsc_brain.skills.frontmatter import SkillFrontmatter
from rsc_brain.skills.store import SkillStore
from rsc_brain.stores.relational import models

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("hr", 0)]


async def _gap(harness: Harness, project_id: str, text: str, count: int) -> None:
    async with harness.sm() as session:
        session.add(
            models.Gap(
                project_id=uuid.UUID(project_id),
                query_hash=query_hash(text),
                query_text=text,
                topics=["hr"],
                count=count,
                status=GAP_STATUS_OPEN,
            )
        )
        await session.commit()


async def test_recurrent_gap_becomes_a_proposed_skill(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project_id, allowed_topics=["hr"])
    await PersonDirectory(harness.sm).add(
        scope, name="Owner", channels={"email": "o@x"}, topics=["hr"]
    )
    await _gap(harness, project_id, "how do we onboard", count=5)  # recurrent
    await _gap(harness, project_id, "one-off question", count=1)  # below threshold

    channel = NullChannel()
    proposed = await propose_skills_from_gaps(harness.sm, scope, threshold=3, channel=channel)
    assert len(proposed) == 1 and channel.sent  # exactly one proposal, owner notified

    store = SkillStore(harness.sm)
    created = await store.get(scope, proposed[0])
    assert created is not None and created.state == "proposed"
    # A proposed skill is NOT exposed by MCP until an owner validates it.
    visible = await store.list_visible(scope, frozenset())
    assert proposed[0] not in [s.slug for s in visible]


async def test_idle_skill_prompts_owner_but_never_auto_archives(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project_id, allowed_topics=["hr"])
    owner_id = await PersonDirectory(harness.sm).add(
        scope, name="Owner", channels={"email": "o@x"}, topics=["hr"]
    )
    await SkillStore(harness.sm).create(
        scope,
        SkillFrontmatter(slug="dusty", title="Dusty", tags=["hr"]),
        "body",
        owner_person_id=owner_id,
    )
    channel = NullChannel()
    prompted = await prompt_idle_skills(
        harness.sm, scope, idle_days=60, now=dt.datetime.now(dt.UTC), channel=channel
    )
    assert prompted == ["dusty"] and len(channel.sent) == 1  # owner asked
    still = await SkillStore(harness.sm).get(scope, "dusty")
    assert still is not None and still.state == "active"  # NEVER archived without the owner


async def test_recently_used_skill_is_not_prompted(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project_id, allowed_topics=["hr"])
    owner_id = await PersonDirectory(harness.sm).add(
        scope, name="O", channels={"email": "o@x"}, topics=["hr"]
    )
    await SkillStore(harness.sm).create(
        scope,
        SkillFrontmatter(slug="fresh", title="Fresh", tags=["hr"]),
        "body",
        owner_person_id=owner_id,
    )
    async with harness.sm() as session:  # a recent run_skill for this skill
        session.add(
            models.AuditLog(
                project_id=uuid.UUID(project_id),
                action="run_skill",
                tool="run_skill",
                principal_type="human",
                query_hash=query_hash("skill:fresh"),
            )
        )
        await session.commit()
    assert await prompt_idle_skills(harness.sm, scope, idle_days=60) == []  # used recently → skip
