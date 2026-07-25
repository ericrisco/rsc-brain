"""Topic visibility as an in-query predicate — applied BEFORE anything becomes observable.

AUDIT-020/R01: a topic-limited caller must not learn about another topic through a row, an
identifier, a **count**, an **aggregate**, a page's density, or an export. The defect this module
removes is not "the list showed too much": the lists were project-scoped, but every side channel
around them (the activity aggregate, the review-queue counters, the CSV export) was computed over
the whole project. So the predicate has to enter the query that produces the count, not filter the
rows after it.

The rule is the SPEC-04 rule (:mod:`rsc_brain.recall.permissions`), lifted to every console
surface: a row is visible when its topics overlap the caller's authority AND it carries no
sensitive topic the caller does not explicitly hold (FR-4.14). Empty topic authority selects
nothing — never everything.

Some rows have no topic dimension at all (an audit entry for a project-level action, a hunt not
derived from a gap). Those are project-level records, not topic-scoped content: a surface may admit
them explicitly with ``allow_untagged=True``, which is the only way an untagged row is ever
visible.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from sqlalchemy import ColumnElement, and_, false, func, literal, or_
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import InstrumentedAttribute

from rsc_brain.recall.permissions import sensitive_tags
from rsc_brain.scope import NON_TOPIC_TAGS, ProjectScope


async def forbidden_topics(
    sessionmaker: async_sessionmaker[AsyncSession], scope: ProjectScope
) -> frozenset[str]:
    """The project's sensitive topics the caller does NOT hold (FR-4.14)."""
    return await sensitive_tags(sessionmaker, scope.project_id) - scope.allowed_topics


def topic_clause(
    column: InstrumentedAttribute[list[str]],
    scope: ProjectScope,
    forbidden: frozenset[str],
    *,
    allow_untagged: bool = False,
) -> ColumnElement[bool]:
    """The visibility predicate over a text-array topic column.

    ``allow_untagged`` admits rows with an empty topic array — use it only where the absence of
    topics means "not topic-scoped content" (project-level audit rows, gapless hunts), never as a
    convenience.
    """
    allowed = sorted(scope.allowed_topics)
    visible: ColumnElement[bool] = column.op("&&")(allowed) if allowed else false()
    if allow_untagged:
        topics_only: Any = column
        for sentinel in sorted(NON_TOPIC_TAGS):
            topics_only = func.array_remove(topics_only, literal(sentinel))
        visible = or_(visible, func.coalesce(func.cardinality(topics_only), 0) == 0)
    if forbidden:
        visible = and_(visible, ~column.op("&&")(sorted(forbidden)))
    return visible


def authorized(
    topics: Iterable[str] | None,
    scope: ProjectScope,
    forbidden: frozenset[str],
    *,
    allow_untagged: bool = False,
) -> bool:
    """The same rule in Python, for values already outside SQL (a graph node's topics, a payload).

    Prefer :func:`topic_clause`: this variant cannot filter a count. It exists for the few places
    where the candidate set does not come from a relational query.
    """
    values = {str(t) for t in (topics or []) if t} - NON_TOPIC_TAGS
    if not values:
        return allow_untagged
    if values & forbidden:
        return False
    return bool(values & set(scope.allowed_topics))
