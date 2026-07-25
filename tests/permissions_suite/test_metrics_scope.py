"""Metrics surface authorization + tenant scoping (AUDIT-030 / R10, task T001 RED).

Two ratified constraints (AUDIT-030 clarifications, 2026-07-24):

1. *Operational metrics require a dedicated operator credential and a deployment network policy;
   anonymous public access is forbidden.*
2. *Global metrics expose runtime dimensions only. Project, user, topic, and content dimensions
   appear solely in an authorized project dashboard.*

Today ``/metrics`` is mounted with no authorization dependency at all
(``src/rsc_brain/api/app.py:139-143``) and every gauge is a cross-tenant aggregate over the whole
database (``src/rsc_brain/observability/metrics.py:42-62``): tokens summed across all projects,
global gap/extraction-error/ingest-run counts, and a global recall p95. An anonymous caller
therefore reads company-wide activity, and a member of project A reads project B's volume.

The positive operator-allow assertion is intentionally NOT here: the operator credential contract
does not exist yet and is produced by the runtime/authorization tasks. Asserting against an API
that does not exist would fail on import rather than on behaviour, which proves nothing. This file
owns the deny side and the tenant-aggregate side; the allow side lands with that contract.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from pathlib import Path

import httpx
import pytest

from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.identity.service import IdentityService
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.store import PgRelationalStore
from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

# The series `render_metrics` publishes. Those marked project-activity are derived from tenant
# content and may not appear as a cross-tenant total on the global scrape.
RUNTIME_SERIES = ("llm_tokens_total",)
PROJECT_ACTIVITY_SERIES = (
    "gaps_created_total",
    "extraction_errors_total",
    "ingest_runs_total",
    "recall_latency_p95_seconds",
)
FORBIDDEN_GLOBAL_LABELS = ("project", "project_id", "user", "user_id", "topic", "principal")


def _client(harness: Harness, tmp_path: Path) -> httpx.AsyncClient:
    app = create_app(
        deps=ApiDeps(sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path))
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _seed_gaps(harness: Harness, project_id: str, count: int) -> None:
    """Record ``count`` distinct gaps for a project — deliberately different volumes per tenant."""
    async with harness.sm() as session:
        for index in range(count):
            session.add(
                models.Gap(
                    project_id=uuid.UUID(project_id),
                    query_hash=f"{unique_slug('h')}-{index}",
                    topics=["general"],
                    status="open",
                )
            )
        await session.commit()


async def _member_pat(harness: Harness, project_id: str, *, project_role: str) -> str:
    user = (
        await PgRelationalStore(harness.sm)
        .users()
        .create_user(email=f"{unique_slug('m')}@example.com", status="active", role="member")
    )
    identity = IdentityService(harness.sm)
    membership = await identity.add_membership(
        user.user_id, project_id, role=project_role, allowed_topics=("general",)
    )
    return (await identity.issue_pat(membership)).token


def _served_series(body: str) -> set[str]:
    """The metric family names present in a Prometheus exposition body."""
    return {
        line.split(" ", 2)[2]
        for line in body.splitlines()
        if line.startswith("# TYPE ") and len(line.split(" ")) > 3
    } | {line.split("{")[0].split(" ")[0] for line in body.splitlines() if not line.startswith("#")}


async def test_anonymous_caller_gets_no_metric_values(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """R10 — anonymous public access to the operational scrape is forbidden."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    await _seed_gaps(harness, project, 2)

    async with _client(harness, tmp_path) as client:
        response = await client.get("/metrics")

    assert response.status_code in (401, 403, 404), (
        f"/metrics served an anonymous caller: {response.status_code}"
    )
    served = _served_series(response.text)
    assert not served & set(RUNTIME_SERIES + PROJECT_ACTIVITY_SERIES), (
        f"an anonymous refusal still leaked metric values: {sorted(served)}"
    )


async def test_project_principal_is_not_an_operator(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """R10 — project authority is not operator authority, for any project role."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    await _seed_gaps(harness, project, 2)

    for project_role in ("viewer", "member", "project-admin"):
        token = await _member_pat(harness, project, project_role=project_role)
        async with _client(harness, tmp_path) as client:
            response = await client.get("/metrics", headers={"Authorization": f"Bearer {token}"})
        assert response.status_code in (401, 403, 404), (
            f"a project `{project_role}` reached the operational scrape: {response.status_code}"
        )


async def test_global_scrape_publishes_no_cross_tenant_activity_total(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """R10 — global metrics carry runtime dimensions only.

    Projects A and B get deliberately different activity. A single global total spanning both is a
    cross-tenant aggregate: it tells any reader how much work another tenant is doing, and it
    reconciles with no single project. Such values belong to the authorized project dashboard.
    """
    harness = build_harness()
    a = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    b = await harness.setup_project(unique_slug("globex"), [("general", 0)])
    await _seed_gaps(harness, a, 2)
    await _seed_gaps(harness, b, 5)

    from rsc_brain.observability.metrics import render_metrics

    raw, _ = await render_metrics(harness.sm)
    body = raw.decode("utf-8")
    served = _served_series(body)

    leaked = served & set(PROJECT_ACTIVITY_SERIES)
    assert not leaked, (
        "the global scrape publishes cross-tenant project-activity totals "
        f"(A=2 gaps, B=5 gaps → one global sum of 7): {sorted(leaked)}"
    )


async def test_global_scrape_carries_no_tenant_dimension(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """R10 invariant guard — no project/user/topic/content label may enter the global scrape.

    This one holds today (the labels are `capability` and `phase`). It is here so that fixing the
    aggregate problem by *labelling* the series per project — which would turn one disclosure into
    a worse one, plus unbounded cardinality — fails immediately.
    """
    harness = build_harness()
    a = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    await _seed_gaps(harness, a, 1)

    from rsc_brain.observability.metrics import render_metrics

    raw, _ = await render_metrics(harness.sm)
    body = raw.decode("utf-8")

    for line in body.splitlines():
        if line.startswith("#") or "{" not in line:
            continue
        labels = line.split("{", 1)[1].rsplit("}", 1)[0]
        for forbidden in FORBIDDEN_GLOBAL_LABELS:
            assert f"{forbidden}=" not in labels, (
                f"global scrape carries a tenant dimension `{forbidden}`: {line}"
            )
