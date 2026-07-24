"""Permission enforcement (SPEC-04): turn a resolved scope into an in-query filter.

The stores' plain ``tags && allowed_topics`` overlap is **not sufficient** for sensitive tags:
a chunk tagged ``{hr, general}`` (where ``hr`` is sensitive) would leak to a ``general``-only
caller through the overlap on ``general``. FR-4.14 requires that a chunk carrying ANY sensitive
tag the caller does not explicitly own is excluded. So the effective filter is:

    project matches  AND  tags && allowed_topics  AND  NOT (tags && forbidden_sensitive_tags)

where ``forbidden_sensitive_tags`` = (the project's tags with ``sensitivity >= threshold``) minus
the caller's ``allowed_topics``. The whole predicate lives in the SQL query (FR-4.2/12.4), never
in Python over fetched rows. Denied and nonexistent are indistinguishable (FR-4.3): the recall
surface returns the same ``found:false`` for an empty result and a forbidden one.
"""

from __future__ import annotations

import uuid

from sqlalchemy import ColumnElement, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational import models

DEFAULT_SENSITIVITY_THRESHOLD = 3


async def sensitive_tags(
    sessionmaker: async_sessionmaker[AsyncSession],
    project_id: str,
    *,
    threshold: int = DEFAULT_SENSITIVITY_THRESHOLD,
) -> frozenset[str]:
    """The project's tag slugs whose ``sensitivity >= threshold`` (config default 3)."""
    async with sessionmaker() as session:
        rows = await session.scalars(
            select(models.Topic.slug).where(
                models.Topic.project_id == uuid.UUID(project_id),
                models.Topic.sensitivity >= threshold,
            )
        )
        return frozenset(rows)


def chunk_visibility_clause(
    scope: ProjectScope, project_sensitive_tags: frozenset[str]
) -> ColumnElement[bool]:
    """SQL predicate over ``chunks`` implementing project + tag + FR-4.14 visibility."""
    allowed = sorted(scope.allowed_topics)
    forbidden = sorted(project_sensitive_tags - scope.allowed_topics)
    clause = (models.Chunk.project_id == uuid.UUID(scope.project_id)) & models.Chunk.tags.op("&&")(
        allowed
    )
    if forbidden:
        clause = clause & ~models.Chunk.tags.op("&&")(forbidden)
    return clause


def claim_visibility_clause(
    scope: ProjectScope, project_sensitive_tags: frozenset[str]
) -> ColumnElement[bool]:
    """The same FR-4.14 visibility predicate as :func:`chunk_visibility_clause`, but over
    ``claims`` (SPEC-17 ``timeline`` queries claims directly, not chunks)."""
    allowed = sorted(scope.allowed_topics)
    forbidden = sorted(project_sensitive_tags - scope.allowed_topics)
    clause = (models.Claim.project_id == uuid.UUID(scope.project_id)) & models.Claim.tags.op("&&")(
        allowed
    )
    if forbidden:
        clause = clause & ~models.Claim.tags.op("&&")(forbidden)
    return clause
