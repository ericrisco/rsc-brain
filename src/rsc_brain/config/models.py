"""Typed configuration models for rsc-brain.

These are plain Pydantic models describing the *shape* of the configuration. The
loading policy (YAML file + environment overlay, 12-factor) lives in
``rsc_brain.config.settings``. Secrets are typed as ``SecretStr`` so they never
render in logs or ``repr`` output and are expected to arrive from the environment,
never from the committed ``config.yaml`` (FR-4.7).
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator

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
    daily_token_budget: int | None = Field(
        default=None,
        ge=0,
        description="Max tokens/day for this capability (FR-9.5); None = unlimited.",
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
    """The configurable capabilities (FR-9.1).

    AUDIT-077: `reranker` used to be required like the rest. FR-3.6 makes the reranker **optional and
    P2**, `RerankerConfig.enabled` is `False` by default, and the product contains no call site for
    it — so every operator had to choose a provider and a model name for a capability that is off,
    unimplemented and never invoked, and `brain verify` then reported "every capability is
    configured" for a route that leads nowhere. Against G1 that is one of five mandatory decisions
    being dead weight.

    It stays configurable, and becomes required the moment `reranker.enabled` is true (validated on
    `AppConfig`, which is where both halves are visible).
    """

    model_config = ConfigDict(extra="forbid")

    extractor: CapabilityConfig
    judge: CapabilityConfig
    topicalizer: CapabilityConfig
    embedder: CapabilityConfig
    reranker: CapabilityConfig | None = None

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
        """The route for ``capability``, or a refusal naming it.

        AUDIT-077: an optional route means this can now be absent. Returning ``None`` to a caller
        that expects a route is how a missing configuration becomes an ``AttributeError`` three
        frames away, so the refusal happens here and says which capability is unconfigured.
        """
        route: CapabilityConfig | None = getattr(self, capability.value)
        if route is None:
            raise ValueError(
                f"capability {capability.value!r} has no configured model route; "
                f"set capabilities.{capability.value} to use it"
            )
        return route


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

    # R23: how much MORE than the page to retrieve, so the temporal filter has something to remove.
    # Relevance ranking runs before the filter can (it needs each chunk's claims), so retrieving
    # exactly the page lets stale-but-similar chunks starve the eligible answer out of it. Bounded by
    # `retriever.MAX_RETRIEVAL_WIDTH` so a large page cannot turn into an unbounded scan (R38).
    temporal_refill_factor: int = Field(default=4, ge=1, le=20)

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
    # Hybrid lexical+vector search (FR-3.7). RRF fuses the two candidate lists; `simple` tsvector
    # covers exact identifiers embeddings miss. `hybrid_enabled=False` reverts to v0.1 vector-only.
    hybrid_enabled: bool = Field(
        default=True, description="Fuse a lexical (tsvector) candidate list with the vector one."
    )
    rrf_k: int = Field(default=60, gt=0, description="Reciprocal Rank Fusion constant k (FR-3.7).")
    lexical_candidates: int = Field(
        default=20, gt=0, description="Max lexical candidates per query before fusion."
    )


class RerankerConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")
    enabled: bool = False  # FR-3.6 (P2)


class VisionConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")
    enabled: bool = False  # FR-1.11 reserved


class TelemetryConfig(BaseModel):
    """Anonymous opt-in telemetry (SPEC-22, FR-10.5). OFF by default (OSS): nothing is sent unless
    the operator explicitly enables it. When on, only version + hardware profile + counters."""

    model_config = ConfigDict(frozen=True, extra="forbid")
    enabled: bool = False


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


class KnowledgeConfig(BaseModel):
    """Living-graph tuning (SPEC-08): credibility, contradictions, feedback, corrections."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    # Authority by source kind (FR-5.1, versioned table). Deterministic tables are the most
    # authoritative document evidence; hunting answers (v0.3) are reserved highest.
    authority_by_source: dict[str, float] = Field(
        default_factory=lambda: {
            "hunting": 0.95,
            "table": 0.9,
            "official_prose": 0.7,
            "prose": 0.6,
            "low_quality_ocr": 0.4,
        }
    )
    default_authority: float = Field(default=0.6, ge=0.0, le=1.0)
    # Contradiction detection/resolution (FR-5.2/5.3).
    contradiction_sim_threshold: float = Field(default=0.75, ge=0.0, le=1.0)
    tie_delta: float = Field(default=0.15, ge=0.0, le=1.0)
    winner_boost: float = Field(default=0.1, ge=0.0, le=1.0)
    loser_factor: float = Field(default=0.5, ge=0.0, le=1.0)
    # Feedback (FR-5.4).
    feedback_alpha_human: float = Field(default=0.1, ge=0.0, le=1.0)
    feedback_alpha_agent: float = Field(default=0.03, ge=0.0, le=1.0)
    feedback_daily_cap: float = Field(
        default=0.1, ge=0.0, le=1.0, description="Max daily |Δcred| per (principal, claim)."
    )
    human_wrong_disputed_below: float = Field(
        default=0.3, ge=0.0, le=1.0, description="Human `wrong` below this credibility ⇒ disputed."
    )
    # Corrections (FR-15.x).
    correction_credibility: float = Field(default=0.9, ge=0.0, le=1.0)
    superseded_credibility: float = Field(default=0.1, ge=0.0, le=1.0)
    corrections_per_person_per_day: int = Field(default=20, ge=1)
    correction_war_threshold: int = Field(
        default=3, ge=1, description="Back-and-forth corrections before escalating to admin."
    )
    agents_can_correct: bool = Field(default=False, description="FR-15.10: default false.")
    # Alias-merge (SPEC-09, FR-1.9 P1). Conservative by design: below auto-apply → human review.
    merge_min_similarity: float = Field(
        default=0.82, ge=0.0, le=1.0, description="Min name similarity to propose a merge."
    )
    merge_auto_apply_confidence: float = Field(
        default=0.97, ge=0.0, le=1.0, description="At/above this confidence a merge auto-applies."
    )


