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


def test_in_a_bare_year_is_a_question_about_that_year() -> None:
    """AUDIT-117: measured on the corpus — `t4` "What was the Globex day rate in 2022?" found
    nothing, because the query classified as CURRENT and the 2022 rate had already been superseded.
    A bare year with an `in` cue is the most natural way to ask a historical question, and neither
    the ISO-date pattern nor the keyword list recognised it."""
    mode = classify("What was the Globex day rate in 2022?")

    assert mode.kind is TemporalKind.RANGE
    assert mode.start == dt.date(2022, 1, 1)
    # Half-open, like every other valid-time interval in the product: the year ends where the next
    # one begins, so a claim closed on 2023-01-01 does not count as valid during 2022.
    assert mode.end == dt.date(2023, 1, 1)


def test_the_year_cue_works_in_spanish() -> None:
    mode = classify("¿Cuál era la tarifa de Globex en 2022?")

    assert mode.kind is TemporalKind.RANGE
    assert mode.start == dt.date(2022, 1, 1)


def test_a_year_without_a_cue_stays_current() -> None:
    """D16's safe default is unchanged: surfacing an expired fact when the caller wanted today's is
    the dangerous direction, so only an explicit cue moves off `current`."""
    assert classify("the 2022 pricing model we use").kind is TemporalKind.CURRENT
    assert classify("Acme Cloud costs 49 EUR").kind is TemporalKind.CURRENT


def test_an_iso_date_is_not_read_twice_as_a_year() -> None:
    """`as of 2023-06-01` must stay a point in time, not become a range over 2023."""
    mode = classify("What was the Acme support SLA as of 2023-06-01?")

    assert mode.kind is TemporalKind.AS_OF
    assert mode.as_of == dt.date(2023, 6, 1)


def test_an_in_year_range_beats_a_bare_history_keyword() -> None:
    """ "previously, in 2022" asks about 2022, not about the whole timeline."""
    mode = classify("What did we previously charge in 2022?")

    assert mode.kind is TemporalKind.RANGE
    assert mode.start == dt.date(2022, 1, 1)
