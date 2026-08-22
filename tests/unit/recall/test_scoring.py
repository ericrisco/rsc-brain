"""Recall scoring (FR-3.2): freshness decay, per-topic half-life, missing-field defaults."""

from __future__ import annotations

import math
from datetime import date

import pytest

from rsc_brain.config.models import ScoreWeights
from rsc_brain.recall.scoring import (
    combined_score,
    freshness,
    freshness_for,
    resolve_half_life,
    score_fragment,
)


def test_freshness_decays_exponentially() -> None:
    assert freshness(0, 365) == 1.0
    assert freshness(-5, 365) == 1.0  # future/clock-skew clamps to fresh
    assert freshness(365, 365) == pytest.approx(math.exp(-1), rel=1e-6)


def test_resolve_half_life_prefers_smallest_override() -> None:
    by_topic = {"pricing": 30, "hr": 90}
    assert resolve_half_life(["pricing", "hr"], default_days=365, by_topic=by_topic) == 30
    assert resolve_half_life(["general"], default_days=365, by_topic=by_topic) == 365


def test_combined_score_matches_formula() -> None:
    weights = ScoreWeights()
    score = combined_score(
        similarity=1.0, credibility=1.0, freshness=1.0, importance=1.0, weights=weights
    )
    assert score == pytest.approx(1.0)
    partial = combined_score(
        similarity=0.5, credibility=0.5, freshness=0.5, importance=0.5, weights=weights
    )
    assert partial == pytest.approx(0.5)


def test_score_fragment_treats_missing_date_as_fresh() -> None:
    weights = ScoreWeights()
    score = score_fragment(
        similarity=0.8,
        credibility=None,
        importance=None,
        valid_from=None,
        valid_to=None,
        as_of=date(2026, 7, 24),
        tags=["general"],
        weights=weights,
        default_half_life_days=365,
        half_life_by_topic={},
    )
    # sim 0.8, cred/imp default 0.5, freshness 1.0 (no date).
    expected = 0.55 * 0.8 + 0.25 * 0.5 + 0.10 * 1.0 + 0.10 * 0.5
    assert score == pytest.approx(expected)


def test_score_fragment_applies_per_topic_decay() -> None:
    """The per-topic half-life still governs the decay — of a claim that has STOPPED holding.

    AUDIT-125 moved the clock from `valid_from` to `valid_to`: a claim still in force is fully fresh
    however old it is, and the decay measures how long ago it ceased to be true. So this case now
    expires the claim 30 days before `as_of` rather than starting it 30 days before, and asserts the
    same exp(-1) it always did.
    """
    weights = ScoreWeights()
    fresh_score = score_fragment(
        similarity=1.0,
        credibility=1.0,
        importance=1.0,
        valid_from=date(2020, 1, 1),
        valid_to=date(2026, 6, 24),  # stopped holding 30 days before as_of
        as_of=date(2026, 7, 24),
        tags=["pricing"],
        weights=weights,
        default_half_life_days=365,
        half_life_by_topic={"pricing": 30},
    )
    # With a 30-day half-life, 30 days after it expired, freshness = exp(-1).
    expected = 0.55 + 0.25 + 0.10 * math.exp(-1) + 0.10
    assert fresh_score == pytest.approx(expected, rel=1e-6)


def test_a_fact_that_still_holds_is_not_penalised_for_being_old() -> None:
    """AUDIT-125: freshness must measure whether a fact still holds, not how long it has held.

    Measured on the corpus after AUDIT-105 gave claims real dates: the claim *"From 2024-01-01 onward,
    the consulting day rate is 120 EUR per hour"* — currently valid, and the answer to the question
    asked — ranked **ninth of ten** candidates, below four undated generic documents about the same
    company. `freshness_for` decayed it from `valid_from` (964 days → 0.071) while a claim with no
    date at all was "maximally fresh" (1.0).

    So the term rewarded claims whose validity is unknown and punished the ones the product had just
    learned to date. It was inert until AUDIT-105 wrote real boundaries; writing them turned it into
    a penalty on the best-documented facts.
    """
    old_but_current = freshness_for(
        date(2024, 1, 1), None, date(2026, 8, 22), (), default_days=365, by_topic={}
    )
    undated = freshness_for(None, None, date(2026, 8, 22), (), default_days=365, by_topic={})

    assert old_but_current == 1.0, "a claim with no end date still holds; age is not staleness"
    assert undated == 1.0, "an unknown date is not evidence of staleness either"


def test_a_fact_that_has_stopped_holding_decays_from_when_it_stopped() -> None:
    """The decay is about how long ago it ceased to be true, which is what staleness means here."""
    just_ended = freshness_for(
        date(2020, 1, 1), date(2026, 8, 1), date(2026, 8, 22), (), default_days=365, by_topic={}
    )
    long_ended = freshness_for(
        date(2020, 1, 1), date(2021, 1, 1), date(2026, 8, 22), (), default_days=365, by_topic={}
    )

    assert 0.9 < just_ended < 1.0, "expired three weeks ago: nearly fresh"
    assert long_ended < 0.01, "expired five years ago: stale"
    assert long_ended < just_ended


def test_a_fact_not_yet_in_force_is_not_treated_as_stale() -> None:
    """A claim effective next year has not gone stale; the temporal filter decides whether it is
    eligible at all, and freshness must not double-judge it."""
    future = freshness_for(
        date(2027, 1, 1), None, date(2026, 8, 22), (), default_days=365, by_topic={}
    )

    assert future == 1.0
