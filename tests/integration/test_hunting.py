"""Hunt engine against the real container (SPEC-15, E7 — the human-in-the-loop circuit).

Covers: topic-overlap routing + NO_OWNER; the human-recurrence trigger (agent gaps never count,
FR-14.6); the magic-link answer → cred 0.95 claim + gap closed + RESOLVED + single-use token;
quiet_hours (never send); 72h → retry → escalate; and the anti-spam caps.
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable

import pytest
from sqlalchemy import func, select

from rsc_brain.hunting.channels import NullChannel
from rsc_brain.hunting.directory import PersonDirectory
from rsc_brain.hunting.service import HuntService
from rsc_brain.hunting.state_machine import HuntState
from rsc_brain.mcp.tools import do_recall
from rsc_brain.recall.retriever import PgRetriever
from rsc_brain.scope import Principal, PrincipalType, ProjectScope
from rsc_brain.skills.frontmatter import SkillFrontmatter
from rsc_brain.skills.store import SkillStore
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational import models

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("hr", 0)]
BASE = dt.datetime(2026, 3, 1, 15, 0, tzinfo=dt.UTC)  # 15:00 UTC — outside a night quiet window


class Clock:
    def __init__(self, now: dt.datetime) -> None:
        self.now = now

    def __call__(self) -> dt.datetime:
        return self.now


def _retriever(harness: Harness) -> PgRetriever:
    return PgRetriever(
        sessionmaker=harness.sm, gateway=harness.gateway, graph_store=AgeGraphStore(harness.sm)
    )


def _human(project_id: str) -> ProjectScope:
    return Principal(
        id="11111111-1111-1111-1111-111111111111",
        type=PrincipalType.HUMAN,
        allowed_topics=frozenset({"hr"}),
    ).scope_for(project_id)


def _agent(project_id: str) -> ProjectScope:
    return Principal(
        id="22222222-2222-2222-2222-222222222222",
        type=PrincipalType.AGENT,
        allowed_topics=frozenset({"hr"}),
    ).scope_for(project_id)


async def _gap_id(harness: Harness, project_id: str, query: str) -> str:
    from rsc_brain.recall.gaps import query_hash

    async with harness.sm() as session:
        gid = await session.scalar(
            select(models.Gap.id).where(
                models.Gap.project_id == uuid.UUID(project_id),
                models.Gap.query_hash == query_hash(query),
            )
        )
    return str(gid)


async def test_gap_recurrence_triggers_hunt_and_answer_becomes_claim(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = _human(project_id)
    await PersonDirectory(harness.sm).add(
        scope, name="Alice", channels={"email": "alice@example.com"}, topics=["hr"]
    )
    async with harness.sm() as session:
        topic_id = await session.scalar(
            select(models.Topic.id).where(
                models.Topic.project_id == uuid.UUID(project_id), models.Topic.slug == "hr"
            )
        )
    assert topic_id is not None
    await SkillStore(harness.sm).create(
        scope,
        SkillFrontmatter(
            slug="hunting-answer-hook",
            title="Hunting answer hook",
            tags=["hr"],
            depends_on=[str(topic_id)],
            state="active",
        ),
        "body",
    )
    retriever = _retriever(harness)
    query = "who owns payroll approvals"
    for _ in range(3):  # 3 human denied recalls in the window
        await do_recall(retriever, harness.sm, scope, query=query, topics_hint=["hr"])
    gap_id = await _gap_id(harness, project_id, query)

    channel = NullChannel()
    svc = HuntService(harness.sm, channel=channel, gateway=harness.gateway, clock=Clock(BASE))
    outcome = await svc.maybe_hunt_for_gap(scope, gap_id, threshold=3)
    assert outcome is not None and outcome.state == HuntState.AWAITING_ANSWER
    assert outcome.person_id and outcome.magic_token
    assert channel.sent and channel.sent[0].magic_link  # the question went out

    # The person answers via the one-time link → a cred-0.95 claim + gap closed + RESOLVED.
    answered = await svc.answer_via_magic_link(outcome.magic_token, "Alice in HR owns payroll.")
    assert answered is not None and answered.state == HuntState.RESOLVED
    async with harness.sm() as session:
        claim = await session.scalar(
            select(models.Claim).where(
                models.Claim.project_id == uuid.UUID(project_id),
                models.Claim.text == "Alice in HR owns payroll.",
            )
        )
        assert claim is not None and float(claim.credibility) == 0.95
        gap = await session.get(models.Gap, uuid.UUID(gap_id))
        assert gap is not None and gap.status == "resolved"
    assert (await SkillStore(harness.sm).get(scope, "hunting-answer-hook")).stale is True  # type: ignore[union-attr]

    # The magic link is single-use.
    assert await svc.answer_via_magic_link(outcome.magic_token, "again") is None


async def test_agent_gap_never_triggers(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    await PersonDirectory(harness.sm).add(_human(project_id), name="A", topics=["hr"])
    retriever = _retriever(harness)
    query = "agent loop question"
    for _ in range(5):  # an agent hammering the same gap
        await do_recall(retriever, harness.sm, _agent(project_id), query=query, topics_hint=["hr"])
    gap_id = await _gap_id(harness, project_id, query)
    svc = HuntService(harness.sm, gateway=harness.gateway, clock=Clock(BASE))
    assert await svc.maybe_hunt_for_gap(_human(project_id), gap_id, threshold=3) is None


async def test_no_owner_when_no_topic_overlap(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = _human(project_id)
    channel = NullChannel()
    svc = HuntService(harness.sm, channel=channel, clock=Clock(BASE))
    outcome = await svc.create_manual(scope, question="who owns X", topics=["nobody-owns-this"])
    assert outcome.state == HuntState.NO_OWNER
    assert any(m.channel == "admin" for m in channel.sent)  # admin alerted


async def test_quiet_hours_defer_the_send(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = _human(project_id)
    await PersonDirectory(harness.sm).add(
        scope,
        name="Night",
        channels={"email": "n@example.com"},
        topics=["hr"],
        quiet_hours={"start": "08:00", "end": "20:00"},  # BASE 15:00 is inside → quiet
    )
    channel = NullChannel()
    clock = Clock(BASE)
    svc = HuntService(harness.sm, channel=channel, clock=clock)
    outcome = await svc.create_manual(scope, question="q", topics=["hr"])

    # R28: parked at SCHEDULED, the state the documented machine always had for this
    # (`CONSENT_REQUESTED → [SCHEDULED →] AWAITING_ANSWER`) and nothing implemented. It used to be
    # recorded as AWAITING_ANSWER, so the 72h clock ran on a question nobody had been asked.
    assert outcome.state == HuntState.SCHEDULED
    assert outcome.delivered is False
    assert channel.sent == []  # NEVER sent during quiet hours
    async with harness.sm() as session:
        parked = await session.get(models.Hunt, uuid.UUID(outcome.hunt_id))
        assert parked is not None
        assert parked.magic_token_hash is None, "a token nobody was told must not be live"
        assert parked.expires_at is None, "the deadline starts when the question is asked"

    # Once the window closes the scheduled send delivers it and the hunt starts awaiting.
    clock.now = BASE + dt.timedelta(hours=6)  # 21:00, outside 08:00-20:00
    assert await svc.send_scheduled(scope) == [outcome.hunt_id]
    assert len(channel.sent) == 1
    async with harness.sm() as session:
        sent = await session.get(models.Hunt, uuid.UUID(outcome.hunt_id))
        assert sent is not None
        assert sent.state == HuntState.AWAITING_ANSWER.value
        assert sent.magic_token_hash is not None
        assert sent.expires_at is not None


async def test_expiry_retries_once_then_escalates(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = _human(project_id)
    await PersonDirectory(harness.sm).add(scope, name="A", channels={"email": "a@x"}, topics=["hr"])
    clock = Clock(BASE)
    svc = HuntService(harness.sm, channel=NullChannel(), clock=clock)
    outcome = await svc.create_manual(scope, question="q", topics=["hr"])

    clock.now = BASE + dt.timedelta(hours=73)  # past the 72h deadline → one retry
    assert await svc.expire_due(scope) == [outcome.hunt_id]
    async with harness.sm() as session:
        hunt = await session.get(models.Hunt, uuid.UUID(outcome.hunt_id))
        assert (
            hunt is not None and hunt.state == HuntState.AWAITING_ANSWER.value and hunt.retries == 1
        )

    clock.now = BASE + dt.timedelta(hours=200)  # still no answer → escalate (terminal EXPIRED)
    await svc.expire_due(scope)
    async with harness.sm() as session:
        hunt = await session.get(models.Hunt, uuid.UUID(outcome.hunt_id))
        assert hunt is not None and hunt.state == HuntState.EXPIRED.value


async def test_anti_spam_caps_open_hunts_per_person(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = _human(project_id)
    await PersonDirectory(harness.sm).add(scope, name="A", channels={"email": "a@x"}, topics=["hr"])
    svc = HuntService(harness.sm, channel=NullChannel(), clock=Clock(BASE), max_open_per_person=3)

    for _ in range(3):
        assert (await svc.create_manual(scope, question="q", topics=["hr"])).throttled is False
    fourth = await svc.create_manual(scope, question="q", topics=["hr"])
    assert fourth.throttled is True  # the 4th open hunt is refused
    async with harness.sm() as session:
        awaiting = await session.scalar(
            select(func.count())
            .select_from(models.Hunt)
            .where(
                models.Hunt.project_id == uuid.UUID(project_id),
                models.Hunt.state == HuntState.AWAITING_ANSWER.value,
            )
        )
        assert int(awaiting or 0) == 3
