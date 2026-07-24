"""Credibility formula (FR-5.1) + feedback weighting with the daily cap (FR-5.4)."""

from __future__ import annotations

import pytest

from rsc_brain.knowledge.credibility import (
    apply_feedback,
    authority_for,
    capped_feedback,
    corroboration,
    initial_credibility,
)

TABLE = {"table": 0.9, "official_prose": 0.7, "low_quality_ocr": 0.4}


def test_corroboration_saturates_at_three_sources() -> None:
    assert corroboration(0) == 0.0
    assert corroboration(1) == pytest.approx(1 / 3)
    assert corroboration(3) == 1.0
    assert corroboration(4) == 1.0


def test_authority_table_lookup_with_default() -> None:
    assert authority_for("table", table=TABLE, default=0.6) == 0.9
    assert authority_for("unknown", table=TABLE, default=0.6) == 0.6
    assert authority_for(None, table=TABLE, default=0.6) == 0.6


def test_initial_credibility_matches_formula_and_clamps() -> None:
    cred = initial_credibility(
        authority=0.9, extraction_confidence=1.0, n_independent_sources=3, freshness=1.0
    )
    # 0.35*0.9 + 0.25*1 + 0.20*1 + 0.20*1 = 0.965
    assert cred == pytest.approx(0.965)
    # A high-authority table row is more credible than a low-quality OCR line.
    ocr = initial_credibility(
        authority=0.4, extraction_confidence=0.5, n_independent_sources=1, freshness=1.0
    )
    assert ocr < cred


def test_missing_extraction_confidence_is_neutral() -> None:
    cred = initial_credibility(
        authority=0.6, extraction_confidence=None, n_independent_sources=0, freshness=1.0
    )
    # extraction defaults to 0.5: 0.35*0.6 + 0.25*0.5 + 0 + 0.20*1 = 0.535
    assert cred == pytest.approx(0.535)


def test_feedback_moves_toward_signal() -> None:
    assert apply_feedback(0.5, "helpful", alpha=0.1) == pytest.approx(0.55)
    assert apply_feedback(0.5, "wrong", alpha=0.1) == pytest.approx(0.45)


def test_daily_cap_limits_movement() -> None:
    # A single move within budget applies fully.
    new, delta = capped_feedback(0.5, "wrong", alpha=0.1, remaining_daily_budget=0.1)
    assert new == pytest.approx(0.45)
    assert delta == pytest.approx(0.05)
    # A huge alpha is clipped to the remaining budget (agent-spam resistance).
    new2, delta2 = capped_feedback(0.5, "wrong", alpha=0.9, remaining_daily_budget=0.03)
    assert new2 == pytest.approx(0.47)
    assert delta2 == pytest.approx(0.03)
    # Exhausted budget → no movement.
    new3, delta3 = capped_feedback(0.5, "wrong", alpha=0.9, remaining_daily_budget=0.0)
    assert new3 == 0.5 and delta3 == 0.0
