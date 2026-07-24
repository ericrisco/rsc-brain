"""Gap registration (FR-3.3): when recall abstains (``max(score) < τ``), record or increment the
unanswered query so recurring gaps surface for hunting (SPEC-15).

Keyed by ``query_hash`` (SHA-256 of the normalized query) unique per project, so repeating the
same unanswered question increments a single row's ``count`` rather than racing new rows.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import uuid
from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope

GAP_STATUS_OPEN = "open"


def query_hash(query: str) -> str:
    """Stable hash of a normalized query (trim + casefold), so trivially different phrasings of
    the same text collapse to one gap."""
    normalized = " ".join(query.strip().casefold().split())
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


async def register_gap(
    sessionmaker: async_sessionmaker[AsyncSession],
    scope: ProjectScope,
    query: str,
    *,
    topics: Sequence[str] = (),
) -> None:
    """Upsert the gap for ``query`` within ``scope``: insert with ``count=1`` or increment."""
    now = dt.datetime.now(dt.UTC)
    statement = (
        pg_insert(models.Gap)
        .values(
            project_id=uuid.UUID(scope.project_id),
            query_hash=query_hash(query),
            query_text=query,
            topics=list(topics),
            count=1,
            status=GAP_STATUS_OPEN,
            created_at=now,
            last_seen_at=now,
        )
        .on_conflict_do_update(
            index_elements=["project_id", "query_hash"],
            set_={
                "count": models.Gap.__table__.c.count + 1,
                "last_seen_at": now,
            },
        )
    )
    async with session_scope(sessionmaker) as session:
        await session.execute(statement)


async def get_gap_count(
    sessionmaker: async_sessionmaker[AsyncSession], scope: ProjectScope, query: str
) -> int:
    """The recorded count for ``query``'s gap within ``scope`` (0 if none). Used in tests/status."""
    async with sessionmaker() as session:
        count = await session.scalar(
            select(models.Gap.count).where(
                models.Gap.project_id == uuid.UUID(scope.project_id),
                models.Gap.query_hash == query_hash(query),
            )
        )
        return int(count or 0)


async def list_gaps(
    sessionmaker: async_sessionmaker[AsyncSession], scope: ProjectScope, *, limit: int = 100
) -> list[dict[str, object]]:
    """The project's recorded gaps, most-frequent first (for the admin API / console)."""
    async with sessionmaker() as session:
        rows = await session.scalars(
            select(models.Gap)
            .where(models.Gap.project_id == uuid.UUID(scope.project_id))
            .order_by(models.Gap.count.desc(), models.Gap.last_seen_at.desc())
            .limit(limit)
        )
        return [
            {
                "query_text": gap.query_text,
                "topics": list(gap.topics),
                "count": gap.count,
                "status": gap.status,
                "last_seen_at": gap.last_seen_at.isoformat() if gap.last_seen_at else None,
            }
            for gap in rows
        ]
