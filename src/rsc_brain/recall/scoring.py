"""Recall scoring (FR-3.2) — pure functions, no I/O.

``score = 0.55·similarity + 0.25·credibility + 0.10·freshness + 0.10·importance`` (weights from
``ScoreWeights``), with ``freshness = exp(-Δdays / half_life)``. A claim with no date is treated
as maximally fresh (1.0). ``half_life`` defaults to 365 days and may be overridden per topic: a
fragment carrying a topic with an override uses the smallest matching half-life (fastest decay),
so the most time-sensitive topic wins.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from datetime import date

from rsc_brain.config.models import ScoreWeights

DEFAULT_CREDIBILITY = 0.5
DEFAULT_IMPORTANCE = 0.5


def freshness(age_days: float, half_life_days: float) -> float:
    """Exponential freshness in (0, 1]. Non-positive age clamps to 1.0."""
    if age_days <= 0:
        return 1.0
    return math.exp(-age_days / half_life_days)


def resolve_half_life(
    tags: Sequence[str], *, default_days: int, by_topic: Mapping[str, int]
) -> int:
    """The freshness half-life for a fragment: the smallest per-topic override among its tags,
    else the default."""
    overrides = [by_topic[tag] for tag in tags if tag in by_topic]
    return min(overrides) if overrides else default_days


def freshness_for(
    valid_from: date | None,
    as_of: date,
    tags: Sequence[str],
    *,
    default_days: int,
    by_topic: Mapping[str, int],
) -> float:
    """Freshness of a fragment given its effective date and topics (no date ⇒ 1.0)."""
    if valid_from is None:
        return 1.0
    half_life = resolve_half_life(tags, default_days=default_days, by_topic=by_topic)
    return freshness(float((as_of - valid_from).days), float(half_life))


def combined_score(
    *,
    similarity: float,
    credibility: float,
    freshness: float,
    importance: float,
    weights: ScoreWeights,
) -> float:
    """The weighted score (FR-3.2). Inputs are expected in [0, 1]; the result is in [0, 1]."""
    return (
        weights.similarity * similarity
        + weights.credibility * credibility
        + weights.freshness * freshness
        + weights.importance * importance
    )


def score_fragment(
    *,
    similarity: float,
    credibility: float | None,
    importance: float | None,
    valid_from: date | None,
    as_of: date,
    tags: Sequence[str],
    weights: ScoreWeights,
    default_half_life_days: int,
    half_life_by_topic: Mapping[str, int],
) -> float:
    """Score one candidate fragment, applying neutral defaults for missing credibility/importance
    and per-topic freshness half-life."""
    fresh = freshness_for(
        valid_from, as_of, tags, default_days=default_half_life_days, by_topic=half_life_by_topic
    )
    return combined_score(
        similarity=similarity,
        credibility=credibility if credibility is not None else DEFAULT_CREDIBILITY,
        freshness=fresh,
        importance=importance if importance is not None else DEFAULT_IMPORTANCE,
        weights=weights,
    )
