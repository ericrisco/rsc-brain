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
from rsc_brain.observability.metrics import NFR6_SERIES
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
        user.user_id, project, allowed_topics=("general",), can_curate=True
    )
    return (await identity.issue_pat(membership)).token


async def test_metrics_exposes_the_nfr6_catalogue(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    # Every NFR-6 series is registered, so its name appears (HELP/TYPE) even before any data —
    # no seeding needed, which also avoids contaminating the global token_usage counters.
    harness = build_harness()
    await harness.setup_project(unique_slug("acme"), [("general", 0)])
    async with _client(harness, tmp_path) as client:
        response = await client.get("/metrics")
    assert response.status_code == 200
    body = response.text
    for series in NFR6_SERIES:
        assert series in body, f"missing NFR-6 series {series}"


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
        response = await client.get("/metrics", headers={"X-Trace-Id": "trace-abc-123"})
    assert response.headers.get("x-trace-id") == "trace-abc-123"  # correlated end-to-end (FR-14.3)
