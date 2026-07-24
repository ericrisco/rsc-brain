"""Per-principal quotas (SPEC-11, FR-14.7) — rate limit + daily recall/write budgets in Postgres.

Counters live in Postgres so they are shared across workers with no extra service (Redis-free,
per the stack). Two limits per call:

* a **sliding per-minute rate window** (agents 300/min, humans 60/min by default) — an atomic
  upsert-increment per (principal, minute) row;
* a **daily budget** of recalls and of writes for agents (config default) — an atomic
  upsert-increment per (project, principal, day) row.

Exceeding either raises :class:`~rsc_brain.mcp.auth.RateLimitedError` with a ``retry_after`` (seconds
to the next window / to UTC midnight). Consumption is persisted so the console (FR-13.7, SPEC-26)
can surface it later; here we expose the data + a read helper.
"""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass
from typing import Literal

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.mcp.auth import RateLimitedError
from rsc_brain.scope import PrincipalType, ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope

Kind = Literal["recall", "write"]


@dataclass(frozen=True, slots=True)
class QuotaConfig:
    agent_rate_per_min: int = 300
    human_rate_per_min: int = 60
    agent_daily_recalls: int = 5000
    agent_daily_writes: int = 1000


def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


class QuotaService:
    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        config: QuotaConfig | None = None,
    ) -> None:
        self._sm = sessionmaker
        self._config = config or QuotaConfig()

    async def consume(
        self, scope: ProjectScope, kind: Kind, *, now: dt.datetime | None = None
    ) -> None:
        """Count one request and raise ``RateLimitedError`` if a limit is exceeded (FR-14.7)."""
        moment = now or _now()
        await self._check_rate(scope, moment)
        if scope.principal_type is PrincipalType.AGENT:
            await self._check_daily_budget(scope, kind, moment)

    async def _check_rate(self, scope: ProjectScope, moment: dt.datetime) -> None:
        is_agent = scope.principal_type is PrincipalType.AGENT
        limit = self._config.agent_rate_per_min if is_agent else self._config.human_rate_per_min
        window_start = moment.replace(second=0, microsecond=0)
        async with session_scope(self._sm) as session:
            count = await session.scalar(
                pg_insert(models.PrincipalRateWindow)
                .values(principal_id=scope.principal_id, window_start=window_start, count=1)
                .on_conflict_do_update(
                    index_elements=["principal_id", "window_start"],
                    set_={"count": models.PrincipalRateWindow.count + 1},
                )
                .returning(models.PrincipalRateWindow.count)
            )
        if count is not None and count > limit:
            raise RateLimitedError("rate limit exceeded", retry_after=max(1, 60 - moment.second))

    async def _check_daily_budget(
        self, scope: ProjectScope, kind: Kind, moment: dt.datetime
    ) -> None:
        budget = (
            self._config.agent_daily_recalls
            if kind == "recall"
            else self._config.agent_daily_writes
        )
        column = (
            models.PrincipalDailyUsage.recalls
            if kind == "recall"
            else (models.PrincipalDailyUsage.writes)
        )
        values = {
            "project_id": uuid.UUID(scope.project_id),
            "principal_id": scope.principal_id,
            "day": moment.date(),
            "recalls": 1 if kind == "recall" else 0,
            "writes": 1 if kind == "write" else 0,
        }
        async with session_scope(self._sm) as session:
            used = await session.scalar(
                pg_insert(models.PrincipalDailyUsage)
                .values(**values)
                .on_conflict_do_update(
                    index_elements=["project_id", "principal_id", "day"],
                    set_={column.key: column + 1},
                )
                .returning(column)
            )
        if used is not None and used > budget:
            midnight = (moment + dt.timedelta(days=1)).replace(
                hour=0, minute=0, second=0, microsecond=0
            )
            raise RateLimitedError(
                "daily budget exceeded",
                retry_after=max(1, int((midnight - moment).total_seconds())),
            )

    async def usage(self, scope: ProjectScope, *, day: dt.date | None = None) -> dict[str, int]:
        """Aggregate recall/write usage for a principal on a day (the FR-13.7 data)."""
        target = day or _now().date()
        async with self._sm() as session:
            row = await session.execute(
                select(models.PrincipalDailyUsage.recalls, models.PrincipalDailyUsage.writes).where(
                    models.PrincipalDailyUsage.project_id == uuid.UUID(scope.project_id),
                    models.PrincipalDailyUsage.principal_id == scope.principal_id,
                    models.PrincipalDailyUsage.day == target,
                )
            )
            found = row.first()
        return {"recalls": found[0], "writes": found[1]} if found else {"recalls": 0, "writes": 0}
