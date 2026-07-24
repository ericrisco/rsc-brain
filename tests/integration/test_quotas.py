"""Per-principal quotas against the real container (SPEC-11 C, FR-14.7).

A burst over the per-minute rate limit → RATE_LIMITED with retry_after; a daily write budget
exhausted → writes blocked; consumption is persisted and readable (the FR-13.7 data).
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable

import pytest

from rsc_brain.mcp.auth import RateLimitedError
from rsc_brain.mcp.quotas import QuotaConfig, QuotaService
from rsc_brain.scope import Principal, PrincipalType, ProjectScope

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

NOW = dt.datetime(2026, 1, 1, 12, 30, 15, tzinfo=dt.UTC)


def _agent(project_id: str) -> ProjectScope:
    return Principal(id=str(uuid.uuid4()), type=PrincipalType.AGENT).scope_for(project_id)


async def test_rate_limit_returns_retry_after(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), [])
    quotas = QuotaService(harness.sm, QuotaConfig(agent_rate_per_min=3))
    agent = _agent(project_id)

    # Three calls in the same minute window are allowed; the fourth trips the limit.
    for _ in range(3):
        await quotas.consume(agent, "recall", now=NOW)
    with pytest.raises(RateLimitedError) as exc:
        await quotas.consume(agent, "recall", now=NOW)
    assert exc.value.retry_after >= 1
    assert exc.value.code == "RATE_LIMITED"


async def test_daily_write_budget_blocks(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), [])
    quotas = QuotaService(harness.sm, QuotaConfig(agent_rate_per_min=1000, agent_daily_writes=2))
    agent = _agent(project_id)

    await quotas.consume(agent, "write", now=NOW)
    await quotas.consume(agent, "write", now=NOW)
    with pytest.raises(RateLimitedError):
        await quotas.consume(agent, "write", now=NOW)

    # Usage is persisted + readable (FR-13.7 data). recalls untouched.
    usage = await quotas.usage(agent, day=NOW.date())
    assert usage["writes"] >= 2
    assert usage["recalls"] == 0


async def test_humans_get_the_human_rate(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), [])
    quotas = QuotaService(harness.sm, QuotaConfig(agent_rate_per_min=1, human_rate_per_min=5))
    human = Principal(id=str(uuid.uuid4()), type=PrincipalType.HUMAN).scope_for(project_id)

    # A human is bound by the human limit (5), not the agent limit (1) — and has no daily budget.
    for _ in range(5):
        await quotas.consume(human, "recall", now=NOW)
    with pytest.raises(RateLimitedError):
        await quotas.consume(human, "recall", now=NOW)
