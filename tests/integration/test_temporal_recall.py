"""Temporal recall against the real container (SPEC-13, FR-16.2/16.3/16.5).

Seeds claims with explicit validity windows and checks: `current` hides expired/superseded
knowledge and never presents it as current; `historical` reveals it (labelled with valid_to +
is_current=false); a per-topic hard_window hides old-but-not-expired claims in current and reveals
them historically; `as_of` returns the knowledge valid at that date. τ=0 isolates the temporal
filter from the (fake-embedding) semantic score.
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable

import pytest
from sqlalchemy import update

from rsc_brain.config.models import RecallConfig
from rsc_brain.mcp.tools import do_recall
from rsc_brain.recall.retriever import PgRetriever
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational import models

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("pricing", 0)]
NOW = dt.datetime.now(dt.UTC)


def _retriever(harness: Harness) -> PgRetriever:
    return PgRetriever(
        sessionmaker=harness.sm,
        gateway=harness.gateway,
        graph_store=AgeGraphStore(harness.sm),
        config=RecallConfig(tau=0.0, hybrid_enabled=True),
    )


async def _seed(
    harness: Harness,
    project_id: str,
    text: str,
    *,
    valid_from: dt.datetime | None,
    valid_to: dt.datetime | None,
) -> str:
    """A processed synthetic doc + an embedded, generally-tagged chunk + a claim with the given
    validity window. Returns the claim id."""
    embedding = (await harness.gateway.embed([text]))[0]
    async with harness.sm() as session:
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
            text=text,
            tags=["pricing"],
            embedding=embedding,
            needs_review=False,
        )
        session.add(chunk)
        await session.flush()
        claim = models.Claim(
            project_id=uuid.UUID(project_id),
            chunk_id=chunk.id,
            text=text,
            tags=["pricing"],
            credibility=0.6,
            valid_from=valid_from,
            valid_to=valid_to,
            embedding=embedding,
            source_document_id=doc.id,
        )
        session.add(claim)
        await session.flush()
        claim_id = str(claim.id)
        await session.commit()
        return claim_id


async def test_current_hides_expired_historical_reveals_it(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project_id, allowed_topics=["pricing"])
    await _seed(
        harness,
        project_id,
        "The pricing plan is 50 EUR",
        valid_from=NOW - dt.timedelta(days=400),
        valid_to=NOW - dt.timedelta(days=30),
    )  # expired
    await _seed(
        harness,
        project_id,
        "The pricing plan is 80 EUR now",
        valid_from=NOW - dt.timedelta(days=10),
        valid_to=None,
    )  # current
    retriever = _retriever(harness)

    # current: only the active plan; the expired one is gone, and the fragment is labelled current.
    current = await do_recall(retriever, harness.sm, scope, query="pricing plan EUR")
    assert current.found is True
    assert any("80 EUR" in f.text for f in current.fragments)
    assert not any("50 EUR" in f.text for f in current.fragments)
    assert all(f.is_current for f in current.fragments)

    # historical: the expired plan reappears, labelled with valid_to + is_current=false.
    hist = await do_recall(
        retriever, harness.sm, scope, query="pricing plan EUR", include_historical=True
    )
    expired = [f for f in hist.fragments if "50 EUR" in f.text]
    assert expired and expired[0].is_current is False and expired[0].valid_to is not None


async def test_hard_window_hides_old_claim_in_current(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project_id, allowed_topics=["pricing"])
    # A never-expired but 120-day-old pricing claim.
    await _seed(
        harness,
        project_id,
        "The pricing tier is Gold",
        valid_from=NOW - dt.timedelta(days=120),
        valid_to=None,
    )
    async with harness.sm() as session:  # pricing horizon: 90 days
        await session.execute(
            update(models.Topic)
            .where(models.Topic.project_id == uuid.UUID(project_id), models.Topic.slug == "pricing")
            .values(hard_window_days=90)
        )
        await session.commit()
    retriever = _retriever(harness)

    # current: outside the 90-day window → hidden.
    assert (await do_recall(retriever, harness.sm, scope, query="pricing tier Gold")).found is False
    # historical intent: the horizon does not apply → revealed.
    hist = await do_recall(
        retriever, harness.sm, scope, query="pricing tier Gold", include_historical=True
    )
    assert hist.found is True


async def test_as_of_returns_knowledge_valid_at_that_date(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project_id, allowed_topics=["pricing"])
    # Valid only during 2022.
    await _seed(
        harness,
        project_id,
        "The pricing was 40 EUR in 2022",
        valid_from=dt.datetime(2022, 1, 1, tzinfo=dt.UTC),
        valid_to=dt.datetime(2023, 1, 1, tzinfo=dt.UTC),
    )
    retriever = _retriever(harness)

    inside = await do_recall(
        retriever, harness.sm, scope, query="pricing 40 EUR", as_of="2022-06-01"
    )
    assert inside.found is True and any("40 EUR" in f.text for f in inside.fragments)
    # as_of after the window → not valid then.
    after = await do_recall(
        retriever, harness.sm, scope, query="pricing 40 EUR", as_of="2024-06-01"
    )
    assert after.found is False
