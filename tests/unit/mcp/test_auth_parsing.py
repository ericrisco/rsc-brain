"""Bearer-token parsing for MCP auth (pure)."""

from __future__ import annotations

import pytest

from rsc_brain.mcp.auth import AuthInvalidError, InternalError, RateLimitedError, parse_bearer


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        ("Bearer ck_abc123", "ck_abc123"),
        ("bearer ck_abc123", "ck_abc123"),
        ("Bearer   ck_spaced  ", "ck_spaced"),
        (None, None),
        ("", None),
        ("ck_no_scheme", None),
        ("Basic ck_wrong_scheme", None),
        ("Bearer ", None),
    ],
)
def test_parse_bearer(header: str | None, expected: str | None) -> None:
    assert parse_bearer(header) == expected


def test_typed_error_codes() -> None:
    assert AuthInvalidError().code == "AUTH_INVALID"
    assert RateLimitedError().code == "RATE_LIMITED"
    assert InternalError().code == "INTERNAL"
