"""Prometheus ``/metrics`` (SPEC-23, NFR-6) — the OPERATOR scrape, runtime dimensions only.

R10 (AUDIT-030, ratified 2026-07-24): *global metrics expose runtime dimensions only; project,
user, topic, and content dimensions appear solely in an authorized project dashboard.*

This scrape used to publish one instance-wide total per tenant-derived signal: recorded gaps,
extraction errors, ingest runs by phase, and a recall p95 over every project's audit rows. Each of
those told any reader how much work other tenants were doing, and reconciled with no single
project — a disclosure that a per-project label would have made worse, not better (it would also
make cardinality unbounded, §7). They now live where they can be authorized:

* gaps, extraction errors, claims, disputed, recall p95, recalls/day, tokens →
  ``GET /api/v1/admin/metrics/product`` (:mod:`rsc_brain.observability.product`);
* ingest runs by phase and their errors → ``GET /api/v1/admin/observability/ingest``;
* the pending-approval queue depth → ``GET /api/v1/admin/observability/health``.

What stays here is the runtime cost signal an operator needs and no tenant can be read out of:
tokens consumed per capability. The endpoint itself requires the operator capability (see
:mod:`rsc_brain.api.app`).
"""

from __future__ import annotations

from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, Gauge, generate_latest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.stores.relational import models

#: Series the global scrape publishes: runtime dimensions only (R10).
RUNTIME_SERIES = ("llm_tokens_total",)

#: Tenant-derived signals that used to be here, with the authorized surface that now owns each.
#: Kept as an explicit record so a future change cannot quietly move one back.
PROJECT_DASHBOARD_SERIES = {
    "gaps_created_total": "GET /api/v1/admin/metrics/product → knowledge.open_gaps",
    "extraction_errors_total": "GET /api/v1/admin/metrics/product → health.extraction_errors",
    "ingest_runs_total": "GET /api/v1/admin/observability/ingest → runs[].phase",
    "recall_latency_p95_seconds": "GET /api/v1/admin/metrics/product → health.recall_p95_ms",
}


async def render_metrics(sessionmaker: async_sessionmaker[AsyncSession]) -> tuple[bytes, str]:
    """Render the runtime series in Prometheus text format + the content type.

    No label here may carry a project, user, topic or principal dimension: the scrape has one
    authorized reader (the operator) and it is not a tenant.
    """
    registry = CollectorRegistry()
    tokens = Gauge(
        "llm_tokens_total", "LLM tokens consumed, by capability", ["capability"], registry=registry
    )

    async with sessionmaker() as session:
        for capability, total in await session.execute(
            select(models.TokenUsage.capability, func.sum(models.TokenUsage.tokens)).group_by(
                models.TokenUsage.capability
            )
        ):
            tokens.labels(capability=capability).set(float(total or 0))

    return generate_latest(registry), CONTENT_TYPE_LATEST
