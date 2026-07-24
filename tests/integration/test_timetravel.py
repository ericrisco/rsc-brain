"""Time-travel: `timeline` + `as_of` reconstruction over seeded history (SPEC-17, FR-16.4/16.6).

`timeline` returns the ordered evolution of claims for a topic/entity, permission- and
project-scoped in the query (a topic the caller can't see is indistinguishable from nonexistent).
`as_of` recall reconstructs the state valid at a date across successive versions. No historical
entry is ever presented as current without its `valid_to`. AC#5: the bitemporal index is used.
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable

import pytest
from sqlalchemy import text

from rsc_brain.config.models import RecallConfig
from rsc_brain.mcp.tools import do_recall, do_timeline
from rsc_brain.recall.retriever import PgRetriever
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational import models

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("hr", 0), ("general", 0)]


def _retriever(harness: Harness) -> PgRetriever:
    return PgRetriever(
        sessionmaker=harness.sm,
        gateway=harness.gateway,
        graph_store=AgeGraphStore(harness.sm),
        config=RecallConfig(tau=0.0, hybrid_enabled=True),
    )


async def _seed_version(
    harness: Harness,
    project_id: str,
    text_: str,
    *,
    subject: str,
    tags: list[str],
    valid_from: dt.datetime | None,
    valid_to: dt.datetime | None,
    with_chunk: bool = True,
) -> str:
    """A claim (optionally with an embedded chunk, for recall) at a given validity window."""
    async with harness.sm() as session:
        chunk_id = None
        if with_chunk:
            embedding = (await harness.gateway.embed([text_]))[0]
            doc = models.Document(
                project_id=uuid.UUID(project_id),
                logical_id=f"seed-{uuid.uuid4().hex[:8]}",
                checksum=f"seed-{uuid.uuid4().hex}",
                status="processed",
            )
            session.add(doc)
            await session.flush()
            chunk = models.Chunk(
                project_id=uuid.UUID(project_id),
                document_id=doc.id,
                kind="prose",
                text=text_,
                tags=tags,
                embedding=embedding,
                needs_review=False,
            )
            session.add(chunk)
            await session.flush()
            chunk_id = chunk.id
        claim = models.Claim(
            project_id=uuid.UUID(project_id),
            chunk_id=chunk_id,
            text=text_,
            subject=subject,
            tags=tags,
            credibility=0.6,
            valid_from=valid_from,
            valid_to=valid_to,
        )
        session.add(claim)
        await session.flush()
        claim_id = str(claim.id)
        await session.commit()
        return claim_id


async def _seed_three_eras(harness: Harness, project_id: str, *, with_chunk: bool = True) -> None:
    """The vacation policy over three eras — 2022, 2023, and current (2024→)."""
    await _seed_version(
        harness,
        project_id,
        "Vacation was 20 days in 2022",
        subject="vacation policy",
        tags=["hr"],
        valid_from=dt.datetime(2022, 1, 1, tzinfo=dt.UTC),
        valid_to=dt.datetime(2023, 1, 1, tzinfo=dt.UTC),
        with_chunk=with_chunk,
    )
    await _seed_version(
        harness,
        project_id,
        "Vacation was 23 days in 2023",
        subject="vacation policy",
        tags=["hr"],
        valid_from=dt.datetime(2023, 1, 1, tzinfo=dt.UTC),
        valid_to=dt.datetime(2024, 1, 1, tzinfo=dt.UTC),
        with_chunk=with_chunk,
    )
    await _seed_version(
        harness,
        project_id,
        "Vacation is 25 days now",
        subject="vacation policy",
        tags=["hr"],
        valid_from=dt.datetime(2024, 1, 1, tzinfo=dt.UTC),
        valid_to=None,
        with_chunk=with_chunk,
    )


async def test_timeline_returns_ordered_evolution(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project_id, allowed_topics=["hr"])
    await _seed_three_eras(harness, project_id, with_chunk=False)

    out = await do_timeline(harness.sm, scope, topic="hr")
    assert out.found is True
    texts = [e.text for e in out.entries]
    assert texts == [
        "Vacation was 20 days in 2022",
        "Vacation was 23 days in 2023",
        "Vacation is 25 days now",
    ]  # oldest-first
    # AC#3: every non-current entry is labelled with its valid_to; the latest is current.
    assert all(e.valid_to is not None and not e.is_current for e in out.entries[:2])
    assert out.entries[-1].is_current and out.entries[-1].valid_to is None


async def test_timeline_by_entity(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project_id, allowed_topics=["hr"])
    await _seed_three_eras(harness, project_id, with_chunk=False)

    out = await do_timeline(harness.sm, scope, entity="Vacation Policy")  # case-insensitive
    assert out.found is True and len(out.entries) == 3


async def test_timeline_respects_permissions(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    await _seed_three_eras(harness, project_id, with_chunk=False)
    # A caller without the `hr` topic gets an empty timeline — indistinguishable from nonexistent.
    scope = harness.scope(project_id, allowed_topics=["general"])
    out = await do_timeline(harness.sm, scope, topic="hr")
    assert out.found is False and out.entries == []


async def test_timeline_cross_project_isolation(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_a = await harness.setup_project(unique_slug("acme"), TOPICS)
    project_b = await harness.setup_project(unique_slug("beta"), TOPICS)
    await _seed_three_eras(harness, project_a, with_chunk=False)
    # Project B's scope sees none of project A's timeline (FR-12.5).
    scope_b = harness.scope(project_b, allowed_topics=["hr"])
    out = await do_timeline(harness.sm, scope_b, topic="hr")
    assert out.found is False


async def test_as_of_reconstructs_the_right_era(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project_id, allowed_topics=["hr"])
    await _seed_three_eras(harness, project_id, with_chunk=True)
    retriever = _retriever(harness)

    at_2023 = await do_recall(
        retriever, harness.sm, scope, query="vacation days", as_of="2023-06-01"
    )
    assert at_2023.found is True
    assert any("23 days" in f.text for f in at_2023.fragments)
    assert not any("20 days" in f.text or "25 days" in f.text for f in at_2023.fragments)
    # AC#3: nothing valid-until-the-past is presented as current without its valid_to.
    for fragment in at_2023.fragments:
        assert fragment.is_current is False and fragment.valid_to is not None


async def test_timeline_as_of_narrows_to_the_snapshot(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project_id, allowed_topics=["hr"])
    await _seed_three_eras(harness, project_id, with_chunk=False)

    out = await do_timeline(harness.sm, scope, topic="hr", as_of="2023-06-01")
    assert [e.text for e in out.entries] == ["Vacation was 23 days in 2023"]


async def test_as_of_latency_benchmark_runs(build_harness: Callable[..., Harness]) -> None:
    # AC#4: as_of reconstruction latency is measurable on the same footing as the D1 benchmark.
    # Scaled-down + reproducible here; the 1M-edge run is the documented manual job (SPEC-09 D1).
    from evals.graph_benchmark import benchmark_as_of

    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project_id, allowed_topics=["hr"])
    await _seed_three_eras(harness, project_id, with_chunk=True)

    result = await benchmark_as_of(
        _retriever(harness), scope, query="vacation days", as_of=dt.date(2023, 6, 1), iterations=5
    )
    assert result.iterations == 5
    assert result.p50_ms >= 0.0 and result.p95_ms >= result.p50_ms


async def test_bitemporal_index_is_used(build_harness: Callable[..., Harness]) -> None:
    # AC#5: the (project_id, valid_from, valid_to) index backs the time-travel query.
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    await _seed_three_eras(harness, project_id, with_chunk=False)
    async with harness.sm() as session:
        plan = await session.execute(
            text(
                "EXPLAIN SELECT id FROM claims WHERE project_id = :pid "
                "AND valid_from <= now() ORDER BY valid_from"
            ),
            {"pid": project_id},
        )
        explanation = "\n".join(row[0] for row in plan.all())
    assert "ix_claims_project_id_valid" in explanation
