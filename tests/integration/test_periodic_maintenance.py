"""Production-reachable lifecycle maintenance against real PostgreSQL (AUDIT-108)."""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid
from collections.abc import Callable

import pytest
from sqlalchemy import func, select

from rsc_brain.hunting.channels import NullChannel, OutboundMessage
from rsc_brain.hunting.directory import PersonDirectory
from rsc_brain.hunting.service import HuntService
from rsc_brain.hunting.state_machine import HuntState
from rsc_brain.maintenance import MaintenanceConfig, run_daily_maintenance, run_hunting_maintenance
from rsc_brain.recall.gaps import GAP_STATUS_OPEN, query_hash
from rsc_brain.skills.autocreate import prompt_idle_skills, propose_skills_from_gaps
from rsc_brain.skills.frontmatter import SkillFrontmatter
from rsc_brain.skills.store import SkillStore
from rsc_brain.stores.relational import models

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

BASE = dt.datetime(2026, 8, 20, 0, 0, tzinfo=dt.UTC)


class Clock:
    def __init__(self, now: dt.datetime) -> None:
        self.now = now

    def __call__(self) -> dt.datetime:
        return self.now


class FailingChannel:
    @property
    def name(self) -> str:
        return "failing"

    async def send(self, message: object) -> None:
        del message
        raise RuntimeError("delivery unavailable")


class RecordingSlackChannel:
    def __init__(self) -> None:
        self.sent: list[OutboundMessage] = []

    @property
    def name(self) -> str:
        return "slack"

    async def send(self, message: OutboundMessage) -> None:
        self.sent.append(message)


