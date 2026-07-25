"""Observability surface (SPEC-23, NFR-6 / §8 / FR-14.3) against the real container.

/metrics exposes the NFR-6 series; the product-metrics API returns the four §8 families
project-scoped; a request's trace_id is echoed for end-to-end correlation.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import httpx
import pytest

from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.identity.service import IdentityService
from rsc_brain.observability.metrics import (
    PROJECT_DASHBOARD_SERIES,
    RUNTIME_SERIES,
    render_metrics,
)
from rsc_brain.stores.relational.store import PgRelationalStore

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration


def _client(harness: Harness, tmp_path: Path) -> httpx.AsyncClient:
    app = create_app(
        deps=ApiDeps(sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path))
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _mint_pat(harness: Harness, project: str) -> str:
    user = (
        await PgRelationalStore(harness.sm)
        .users()
        .create_user(email=f"{unique_slug('a')}@example.com", status="active", role="admin")
    )
    identity = IdentityService(harness.sm)
    membership = await identity.add_membership(
        # A platform "admin" role is not project content authority (AUDIT-020/R03): the dashboard
        # read needs an explicit membership, and this fixture relied on the old blanket gate.
        user.user_id,
        project,
        role="project-admin",
        allowed_topics=("general",),
    )
    return (await identity.issue_pat(membership)).token


async def test_metrics_publishes_runtime_series_and_nothing_tenant_derived(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """R10 — the scrape is an operator surface carrying runtime dimensions only.

    This test used to assert that an ANONYMOUS caller got 200 and the whole NFR-6 catalogue,
    including four instance-wide totals derived from tenant content. AUDIT-030's ratified
    clarification (2026-07-24) says the opposite on both counts, so the assertion was canonizing the
    disclosure. The NFR-6 signals themselves did not disappear: each moved to the authorized project
    dashboard, and ``PROJECT_DASHBOARD_SERIES`` records where — asserted here so the move cannot be
    silently undone.
    """
    harness = build_harness()
    await harness.setup_project(unique_slug("acme"), [("general", 0)])
    async with _client(harness, tmp_path) as client:
        response = await client.get("/metrics")
    assert response.status_code in (401, 403), (
        f"the operational scrape served an unauthorized caller: {response.status_code}"
    )

    body, _ = await render_metrics(harness.sm)
    text = body.decode("utf-8")
    for series in RUNTIME_SERIES:
        assert series in text, f"missing runtime series {series}"
    for series in PROJECT_DASHBOARD_SERIES:
        assert series not in text, (
            f"{series} is a tenant-derived signal and must live only in the project dashboard "
            f"({PROJECT_DASHBOARD_SERIES[series]})"
        )


async def test_product_metrics_has_the_four_families(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    token = await _mint_pat(harness, project)
    async with _client(harness, tmp_path) as client:
        response = await client.get(
            "/api/v1/admin/metrics/product", headers={"Authorization": f"Bearer {token}"}
        )
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"adoption", "quality", "knowledge", "health"}
    assert "tokens_by_capability" in body["health"]


async def test_trace_id_is_echoed(build_harness: Callable[..., Harness], tmp_path: Path) -> None:
    harness = build_harness()
    async with _client(harness, tmp_path) as client:
        # Any request works as the correlation probe; the scrape now refuses an unauthorized caller
        # (R10) and the trace header must still round-trip on the refusal.
        response = await client.get("/metrics", headers={"X-Trace-Id": "trace-abc-123"})
    assert response.headers.get("x-trace-id") == "trace-abc-123"  # correlated end-to-end (FR-14.3)
