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
