"""submit_knowledge against the real container (SPEC-11 B, FR-14.4 + §5.14b).

Per-project ``agent_writes`` policy: quarantine (default) → needs_review, NOT recallable until
validated; direct → active + recallable, credibility ≤0.6; off → rejected for agents. Writes are
idempotent — a retry with the same key never creates a second claim.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable

import pytest
from sqlalchemy import func, select, update

from rsc_brain.mcp.tools import do_recall, do_submit_knowledge
from rsc_brain.recall.retriever import PgRetriever
from rsc_brain.scope import Principal, PrincipalType, ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational import models

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("general", 0)]
TEXT = "The remote work policy allows three days from home each week."
QUERY = "remote work policy days from home"


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


async def _claim_count(harness: Harness, project_id: str) -> int:
    async with harness.sm() as session:
        total = await session.scalar(
            select(func.count())
            .select_from(models.Claim)
            .where(models.Claim.project_id == uuid.UUID(project_id))
        )
        return int(total or 0)


async def test_quarantine_default_is_not_recallable(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)  # no policy set → default
    agent = _agent(project_id)

    result = await do_submit_knowledge(
        harness.sm, harness.gateway, agent, text=TEXT, idempotency_key="k1", tags=["general"]
    )
    assert result.status == "quarantined"
    assert result.ok is True
    assert len(result.claim_ids) == 1

    # A quarantined submission is invisible to recall (same in-query gate as an unapproved doc).
    recalled = await do_recall(_retriever(harness), harness.sm, agent, query=QUERY)
    assert recalled.found is False


async def test_direct_policy_is_recallable_and_capped(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    await _set_policy(harness, project_id, "direct")
    agent = _agent(project_id)

    result = await do_submit_knowledge(
        harness.sm, harness.gateway, agent, text=TEXT, idempotency_key="k1", tags=["general"]
    )
    assert result.status == "active"
    recalled = await do_recall(_retriever(harness), harness.sm, agent, query=QUERY)
    assert recalled.found is True
    assert all(f.credibility <= 0.6 for f in recalled.fragments)  # never authoritative


async def test_off_policy_rejects_agents(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    await _set_policy(harness, project_id, "off")
    agent = _agent(project_id)

    result = await do_submit_knowledge(
        harness.sm, harness.gateway, agent, text=TEXT, idempotency_key="k1"
    )
    assert result.status == "rejected"
    assert result.ok is False
    assert await _claim_count(harness, project_id) == 0


async def test_idempotent_write_does_not_duplicate(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    agent = _agent(project_id)

    first = await do_submit_knowledge(
        harness.sm, harness.gateway, agent, text=TEXT, idempotency_key="dup", tags=["general"]
    )
    second = await do_submit_knowledge(
        harness.sm, harness.gateway, agent, text=TEXT, idempotency_key="dup", tags=["general"]
    )
    assert first.claim_ids == second.claim_ids  # §5.14b — same key, same claims
    assert await _claim_count(harness, project_id) == 1  # exactly one claim, no duplicate

    # A missing idempotency_key is rejected outright.
    no_key = await do_submit_knowledge(
        harness.sm, harness.gateway, agent, text=TEXT, idempotency_key=""
    )
    assert no_key.status == "rejected"
