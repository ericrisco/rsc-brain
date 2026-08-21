"""``timeline(topic?|entity?)`` — the ordered evolution of claims (SPEC-17, FR-16.6, U21).

A time-travel read that reconstructs *how a topic or entity's knowledge changed*, oldest first.
Claims live only in Postgres, so this is a permission-filtered SQL query over ``claims`` ordered by
``valid_from`` — never a graph dump. The same FR-4.14 visibility predicate as recall runs **in the
query** (topics the caller can't see are indistinguishable from nonexistent, FR-4.3), the project
comes from the resolved scope (FR-12.3), and the result is capped (never the whole timeline at
once). An optional ``as_of`` narrows the evolution to what was valid at that date.
"""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Row, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.ingest.entity_resolution import normalize_name
from rsc_brain.recall.permissions import claim_visibility_clause, sensitive_tags
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.temporal import active_at_clause, is_active_at

DEFAULT_TIMELINE_LIMIT = 50


@dataclass(frozen=True, slots=True)
class TimelineEntry:
    claim_id: str
    text: str
    subject: str | None
    predicate: str | None
    object: str | None
    credibility: float
    tags: tuple[str, ...]
    valid_from: dt.date | None
    valid_to: dt.date | None
    is_current: bool
    document_id: str | None


def _midnight(day: dt.date) -> dt.datetime:
    return dt.datetime.combine(day, dt.time.min, tzinfo=dt.UTC)


async def _entity_names(session: AsyncSession, scope: ProjectScope, entity: str) -> set[str]:
    """The names an entity may appear under in ``claims.subject``/``object``: the given name, its
    canonical form (following an alias-merge), and its recorded aliases (SPEC-09)."""
    names = {entity}
    pid = uuid.UUID(scope.project_id)
    row = await session.scalar(
        select(models.Entity).where(
            models.Entity.project_id == pid,
            models.Entity.normalized_name == normalize_name(entity),
        )
    )
    if row is None:
        return names
    canonical = row
    if row.merged_into is not None:
        canonical = await session.get(models.Entity, row.merged_into) or row
    names.add(canonical.name)
    aliases = await session.scalars(
        select(models.EntityAlias.alias).where(
            models.EntityAlias.project_id == pid,
            models.EntityAlias.entity_id == canonical.id,
        )
    )
    names.update(aliases)
    return names


async def build_timeline(
    sessionmaker: async_sessionmaker[AsyncSession],
    scope: ProjectScope,
    *,
    topic: str | None = None,
    entity: str | None = None,
    as_of: dt.date | None = None,
    limit: int = DEFAULT_TIMELINE_LIMIT,
) -> list[TimelineEntry]:
    """The ordered (oldest-first) evolution of claims for a topic or entity. Returns ``[]`` when
    neither selector is given, or when the caller cannot see the requested topic (FR-4.3)."""
    if not topic and not entity:
        return []
    # A topic the caller doesn't own is indistinguishable from one that doesn't exist (FR-4.3).
    if topic is not None and topic not in scope.allowed_topics:
        return []

    forbidden = await sensitive_tags(sessionmaker, scope.project_id)
    now_ts = dt.datetime.now(dt.UTC)
    async with sessionmaker() as session:
        conditions = [
            claim_visibility_clause(scope, forbidden),
            models.Claim.pending_confirmation.is_(False),
        ]
        if topic is not None:
            conditions.append(models.Claim.tags.op("@>")([topic]))
        if entity is not None:
            lowered = [name.lower() for name in await _entity_names(session, scope, entity)]
            conditions.append(
                or_(
                    func.lower(models.Claim.subject).in_(lowered),
                    func.lower(models.Claim.object).in_(lowered),
                )
            )
        if as_of is not None:
            anchor = _midnight(as_of)
            conditions.append(
                active_at_clause(models.Claim.valid_from, models.Claim.valid_to, anchor)
            )

        rows = (
            await session.execute(
                select(
                    models.Claim.id,
                    models.Claim.text,
                    models.Claim.subject,
                    models.Claim.predicate,
                    models.Claim.object,
                    models.Claim.credibility,
                    models.Claim.tags,
                    models.Claim.valid_from,
                    models.Claim.valid_to,
                    models.Claim.source_document_id,
                )
                .where(*conditions)
                .order_by(models.Claim.valid_from.asc().nullsfirst(), models.Claim.id)
                .limit(limit)
            )
        ).all()

    return [_to_entry(row, now_ts) for row in rows]


def _to_entry(row: Row[Any], now_ts: dt.datetime) -> TimelineEntry:
    cid, text, subject, predicate, obj, cred, tags, vf, vt, doc_id = row
    is_current = is_active_at(vf, vt, now_ts)
    return TimelineEntry(
        claim_id=str(cid),
        text=text,
        subject=subject,
        predicate=predicate,
        object=obj,
        credibility=float(cred) if cred is not None else 0.0,
        tags=tuple(tags or ()),
        valid_from=vf.date() if vf is not None else None,
        valid_to=vt.date() if vt is not None else None,
        is_current=is_current,
        document_id=str(doc_id) if doc_id is not None else None,
    )
