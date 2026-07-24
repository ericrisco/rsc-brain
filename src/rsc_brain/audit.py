"""Audit log (SPEC-04): one row per authenticated action, plus query + CSV export.

Every authenticated action writes exactly one row capturing who/what/how-much and whether it
was denied (FR-4.5), including the agent fields (`principal_type`, `principal_id`,
`on_behalf_of`, `trace_id`) for agent principals (FR-14.3). Query text is stored only when the
project's ``query_text_logging`` is ON (FR-13.9, default ON) — otherwise just a hash, so audit
never leaks content. This module also serves the SPEC-14 read-observability aggregates.
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import uuid
from collections.abc import Sequence

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.scope import PrincipalType, ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope


async def record_audit(
    sessionmaker: async_sessionmaker[AsyncSession],
    scope: ProjectScope,
    *,
    action: str,
    tool: str | None = None,
    query_hash: str | None = None,
    query_text: str | None = None,
    duration_ms: int | None = None,
    topics_used: Sequence[str] = (),
    result_count: int | None = None,
    denied: bool = False,
    trace_id: str | None = None,
) -> None:
    # `query_text` is persisted verbatim only when the caller passes it (do_recall passes it solely
    # when the project's query_text_logging is ON, FR-13.9) — record_audit itself never fetches it.
    is_human = scope.principal_type is PrincipalType.HUMAN
    async with session_scope(sessionmaker) as session:
        session.add(
            models.AuditLog(
                project_id=uuid.UUID(scope.project_id),
                user_id=uuid.UUID(scope.principal_id) if is_human else None,
                principal_type=scope.principal_type.value,
                principal_id=scope.principal_id,
                on_behalf_of=scope.on_behalf_of,
                trace_id=trace_id,
                action=action,
                tool=tool,
                query_hash=query_hash,
                query_text=query_text,
                duration_ms=duration_ms,
                topics_used=list(topics_used),
                result_count=result_count,
                denied=denied,
            )
        )


async def query_text_logging_enabled(
    sessionmaker: async_sessionmaker[AsyncSession], project_id: str
) -> bool:
    """Whether a project stores the raw query text in the audit log (FR-13.9, default ON). OFF ⇒
    the text is never persisted or served — only the hash + topics."""
    async with sessionmaker() as session:
        settings = await session.scalar(
            select(models.Project.settings).where(models.Project.id == uuid.UUID(project_id))
        )
    value = (settings or {}).get("query_text_logging", True)
    return bool(value)


def _row_to_dict(row: models.AuditLog) -> dict[str, object]:
    return {
        "id": row.id,
        "ts": row.ts.isoformat() if row.ts else None,
        "project_id": str(row.project_id),
        "user_id": str(row.user_id) if row.user_id else None,
        "principal_type": row.principal_type,
        "principal_id": row.principal_id,
        "on_behalf_of": row.on_behalf_of,
        "trace_id": row.trace_id,
        "action": row.action,
        "tool": row.tool,
        "query_hash": row.query_hash,
        "query_text": row.query_text,  # NULL unless query_text_logging is ON (FR-13.9)
        "duration_ms": row.duration_ms,
        "topics_used": list(row.topics_used),
        "result_count": row.result_count,
        "denied": row.denied,
    }


def _parse_date(value: str | None) -> dt.datetime | None:
    """Accept a date (YYYY-MM-DD) or an ISO timestamp; None passes through. Naive dates are UTC."""
    if not value:
        return None
    parsed = dt.datetime.fromisoformat(value)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.UTC)


async def query_audit(
    sessionmaker: async_sessionmaker[AsyncSession],
    project_id: str,
    *,
    action: str | None = None,
    tool: str | None = None,
    principal_type: str | None = None,
    principal_id: str | None = None,
    denied: bool | None = None,
    since: str | None = None,
    until: str | None = None,
    limit: int = 100,
) -> list[dict[str, object]]:
    """Filterable audit query (SPEC-26 FR-13.7). All filters AND together; the project scope is
    always applied in-query (FR-12.5). Ordered newest-first. ``query_text`` is NULL unless the
    project's ``query_text_logging`` is ON, so no filter can surface query content (FR-13.9)."""
    conditions = [models.AuditLog.project_id == uuid.UUID(project_id)]
    if action is not None:
        conditions.append(models.AuditLog.action == action)
    if tool is not None:
        conditions.append(models.AuditLog.tool == tool)
    if principal_type is not None:
        conditions.append(models.AuditLog.principal_type == principal_type)
    if principal_id is not None:
        conditions.append(models.AuditLog.principal_id == principal_id)
    if denied is not None:
        conditions.append(models.AuditLog.denied.is_(denied))
    since_ts = _parse_date(since)
    if since_ts is not None:
        conditions.append(models.AuditLog.ts >= since_ts)
    until_ts = _parse_date(until)
    if until_ts is not None:
        conditions.append(models.AuditLog.ts <= until_ts)
    statement = (
        select(models.AuditLog).where(*conditions).order_by(models.AuditLog.ts.desc()).limit(limit)
    )
    async with sessionmaker() as session:
        rows = await session.scalars(statement)
        return [_row_to_dict(row) for row in rows]


