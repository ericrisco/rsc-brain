"""Product metrics (SPEC-23, PRD §8) — the four families, aggregated per project from Postgres.

adoption (recalls, active principals), quality (abstention rate, % hunts answered), knowledge
(claims, disputed, open gaps), health (extraction errors, recall p95, tokens/day by capability).
Topic-bearing inputs are filtered by project and complete topic authority in-query before any
aggregate; project-level token accounting remains project-scoped. Query text is never included.
"""

from __future__ import annotations

import datetime as dt
import uuid

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain import audit as audit_mod
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.visibility import fully_authorized_topic_clause


async def product_metrics(
    sessionmaker: async_sessionmaker[AsyncSession], scope: ProjectScope, *, window_days: int = 30
) -> dict[str, object]:
    pid = uuid.UUID(scope.project_id)
    since = dt.datetime.now(dt.UTC) - dt.timedelta(days=window_days)
    activity = await audit_mod.activity_summary(sessionmaker, scope, since=since)
    visible_claim = fully_authorized_topic_clause(models.Claim.tags, scope)
    visible_gap = fully_authorized_topic_clause(models.Gap.topics, scope)
    visible_document = fully_authorized_topic_clause(models.Document.doc_tags, scope)
    async with sessionmaker() as session:
        claims = await _count(session, models.Claim, models.Claim.project_id == pid, visible_claim)
        disputed = await _count(
            session,
            models.Claim,
            models.Claim.project_id == pid,
            visible_claim,
            models.Claim.disputed.is_(True),
        )
        open_gaps = await _count(
            session,
            models.Gap,
            models.Gap.project_id == pid,
            visible_gap,
            models.Gap.status == "open",
        )
        hunts_total = await _count_visible_hunts(
            session, pid, visible_gap, models.Hunt.created_at >= since
        )
        hunts_answered = await _count_visible_hunts(
            session,
            pid,
            visible_gap,
            models.Hunt.state.in_(["ANSWERED", "INGESTED", "RESOLVED"]),
            models.Hunt.created_at >= since,
        )
        extraction_errors = await _count_visible_ingest_errors(
            session, pid, visible_document, since=since
        )
        tokens = {
            str(capability): int(total or 0)
            for capability, total in await session.execute(
                select(models.TokenUsage.capability, func.sum(models.TokenUsage.tokens))
                .where(
                    models.TokenUsage.day >= since.date(),
                    # R12: this project's consumption, not the instance's.
                    models.TokenUsage.project_id == pid,
                )
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


async def _count_visible_hunts(
    session: AsyncSession, pid: uuid.UUID, gap_visibility: object, *conditions: object
) -> int:
    """Count only hunts attributable to a gap whose complete topic set is authorized."""
    total = await session.scalar(
        select(func.count())
        .select_from(models.Hunt)
        .join(
            models.Gap,
            and_(
                models.Gap.project_id == models.Hunt.project_id, models.Gap.id == models.Hunt.gap_id
            ),
        )
        .where(
            models.Hunt.project_id == pid,
            models.Gap.project_id == pid,
            gap_visibility,  # type: ignore[arg-type]
            *conditions,  # type: ignore[arg-type]
        )
    )
    return int(total or 0)


async def _count_visible_ingest_errors(
    session: AsyncSession,
    pid: uuid.UUID,
    document_visibility: object,
    *,
    since: dt.datetime,
) -> int:
    """Count extraction errors only through their authorized owning document."""
    total = await session.scalar(
        select(func.count())
        .select_from(models.IngestError)
        .join(
            models.Document,
            and_(
                models.Document.project_id == models.IngestError.project_id,
                models.Document.id == models.IngestError.document_id,
            ),
        )
        .where(
            models.IngestError.project_id == pid,
            models.Document.project_id == pid,
            document_visibility,  # type: ignore[arg-type]
            models.IngestError.created_at >= since,
        )
    )
    return int(total or 0)


def _num(value: object) -> int:
    return int(value) if isinstance(value, int) else 0
