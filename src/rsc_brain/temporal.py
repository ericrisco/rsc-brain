"""Shared half-open valid-time predicates.

All arguments are UTC-aware datetimes.  Callers retain responsibility for choosing the
anchor; this module only defines whether an interval is active at that instant.
"""

from __future__ import annotations

import datetime as dt

from sqlalchemy import SQLColumnExpression, and_, or_
from sqlalchemy.sql.elements import ColumnElement


def is_active_at(
    valid_from: dt.datetime | None, valid_to: dt.datetime | None, anchor: dt.datetime
) -> bool:
    """Return whether the nullable half-open interval contains ``anchor``."""
    return (valid_from is None or valid_from <= anchor) and (valid_to is None or valid_to > anchor)


def active_at_clause(
    valid_from_column: SQLColumnExpression[dt.datetime | None],
    valid_to_column: SQLColumnExpression[dt.datetime | None],
    anchor: dt.datetime,
) -> ColumnElement[bool]:
    """Return SQL for the same nullable half-open interval as :func:`is_active_at`."""
    return and_(
        or_(valid_from_column.is_(None), valid_from_column <= anchor),
        or_(valid_to_column.is_(None), valid_to_column > anchor),
    )
