"""Contradiction detect/resolve/cache against the real container (SPEC-08 §5.3/5.5, AC 8/9)."""

from __future__ import annotations

import uuid
from collections.abc import Callable

import pytest
from sqlalchemy import select

from rsc_brain.knowledge.contradictions import ContradictionResolver
from rsc_brain.knowledge.judge import HeuristicJudge, JudgeResult
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.knowledge_store import KnowledgeStore
from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

# Two near-identical embeddings (cosine ≈ 1.0 > 0.75) so the pair is a candidate.
EMB = [1.0] * 8 + [0.0] * 1016


class _CountingJudge(HeuristicJudge):
    def __init__(self) -> None:
        super().__init__()
        self.calls = 0

    async def judge(self, a: str, b: str) -> JudgeResult:
        self.calls += 1
        return await super().judge(a, b)


async def _insert_claim(
    harness: Harness, project_id: str, *, text: str, subject: str, credibility: float
) -> str:
    async with harness.sm() as session:
        claim = models.Claim(
            project_id=uuid.UUID(project_id),
            text=text,
            subject=subject,
            credibility=credibility,
            tags=["general"],
            embedding=EMB,
            source_document_id=uuid.UUID(project_id),  # any uuid; we fetch by id
        )
        session.add(claim)
        await session.flush()
        claim_id = str(claim.id)
        await session.commit()
    return claim_id


def _resolver(harness: Harness, judge: HeuristicJudge) -> ContradictionResolver:
    return ContradictionResolver(
        store=KnowledgeStore(harness.sm), graph=AgeGraphStore(harness.sm), judge=judge
    )


async def test_contradiction_supersedes_lower_credibility(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    scope = harness.scope(project)
    a = await _insert_claim(
        harness, project, text="The Acme SLA is 24 hours", subject="Acme SLA", credibility=0.8
    )
    b = await _insert_claim(
        harness, project, text="The Acme SLA is not 24 hours", subject="Acme SLA", credibility=0.5
    )
    store = KnowledgeStore(harness.sm)

    summary = await _resolver(harness, HeuristicJudge()).resolve_claims(
        scope, await store.claims_by_ids(scope, [a, b])
    )
    assert summary.contradictions == 1
    assert summary.superseded == [b]  # the lower-credibility claim loses

    winner = await store.get_claim(scope, a)
    loser = await store.get_claim(scope, b)
    assert winner is not None and winner.credibility == pytest.approx(0.9)  # 0.8 + 0.1
    assert loser is not None and loser.credibility == pytest.approx(0.25)  # 0.5 * 0.5
    assert loser.valid_to is not None  # superseded, not deleted (FR-5.5)


async def test_tie_marks_both_disputed(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    scope = harness.scope(project)
    a = await _insert_claim(
        harness, project, text="The Acme SLA is 24 hours", subject="Acme SLA", credibility=0.55
    )
    b = await _insert_claim(
        harness, project, text="The Acme SLA is not 24 hours", subject="Acme SLA", credibility=0.5
    )
    store = KnowledgeStore(harness.sm)
    summary = await _resolver(harness, HeuristicJudge()).resolve_claims(
        scope, await store.claims_by_ids(scope, [a, b])
    )
    assert set(summary.disputed) == {a, b}
    async with harness.sm() as session:
        rows = await session.scalars(
            select(models.Claim).where(models.Claim.id.in_([uuid.UUID(a), uuid.UUID(b)]))
        )
        claims = list(rows)
        assert claims and all(c.disputed for c in claims)
        assert all(c.valid_to is None for c in claims)  # a tie supersedes neither


async def test_verdict_is_cached(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    scope = harness.scope(project)
    # Use a tie (|Δcred| < 0.15) so neither claim is superseded — both stay active and the same
    # pair is re-examined on the second pass, proving the cache (not a vanished claim).
    a = await _insert_claim(
        harness, project, text="Acme SLA is 24 hours", subject="Acme SLA", credibility=0.55
    )
    b = await _insert_claim(
        harness, project, text="Acme SLA is not 24 hours", subject="Acme SLA", credibility=0.5
    )
    store = KnowledgeStore(harness.sm)
    judge = _CountingJudge()
    resolver = _resolver(harness, judge)

    await resolver.resolve_claims(scope, await store.claims_by_ids(scope, [a, b]))
    assert judge.calls == 1
    # The verdict is cached; a re-check of the same pair does not call the judge again.
    judge.calls = 0
    await resolver.resolve_claims(scope, await store.claims_by_ids(scope, [a, b]))
    assert judge.calls == 0