async def test_hunting_job_delivers_scheduled_and_retries_due_across_projects(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_a = await harness.setup_project(unique_slug("scheduled"), [("hr", 0)])
    project_b = await harness.setup_project(unique_slug("due"), [("ops", 0)])
    scope_a = harness.scope(project_a, allowed_topics=["hr"])
    scope_b = harness.scope(project_b, allowed_topics=["ops"])
    await PersonDirectory(harness.sm).add(
        scope_a,
        name="Quiet owner",
        channels={"email": "quiet@example.com"},
        topics=["hr"],
        quiet_hours={"start": "00:00", "end": "01:00"},
    )
    await PersonDirectory(harness.sm).add(
        scope_b,
        name="Due owner",
        channels={"email": "due@example.com"},
        topics=["ops"],
    )
    setup_channel = NullChannel()
    setup_clock = Clock(BASE)
    service = HuntService(harness.sm, channel=setup_channel, clock=setup_clock)
    scheduled = await service.create_manual(scope_a, question="scheduled", topics=["hr"])
    due = await service.create_manual(scope_b, question="due", topics=["ops"])
    assert scheduled.state == HuntState.SCHEDULED
    assert due.state == HuntState.AWAITING_ANSWER

    maintenance_channel = NullChannel()
    maintenance_clock = Clock(BASE + dt.timedelta(hours=73))
    result = await run_hunting_maintenance(
        harness.sm,
        channel=maintenance_channel,
        public_origin="https://brain.example",
        clock=maintenance_clock,
    )

    assert scheduled.hunt_id in result.delivered
    assert due.hunt_id in result.retried_or_expired
    assert {
        message.to
        for message in maintenance_channel.sent
        if message.to in {"quiet@example.com", "due@example.com"}
    } == {
        "quiet@example.com",
        "due@example.com",
    }
    assert all(
        message.magic_link
        for message in maintenance_channel.sent
        if message.to in {"quiet@example.com", "due@example.com"}
    )
    again = await run_hunting_maintenance(
        harness.sm,
        channel=maintenance_channel,
        public_origin="https://brain.example",
        clock=maintenance_clock,
    )
    assert scheduled.hunt_id not in again.delivered
    assert due.hunt_id not in again.retried_or_expired
    assert (
        sum(
            message.to in {"quiet@example.com", "due@example.com"}
            for message in maintenance_channel.sent
        )
        == 2
    )
    async with harness.sm() as session:
        scheduled_row = await session.get(models.Hunt, uuid.UUID(scheduled.hunt_id))
        due_row = await session.get(models.Hunt, uuid.UUID(due.hunt_id))
        assert scheduled_row is not None and scheduled_row.project_id == uuid.UUID(project_a)
        assert scheduled_row.state == HuntState.AWAITING_ANSWER.value
        assert due_row is not None and due_row.project_id == uuid.UUID(project_b)
        assert due_row.state == HuntState.AWAITING_ANSWER.value and due_row.retries == 1


async def test_daily_job_purges_and_runs_skills_once_per_idle_episode(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_a = await harness.setup_project(unique_slug("daily-a"), [("hr", 0)])
    project_b = await harness.setup_project(unique_slug("daily-b"), [("ops", 0)])
    scope_a = harness.scope(project_a, allowed_topics=["hr"])
    scope_b = harness.scope(project_b, allowed_topics=["ops"])
    owner_a = await PersonDirectory(harness.sm).add(
        scope_a, name="A", channels={"email": "a@example.com"}, topics=["hr"]
    )
    await PersonDirectory(harness.sm).add(
        scope_b, name="B", channels={"email": "b@example.com"}, topics=["ops"]
    )
    await SkillStore(harness.sm).create(
        scope_a,
        SkillFrontmatter(slug="idle", title="Idle", tags=["hr"]),
        "body",
        owner_person_id=owner_a,
    )
    async with harness.sm() as session:
        session.add(
            models.Gap(
                project_id=uuid.UUID(project_b),
                query_hash=query_hash("how do we deploy"),
                query_text="how do we deploy",
                topics=["ops"],
                count=3,
                status=GAP_STATUS_OPEN,
            )
        )
        session.add_all(
            [
                models.AuditLog(
                    project_id=uuid.UUID(project_a),
                    action="old-a",
                    principal_type="agent",
                    ts=BASE - dt.timedelta(days=366),
                ),
                models.AuditLog(
                    project_id=uuid.UUID(project_b),
                    action="old-b",
                    principal_type="agent",
                    ts=BASE - dt.timedelta(days=400),
                ),
                models.AuditLog(
                    project_id=uuid.UUID(project_a),
                    action="recent",
                    principal_type="agent",
                    ts=BASE - dt.timedelta(days=10),
                ),
                models.AuditLog(
                    project_id=uuid.UUID(project_b),
                    action="boundary",
                    principal_type="agent",
                    ts=BASE - dt.timedelta(days=365),
                ),
            ]
        )
        await session.commit()

    channel = NullChannel()
    config = MaintenanceConfig(audit_retention_days=365, skill_idle_days=60)
    first = await run_daily_maintenance(
        harness.sm, channel=channel, config=config, clock=Clock(BASE)
    )
    second = await run_daily_maintenance(
        harness.sm, channel=channel, config=config, clock=Clock(BASE)
    )

    assert first.audit_rows_purged >= 2
    assert "how-do-we-deploy" in first.proposed
    assert "how-do-we-deploy" not in second.proposed
    assert "idle" in first.idle_prompted
    assert "idle" not in second.idle_prompted
    assert {"a@example.com", "b@example.com"} <= {message.to for message in channel.sent}
    idle = await SkillStore(harness.sm).get(scope_a, "idle")
    assert idle is not None and idle.state == "active"
    proposed = await SkillStore(harness.sm).get(scope_b, "how-do-we-deploy")
    assert proposed is not None and proposed.state == "proposed"
    async with harness.sm() as session:
        idle_prompted_at = await session.scalar(
            select(models.Skill.idle_prompted_at).where(
                models.Skill.project_id == uuid.UUID(project_a), models.Skill.slug == "idle"
            )
        )
        assert idle_prompted_at == BASE
        survivor_actions = set(
            await session.scalars(
                select(models.AuditLog.action).where(
                    models.AuditLog.project_id.in_([uuid.UUID(project_a), uuid.UUID(project_b)])
                )
            )
        )
        assert {"recent", "boundary", "skill_idle_prompted"} <= survivor_actions
        survivors = await session.scalar(select(func.count()).select_from(models.AuditLog))
        assert int(survivors or 0) >= 2  # recent row plus the durable idle-prompt marker

    # A row lock + durable marker makes two concurrent periodic attempts one owner-visible prompt.
    await SkillStore(harness.sm).create(
        scope_a,
        SkillFrontmatter(slug="race-idle", title="Race idle", tags=["hr"]),
        "body",
        owner_person_id=owner_a,
    )
    before_race = len(channel.sent)
    concurrent = await asyncio.gather(
        prompt_idle_skills(harness.sm, scope_a, idle_days=60, now=BASE, channel=channel),
        prompt_idle_skills(harness.sm, scope_a, idle_days=60, now=BASE, channel=channel),
    )
    assert sum("race-idle" in result for result in concurrent) == 1
    assert len(channel.sent) == before_race + 1

    # A real later use re-arms the same skill for a new idle episode.
    async with harness.sm.begin() as session:
        session.add(
            models.AuditLog(
                project_id=uuid.UUID(project_a),
                action="run_skill",
                tool="run_skill",
                principal_type="human",
                query_hash=query_hash("skill:idle"),
                ts=BASE + dt.timedelta(days=1),
            )
        )
    later = await run_daily_maintenance(
        harness.sm,
        channel=channel,
        config=config,
        clock=Clock(BASE + dt.timedelta(days=62)),
    )
    assert "idle" in later.idle_prompted
    assert sum("'idle'" in message.subject for message in channel.sent) == 2


async def test_concurrent_due_retry_sends_once_and_failure_rolls_back(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("retry-race"), [("ops", 0)])
    scope = harness.scope(project_id, allowed_topics=["ops"])
    await PersonDirectory(harness.sm).add(
        scope, name="Owner", channels={"email": "race@example.com"}, topics=["ops"]
    )
    setup = HuntService(harness.sm, channel=NullChannel(), clock=Clock(BASE))
    outcome = await setup.create_manual(scope, question="retry me", topics=["ops"])
    now = BASE + dt.timedelta(hours=73)
    channel = NullChannel()
    left = HuntService(harness.sm, channel=channel, clock=Clock(now))
    right = HuntService(harness.sm, channel=channel, clock=Clock(now))
    results = await asyncio.gather(left.expire_due(scope), right.expire_due(scope))
    assert sum(outcome.hunt_id in result for result in results) == 1
    assert sum(message.to == "race@example.com" for message in channel.sent) == 1

    second = await setup.create_manual(scope, question="fail me", topics=["ops"])
    failing = HuntService(harness.sm, channel=FailingChannel(), clock=Clock(now))
    with pytest.raises(RuntimeError, match="delivery unavailable"):
        await failing.expire_due(scope)
    async with harness.sm() as session:
        unchanged = await session.get(models.Hunt, uuid.UUID(second.hunt_id))
        assert unchanged is not None
        assert unchanged.retries == 0 and unchanged.state == HuntState.AWAITING_ANSWER.value


async def test_failed_proposal_notification_is_repaired_without_duplicate_skill(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("proposal-retry"), [("ops", 0)])
    scope = harness.scope(project_id, allowed_topics=["ops"])
    await PersonDirectory(harness.sm).add(
        scope, name="Owner", channels={"email": "proposal@example.com"}, topics=["ops"]
    )
    async with harness.sm.begin() as session:
        session.add(
            models.Gap(
                project_id=uuid.UUID(project_id),
                query_hash=query_hash("repair this proposal"),
                query_text="repair this proposal",
                topics=["ops"],
                count=3,
                status=GAP_STATUS_OPEN,
            )
        )

    with pytest.raises(RuntimeError, match="delivery unavailable"):
        await propose_skills_from_gaps(harness.sm, scope, channel=FailingChannel())
    async with harness.sm() as session:
        rows = list(
            await session.scalars(
                select(models.Skill).where(
                    models.Skill.project_id == uuid.UUID(project_id),
                    models.Skill.slug == "repair-this-proposal",
                )
            )
        )
        assert len(rows) == 1 and rows[0].proposal_notified_at is None

    channel = NullChannel()
    assert await propose_skills_from_gaps(harness.sm, scope, channel=channel) == []
    assert [message.to for message in channel.sent] == ["proposal@example.com"]
    assert await propose_skills_from_gaps(harness.sm, scope, channel=channel) == []
    assert len(channel.sent) == 1
    async with harness.sm() as session:
        rows = list(
            await session.scalars(
                select(models.Skill).where(
                    models.Skill.project_id == uuid.UUID(project_id),
                    models.Skill.slug == "repair-this-proposal",
                )
            )
        )
        assert len(rows) == 1 and rows[0].proposal_notified_at is not None


async def test_delivery_failure_cannot_claim_awaiting_and_slack_uses_slack_identity(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("channel-route"), [("ops", 0)])
    scope = harness.scope(project_id, allowed_topics=["ops"])
    owner_id = await PersonDirectory(harness.sm).add(
        scope,
        name="Owner",
        channels={"email": "wrong-for-slack@example.com", "slack": "U12345"},
        topics=["ops"],
    )

    failing = HuntService(harness.sm, channel=FailingChannel(), clock=Clock(BASE))
    with pytest.raises(RuntimeError, match="delivery unavailable"):
        await failing.create_manual(scope, question="must roll back", topics=["ops"])
    async with harness.sm() as session:
        false_awaiting = await session.scalar(
            select(func.count())
            .select_from(models.Hunt)
            .where(
                models.Hunt.project_id == uuid.UUID(project_id),
                models.Hunt.question == "must roll back",
            )
        )
        assert int(false_awaiting or 0) == 0

    slack = RecordingSlackChannel()
    service = HuntService(harness.sm, channel=slack, clock=Clock(BASE))
    outcome = await service.create_manual(scope, question="use Slack", topics=["ops"])
    assert outcome.state == HuntState.AWAITING_ANSWER
    assert len(slack.sent) == 1
    assert slack.sent[0].channel == "slack" and slack.sent[0].to == "U12345"
    async with harness.sm() as session:
        row = await session.get(models.Hunt, uuid.UUID(outcome.hunt_id))
        assert row is not None and row.channel == "slack"

    async with harness.sm.begin() as session:
        session.add(
            models.Gap(
                project_id=uuid.UUID(project_id),
                query_hash=query_hash("slack proposal"),
                query_text="slack proposal",
                topics=["ops"],
                count=3,
                status=GAP_STATUS_OPEN,
            )
        )
    await propose_skills_from_gaps(harness.sm, scope, channel=slack)
    assert slack.sent[-1].channel == "slack" and slack.sent[-1].to == "U12345"

    await SkillStore(harness.sm).create(
        scope,
        SkillFrontmatter(slug="slack-idle", title="Slack idle", tags=["ops"]),
        "body",
        owner_person_id=owner_id,
    )
    assert await prompt_idle_skills(harness.sm, scope, now=BASE, channel=slack) == ["slack-idle"]
    assert slack.sent[-1].channel == "slack" and slack.sent[-1].to == "U12345"
