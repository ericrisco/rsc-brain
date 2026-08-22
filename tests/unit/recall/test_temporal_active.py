"""The one half-open valid-time contract shared by recall readers."""

from __future__ import annotations

import datetime as dt

import pytest

from rsc_brain.temporal import is_active_at

ANCHOR = dt.datetime(2026, 8, 20, 12, tzinfo=dt.UTC)


@pytest.mark.parametrize(
    ("valid_from", "valid_to", "expected"),
    [
        (None, None, True),
        (ANCHOR, None, True),
        (ANCHOR + dt.timedelta(microseconds=1), None, False),
        (None, ANCHOR, False),
        (None, ANCHOR + dt.timedelta(microseconds=1), True),
        (ANCHOR - dt.timedelta(days=1), ANCHOR, False),
        (ANCHOR - dt.timedelta(days=1), ANCHOR + dt.timedelta(days=1), True),
    ],
    ids=(
        "unknown",
        "starts-at-anchor",
        "future-start",
        "ends-at-anchor",
        "future-end",
        "expired",
        "bounded",
    ),
)
def test_is_active_at_uses_a_half_open_interval(
    valid_from: dt.datetime | None, valid_to: dt.datetime | None, expected: bool
) -> None:
    assert is_active_at(valid_from, valid_to, ANCHOR) is expected


def test_a_range_excludes_a_claim_starting_at_its_exclusive_end() -> None:
    """AUDIT-123: `[start, end)` means end is not in the range.

    Measured on the corpus: "What was the Acme support SLA in 2023?" classifies as RANGE
    `[2023-01-01, 2024-01-01)` since AUDIT-117, and returned the 2024 claim — whose validity begins
    exactly at 2024-01-01. The condition was `valid_from <= end`, so the instant that ends the range
    also opened it. Every other valid-time comparison in this product is half-open; this one was not,
    and the mismatch only became reachable once a natural question could produce a RANGE at all.
    """
    from rsc_brain.recall.retriever import PgRetriever
    from rsc_brain.recall.temporal_intent import TemporalKind, TemporalMode

    mode = TemporalMode(TemporalKind.RANGE, start=dt.date(2023, 1, 1), end=dt.date(2024, 1, 1))

    rendered = " ".join(
        str(condition.compile(compile_kwargs={"literal_binds": True}))
        for condition in PgRetriever._temporal_conditions(
            mode, dt.datetime(2026, 8, 22, tzinfo=dt.UTC), False, None
        )
    )

    assert "valid_from < '2024-01-01" in rendered, (
        "a claim whose validity begins at the range's exclusive end is not valid during the range: "
        f"{rendered}"
    )
    assert "valid_from <= '2024-01-01" not in rendered
