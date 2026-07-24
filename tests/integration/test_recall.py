"""Recall against real Postgres+AGE+pgvector (SPEC-06 §5): provenance, abstention+gap, D13
holds through recall, cross-project disjoint. Publishes knowledge via the SPEC-05 harness, then
recalls with a PgRetriever over the same stores + deterministic gateway."""

from __future__ import annotations

from collections.abc import Callable

import pytest

from rsc_brain.config.models import RecallConfig
from rsc_brain.recall.gaps import get_gap_count
from rsc_brain.recall.retriever import PgRetriever
from rsc_brain.stores.age_graph_store import AgeGraphStore
from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("general", 0), ("engineering", 0), ("hr", 3)]
DOC = b"# Engineering handbook\n\nThe deployment pipeline uses Docker containers and runs in CI.\n"


def _retriever(harness: Harness, config: RecallConfig | None = None) -> PgRetriever:
    return PgRetriever(
        sessionmaker=harness.sm,
        gateway=harness.gateway,
        graph_store=AgeGraphStore(harness.sm),
        config=config or RecallConfig(),
    )


async def _publish(harness: Harness, project_id: str, *, policy: str, tags: list[str]) -> str:
    scope = harness.scope(project_id, allowed_topics=tags)
    await harness.repo.create_source(
        scope, name="src", type_="folder", policy=policy, default_tags=tags
    )
    outcome = await harness.service.ingest_bytes(scope, DOC, filename="hb.md", source="src")
    return outcome.document_id


async def test_recall_returns_fragments_with_provenance(
    build_harness: Callable[..., Harness],
    make_completion: Callable[..., object],
) -> None:
    harness = build_harness(
        completion=make_completion(
            entities=[{"name": "pipeline", "type": "system", "aliases": []}],
            claims=[
                {"text": "runs in CI", "subject": "pipeline", "predicate": "runs", "object": "CI"}
            ],
            tags=["engineering"],
        )
    )
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    await _publish(harness, project, policy="source_tags", tags=["engineering"])
    scope = harness.scope(project, allowed_topics=["engineering", "general"])

    result = await _retriever(harness).recall(scope, "deployment pipeline", top_k=8)
    assert result.found is True
    assert result.fragments
    fragment = result.fragments[0]
    assert fragment.untrusted_data is True
    assert fragment.provenance["document"]  # a title/id present
    assert "tags" in fragment.provenance and "claim_ids" in fragment.provenance


async def test_abstains_below_tau_and_registers_gap(
    build_harness: Callable[..., Harness],
    make_completion: Callable[..., object],
) -> None:
    harness = build_harness(completion=make_completion(tags=["engineering"]))
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    await _publish(harness, project, policy="source_tags", tags=["engineering"])
    # Scope only allows 'hr' — no engineering chunk is visible → abstain, indistinguishable.
    scope = harness.scope(project, allowed_topics=["hr"])
    retriever = _retriever(harness)

    for _ in range(3):
        result = await retriever.recall(scope, "how does deployment work", top_k=8)
        assert result.found is False
        assert result.gap_registered is True
    assert await get_gap_count(harness.sm, scope, "how does deployment work") == 3


async def test_d13_manual_doc_not_recallable_until_approved(
    build_harness: Callable[..., Harness],
    make_completion: Callable[..., object],
) -> None:
    harness = build_harness(
        completion=make_completion(
            claims=[
                {"text": "runs in CI", "subject": "pipeline", "predicate": "runs", "object": "CI"}
            ],
            tags=["engineering"],
        )
    )
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["engineering", "general"])
    await harness.repo.create_source(
        scope, name="manual", type_="folder", policy="manual", default_tags=["engineering"]
    )
    outcome = await harness.service.ingest_bytes(scope, DOC, filename="hb.md", source="manual")
    retriever = _retriever(harness)

    # Pending approval → nothing embedded → not recallable.
    pending = await retriever.recall(scope, "deployment pipeline", top_k=8)
    assert pending.found is False

    await harness.service.approve(scope, outcome.document_id, approver="cli")
    published = await retriever.recall(scope, "deployment pipeline", top_k=8)
    assert published.found is True


async def test_cross_project_recall_is_disjoint(
    build_harness: Callable[..., Harness],
    make_completion: Callable[..., object],
) -> None:
    harness = build_harness(completion=make_completion(tags=["engineering"]))
    acme = await harness.setup_project(unique_slug("acme"), TOPICS)
    globex = await harness.setup_project(unique_slug("globex"), TOPICS)
    await _publish(harness, acme, policy="source_tags", tags=["engineering"])

    # A scope for globex (which has nothing published) sees no acme knowledge.
    globex_scope = harness.scope(globex, allowed_topics=["engineering", "general"])
    result = await _retriever(harness).recall(globex_scope, "deployment pipeline", top_k=8)
    assert result.found is False
