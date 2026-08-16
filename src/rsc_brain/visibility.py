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
    column: ColumnElement[list[str]] | InstrumentedAttribute[list[str]],
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


def fully_authorized_topic_clause(
    column: ColumnElement[list[str]] | InstrumentedAttribute[list[str]],
    scope: ProjectScope,
    *,
    allow_untagged: bool = False,
) -> ColumnElement[bool]:
    """Require every real topic carried by a row to be present in ``scope``.

    Console posture, counts and pagination use a stricter contract than a relevance search: a row
    tagged for two topics is one indivisible observable, so an overlap with one topic cannot make
    the other topic's existence visible.  PostgreSQL evaluates the subset predicate in the same
    query that counts, orders and pages the rows; no forbidden row reaches Python first.

    Workflow sentinels are not topics and are removed before comparing.  Untagged rows remain
    fail-closed unless a caller explicitly identifies them as project-level metadata.
    """
    topics_only: Any = column
    for sentinel in sorted(NON_TOPIC_TAGS):
        topics_only = func.array_remove(topics_only, literal(sentinel))
    topic_count = func.coalesce(func.cardinality(topics_only), 0)
    all_granted = and_(topic_count > 0, topics_only.op("<@")(sorted(scope.allowed_topics)))
    if allow_untagged:
        return or_(topic_count == 0, all_granted)
    return all_granted
