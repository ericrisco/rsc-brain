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
