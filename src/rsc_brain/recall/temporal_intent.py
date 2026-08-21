"""Temporal-intent classifier (SPEC-13, FR-16.1).

Maps a recall query (+ any explicit params) to a temporal mode: ``current`` (default) |
``historical`` | ``as_of:<date>`` | ``range:<d1,d2>``. Deterministic ES/EN keyword + explicit-date
rules; **when in doubt, current** (the safe D16 default). A GPU-profile model layer (small
classifier via the gateway) is a documented seam — not on the CPU critical path — and is
blocked-by-resource in CI. Explicit ``recall`` params (``as_of``, ``include_historical``) always
override the query heuristics.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass
from enum import StrEnum

_ISO_DATE = re.compile(r"\b(\d{4}-\d{2}-\d{2})\b")

# AUDIT-117: a bare year after an `in`-style cue. Measured on the corpus: "What was the Globex day
# rate in 2022?" classified as CURRENT, so the superseded 2022 rate was filtered out and the query
# found nothing — the most natural phrasing of a historical question was the one form neither the
# ISO pattern nor the keyword list recognised.
#
# The cue is required. A bare year with no cue ("the 2022 pricing model we use") stays current,
# because D16's safe default protects the dangerous direction: presenting an expired fact as today's.
_IN_YEAR = re.compile(r"\b(?:in|en|during|durante)\s+((?:19|20)\d{2})\b(?!-\d{2})")

# History intent — the query asks for the past / evolution, not the current truth.
_HISTORICAL_KW = (
    "historical",
    "history",
    "over time",
    "all versions",
    "previous",
    "previously",
    "used to",
    "evolution",
    "no longer",
    "histórico",
    "historial",
    "anteriores",
    "versiones",
    "evolución",
    "antiguo",
    "solía",
)
_AS_OF_KW = ("as of", "as at", "a fecha de", "a fecha", "en fecha")
_RANGE_KW = ("between", "from", "entre", "desde")


class TemporalKind(StrEnum):
    CURRENT = "current"
    HISTORICAL = "historical"
    AS_OF = "as_of"
    RANGE = "range"


@dataclass(frozen=True, slots=True)
class TemporalMode:
    kind: TemporalKind
    as_of: dt.date | None = None  # AS_OF: the point in time
    start: dt.date | None = None  # RANGE: inclusive start
    end: dt.date | None = None  # RANGE: inclusive end


def _dates(query: str) -> list[dt.date]:
    found: list[dt.date] = []
    for raw in _ISO_DATE.findall(query):
        try:
            found.append(dt.date.fromisoformat(raw))
        except ValueError:  # pragma: no cover - regex already constrains the shape
            continue
    return found


def _cued_year(query: str) -> int | None:
    """The year in an `in <year>` cue, or None. Ignores a year that is part of an ISO date."""
    iso_spans = [match.span(1) for match in _ISO_DATE.finditer(query)]
    for match in _IN_YEAR.finditer(query):
        start, end = match.span(1)
        if any(low <= start and end <= high for low, high in iso_spans):
            continue
        return int(match.group(1))
    return None


def classify(
    query: str, *, as_of: dt.date | None = None, include_historical: bool = False
) -> TemporalMode:
    """Classify the temporal intent. Explicit params win; otherwise heuristics; else ``current``."""
    if as_of is not None:
        return TemporalMode(TemporalKind.AS_OF, as_of=as_of)
    if include_historical:
        return TemporalMode(TemporalKind.HISTORICAL)

    lowered = query.lower()
    dates = _dates(query)

    # A cued bare year → that calendar year, half-open like every other valid-time interval here.
    # Checked before the history keywords: "previously, in 2022" asks about 2022, not about the whole
    # timeline. An ISO date cannot reach this branch — the pattern refuses a `-NN` suffix, so
    # "as of 2023-06-01" stays a point in time.
    if (year := _cued_year(query)) is not None:
        return TemporalMode(
            TemporalKind.RANGE, start=dt.date(year, 1, 1), end=dt.date(year + 1, 1, 1)
        )

    # Two dates + a range cue → an explicit window.
    if len(dates) >= 2 and any(kw in lowered for kw in _RANGE_KW):
        start, end = sorted(dates[:2])
        return TemporalMode(TemporalKind.RANGE, start=start, end=end)

    # One date + an "as of" cue → point-in-time.
    if len(dates) == 1 and any(kw in lowered for kw in _AS_OF_KW):
        return TemporalMode(TemporalKind.AS_OF, as_of=dates[0])

    # History keywords → the past.
    if any(kw in lowered for kw in _HISTORICAL_KW):
        return TemporalMode(TemporalKind.HISTORICAL)

    # When in doubt, current (a bare date with no cue stays current — D16 safe default).
    return TemporalMode(TemporalKind.CURRENT)
