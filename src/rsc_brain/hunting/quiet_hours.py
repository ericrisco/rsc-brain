"""Directory quiet-hour policy shared by hunts and durable skill notifications."""

from __future__ import annotations

import datetime as dt
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from rsc_brain.hunting.directory import PersonRow


def _hhmm(value: object) -> dt.time | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = dt.time.fromisoformat(value)
    except ValueError:
        return None
    if parsed.second or parsed.microsecond:
        return None
    return parsed


def _window(person: PersonRow) -> tuple[dt.time, dt.time, ZoneInfo] | None:
    quiet = person.quiet_hours or {}
    start = _hhmm(quiet.get("start"))
    end = _hhmm(quiet.get("end"))
    if start is None or end is None or start == end:
        return None
    timezone = quiet.get("tz", "UTC")
    if not isinstance(timezone, str):
        return None
    try:
        zone = ZoneInfo(timezone)
    except ZoneInfoNotFoundError:
        return None
    return start, end, zone


def in_quiet_hours(person: PersonRow, now: dt.datetime) -> bool:
    """Whether the aware instant is inside the person's local half-open quiet window."""
    window = _window(person)
    if window is None:
        return False
    start, end, zone = window
    local_time = now.astimezone(zone).timetz().replace(tzinfo=None)
    if start < end:
        return start <= local_time < end
    return local_time >= start or local_time < end


def next_allowed_at(person: PersonRow, now: dt.datetime) -> dt.datetime:
    """The first UTC instant at which delivery is permitted; ``now`` when already permitted."""
    window = _window(person)
    if window is None or not in_quiet_hours(person, now):
        return now
    start, end, zone = window
    local = now.astimezone(zone)
    end_date = local.date()
    if start > end and local.timetz().replace(tzinfo=None) >= start:
        end_date += dt.timedelta(days=1)
    local_end = dt.datetime.combine(end_date, end, tzinfo=zone)
    return local_end.astimezone(dt.UTC)
