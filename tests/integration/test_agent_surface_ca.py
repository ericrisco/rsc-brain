"""PRD §5.14 acceptance suite for the agent surface (SPEC-11 D).

Covers the remaining literal ACs: an agent's repeated `wrong` feedback cannot move a claim more
than the daily cap (§5.14c, the SPEC-08 mechanism verified here); an agent's abstained recall
registers a gap attributed to `principal_type=agent` with NO hunt created in v0.2 (§5.14d); and
revoking an agent cuts its token <5s while its contributed claims keep their provenance (FR-14.9).
(§5.14a delegation + §5.14b idempotency live in test_agent_delegation / test_submit_knowledge.)
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Callable

import pytest
from sqlalchemy import func, select, update

from rsc_brain.identity.resolve import resolve_scope
from rsc_brain.identity.service import IdentityService
from rsc_brain.knowledge.feedback import apply_report_feedback
from rsc_brain.mcp.tools import do_recall, do_submit_knowledge
from rsc_brain.recall.retriever import PgRetriever
from rsc_brain.scope import Principal, PrincipalType, ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.knowledge_store import KnowledgeStore

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("general", 0)]


def _retriever(harness: Harness) -> PgRetriever:
    return PgRetriever(
        sessionmaker=harness.sm, gateway=harness.gateway, graph_store=AgeGraphStore(harness.sm)
    )


def _agent(project_id: str) -> ProjectScope:
    return Principal(
        id=str(uuid.uuid4()), type=PrincipalType.AGENT, allowed_topics=frozenset({"general"})
    ).scope_for(project_id)


async def _set_policy(harness: Harness, project_id: str, policy: str) -> None:
    async with harness.sm() as session:
        await session.execute(
            update(models.Project)
            .where(models.Project.id == uuid.UUID(project_id))
            .values(settings={"agent_writes": policy})
        )
        await session.commit()


async def test_agent_feedback_is_capped_5_14c(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    await _set_policy(harness, project_id, "direct")
    agent = _agent(project_id)
    submitted = await do_submit_knowledge(
        harness.sm,
        harness.gateway,
        agent,
        text="Support SLA is 24 hours for all customers.",
        idempotency_key="k1",
        tags=["general"],
    )
    claim_id = submitted.claim_ids[0]
    store = KnowledgeStore(harness.sm)
    before = (await store.get_claim(agent, claim_id)).credibility  # type: ignore[union-attr]

    # Hammer the same claim with agent `wrong` feedback; the daily cap bounds total movement, and
    # agent feedback NEVER disputes (SPEC-08 / §5.14c).
    for _ in range(50):
        result = await apply_report_feedback(store, agent, claim_ids=[claim_id], signal="wrong")
        assert result.disputed == []
    after = (await store.get_claim(agent, claim_id)).credibility  # type: ignore[union-attr]
    assert before - after <= 0.1 + 1e-6  # feedback_daily_cap


async def test_agent_gap_records_agent_and_makes_no_hunt_5_14d(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    agent = _agent(project_id)

    # Nothing ingested → the agent's recall abstains and registers a gap, audited as an agent.
    out = await do_recall(_retriever(harness), harness.sm, agent, query="who owns payroll")
    assert out.found is False

    async with harness.sm() as session:
        gap_count = await session.scalar(
            select(func.count())
            .select_from(models.Gap)
            .where(models.Gap.project_id == uuid.UUID(project_id))
        )
        hunt_count = await session.scalar(
            select(func.count())
            .select_from(models.Hunt)
            .where(models.Hunt.project_id == uuid.UUID(project_id))
        )
        audit_row = await session.scalar(
            select(models.AuditLog.principal_type).where(
                models.AuditLog.project_id == uuid.UUID(project_id),
                models.AuditLog.action == "recall",
            )
        )
    assert gap_count and gap_count >= 1
    assert hunt_count == 0  # v0.2: agent gaps never become hunts (hunting is SPEC-15)
    assert audit_row == "agent"


async def test_agent_revocation_preserves_provenance_fr_14_9(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    await _set_policy(harness, project_id, "direct")
    identity = IdentityService(harness.sm)
    inv = await identity.invite_user(f"{unique_slug('owner')}@example.com", role="admin")
    owner = await identity.accept_invitation(inv.token, "owner-password-123456")
    agent_id = await identity.create_agent(project_id, owner, "bot", allowed_topics=("general",))
    agent_pat = await identity.issue_agent_pat(agent_id, name="svc")

    resolved = await resolve_scope(harness.sm, agent_pat.token)
    assert resolved is not None
    contributed = await do_submit_knowledge(
        harness.sm,
        harness.gateway,
        resolved,
        text="The office is closed on public holidays.",
        idempotency_key="k1",
        tags=["general"],
    )
    assert contributed.claim_ids

    # Revoke the agent: its token dies < 5s, but the claim it contributed remains.
    start = time.monotonic()
    await identity.deactivate_agent(agent_id)
    assert await resolve_scope(harness.sm, agent_pat.token) is None
    assert time.monotonic() - start < 5.0
    async with harness.sm() as session:
        still_there = await session.get(models.Claim, uuid.UUID(contributed.claim_ids[0]))
        assert still_there is not None  # provenance intact — contributions are not deleted
