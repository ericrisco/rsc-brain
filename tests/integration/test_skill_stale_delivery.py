"""AUDIT-018 durable delivery, quiet hours, retry and concurrent dedupe."""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid
from collections.abc import Callable

import pytest
from sqlalchemy import select, update

from rsc_brain.hunting.channels import OutboundMessage
from rsc_brain.hunting.directory import PersonDirectory
from rsc_brain.skills.frontmatter import SkillFrontmatter
from rsc_brain.skills.staleness import SkillStaleNotificationDispatcher
from rsc_brain.skills.store import SkillStore
from rsc_brain.stores.relational import models

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration


class RecordingSmtp:
    name = "smtp"

    def __init__(self, *, fail_first: bool = False, yield_during_send: bool = False) -> None:
        self.fail_first = fail_first
        self.yield_during_send = yield_during_send
        self.attempts = 0
        self.sent: list[OutboundMessage] = []

    async def send(self, message: OutboundMessage) -> None:
        self.attempts += 1
        if self.yield_during_send:
            await asyncio.sleep(0.05)
        if self.fail_first and self.attempts == 1:
            raise RuntimeError("temporary provider failure")
        self.sent.append(message)


class RecordingSlack(RecordingSmtp):
    name = "slack"


async def _stale_skill(
    harness: Harness,
    *,
    quiet_hours: dict[str, str] | None = None,
    channels: dict[str, str] | None = None,
) -> tuple[str, str]:
    project_id = await harness.setup_project(unique_slug("stale-delivery"), [("hr", 0)])
    scope = harness.scope(project_id, allowed_topics=["hr"])
    owner_id = await PersonDirectory(harness.sm).add(
        scope,
        name="Owner",
        channels=channels or {"email": "owner@example.test"},
        topics=["hr"],
        quiet_hours=quiet_hours,
    )
    dependency = str(uuid.uuid4())
    await SkillStore(harness.sm).create(
        scope,
        SkillFrontmatter(
            slug="payroll",
            title="Payroll",
            tags=["hr"],
            owner=owner_id,
            depends_on=[dependency],
            state="active",
        ),
        "body",
    )
    await SkillStore(harness.sm).mark_stale_for(scope, [dependency], reason="knowledge changed")
    return project_id, owner_id


async def _make_due(harness: Harness, project_id: str, at: dt.datetime) -> None:
    async with harness.sm() as session:
        await session.execute(
            update(models.SkillStaleNotification)
            .where(models.SkillStaleNotification.project_id == uuid.UUID(project_id))
            .values(next_attempt_at=at)
        )
        await session.commit()


async def _notice(harness: Harness, project_id: str) -> models.SkillStaleNotification:
    async with harness.sm() as session:
        row = await session.scalar(
            select(models.SkillStaleNotification).where(
                models.SkillStaleNotification.project_id == uuid.UUID(project_id)
            )
        )
        assert row is not None
        session.expunge(row)
        return row


async def test_quiet_hours_defer_until_the_owners_local_window_opens(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id, _ = await _stale_skill(
        harness,
        quiet_hours={"start": "22:00", "end": "08:00", "tz": "Europe/Madrid"},
    )
    quiet_now = dt.datetime(2026, 8, 20, 21, 30, tzinfo=dt.UTC)
    await _make_due(harness, project_id, quiet_now)
    channel = RecordingSmtp()
    dispatcher = SkillStaleNotificationDispatcher(
        harness.sm, channel=channel, can_deliver=True, clock=lambda: quiet_now
    )

    assert await dispatcher.deliver_due(project_id=project_id) == []
    deferred = await _notice(harness, project_id)
    assert channel.sent == []
    assert deferred.state == "pending"
    assert deferred.next_attempt_at == dt.datetime(2026, 8, 21, 6, 0, tzinfo=dt.UTC)

    open_now = deferred.next_attempt_at
    delivered = SkillStaleNotificationDispatcher(
        harness.sm, channel=channel, can_deliver=True, clock=lambda: open_now
    )
    assert len(await delivered.deliver_due(project_id=project_id)) == 1
    assert len(channel.sent) == 1
    assert channel.sent[0].to == "owner@example.test"
    assert channel.sent[0].idempotency_key == deferred.idempotency_key
    assert (await _notice(harness, project_id)).state == "delivered"


async def test_transient_failure_retries_without_losing_stale_or_duplicate_success(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id, _ = await _stale_skill(harness)
    first_now = dt.datetime(2026, 8, 20, 12, 0, tzinfo=dt.UTC)
    await _make_due(harness, project_id, first_now)
    channel = RecordingSmtp(fail_first=True)
    first = SkillStaleNotificationDispatcher(
        harness.sm, channel=channel, can_deliver=True, clock=lambda: first_now
    )
    assert await first.deliver_due(project_id=project_id) == []
    failed = await _notice(harness, project_id)
    assert failed.state == "pending" and failed.attempts == 1
    assert failed.last_error == "RuntimeError: delivery failed"

    retry = SkillStaleNotificationDispatcher(
        harness.sm, channel=channel, can_deliver=True, clock=lambda: failed.next_attempt_at
    )
    assert len(await retry.deliver_due(project_id=project_id)) == 1
    assert channel.attempts == 2 and len(channel.sent) == 1
    assert channel.sent[0].idempotency_key == failed.idempotency_key
    assert await retry.deliver_due(project_id=project_id) == []
    async with harness.sm() as session:
        skill = await session.scalar(
            select(models.Skill).where(models.Skill.project_id == uuid.UUID(project_id))
        )
        assert skill is not None and skill.stale is True


async def test_configured_channel_uses_the_matching_directory_destination(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id, _ = await _stale_skill(
        harness,
        channels={"email": "owner@example.test", "slack": "U123OWNER"},
    )
    now = dt.datetime(2026, 8, 20, 12, 0, tzinfo=dt.UTC)
    await _make_due(harness, project_id, now)
    channel = RecordingSlack()
    dispatcher = SkillStaleNotificationDispatcher(
        harness.sm, channel=channel, can_deliver=True, clock=lambda: now
    )

    assert len(await dispatcher.deliver_due(project_id=project_id)) == 1
    assert len(channel.sent) == 1
    assert channel.sent[0].channel == "slack"
    assert channel.sent[0].to == "U123OWNER"


async def test_two_dispatchers_cannot_deliver_the_same_transition_concurrently(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project_id, _ = await _stale_skill(harness)
    now = dt.datetime(2026, 8, 20, 12, 0, tzinfo=dt.UTC)
    await _make_due(harness, project_id, now)
    channel = RecordingSmtp(yield_during_send=True)
    first = SkillStaleNotificationDispatcher(
        harness.sm, channel=channel, can_deliver=True, clock=lambda: now
    )
    second = SkillStaleNotificationDispatcher(
        harness.sm, channel=channel, can_deliver=True, clock=lambda: now
    )

    outcomes = await asyncio.gather(
        first.deliver_due(project_id=project_id), second.deliver_due(project_id=project_id)
    )
    assert sum(len(result) for result in outcomes) == 1
    assert len(channel.sent) == 1
    assert (await _notice(harness, project_id)).state == "delivered"
