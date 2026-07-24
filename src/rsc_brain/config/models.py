"""Typed configuration models for rsc-brain.

These are plain Pydantic models describing the *shape* of the configuration. The
loading policy (YAML file + environment overlay, 12-factor) lives in
``rsc_brain.config.settings``. Secrets are typed as ``SecretStr`` so they never
render in logs or ``repr`` output and are expected to arrive from the environment,
never from the committed ``config.yaml`` (FR-4.7).
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator

# The embedding dimension is anchored to BGE-M3 (D5) and must match the DDL
# ``chunks.embedding vector(1024)`` (PRD §5.2). The gateway fails loudly if a
# configured embedder returns a different dimension (FR-9.4).
ANCHORED_EMBEDDING_DIM = 1024


class Capability(StrEnum):
    """Configurable model roles (PRD §13 glossary: "capacidad")."""

    EXTRACTOR = "extractor"
    JUDGE = "judge"
    TOPICALIZER = "topicalizer"
    EMBEDDER = "embedder"
    RERANKER = "reranker"


class HardwareProfile(StrEnum):
    """Hardware profile presets (G5)."""

    WORKSTATION = "workstation"
    CPU_ONLY = "cpu_only"


class CapabilityConfig(BaseModel):
    """Per-capability model routing. Owned by configuration, never by callers.

    All routing fields (``provider``, ``model``, ``api_base``, ``api_key``,
    ``timeout_s``, ``fallback_model``) are resolved here and are immutable from
    ordinary call data at the gateway boundary (AUDIT-005).
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    provider: str = Field(description="LiteLLM provider prefix, e.g. 'ollama', 'openai'.")
    model: str = Field(description="Provider-specific model name.")
    api_base: str | None = Field(
        default=None, description="Endpoint override; None uses the provider default."
    )
    api_key: SecretStr | None = Field(default=None, description="Credential — supply via env only.")
    timeout_s: float = Field(default=60.0, gt=0, le=600)
    fallback_model: str | None = Field(
        default=None, description="Same-provider fallback on definitive failure."
    )
    dimension: int | None = Field(
        default=None, description="Embedding dimension anchor (embedder only)."
    )

    @property
    def litellm_model(self) -> str:
        """The ``provider/model`` string LiteLLM expects for routing."""
        return f"{self.provider}/{self.model}"

    @property
    def effective_dimension(self) -> int:
        """Configured embedding dimension, defaulting to the BGE-M3 anchor (FR-9.4)."""
        return self.dimension if self.dimension is not None else ANCHORED_EMBEDDING_DIM


class CapabilitiesConfig(BaseModel):
    """The five configurable capabilities (FR-9.1)."""

    model_config = ConfigDict(extra="forbid")

    extractor: CapabilityConfig
    judge: CapabilityConfig
    topicalizer: CapabilityConfig
    embedder: CapabilityConfig
    reranker: CapabilityConfig

    @model_validator(mode="after")
    def _anchor_embedder_dimension(self) -> CapabilitiesConfig:
        # If an embedder dimension is set explicitly it must equal the anchor; when
        # omitted, ``embedder.effective_dimension`` supplies the anchor without mutation.
        dim = self.embedder.dimension
        if dim is not None and dim != ANCHORED_EMBEDDING_DIM:
            raise ValueError(
                f"embedder.dimension must be {ANCHORED_EMBEDDING_DIM} (BGE-M3 anchor); got {dim}"
            )
        return self

    def get(self, capability: Capability) -> CapabilityConfig:
        return getattr(self, capability.value)  # type: ignore[no-any-return]


Weight = Annotated[float, Field(ge=0.0, le=1.0)]


class ScoreWeights(BaseModel):
    """Recall score weights (FR-3.2): score = 0.55·sim + 0.25·cred + 0.10·fresh + 0.10·imp."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    similarity: Weight = 0.55
    credibility: Weight = 0.25
    freshness: Weight = 0.10
    importance: Weight = 0.10

    @model_validator(mode="after")
    def _weights_sum_to_one(self) -> ScoreWeights:
        total = self.similarity + self.credibility + self.freshness + self.importance
        if abs(total - 1.0) > 1e-6:
            raise ValueError(f"score weights must sum to 1.0; got {total:.6f}")
        return self


class RecallConfig(BaseModel):
    """Recall tuning (FR-3.2 / §5.8)."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    tau: Weight = Field(
        default=0.45, description="Relevance threshold τ below which recall abstains (D2)."
    )
    weights: ScoreWeights = Field(default_factory=ScoreWeights)
    half_life_days: int = Field(
        default=365, gt=0, description="Freshness half-life default (FR-3.2)."
    )
    half_life_by_topic: dict[str, int] = Field(
        default_factory=dict, description="Per-topic freshness half-life overrides (FR-3.2)."
    )
    k_hop: int = Field(
        default=1,
        ge=0,
        le=3,
        description="Graph expansion depth (k=1 default, k=2 config; FR-3.1).",
    )
    answer_token_budget: int = Field(
        default=2000, gt=0, description="Response fragment token budget (§5.8)."
    )


class RerankerConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")
    enabled: bool = False  # FR-3.6 (P2)


class VisionConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")
    enabled: bool = False  # FR-1.11 reserved


class IngestConfig(BaseModel):
    """Ingestion pipeline tuning (SPEC-05)."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    data_dir: str = Field(
        default="data", description="Root for stored document blobs + the watched inbox."
    )
    sensitivity_threshold: int = Field(
        default=3,
        ge=0,
        description="Topic sensitivity ≥ this holds an LLM-tagged doc for review (D13/FR-4.14).",
    )
    default_tag: str = Field(
        default="general", description="Fallback tag when nothing else applies (FR-1.7)."
    )
    watch_interval_s: float = Field(default=2.0, gt=0, description="Folder-watcher poll interval.")
    watch_settle_s: float = Field(
        default=1.0, ge=0, description="Debounce: ignore files modified within this window."
    )


class DatabaseConfig(BaseModel):
    """Data-service connection. The DSN carries a secret and is env-only (12-factor)."""

    model_config = ConfigDict(frozen=True, extra="forbid")
    dsn: SecretStr | None = Field(default=None, description="Postgres DSN; supply via env only.")


class LoggingConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", populate_by_name=True)
    level: str = Field(default="INFO")
    json_format: bool = Field(
        default=True,
        alias="json",
        description="Emit JSON logs (structlog wiring lands in SPEC-23).",
    )


class AppConfig(BaseModel):
    """Root configuration tree."""

    model_config = ConfigDict(extra="forbid")

    hardware_profile: HardwareProfile = HardwareProfile.WORKSTATION
    capabilities: CapabilitiesConfig
    recall: RecallConfig = Field(default_factory=RecallConfig)
    reranker: RerankerConfig = Field(default_factory=RerankerConfig)
    vision: VisionConfig = Field(default_factory=VisionConfig)
    ingest: IngestConfig = Field(default_factory=IngestConfig)
    database: DatabaseConfig = Field(default_factory=DatabaseConfig)
    logging: LoggingConfig = Field(default_factory=LoggingConfig)
