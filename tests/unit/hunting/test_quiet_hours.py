from __future__ import annotations

import datetime as dt

from rsc_brain.hunting.directory import PersonRow
from rsc_brain.hunting.quiet_hours import in_quiet_hours, next_allowed_at


def _person(*, start: str, end: str, tz: str) -> PersonRow:
    return PersonRow(
        id="11111111-1111-1111-1111-111111111111",
        name="Owner",
        channels={"email": "owner@example.test"},
        topics=("hr",),
        quiet_hours={"start": start, "end": end, "tz": tz},
    )


def test_quiet_hours_use_the_person_timezone_and_return_the_next_open_instant() -> None:
    person = _person(start="22:00", end="08:00", tz="Europe/Madrid")
    now = dt.datetime(2026, 8, 20, 21, 30, tzinfo=dt.UTC)  # 23:30 CEST
    assert in_quiet_hours(person, now) is True
    assert next_allowed_at(person, now) == dt.datetime(2026, 8, 21, 6, 0, tzinfo=dt.UTC)


def test_invalid_or_open_quiet_window_never_delays_delivery() -> None:
    now = dt.datetime(2026, 8, 20, 12, 0, tzinfo=dt.UTC)
    invalid = _person(start="bad", end="08:00", tz="Not/AZone")
    daytime = _person(start="22:00", end="08:00", tz="UTC")
    assert in_quiet_hours(invalid, now) is False
    assert next_allowed_at(invalid, now) == now
    assert in_quiet_hours(daytime, now) is False
    assert next_allowed_at(daytime, now) == now
