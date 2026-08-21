"""Production periodic lifecycle work (AUDIT-108).

The deployed Procrastinate worker already owns a PostgreSQL-backed periodic deferrer. This module
registers the work that used to exist only as test-called functions and runs it over project ids
loaded from the database, never from request/job arguments.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal

from procrastinate import App
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.config.models import MaintenanceConfig
from rsc_brain.hunting.channels import Channel
from rsc_brain.ingest.queue import MAINTENANCE_QUEUE
from rsc_brain.hunting.service import HuntService
from rsc_brain.knowledge.gdpr import purge_audit
from rsc_brain.scope import PROJECT_ROLE_AGENT, PrincipalType, ProjectScope
from rsc_brain.skills.autocreate import prompt_idle_skills, propose_skills_from_gaps
from rsc_brain.stores.relational import models

# One definition of the queue name, in the module that builds the queue (AUDIT-018).
HUNTING_MAINTENANCE_TASK = "maintenance_hunting"
DAILY_MAINTENANCE_TASK = "maintenance_daily"
HUNTING_CRON = "* * * * *"
DAILY_CRON = "0 3 * * *"

MaintenanceKind = Literal["hunting", "daily"]
MaintenanceRunner = Callable[[MaintenanceKind], Awaitable[None]]
Clock = Callable[[], dt.datetime]

# Internal service identity: no user FK or platform role, rebound only to DB-owned project ids.
_SYSTEM_PRINCIPAL_ID = "00000000-0000-0000-0000-000000000108"


@dataclass(frozen=True, slots=True)
class HuntingMaintenanceResult:
    delivered: tuple[str, ...]
    retried_or_expired: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class DailyMaintenanceResult:
    audit_rows_purged: int
    proposed: tuple[str, ...]
    idle_prompted: tuple[str, ...]


def register_periodic_tasks(app: App, runner: MaintenanceRunner) -> None:
    """Register durable periodic jobs on the same app the production worker consumes."""

    @app.periodic(
        cron=HUNTING_CRON,
        periodic_id="hunting",
        lock=HUNTING_MAINTENANCE_TASK,
        queueing_lock=HUNTING_MAINTENANCE_TASK,
    )
    @app.task(
        name=HUNTING_MAINTENANCE_TASK,
        queue=MAINTENANCE_QUEUE,
        lock=HUNTING_MAINTENANCE_TASK,
        queueing_lock=HUNTING_MAINTENANCE_TASK,
    )
    async def maintain_hunting(timestamp: int) -> None:
        del timestamp
        await runner("hunting")

    @app.periodic(
        cron=DAILY_CRON,
        periodic_id="daily",
        lock=DAILY_MAINTENANCE_TASK,
        queueing_lock=DAILY_MAINTENANCE_TASK,
    )
    @app.task(
        name=DAILY_MAINTENANCE_TASK,
        queue=MAINTENANCE_QUEUE,
        lock=DAILY_MAINTENANCE_TASK,
        queueing_lock=DAILY_MAINTENANCE_TASK,
    )
    async def maintain_daily(timestamp: int) -> None:
        del timestamp
        await runner("daily")


async def run_hunting_maintenance(
    sessionmaker: async_sessionmaker[AsyncSession],
    *,
    service: HuntService | None = None,
    channel: Channel | None = None,
    public_origin: str = HuntService.UNCONFIGURED_BASE_URL,
    clock: Clock | None = None,
) -> HuntingMaintenanceResult:
    """Advance scheduled and due hunts for every active project."""
    active_service = service or HuntService(
        sessionmaker,
        channel=channel,
        base_url=public_origin,
        clock=clock,
    )
    delivered: list[str] = []
    changed: list[str] = []
    for scope in await _active_project_scopes(sessionmaker):
        delivered.extend(await active_service.send_scheduled(scope))
        changed.extend(await active_service.expire_due(scope))
    return HuntingMaintenanceResult(tuple(delivered), tuple(changed))


async def run_daily_maintenance(
    sessionmaker: async_sessionmaker[AsyncSession],
    *,
    channel: Channel | None,
    config: MaintenanceConfig,
    clock: Clock | None = None,
) -> DailyMaintenanceResult:
    """Run global retention and project-scoped skill maintenance once."""
    now = (clock or (lambda: dt.datetime.now(dt.UTC)))()
    purged = await purge_audit(
        sessionmaker,
        retention_days=config.audit_retention_days,
        now=now,
    )
    proposed: list[str] = []
    prompted: list[str] = []
    for scope in await _active_project_scopes(sessionmaker):
        proposed.extend(
            await propose_skills_from_gaps(
                sessionmaker,
                scope,
                threshold=config.skill_cluster_threshold,
                channel=channel,
            )
        )
        prompted.extend(
            await prompt_idle_skills(
                sessionmaker,
                scope,
                idle_days=config.skill_idle_days,
                now=now,
                channel=channel,
            )
        )
    return DailyMaintenanceResult(purged, tuple(proposed), tuple(prompted))


async def _active_project_scopes(
    sessionmaker: async_sessionmaker[AsyncSession],
) -> list[ProjectScope]:
    """Derive bounded project authority solely from active database-owned rows."""
    async with sessionmaker() as session:
        rows = (
            await session.execute(
                select(models.Project.id, models.Topic.slug)
                .outerjoin(models.Topic, models.Topic.project_id == models.Project.id)
                .where(models.Project.status == "active")
                .order_by(models.Project.id, models.Topic.slug)
            )
        ).all()
    topics_by_project: dict[str, set[str]] = {}
    for project_id, topic in rows:
        topics = topics_by_project.setdefault(str(project_id), set())
        if topic:
            topics.add(str(topic))
    return [
        ProjectScope(
            principal_id=_SYSTEM_PRINCIPAL_ID,
            principal_type=PrincipalType.AGENT,
            project_id=project_id,
            allowed_topics=frozenset(topics),
            can_curate=True,
            role=PROJECT_ROLE_AGENT,
        )
        for project_id, topics in topics_by_project.items()
    ]


async def default_maintenance_runner(kind: MaintenanceKind) -> None:
    """Build the exact production runtime for one persisted maintenance job."""
    from rsc_brain import runtime
    from rsc_brain.hunting.factory import build_hunt_service_from_config

    dependencies = runtime.build("worker")
    try:
        service = build_hunt_service_from_config(
            dependencies.sessionmaker,
            hunting=dependencies.hunting,
            public_origin=dependencies.ingress.public_origin,
            gateway=dependencies.gateway,
        )
        if kind == "hunting":
            await run_hunting_maintenance(dependencies.sessionmaker, service=service)
            return
        if kind == "daily":
            await run_daily_maintenance(
                dependencies.sessionmaker,
                channel=service.channel if service.can_deliver else None,
                config=dependencies.maintenance,
            )
            return
        raise ValueError(f"unknown maintenance kind {kind!r}")
    finally:
        await dependencies.dispose()


__all__ = [
    "DAILY_MAINTENANCE_TASK",
    "HUNTING_MAINTENANCE_TASK",
    "MAINTENANCE_QUEUE",
    "MaintenanceConfig",
    "default_maintenance_runner",
    "register_periodic_tasks",
    "run_daily_maintenance",
    "run_hunting_maintenance",
]
