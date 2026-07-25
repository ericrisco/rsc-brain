"""The unified needs_review queue + resolution (SPEC-21, FR-13.6) against the real container.

The queue aggregates the four sources; resolving a chunk approves it into recall (or rejects it),
resolving a merge applies it (or rejects it) — both idempotent and project-isolated.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable

import pytest

from rsc_brain.config.models import KnowledgeConfig
from rsc_brain.knowledge.agent_writes import AGENT_SUBMISSION_LOGICAL_ID
from rsc_brain.knowledge.entity_merge import DeterministicMergeProposer, EntityMergeService
from rsc_brain.review.queue import list_review_queue
from rsc_brain.review.resolve import REJECTED_TAG, resolve_chunk, resolve_merge
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.entity_store import EntityStore

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("hr", 0)]


async def _needs_review_chunk(
    harness: Harness, project_id: str, *, logical_id: str, kind: str
) -> str:
    async with harness.sm() as session:
        doc = models.Document(
            project_id=uuid.UUID(project_id),
            logical_id=logical_id,
            checksum=f"c-{uuid.uuid4().hex}",
            status="processed",
        )
        session.add(doc)
        await session.flush()
        chunk = models.Chunk(
            project_id=uuid.UUID(project_id),
            document_id=doc.id,
            kind=kind,
            text="ambiguous row content",
            tags=["__needs_review__"],
            needs_review=True,
        )
        session.add(chunk)
        await session.flush()
        cid = str(chunk.id)
        await session.commit()
        return cid


async def _pending_merge(harness: Harness, project_id: str) -> tuple[str, str, str]:
    """A proposal awaiting a human, created by the service that creates proposals (R55).

    This fixture used to insert the row by hand with ``status="pending"`` — a status no producer
    writes. That is how R25 survived a green suite: the fixture agreed with the query rather than with
    the product, so nobody noticed that a real proposal never reached the queue at all.
    """
    suffix = uuid.uuid4().hex[:8]
    scope = harness.scope(project_id, allowed_topics=["hr"])
    async with harness.sm() as session:
        canonical = models.Entity(
            project_id=uuid.UUID(project_id),
            name=f"Acme Corporation {suffix}",
            normalized_name=f"acme corporation {suffix}",
            type="org",
        )
        duplicate = models.Entity(
            project_id=uuid.UUID(project_id),
            name=f"Acme Corporaton {suffix}",  # typo → high similarity, below auto-apply
            normalized_name=f"acme corporaton {suffix}",
            type="org",
        )
        session.add_all([canonical, duplicate])
        await session.flush()
        ids = (str(canonical.id), str(duplicate.id))
        await session.commit()
    service = EntityMergeService(
        store=EntityStore(harness.sm),
        graph=AgeGraphStore(harness.sm),
        proposer=DeterministicMergeProposer(min_similarity=0.82),
        sessionmaker=harness.sm,
        config=KnowledgeConfig(merge_auto_apply_confidence=1.0),
    )
    summary = await service.propose(scope)
    assert summary.queued, "the proposer queued nothing, so this fixture is not a review item"
    return (summary.queued[0], ids[0], ids[1])


async def test_queue_aggregates_all_sources(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project_id, allowed_topics=["hr"])
    await _needs_review_chunk(harness, project_id, logical_id="doc-1", kind="table_row")
    await _needs_review_chunk(
        harness, project_id, logical_id=AGENT_SUBMISSION_LOGICAL_ID, kind="prose"
    )
    await _pending_merge(harness, project_id)

    items = await list_review_queue(harness.sm, scope)
    sources = {i.source for i in items}
    assert "ambiguous_table" in sources  # FR-1.5
    assert "agent_submission" in sources  # FR-14.4
    assert "entity_merge" in sources  # FR-1.9
    # The source filter narrows the queue.
    only_merges = await list_review_queue(harness.sm, scope, source="entity_merge")
    assert only_merges and all(i.source == "entity_merge" for i in only_merges)


async def test_chunk_approve_makes_it_recallable_reject_does_not(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project_id, allowed_topics=["hr"])
    approved = await _needs_review_chunk(harness, project_id, logical_id="d1", kind="table_row")
    rejected = await _needs_review_chunk(harness, project_id, logical_id="d2", kind="table_row")

    assert (
        await resolve_chunk(
            harness.sm, scope, approved, approve=True, gateway=harness.gateway, tags=["hr"]
        )
        == "approved"
    )
    assert (
        await resolve_chunk(harness.sm, scope, rejected, approve=False, gateway=harness.gateway)
        == "rejected"
    )
    async with harness.sm() as session:
        ok = await session.get(models.Chunk, uuid.UUID(approved))
        assert (
            ok is not None
            and ok.needs_review is False
            and ok.embedding is not None
            and ok.tags == ["hr"]
        )
        no = await session.get(models.Chunk, uuid.UUID(rejected))
        # R26/R55: this used to assert `needs_review is True` — the vulnerable behaviour, written down
        # as the expectation. Rejecting is terminal (it leaves the queue) and the content stays out of
        # the index, marked so a publish redo cannot resurrect it.
        assert no is not None
        assert no.needs_review is False
        assert no.embedding is None
        assert REJECTED_TAG in no.tags
    # Idempotent: re-approving an already-resolved chunk is a no-op.
    assert (
        await resolve_chunk(harness.sm, scope, approved, approve=True, gateway=harness.gateway)
        == "already_resolved"
    )


async def test_merge_approve_applies_reject_keeps_separate(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project_id, allowed_topics=["hr"])
    proposal_id, _canonical, duplicate = await _pending_merge(harness, project_id)

    assert await resolve_merge(harness.sm, scope, proposal_id, approve=True) == "approved"
    async with harness.sm() as session:
        dup = await session.get(models.Entity, uuid.UUID(duplicate))
        assert dup is not None and dup.merged_into is not None  # merged (SPEC-09 effect)
    # Idempotent second resolution.
    assert await resolve_merge(harness.sm, scope, proposal_id, approve=True) == "already_resolved"

    # A rejected proposal leaves the entities separate.
    reject_id, _c2, dup2 = await _pending_merge(harness, project_id)
    assert await resolve_merge(harness.sm, scope, reject_id, approve=False) == "rejected"
    async with harness.sm() as session:
        d2 = await session.get(models.Entity, uuid.UUID(dup2))
        assert d2 is not None and d2.merged_into is None


async def test_queue_is_project_isolated(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_a = await harness.setup_project(unique_slug("acme"), TOPICS)
    project_b = await harness.setup_project(unique_slug("beta"), TOPICS)
    await _needs_review_chunk(harness, project_a, logical_id="d", kind="table_row")
    scope_b = harness.scope(project_b, allowed_topics=["hr"])
    assert await list_review_queue(harness.sm, scope_b) == []  # A's queue invisible to B (FR-12.5)
