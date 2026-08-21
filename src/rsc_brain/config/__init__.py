"""12-factor configuration (pydantic-settings): file + env overlay. Implemented in SPEC-01."""

from rsc_brain.config.models import (
    ANCHORED_EMBEDDING_DIM,
    AppConfig,
    CapabilitiesConfig,
    Capability,
    CapabilityConfig,
    DatabaseConfig,
    HardwareProfile,
    LoggingConfig,
    ModelEgressConfig,
    RecallConfig,
    RerankerConfig,
    ScoreWeights,
    VisionConfig,
)
from rsc_brain.config.settings import CONFIG_ENV_VAR, Settings, load_settings

__all__ = [
    "ANCHORED_EMBEDDING_DIM",
    "CONFIG_ENV_VAR",
    "AppConfig",
    "CapabilitiesConfig",
    "Capability",
    "CapabilityConfig",
    "DatabaseConfig",
    "HardwareProfile",
    "LoggingConfig",
    "ModelEgressConfig",
    "RecallConfig",
    "RerankerConfig",
    "ScoreWeights",
    "Settings",
    "VisionConfig",
    "load_settings",
]
