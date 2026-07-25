"""Product metrics (SPEC-23, PRD §8) — the four families, aggregated per project from Postgres.

adoption (recalls, active principals), quality (abstention rate, % hunts answered), knowledge
(claims, disputed, open gaps), health (extraction errors, recall p95, tokens/day by capability).
Everything is filtered by ``project_id`` in-query (FR-12.5); query text is never included.
"""

from __future__ import annotations

import datetime as dt
import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain import audit as audit_mod
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational import models


async def product_metrics(
    sessionmaker: async_sessionmaker[AsyncSession], scope: ProjectScope, *, window_days: int = 30
) -> dict[str, object]:
    pid = uuid.UUID(scope.project_id)
    activity = await audit_mod.activity_summary(sessionmaker, scope)
    since = dt.datetime.now(dt.UTC) - dt.timedelta(days=window_days)
    async with sessionmaker() as session:
        claims = await _count(session, models.Claim, models.Claim.project_id == pid)
        disputed = await _count(
            session, models.Claim, models.Claim.project_id == pid, models.Claim.disputed.is_(True)
        )
        open_gaps = await _count(
            session, models.Gap, models.Gap.project_id == pid, models.Gap.status == "open"
        )
        hunts_total = await _count(session, models.Hunt, models.Hunt.project_id == pid)
        hunts_answered = await _count(
            session,
            models.Hunt,
            models.Hunt.project_id == pid,
            models.Hunt.state.in_(["ANSWERED", "INGESTED", "RESOLVED"]),
        )
        extraction_errors = await _count(
            session, models.IngestError, models.IngestError.project_id == pid
        )
        tokens = {
            str(capability): int(total) if isinstance(total, int) else 0
            for capability, total in await session.execute(
                select(models.TokenUsage.capability, func.sum(models.TokenUsage.tokens))
                .where(models.TokenUsage.day >= since.date())
                .group_by(models.TokenUsage.capability)
            )
        }
    recalls = _num(activity.get("recalls"))
    denied = _num(activity.get("denied"))
    return {
        "adoption": {
            "recalls": recalls,
            "active_principals": activity.get("active_principals", 0),
            "recalls_per_day": activity.get("recalls_per_day", []),
        },
        "quality": {
            "abstention_rate": round(denied / recalls, 3) if recalls else 0.0,
            "hunts_answered_pct": round(hunts_answered / hunts_total, 3) if hunts_total else 0.0,
        },
        "knowledge": {"claims": claims, "disputed": disputed, "open_gaps": open_gaps},
        "health": {
            "extraction_errors": extraction_errors,
            "recall_p95_ms": activity.get("p95_duration_ms"),
            "tokens_by_capability": tokens,
        },
    }


async def _count(session: AsyncSession, model: type[models.Base], *conditions: object) -> int:
    total = await session.scalar(select(func.count()).select_from(model).where(*conditions))  # type: ignore[arg-type]
    return int(total or 0)


def _num(value: object) -> int:
    return int(value) if isinstance(value, int) else 0