class PublicLimits(BaseModel):
    """Ratified ceilings for every public surface (AUDIT-044 / R38, plan §3).

    Nothing here is optional. A surface with no ceiling is unbounded work an anonymous or
    minimally-authorized caller can ask for: a 5 GB body, a million-entry array, a page that scans the
    whole table. Deployments may LOWER these; omitting one is what the finding was.
    """

    model_config = ConfigDict(extra="forbid")

    json_body_bytes: int = Field(default=1024 * 1024, ge=1024)
    ontology_bytes: int = Field(default=5 * 1024 * 1024, ge=1024)
    free_text_bytes: int = Field(default=64 * 1024, ge=256)
    upload_bytes: int = Field(default=50 * 1024 * 1024, ge=1024)
    public_array_items: int = Field(default=100, ge=1)
    page_items: int = Field(default=100, ge=1)
    admin_page_items: int = Field(default=200, ge=1)
    audit_export_rows: int = Field(default=10_000, ge=1)
    window_days: int = Field(default=365, ge=1)


class IngressConfig(BaseModel):
    """How the service is reached from outside (AUDIT-038 / R51).

    ``public_origin`` is the scheme+host clients actually use. It is a DEPLOYMENT fact, not something
    a request can imply: OAuth metadata used to be built from ``request.base_url``, so a direct client
    sending ``Host: attacker.example`` received an issuer and three endpoint URLs on the attacker's
    host — and a client that discovers metadata that way sends its authorization code there. The MCP
    transport also uses it as the exact public Host and Origin boundary while retaining DNS-rebinding
    protection.

    ``trusted_proxies`` lists the networks whose forwarding headers may be believed. Empty means the
    service is reached directly and no forwarding header is trusted from anyone, which is the safe
    default rather than the permissive one.
    """

    model_config = ConfigDict(extra="forbid")

    public_origin: str | None = Field(
        default=None,
        description=(
            "ASCII HTTP(S) scheme+host, e.g. https://brain.example.com; also the MCP Host/Origin "
            "boundary. Use IDNA punycode for international domains. None → derive OAuth per "
            "request and keep MCP loopback-only."
        ),
    )
    trusted_proxies: list[str] = Field(
        default_factory=list,
        description="CIDRs whose X-Forwarded-* headers are believed. Empty trusts none.",
    )

    @field_validator("public_origin")
    @classmethod
    def _canonical_public_origin(cls, value: str | None) -> str | None:
        """Validate one ASCII HTTP origin and give every security consumer the same value."""
        if value is None:
            return None
        candidate = value.strip()
        if not candidate:
            return None
        try:
            parsed = urlsplit(candidate)
            port = parsed.port
        except ValueError as exc:
            raise ValueError("public origin must contain a valid host and port") from exc

        scheme = parsed.scheme.lower()
        hostname = parsed.hostname
        if (
            scheme not in {"http", "https"}
            or not hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or bool(parsed.query)
            or bool(parsed.fragment)
            or (parsed.netloc.startswith("[") and ":" not in hostname)
        ):
            raise ValueError("public origin must be an HTTP(S) scheme plus host, without a path")
        if not hostname.isascii() or any(
            not (character.isalnum() or character in ".-:") for character in hostname
        ):
            raise ValueError(
                "public origin host must be ASCII; configure international domains as IDNA punycode"
            )

        canonical_host = hostname.lower()
        if ":" in canonical_host:
            canonical_host = f"[{canonical_host}]"
        default_port = 443 if scheme == "https" else 80
        authority = (
            canonical_host if port is None or port == default_port else f"{canonical_host}:{port}"
        )
        return f"{scheme}://{authority}"


