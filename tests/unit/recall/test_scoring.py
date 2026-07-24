"""Recall scoring (FR-3.2): freshness decay, per-topic half-life, missing-field defaults."""

from __future__ import annotations

import math
from datetime import date

import pytest

from rsc_brain.config.models import ScoreWeights
from rsc_brain.recall.scoring import (
    combined_score,
    freshness,
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
    weights = ScoreWeights()
    fresh_score = score_fragment(
        similarity=1.0,
        credibility=1.0,
        importance=1.0,
        valid_from=date(2026, 6, 24),  # 30 days before as_of
        as_of=date(2026, 7, 24),
        tags=["pricing"],
        weights=weights,
        default_half_life_days=365,
        half_life_by_topic={"pricing": 30},
    )
    # With a 30-day half-life at 30 days old, freshness = exp(-1).
    expected = 0.55 + 0.25 + 0.10 * math.exp(-1) + 0.10
    assert fresh_score == pytest.approx(expected, rel=1e-6)
