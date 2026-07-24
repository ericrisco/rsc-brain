"""Anti-spam under concurrent hunt creation (SPEC-15 AC#7 / DONE checklist).

The per-person open cap must hold even when many hunts are opened at once — a naive
count-then-insert races. A per-person transactional advisory lock serialises the check with the
insert, so exactly ``max_open_per_person`` reach AWAITING_ANSWER and the rest are parked ROUTED.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid
from collections.abc import Callable

import pytest
from sqlalchemy import func, select

from rsc_brain.hunting.channels import NullChannel
from rsc_brain.hunting.directory import PersonDirectory
from rsc_brain.hunting.service import HuntService
from rsc_brain.hunting.state_machine import HuntState
from rsc_brain.scope import Principal, PrincipalType, ProjectScope
from rsc_brain.stores.relational import models

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

BASE = dt.datetime(2026, 3, 1, 15, 0, tzinfo=dt.UTC)


class _Clock:
    def __init__(self, now: dt.datetime) -> None:
        self.now = now

    def __call__(self) -> dt.datetime:
        return self.now


def _human(project_id: str) -> ProjectScope:
    return Principal(
        id="11111111-1111-1111-1111-111111111111",
        type=PrincipalType.HUMAN,
        allowed_topics=frozenset({"hr"}),
    ).scope_for(project_id)


async def test_anti_spam_holds_under_concurrent_creation(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), [("hr", 0)])
    scope = _human(project_id)
    await PersonDirectory(harness.sm).add(scope, name="A", channels={"email": "a@x"}, topics=["hr"])
    # A high weekly cap so the *open* cap (3) is the binding constraint under concurrency.
    svc = HuntService(
        harness.sm,
        channel=NullChannel(),
        clock=_Clock(BASE),
        max_open_per_person=3,
        max_per_week=100,
    )

    outcomes = await asyncio.gather(
        *(svc.create_manual(scope, question="q", topics=["hr"]) for _ in range(10))
    )
    awaiting = [o for o in outcomes if o.state == HuntState.AWAITING_ANSWER]
    throttled = [o for o in outcomes if o.throttled]
    assert len(awaiting) == 3  # never more than the cap, despite 10 concurrent opens
    assert len(throttled) == 7

    async with harness.sm() as session:
        count = await session.scalar(
            select(func.count())
            .select_from(models.Hunt)
            .where(
                models.Hunt.project_id == uuid.UUID(project_id),
                models.Hunt.state == HuntState.AWAITING_ANSWER.value,
            )
        )
        assert int(count or 0) == 3  # the database agrees
