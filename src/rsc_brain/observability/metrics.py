"""Prometheus ``/metrics`` (SPEC-23, NFR-6).

The NFR-6 catalogue — recall latency, ingest queue/jobs, extraction errors, tokens per capability,
gaps/day — rendered on scrape from Postgres aggregates. Computing on scrape (rather than keeping
in-process counters) keeps the metrics correct across the multi-process API + worker without a
pushgateway. Series stay **unlabeled by project** (except where cheap) to bound cardinality (§7).
"""

from __future__ import annotations

from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, Gauge, generate_latest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.stores.relational import models

# The committed NFR-6 series — the catalogue test asserts every one of these is present.
NFR6_SERIES = (
    "llm_tokens_total",
    "gaps_created_total",
    "extraction_errors_total",
    "ingest_runs_total",
    "recall_latency_p95_seconds",
)


async def render_metrics(sessionmaker: async_sessionmaker[AsyncSession]) -> tuple[bytes, str]:
    """Render the NFR-6 series in Prometheus text format + the content type."""
    registry = CollectorRegistry()
    tokens = Gauge(
        "llm_tokens_total", "LLM tokens consumed, by capability", ["capability"], registry=registry
    )
    gaps = Gauge("gaps_created_total", "Knowledge gaps recorded", registry=registry)
    errors = Gauge("extraction_errors_total", "Ingestion extraction errors", registry=registry)
    ingest_runs = Gauge(
        "ingest_runs_total", "Ingestion runs, by phase", ["phase"], registry=registry
    )
    recall_p95 = Gauge(
        "recall_latency_p95_seconds", "Recall p95 latency (seconds)", registry=registry
    )

    async with sessionmaker() as session:
        for capability, total in await session.execute(
            select(models.TokenUsage.capability, func.sum(models.TokenUsage.tokens)).group_by(
                models.TokenUsage.capability
            )
        ):
            tokens.labels(capability=capability).set(float(total or 0))
        gaps.set(float(await session.scalar(select(func.count()).select_from(models.Gap)) or 0))
        errors.set(
            float(await session.scalar(select(func.count()).select_from(models.IngestError)) or 0)
        )
        for phase, count in await session.execute(
            select(models.IngestRun.phase, func.count()).group_by(models.IngestRun.phase)
        ):
            ingest_runs.labels(phase=phase).set(float(count or 0))
        p95_ms = await session.scalar(
            select(
                func.percentile_cont(0.95).within_group(models.AuditLog.duration_ms.asc())
            ).where(models.AuditLog.action == "recall", models.AuditLog.duration_ms.is_not(None))
        )
        recall_p95.set(float(p95_ms or 0) / 1000.0)

    return generate_latest(registry), CONTENT_TYPE_LATEST
