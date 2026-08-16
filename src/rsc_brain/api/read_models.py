"""Typed, transient read-model envelopes for the console control plane.

These models deliberately contain no persisted authorization state.  Producers receive a
``ProjectScope`` and construct the envelope only after permission filtering, so generated clients
cannot accidentally interpret a raw store page as an authorized one.
"""

from __future__ import annotations

import datetime as dt

from pydantic import BaseModel


class ReadPage[T](BaseModel):
    """A bounded page whose metadata describes the authorized set only."""

    items: list[T]
    next_cursor: str | None
    total: int | None
    freshness: dt.datetime


class RecallView(BaseModel):
    """Display-safe recall audit row returned by the observability stream."""

    id: str
    ts: dt.datetime | None
    project_id: str
    user_id: str | None
    principal_type: str | None
    principal_id: str | None
    on_behalf_of: str | None
    trace_id: str | None
    action: str
    tool: str | None
    query_hash: str | None
    query_text: str | None
    duration_ms: int | None
    topics_used: list[str]
    result_count: int | None
    denied: bool


class ActivityDay(BaseModel):
    day: str
    recalls: int


class ActivityEnvelope(BaseModel):
    recalls: int
    denied: int
    active_principals: int
    p95_duration_ms: float | None
    recalls_per_day: list[ActivityDay]


class HealthEnvelope(BaseModel):
    database: str
    pending_approval: int
    ingest_errors: int


class IngestRunView(BaseModel):
    document_id: str
    phase: str
    completed_stages: list[str]
    chunks_created: int
    claims_generated: int
    discarded_chunks: int
    error: str | None


class IngestErrorView(BaseModel):
    document_id: str | None
    chunk: str | None
    stage: str
    error: str


class IngestEnvelope(BaseModel):
    runs: list[IngestRunView]
    errors: list[IngestErrorView]


class PendingDocumentView(BaseModel):
    document_id: str
    title: str | None
    proposed_tags: list[str]
    source_id: str | None
    preview: str
    content_type: str


class PendingDocumentEnvelope(BaseModel):
    documents: list[PendingDocumentView]


class GapView(BaseModel):
    id: str
    query_text: str | None
    topics: list[str]
    count: int
    status: str
    last_seen_at: dt.datetime | None


class GapEnvelope(BaseModel):
    gaps: list[GapView]


class HuntView(BaseModel):
    id: str
    type: str
    state: str
    question: str | None
    topics: list[str]
    person_id: str | None
    gap_id: str | None
    correction_id: str | None
    channel: str | None
    retries: int
    created_at: dt.datetime | None
    asked_at: dt.datetime | None
    answered_at: dt.datetime | None
    expires_at: dt.datetime | None
    resolved_at: dt.datetime | None


class HuntEnvelope(BaseModel):
    hunts: list[HuntView]


class DisputedClaimView(BaseModel):
    id: str
    text: str
    tags: list[str]
    credibility: float
    valid_to: dt.datetime | None


class DisputedClaimEnvelope(BaseModel):
    claims: list[DisputedClaimView]


class ResolutionSideView(BaseModel):
    claim_id: str
    text: str
    credibility: float
    valid_to: dt.datetime | None


class ContradictionResolutionView(BaseModel):
    verdict: str
    confidence: float
    judge_version: str
    winner: ResolutionSideView
    loser: ResolutionSideView
    created_at: dt.datetime | None


class ContradictionResolutionEnvelope(BaseModel):
    resolutions: list[ContradictionResolutionView]


class CorrectionView(BaseModel):
    id: str
    target_claim: str
    new_claim: str | None
    status: str
    role_applied: str | None
    author_id: str | None
    on_behalf_of: str | None
    hunt_id: str | None
    before_text: str | None
    after_text: str | None
    created_at: dt.datetime | None
    resolved_at: dt.datetime | None


class CorrectionEnvelope(BaseModel):
    corrections: list[CorrectionView]


class CorrectionMetricsEnvelope(BaseModel):
    total: int
    by_status: dict[str, int]
    applied: int
    routed_hunt: int
    rejected: int
    revert_rate: float
    correction_wars: int
    ownership_coverage: float


class CorrectionRevertResult(BaseModel):
    status: str
    explanation: str


class ReviewItemView(BaseModel):
    source: str
    id: str
    preview: str
    detail: dict[str, object]
    content_type: str


class ReviewQueueEnvelope(BaseModel):
    items: list[ReviewItemView]
    counts: dict[str, int]


class ChunkReviewResolution(BaseModel):
    chunk_id: str
    outcome: str


class MergeReviewResolution(BaseModel):
    proposal_id: str
    outcome: str


class PromoteGapResult(BaseModel):
    hunt_id: str
    state: str


class ProductMetricDay(BaseModel):
    """One exact server-owned recall count in the selected reporting window."""

    day: str
    recalls: int


class ProductAdoptionMetrics(BaseModel):
    recalls: int
    active_principals: int
    recalls_per_day: list[ProductMetricDay]


class ProductQualityMetrics(BaseModel):
    abstention_rate: float
    hunts_answered_pct: float


class ProductKnowledgeMetrics(BaseModel):
    claims: int
    disputed: int
    open_gaps: int


class ProductHealthMetrics(BaseModel):
    extraction_errors: int
    recall_p95_ms: float | None
    tokens_by_capability: dict[str, int]


class ProductMetricsEnvelope(BaseModel):
    """The four permission-filtered product families exposed to the console."""

    adoption: ProductAdoptionMetrics
    quality: ProductQualityMetrics
    knowledge: ProductKnowledgeMetrics
    health: ProductHealthMetrics


class UsageRowView(BaseModel):
    capability: str
    day: str
    tokens: int
    calls: int


class UsageDayTotal(BaseModel):
    day: str
    tokens: int
    calls: int


class UsageEnvelope(BaseModel):
    """Project-scoped usage with server-owned aggregates for one reporting window."""

    usage: list[UsageRowView]
    capabilities: list[str]
    daily_totals: list[UsageDayTotal]
    total_tokens: int
    total_calls: int
    window_days: int
    project: str
    capability: str | None


class AuditView(BaseModel):
    """One display-safe, permission-filtered audit event."""

    id: int
    ts: dt.datetime | None
    project_id: str
    user_id: str | None
    principal_type: str | None
    principal_id: str | None
    on_behalf_of: str | None
    trace_id: str | None
    action: str
    tool: str | None
    query_hash: str | None
    query_text: str | None
    duration_ms: int | None
    topics_used: list[str]
    result_count: int | None
    denied: bool


class AuditEnvelope(BaseModel):
    audit: list[AuditView]
    next_offset: int | None
    freshness: dt.datetime


class GraphNodeView(BaseModel):
    id: str
    name: str
    type: str
    anchored: bool


class GraphEdgeView(BaseModel):
    source: str
    target: str
    type: str


class EntityGraphEnvelope(BaseModel):
    center: GraphNodeView
    neighbors: list[GraphNodeView]
    edges: list[GraphEdgeView]
    total: int
    offset: int
    limit: int
