"""GDPR erasure + audit retention (SPEC-22, FR-4.6) against the real container."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable

import pytest
from sqlalchemy import func, select

from rsc_brain.ingest.entity_resolution import entity_id
from rsc_brain.knowledge.gdpr import forget_entity, purge_audit
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.graph_store import GraphNode
from rsc_brain.stores.relational import models

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration


async def test_forget_entity_erases_rows_and_tombstones_the_node(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), [("hr", 0)])
    scope = harness.scope(project_id, allowed_topics=["hr"])
    graph = AgeGraphStore(harness.sm)
    await graph.create_graph(scope)
    node_id = str(entity_id("person", "Jane Doe"))
    await graph.upsert_nodes(
        scope,
        [GraphNode(id=node_id, labels=frozenset({"Entity"}), properties={"name": "Jane Doe"})],
    )
    async with harness.sm() as session:
        entity = models.Entity(
            project_id=uuid.UUID(project_id),
            name="Jane Doe",
            normalized_name="jane doe",
            type="person",
        )
        session.add(entity)
        await session.flush()
        session.add(
            models.EntityAlias(
                project_id=uuid.UUID(project_id), entity_id=entity.id, alias="J. Doe"
            )
        )
        await session.commit()

    result = await forget_entity(harness.sm, scope, "Jane Doe")
    assert result["deleted_entities"] == 1 and result["tombstoned"] == 1
    async with harness.sm() as session:
        remaining = await session.scalar(
            select(func.count())
            .select_from(models.Entity)
            .where(
                models.Entity.project_id == uuid.UUID(project_id),
                models.Entity.name == "Jane Doe",
            )
        )
        assert int(remaining or 0) == 0  # erased — no trace


async def test_purge_audit_respects_retention(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), [("hr", 0)])
    now = dt.datetime.now(dt.UTC)
    async with harness.sm() as session:
        session.add_all(
            [
                models.AuditLog(
                    project_id=uuid.UUID(project_id),
                    action="recall",
                    tool="t",
                    principal_type="human",
                    ts=now - dt.timedelta(days=400),  # older than retention
                ),
                models.AuditLog(
                    project_id=uuid.UUID(project_id),
                    action="recall",
                    tool="t",
                    principal_type="human",
                    ts=now - dt.timedelta(days=10),  # recent
                ),
            ]
        )
        await session.commit()

    deleted = await purge_audit(harness.sm, retention_days=365)
    assert deleted >= 1
    async with harness.sm() as session:
        survivors = await session.scalars(
            select(models.AuditLog.ts).where(models.AuditLog.project_id == uuid.UUID(project_id))
        )
        ages = [now - ts for ts in survivors]
        assert ages and all(age < dt.timedelta(days=365) for age in ages)  # only recent remain
