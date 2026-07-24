"""Model gateway over LiteLLM (FR-9.*). Implemented in SPEC-01."""

from rsc_brain.gateway.errors import (
    GatewayDimensionError,
    GatewayError,
    GatewayRoutingError,
    GatewayUnavailableError,
    GatewayValidationError,
    UnknownCapabilityError,
)
from rsc_brain.gateway.model_gateway import HealthStatus, ModelGateway
from rsc_brain.gateway.options import GenerationOptions

__all__ = [
    "GatewayDimensionError",
    "GatewayError",
    "GatewayRoutingError",
    "GatewayUnavailableError",
    "GatewayValidationError",
    "GenerationOptions",
    "HealthStatus",
    "ModelGateway",
    "UnknownCapabilityError",
]
