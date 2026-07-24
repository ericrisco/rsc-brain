"""Temporal-intent classifier (SPEC-13, FR-16.1, pure)."""

from __future__ import annotations

import datetime as dt

from rsc_brain.recall.temporal_intent import TemporalKind, classify


def test_default_is_current() -> None:
    assert classify("what is the current price?").kind is TemporalKind.CURRENT
    assert classify("who owns payroll").kind is TemporalKind.CURRENT


def test_bare_date_without_a_cue_stays_current() -> None:
    # Ambiguous (a date but no temporal cue) → current, the safe D16 default.
    assert classify("invoice 2024-03-01 total").kind is TemporalKind.CURRENT


def test_historical_keywords_en_and_es() -> None:
    assert classify("show the price history").kind is TemporalKind.HISTORICAL
    assert classify("precios anteriores del producto").kind is TemporalKind.HISTORICAL
    assert classify("how did the policy evolve over time").kind is TemporalKind.HISTORICAL


def test_as_of_with_a_date() -> None:
    mode = classify("what was the price as of 2023-06-15")
    assert mode.kind is TemporalKind.AS_OF
    assert mode.as_of == dt.date(2023, 6, 15)
    mode_es = classify("precio a fecha de 2023-06-15")
    assert mode_es.kind is TemporalKind.AS_OF


def test_range_with_two_dates() -> None:
    mode = classify("changes between 2022-01-01 and 2022-12-31")
    assert mode.kind is TemporalKind.RANGE
    assert mode.start == dt.date(2022, 1, 1)
    assert mode.end == dt.date(2022, 12, 31)


def test_explicit_params_override_the_query() -> None:
    # An explicit as_of wins even over a "current"-looking query.
    forced = classify("current price", as_of=dt.date(2020, 1, 1))
    assert forced.kind is TemporalKind.AS_OF and forced.as_of == dt.date(2020, 1, 1)
    assert classify("current price", include_historical=True).kind is TemporalKind.HISTORICAL
