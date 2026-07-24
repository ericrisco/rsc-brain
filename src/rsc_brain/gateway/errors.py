"""Typed, redacted gateway errors (AUDIT-005).

Public gateway errors NEVER carry raw upstream text (provider exception bodies, prompts,
credentials, URLs). They expose a stable ``code`` and a ``correlation_id`` for internal
diagnosis only. Ingestion uses these typed errors to discard-and-log rather than let bad data
reach the graph (FR-1.8).
"""

from __future__ import annotations


class GatewayError(Exception):
    """Base class for all model-gateway failures. Message is constant + correlation id."""

    def __init__(self, code: str, correlation_id: str, detail: str = "model gateway error") -> None:
        self.code = code
        self.correlation_id = correlation_id
        super().__init__(f"[{code}] {detail} (ref={correlation_id})")


class UnknownCapabilityError(GatewayError):
    """A capability was requested that is not configured."""


class GatewayRoutingError(GatewayError):
    """A caller attempted to influence routing/destination (should be unreachable by type)."""


class GatewayUnavailableError(GatewayError):
    """The provider call failed. No upstream exception text is propagated."""


class GatewayValidationError(GatewayError):
    """Structured output could not be validated/repaired within the allowed attempts."""


class GatewayDimensionError(GatewayError):
    """An embedding was returned with a dimension other than the configured anchor."""
