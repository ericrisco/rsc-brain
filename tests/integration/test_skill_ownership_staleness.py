"""AUDIT-018: project-safe ownership, audited lifecycle and durable stale transitions."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable

import pytest
from sqlalchemy import func, select

from rsc_brain.audit import query_audit
from rsc_brain.hunting.directory import PersonDirectory
from rsc_brain.skills.frontmatter import SkillFrontmatter
from rsc_brain.skills.store import SkillOwnerNotFound, SkillStore, SkillVersionConflict
from rsc_brain.stores.relational import models

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("hr", 0), ("general", 0)]


def _fm(
    slug: str,
    *,
    owner: str | None = None,
    version: int = 1,
    depends_on: list[str] | None = None,
) -> SkillFrontmatter:
    return SkillFrontmatter(
        slug=slug,
        title="Payroll runbook",
        tags=["hr"],
        owner=owner,
        version=version,
        state="active",
        depends_on=depends_on or [],
    )


async def test_owner_is_resolved_only_inside_the_skill_project(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_a = await harness.setup_project(unique_slug("owner-a"), TOPICS)
    project_b = await harness.setup_project(unique_slug("owner-b"), TOPICS)
    scope_a = harness.scope(project_a, allowed_topics=["hr"])
    scope_b = harness.scope(project_b, allowed_topics=["hr"])
    directory = PersonDirectory(harness.sm)
    local_id = await directory.add(scope_a, name="Local Owner", topics=["hr"])
    foreign_id = await directory.add(scope_b, name="Foreign Owner", topics=["hr"])
    store = SkillStore(harness.sm)

    for identifier in (foreign_id, "Foreign Owner", str(uuid.uuid4()), "Missing Owner"):
        with pytest.raises(SkillOwnerNotFound, match="owner not found"):
            await store.create(
                scope_a,
                _fm(f"denied-{uuid.uuid4().hex[:8]}", owner=identifier),
                "secret instructions",
            )

    created_id = await store.create(scope_a, _fm("local", owner="Local Owner"), "body")
    row = await store.get(scope_a, "local")
    assert row is not None
    assert row.id == created_id and row.owner_person_id == local_id

    # Duplicate same-project names are ambiguous and use the same non-disclosing failure.
    await directory.add(scope_a, name="Duplicate", topics=["hr"])
    await directory.add(scope_a, name="Duplicate", topics=["hr"])
    with pytest.raises(SkillOwnerNotFound, match="owner not found"):
        await store.update(scope_a, "local", _fm("local", owner="Duplicate"), "changed")
    assert (await store.get(scope_a, "local")).owner_person_id == local_id  # type: ignore[union-attr]

    replacement_id = await directory.add(scope_a, name="Replacement Owner", topics=["hr"])
    current = await store.get(scope_a, "local")
    assert current is not None
    replaced = await store.update(
        scope_a,
        "local",
        _fm("local", owner="Replacement Owner", version=current.version),
        "reviewed",
    )
    assert replaced.owner_person_id == replacement_id


async def test_create_update_and_stale_resolution_are_versioned_and_audited(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("audit"), TOPICS)
    scope = harness.scope(project_id, allowed_topics=["hr"])
    owner_id = await PersonDirectory(harness.sm).add(scope, name="Owner", topics=["hr"])
    store = SkillStore(harness.sm)
    dependency = str(uuid.uuid4())

    await store.create(
        scope,
        _fm("payroll", owner=owner_id, depends_on=[dependency]),
        "TOP SECRET BODY",
    )
    await store.mark_stale_for(scope, [dependency], reason="claim corrected")
    stale_row = await store.get(scope, "payroll")
    assert stale_row is not None
    updated = await store.update(
        scope,
        "payroll",
        _fm("payroll", owner=owner_id, version=stale_row.version, depends_on=[dependency]),
        "reviewed body",
    )
    assert updated.version == stale_row.version + 1 and updated.stale is False
    with pytest.raises(SkillVersionConflict):
        await store.update(
            scope,
            "payroll",
            _fm("payroll", owner=owner_id, version=stale_row.version, depends_on=[dependency]),
            "lost update",
        )

    async with harness.sm() as session:
        audits = (
            await session.scalars(
                select(models.AuditLog)
                .where(
                    models.AuditLog.project_id == uuid.UUID(project_id),
                    models.AuditLog.resource_type == "skill",
                    models.AuditLog.resource_id == uuid.UUID(updated.id),
                )
                .order_by(models.AuditLog.id)
            )
        ).all()
    assert [row.action for row in audits] == [
        "skill_create",
        "skill_stale",
        "skill_update",
        "skill_stale_resolved",
    ]
    assert all(row.principal_id == scope.principal_id for row in audits)
    assert all("TOP SECRET BODY" not in str(row.__dict__) for row in audits)
    queried = await query_audit(harness.sm, scope, limit=20)
    lifecycle = [
        row
        for row in queried
        if isinstance(row["action"], str) and row["action"].startswith("skill_")
    ]
    assert lifecycle
    assert all(row["resource_type"] == "skill" for row in lifecycle)
    assert all(row["resource_id"] == updated.id for row in lifecycle)
    assert all("TOP SECRET BODY" not in str(row) for row in lifecycle)


async def test_fresh_to_stale_transition_has_one_durable_outbox_row_per_generation(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("outbox"), TOPICS)
    scope = harness.scope(project_id, allowed_topics=["hr"])
    owner_id = await PersonDirectory(harness.sm).add(
        scope,
        name="Owner",
        channels={"email": "owner@example.test"},
        topics=["hr"],
    )
    dependency = str(uuid.uuid4())
    store = SkillStore(harness.sm)
    await store.create(
        scope,
        _fm("payroll", owner=owner_id, depends_on=[dependency]),
        "body",
    )

    assert await store.mark_stale_for(scope, [dependency], reason="ingest") == ["payroll"]
    assert await store.mark_stale_for(scope, [dependency], reason="correction") == []
    async with harness.sm() as session:
        first = (
            await session.scalars(
                select(models.SkillStaleNotification).where(
                    models.SkillStaleNotification.project_id == uuid.UUID(project_id)
                )
            )
        ).all()
    assert len(first) == 1 and first[0].generation == 1 and first[0].state == "pending"

    row = await store.get(scope, "payroll")
    assert row is not None
    await store.update(
        scope,
        "payroll",
        _fm("payroll", owner=owner_id, version=row.version, depends_on=[dependency]),
        "reviewed",
    )
    assert await store.mark_stale_for(scope, [dependency], reason="later ingest") == ["payroll"]
    async with harness.sm() as session:
        generations = list(
            await session.scalars(
                select(models.SkillStaleNotification.generation)
                .where(models.SkillStaleNotification.project_id == uuid.UUID(project_id))
                .order_by(models.SkillStaleNotification.generation)
            )
        )
        pending = await session.scalar(
            select(func.count())
            .select_from(models.SkillStaleNotification)
            .where(
                models.SkillStaleNotification.project_id == uuid.UUID(project_id),
                models.SkillStaleNotification.state == "pending",
                models.SkillStaleNotification.next_attempt_at <= dt.datetime.now(dt.UTC),
            )
        )
    assert generations == [1, 2]
    assert pending == 1
