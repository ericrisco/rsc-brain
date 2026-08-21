"""Normalization of untrusted claim validity metadata (AUDIT-105)."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from rsc_brain.ingest.temporal_validity import normalize_validity


@pytest.mark.parametrize(
    ("raw_from", "raw_to", "expected_from", "expected_to"),
    [
        (
            "2024-01-01",
            None,
            datetime(2024, 1, 1, tzinfo=UTC),
            None,
        ),
        (
            "2024-01-01T01:30:00+01:00",
            "2024-01-01T03:30:00+01:00",
            datetime(2024, 1, 1, 0, 30, tzinfo=UTC),
            datetime(2024, 1, 1, 2, 30, tzinfo=UTC),
        ),
        (
            None,
            "2024-01-01T00:00:00Z",
            None,
            datetime(2024, 1, 1, tzinfo=UTC),
        ),
    ],
)
def test_normalize_validity_normalizes_supported_iso_values_to_utc(
    raw_from: str | None,
    raw_to: str | None,
    expected_from: datetime | None,
    expected_to: datetime | None,
) -> None:
    normalized = normalize_validity(raw_from, raw_to)

    assert normalized.valid_from == expected_from
    assert normalized.valid_to == expected_to
    assert normalized.diagnostics == ()


def test_normalize_validity_keeps_missing_boundaries_unknown() -> None:
    normalized = normalize_validity(None, None)

    assert normalized.valid_from is None
    assert normalized.valid_to is None
    assert normalized.diagnostics == ()


@pytest.mark.parametrize(
    ("raw_from", "raw_to", "expected_field"),
    [
        ("not-a-date", None, "valid_from"),
        (None, "2024-01-01T00:00:00", "valid_to"),
        ("2024-01-01T00:00:00+01:99", None, "valid_from"),
        ("2024-01-01T00:00:00+24:00", None, "valid_from"),
        ("2024-02-01", "2024-02-01", "validity"),
        ("2024-02-02T00:00:00Z", "2024-02-01T00:00:00Z", "validity"),
    ],
)
def test_normalize_validity_degrades_unsupported_or_empty_intervals_non_fatally(
    raw_from: str | None, raw_to: str | None, expected_field: str
) -> None:
    normalized = normalize_validity(raw_from, raw_to)

    assert normalized.valid_from is None
    assert normalized.valid_to is None
    assert len(normalized.diagnostics) == 1
    assert normalized.diagnostics[0].field == expected_field
