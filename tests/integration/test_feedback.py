"""Real report_feedback (SPEC-08 §3.4, AC-7) against the real container."""

from __future__ import annotations

import uuid
from collections.abc import Callable

import pytest

from rsc_brain.knowledge.feedback import apply_report_feedback
from rsc_brain.mcp.tools import do_report_feedback
from rsc_brain.scope import Principal, PrincipalType, ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.knowledge_store import KnowledgeStore
from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration


async def _insert_claim(harness: Harness, project_id: str, credibility: float) -> str:
    async with harness.sm() as session:
        claim = models.Claim(
            project_id=uuid.UUID(project_id),
            text="Acme SLA is 24 hours",
            subject="Acme SLA",
            credibility=credibility,
            tags=["general"],
        )
        session.add(claim)
        await session.flush()
        claim_id = str(claim.id)
        await session.commit()
    return claim_id


def _agent_scope(project_id: str) -> ProjectScope:
    return Principal(id="00000000-0000-0000-0000-0000000000ee", type=PrincipalType.AGENT).scope_for(
        project_id
    )


async def test_human_helpful_raises_and_wrong_below_threshold_disputes(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    scope = harness.scope(project)
    store = KnowledgeStore(harness.sm)

    good = await _insert_claim(harness, project, 0.5)
    await apply_report_feedback(store, scope, claim_ids=[good], signal="helpful")
    raised = await store.get_claim(scope, good)
    assert raised is not None and raised.credibility == pytest.approx(0.55)

    weak = await _insert_claim(harness, project, 0.25)
    result = await apply_report_feedback(store, scope, claim_ids=[weak], signal="wrong")
    assert result.disputed == [weak]
    disputed = await store.get_claim(scope, weak)
    assert disputed is not None and disputed.credibility < 0.3


async def test_agent_feedback_capped_and_never_disputes(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    agent = _agent_scope(project)
    store = KnowledgeStore(harness.sm)
    claim = await _insert_claim(harness, project, 0.5)

    # Many 'wrong' signals from one agent on one claim: total movement ≤ the daily cap (0.1).
    for _ in range(40):
        await apply_report_feedback(store, agent, claim_ids=[claim], signal="wrong")
    final = await store.get_claim(agent, claim)
    assert final is not None
    assert final.credibility >= 0.5 - 0.1 - 1e-9  # never moved more than the daily cap
    async with harness.sm() as session:
        row = await session.get(models.Claim, uuid.UUID(claim))
        assert row is not None and row.disputed is False  # agents never dispute


async def test_report_feedback_tool_applies_and_audits(
    build_harness: Callable[..., Harness],
) -> None:
    from rsc_brain.audit import query_audit

    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    scope = harness.scope(project)
    claim = await _insert_claim(harness, project, 0.5)

    result = await do_report_feedback(harness.sm, scope, claim_ids=[claim], signal="helpful")
    assert result.ok is True
    rows = await query_audit(harness.sm, project, action="report_feedback:helpful")
    assert rows and rows[0]["tool"] == "report_feedback"
