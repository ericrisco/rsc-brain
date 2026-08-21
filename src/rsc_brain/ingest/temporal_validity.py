"""Normalize source-supported claim validity without discarding the claim.

The extraction boundary intentionally carries raw strings: a malformed model
date must not make Pydantic reject an otherwise useful claim. This module is
the single conversion point from that untrusted representation to UTC-aware
datetimes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime

_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_ISO_TIMESTAMP = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?"
    r"(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$"
)


@dataclass(frozen=True, slots=True)
class TemporalDiagnostic:
    """A non-fatal reason why source validity could not be retained."""

    field: str
    message: str


@dataclass(frozen=True, slots=True)
class NormalizedValidity:
    """UTC validity boundaries and any non-fatal normalization diagnostics."""

    valid_from: datetime | None
    valid_to: datetime | None
    diagnostics: tuple[TemporalDiagnostic, ...]


def normalize_validity(raw_from: str | None, raw_to: str | None) -> NormalizedValidity:
    """Normalize canonical ISO boundaries, degrading unusable metadata to null.

    Dates denote midnight UTC. Timestamps must carry an explicit UTC offset so
    their meaning is source-supported rather than guessed. A present pair is a
    half-open interval and is valid only when ``valid_from < valid_to``.
    """
    valid_from, from_diagnostic = _parse_boundary(raw_from, "valid_from")
    valid_to, to_diagnostic = _parse_boundary(raw_to, "valid_to")
    diagnostics = tuple(
        diagnostic for diagnostic in (from_diagnostic, to_diagnostic) if diagnostic is not None
    )
    if diagnostics:
        return NormalizedValidity(None, None, diagnostics)

    if valid_from is not None and valid_to is not None and valid_to <= valid_from:
        return NormalizedValidity(
            None,
            None,
            (
                TemporalDiagnostic(
                    field="validity",
                    message="valid_to must be later than valid_from",
                ),
            ),
        )

    return NormalizedValidity(valid_from, valid_to, ())


def _parse_boundary(
    raw_value: str | None, field: str
) -> tuple[datetime | None, TemporalDiagnostic | None]:
    if raw_value is None:
        return None, None

    if _ISO_DATE.fullmatch(raw_value):
        try:
            parsed_date = datetime.fromisoformat(raw_value)
        except ValueError:
            return None, _unsupported_value(field)
        return parsed_date.replace(tzinfo=UTC), None

    if _ISO_TIMESTAMP.fullmatch(raw_value):
        try:
            parsed_timestamp = datetime.fromisoformat(raw_value)
        except ValueError:
            return None, _unsupported_value(field)
        if parsed_timestamp.tzinfo is not None and parsed_timestamp.utcoffset() is not None:
            return parsed_timestamp.astimezone(UTC), None

    return None, _unsupported_value(field)


def _unsupported_value(field: str) -> TemporalDiagnostic:
    return TemporalDiagnostic(
        field=field,
        message=f"{field} is not a supported ISO date or offset timestamp",
    )
