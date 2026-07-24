"""MCP auth + typed errors (SPEC-06 §5.8, FR-4.1a/12.3).

Auth is a Bearer PAT (``Authorization: Bearer ck_…``) resolved to a
:class:`~rsc_brain.scope.ProjectScope` by the SPEC-04 resolver — scope comes only from the token,
never from tool input. Errors are the typed set the contract requires: ``AUTH_INVALID`` /
``RATE_LIMITED`` / ``INTERNAL`` (RATE_LIMITED is typed here, enforced with quotas in SPEC-11).
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.identity.resolve import resolve_scope
from rsc_brain.scope import ProjectScope

BEARER_PREFIX = "bearer"


class MCPToolError(Exception):
    """Base for typed MCP tool errors. ``code`` is the wire error code."""

    code = "INTERNAL"


class AuthInvalidError(MCPToolError):
    code = "AUTH_INVALID"


class RateLimitedError(MCPToolError):
    code = "RATE_LIMITED"

    def __init__(self, message: str = "rate limited", *, retry_after: int = 60) -> None:
        super().__init__(message)
        self.retry_after = retry_after  # seconds until the caller may retry (FR-14.7)


class InternalError(MCPToolError):
    code = "INTERNAL"


def parse_bearer(authorization: str | None) -> str | None:
    """Extract the token from an ``Authorization: Bearer <token>`` header, or None."""
    if not authorization:
        return None
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != BEARER_PREFIX:
        return None
    token = parts[1].strip()
    return token or None


async def authenticate(
    sessionmaker: async_sessionmaker[AsyncSession], authorization: str | None
) -> ProjectScope:
    """Resolve the presented Bearer PAT to a scope; raise ``AuthInvalidError`` if it does not
    resolve (missing, malformed, unknown, revoked, expired, or a disabled principal)."""
    token = parse_bearer(authorization)
    if token is None:
        raise AuthInvalidError("missing or malformed bearer token")
    scope = await resolve_scope(sessionmaker, token)
    if scope is None:
        raise AuthInvalidError("invalid or revoked token")
    return scope