async def activity_summary(
    sessionmaker: async_sessionmaker[AsyncSession], project_id: str
) -> dict[str, object]:
    """Recall activity aggregates for the dashboard (FR-13.2), scoped to one project in-query:
    total recalls, denied/abstained, distinct active principals, p95 duration, and recalls/day."""
    pid = uuid.UUID(project_id)
    recall_rows = models.AuditLog.action == "recall"
    async with sessionmaker() as session:
        totals = (
            await session.execute(
                select(
                    func.count(),
                    func.count().filter(models.AuditLog.denied.is_(True)),
                    func.count(func.distinct(models.AuditLog.principal_id)),
                    func.percentile_cont(0.95).within_group(models.AuditLog.duration_ms.asc()),
                ).where(models.AuditLog.project_id == pid, recall_rows)
            )
        ).one()
        per_day_rows = await session.execute(
            select(func.date(models.AuditLog.ts), func.count())
            .where(models.AuditLog.project_id == pid, recall_rows)
            .group_by(func.date(models.AuditLog.ts))
            .order_by(func.date(models.AuditLog.ts))
        )
        per_day = [{"day": str(day), "recalls": count} for day, count in per_day_rows.all()]
    total, denied, active, p95 = totals
    return {
        "recalls": int(total or 0),
        "denied": int(denied or 0),
        "active_principals": int(active or 0),
        "p95_duration_ms": round(float(p95), 1) if p95 is not None else None,
        "recalls_per_day": per_day,
    }


async def recall_stream(
    sessionmaker: async_sessionmaker[AsyncSession],
    project_id: str,
    *,
    principal_type: str | None = None,
    denied: bool | None = None,
    limit: int = 100,
) -> list[dict[str, object]]:
    """The live recall stream (FR-13.3), scoped in-query, filterable by principal + denial.
    ``query_text`` is already NULL when the project's logging is OFF (FR-13.9) — no filter needed."""
    conditions = [
        models.AuditLog.project_id == uuid.UUID(project_id),
        models.AuditLog.action == "recall",
    ]
    if principal_type is not None:
        conditions.append(models.AuditLog.principal_type == principal_type)
    if denied is not None:
        conditions.append(models.AuditLog.denied.is_(denied))
    async with sessionmaker() as session:
        rows = await session.scalars(
            select(models.AuditLog)
            .where(*conditions)
            .order_by(models.AuditLog.ts.desc())
            .limit(limit)
        )
        return [_row_to_dict(row) for row in rows]


async def set_query_text_logging(
    sessionmaker: async_sessionmaker[AsyncSession], project_id: str, *, enabled: bool
) -> None:
    """Toggle the per-project ``query_text_logging`` setting (FR-13.9). Merges into settings JSONB."""
    async with session_scope(sessionmaker) as session:
        project = await session.get(models.Project, uuid.UUID(project_id))
        if project is None:  # pragma: no cover - scope guarantees the project exists
            return
        project.settings = {**(project.settings or {}), "query_text_logging": enabled}


def to_csv(rows: Sequence[dict[str, object]]) -> str:
    if not rows:
        return ""
    fields = list(rows[0].keys())
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=fields)
    writer.writeheader()
    for row in rows:
        writer.writerow({k: ";".join(v) if isinstance(v, list) else v for k, v in row.items()})
    return buffer.getvalue()
