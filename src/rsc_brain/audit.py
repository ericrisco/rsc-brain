"""Audit log (SPEC-04): one row per authenticated action, plus query + CSV export.

Every authenticated action writes exactly one row capturing who/what/how-much and whether it
was denied (FR-4.5), including the agent fields (`principal_type`, `principal_id`,
`on_behalf_of`, `trace_id`) for agent principals (FR-14.3). Query text itself is never stored —
only a hash — so audit never leaks content.
"""

from __future__ import annotations

import csv
import io
import uuid
from collections.abc import Sequence

from sqlalchemy import select
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
    topics_used: Sequence[str] = (),
    result_count: int | None = None,
    denied: bool = False,
    trace_id: str | None = None,
) -> None:
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
                topics_used=list(topics_used),
                result_count=result_count,
                denied=denied,
            )
        )


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
        "topics_used": list(row.topics_used),
        "result_count": row.result_count,
        "denied": row.denied,
    }


async def query_audit(
    sessionmaker: async_sessionmaker[AsyncSession],
    project_id: str,
    *,
    action: str | None = None,
    limit: int = 100,
) -> list[dict[str, object]]:
    conditions = [models.AuditLog.project_id == uuid.UUID(project_id)]
    if action is not None:
        conditions.append(models.AuditLog.action == action)
    statement = (
        select(models.AuditLog).where(*conditions).order_by(models.AuditLog.ts.desc()).limit(limit)
    )
    async with sessionmaker() as session:
        rows = await session.scalars(statement)
        return [_row_to_dict(row) for row in rows]


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
