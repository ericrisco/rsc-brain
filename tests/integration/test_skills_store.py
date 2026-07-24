"""Skill store CRUD + visibility + graph-sync staleness (SPEC-20) against the real container."""

from __future__ import annotations

import uuid
from collections.abc import Callable

import pytest

from rsc_brain.recall.permissions import sensitive_tags
from rsc_brain.skills.frontmatter import SkillFrontmatter
from rsc_brain.skills.store import SkillStore

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("hr", 0), ("general", 0)]


def _fm(slug: str, tags: list[str], depends_on: list[str] | None = None) -> SkillFrontmatter:
    return SkillFrontmatter(
        slug=slug, title=slug.title(), tags=tags, depends_on=depends_on or [], state="active"
    )


async def test_crud_and_state(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project_id, allowed_topics=["hr"])
    store = SkillStore(harness.sm)

    await store.create(scope, _fm("onboard", ["hr"]), "## Body\n")
    got = await store.get(scope, "onboard")
    assert got is not None and got.state == "active" and got.body == "## Body\n"

    await store.set_state(scope, "onboard", "archived")
    assert (await store.get(scope, "onboard")).state == "archived"  # type: ignore[union-attr]
    assert [s.slug for s in await store.list_all(scope, state="active")] == []


async def test_visibility_by_tag(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    admin = harness.scope(project_id, allowed_topics=["hr", "general"])
    store = SkillStore(harness.sm)
    await store.create(admin, _fm("hr-skill", ["hr"]), "body")
    forbidden = await sensitive_tags(harness.sm, project_id)

    # A caller with hr sees it; a caller with only general does not (FR-4.14).
    with_hr = await store.list_visible(harness.scope(project_id, allowed_topics=["hr"]), forbidden)
    without_hr = await store.list_visible(
        harness.scope(project_id, allowed_topics=["general"]), forbidden
    )
    assert [s.slug for s in with_hr] == ["hr-skill"]
    assert without_hr == []


async def test_stale_sync_is_idempotent(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project_id, allowed_topics=["hr"])
    store = SkillStore(harness.sm)
    entity_id = str(uuid.uuid4())
    await store.create(scope, _fm("payroll", ["hr"], depends_on=[entity_id]), "body")

    # A knowledge mutation touching the depended-on entity marks the skill stale — once.
    newly = await store.mark_stale_for(scope, [entity_id], reason="claim corrected")
    assert newly == ["payroll"]
    assert (await store.get(scope, "payroll")).stale is True  # type: ignore[union-attr]
    # Re-running finds nothing new (idempotent, so the owner is notified exactly once, FR-7.2).
    assert await store.mark_stale_for(scope, [entity_id], reason="claim corrected") == []
    # An unrelated entity never marks it.
    await store.set_state(scope, "payroll", "active")  # no-op; already active
    assert await store.mark_stale_for(scope, [str(uuid.uuid4())], reason="x") == []