class SmtpConfig(BaseModel):
    """SMTP delivery for hunts. The password is a secret and belongs in the environment."""

    model_config = ConfigDict(extra="forbid")

    host: str
    port: int = Field(default=587, ge=1, le=65535)
    sender: str = Field(default="rsc-brain@localhost")
    username: str | None = None
    password: SecretStr | None = Field(default=None, description="Supply via env only.")
    starttls: bool = True


class SlackConfig(BaseModel):
    """Slack delivery for hunts. The bot token is a secret and belongs in the environment."""

    model_config = ConfigDict(extra="forbid")

    bot_token: SecretStr = Field(description="Bot token; supply via env only.")
    default_channel: str | None = None


class HuntingConfig(BaseModel):
    """How a hunt reaches the person who knows (AUDIT-042 / R28).

    ``channel`` defaults to ``"none"`` because an install that has said nothing about email or Slack
    cannot deliver anything. What changed is that the product now SAYS so: an opened hunt on such an
    install is reported undelivered instead of awaiting an answer, so an unconfigured install is
    distinguishable from a working one. It used to be indistinguishable, which left knowledge gaps open
    behind records claiming somebody had been contacted.
    """

    model_config = ConfigDict(extra="forbid")

    channel: Literal["none", "smtp", "slack"] = "none"
    smtp: SmtpConfig | None = None
    slack: SlackConfig | None = None


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
    # (the validator that ties `reranker.enabled` to its route lives after the field block)
    vision: VisionConfig = Field(default_factory=VisionConfig)
    telemetry: TelemetryConfig = Field(default_factory=TelemetryConfig)
    ingest: IngestConfig = Field(default_factory=IngestConfig)
    knowledge: KnowledgeConfig = Field(default_factory=KnowledgeConfig)
    database: DatabaseConfig = Field(default_factory=DatabaseConfig)
    ingress: IngressConfig = Field(default_factory=IngressConfig)
    hunting: HuntingConfig = Field(default_factory=HuntingConfig)
    limits: PublicLimits = Field(default_factory=PublicLimits)
    logging: LoggingConfig = Field(default_factory=LoggingConfig)

    @model_validator(mode="after")
    def _reranker_route_required_only_when_enabled(self) -> AppConfig:
        """AUDIT-077: optional is not ignorable.

        The route stops being mandatory for everyone, and starts being mandatory for whoever turns
        the feature on — refused here, at load, rather than at the first call that finds no route.
        """
        if self.reranker.enabled and self.capabilities.reranker is None:
            raise ValueError(
                "reranker.enabled is true but capabilities.reranker has no model route; "
                "configure the route or leave the reranker disabled (FR-3.6 makes it optional)"
            )
        return self
