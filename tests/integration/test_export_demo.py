"""OKF export (permission-respecting) + demo seed/reset (SPEC-22, FR-10.6/10.7/12.7)."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import cast

import pytest
from sqlalchemy import func, select

from rsc_brain.demo import DEMO_SLUG, reset_demo, seed_demo
from rsc_brain.export.okf import export_okf_bundle
from rsc_brain.skills.frontmatter import SkillFrontmatter
from rsc_brain.skills.store import SkillStore
from rsc_brain.stores.relational import models

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("hr", 0), ("general", 0)]


async def _claim(harness: Harness, project_id: str, text: str, tags: list[str]) -> None:
    async with harness.sm() as session:
        session.add(
            models.Claim(project_id=uuid.UUID(project_id), text=text, tags=tags, credibility=0.7)
        )
        await session.commit()


async def test_okf_export_respects_permissions(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    await _claim(harness, project_id, "General fact", ["general"])
    await _claim(harness, project_id, "HR secret", ["hr"])
    await SkillStore(harness.sm).create(
        harness.scope(project_id, allowed_topics=["general"]),
        SkillFrontmatter(slug="onboard", title="Onboard", tags=["general"]),
        "body",
    )

    full = await export_okf_bundle(
        harness.sm, harness.scope(project_id, allowed_topics=["hr", "general"])
    )
    assert full["okf_version"] == "0.1"
    claims = cast("list[dict[str, object]]", full["rsc_brain_claims"])
    texts = {c["title"] for c in claims}
    assert {"General fact", "HR secret"} <= texts
    assert len(cast("list[object]", full["rsc_brain_skills"])) == 1

    # A general-only exporter never sees the hr claim (FR-10.6 respects permissions).
    limited = await export_okf_bundle(
        harness.sm, harness.scope(project_id, allowed_topics=["general"])
    )
    limited_texts = {
        c["title"] for c in cast("list[dict[str, object]]", limited["rsc_brain_claims"])
    }
    assert "General fact" in limited_texts and "HR secret" not in limited_texts


async def test_demo_seed_then_reset(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    seeded = await seed_demo(harness.sm)
    assert seeded["status"] == "seeded"
    async with harness.sm() as session:
        project_id = await session.scalar(
            select(models.Project.id).where(models.Project.slug == DEMO_SLUG)
        )
        assert project_id is not None
        claims = await session.scalar(
            select(func.count())
            .select_from(models.Claim)
            .where(models.Claim.project_id == project_id)
        )
        assert int(claims or 0) >= 1  # something recallable was seeded

    # Re-seeding is refused; reset wipes it (0 rows), and the cascade removes the seeded claim.
    assert (await seed_demo(harness.sm))["status"] == "exists"
    assert (await reset_demo(harness.sm))["status"] == "removed"
    async with harness.sm() as session:
        gone = await session.scalar(
            select(func.count()).select_from(models.Project).where(models.Project.slug == DEMO_SLUG)
        )
        assert int(gone or 0) == 0
