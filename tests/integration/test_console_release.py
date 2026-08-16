"""SPEC-26 console-release backend: usage endpoint (parity with `brain usage`), filterable audit +
CSV export (FR-13.7) respecting FR-13.9, and the bounded/permission-scoped entity subgraph (FR-13.8)."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from pathlib import Path

import httpx
import pytest

from rsc_brain import audit as audit_mod
from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.gateway.usage import PgUsageRecorder, usage_by_day
from rsc_brain.identity.service import IdentityService
from rsc_brain.ingest.entity_resolution import entity_id
from rsc_brain.knowledge.entity_graph import entity_neighborhood
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.graph_store import GraphEdge, GraphNode
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.store import PgRelationalStore
from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("general", 0), ("secret", 3)]


async def _mint_pat(harness: Harness, project_id: str) -> str:
    user = (
        await PgRelationalStore(harness.sm)
        .users()
        .create_user(email=f"{unique_slug('admin')}@example.com", status="active", role="admin")
    )
    identity = IdentityService(harness.sm)
    membership = await identity.add_membership(
        # The management surface belongs to the project role, not to `can_curate` (AUDIT-020/R03).
        user.user_id,
        project_id,
        role="project-admin",
        allowed_topics=("general", "secret"),
    )
    return (await identity.issue_pat(membership)).token


def _client(harness: Harness, tmp_path: Path) -> httpx.AsyncClient:
    app = create_app(
        deps=ApiDeps(sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path))
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


# --- FR-13.7 usage (parity with brain usage) --------------------------------


async def test_usage_endpoint_matches_brain_usage(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    project_slug = unique_slug("acme")
    project = await harness.setup_project(project_slug, TOPICS)
    # Counters are per project (AUDIT-021 / R12), so the parity this test proves is per project:
    # the console figure equals `brain usage --project <slug>` exactly. Recording to capabilities no
    # other test asserts on keeps it from contaminating the SPEC-22 usage/budget tests.
    recorder = PgUsageRecorder(harness.sm, harness.gateway._caps, project_id=project)
    await recorder.record("judge", 1200)
    await recorder.record("reranker", 340)

    token = await _mint_pat(harness, project)
    async with _client(harness, tmp_path) as client:
        response = await client.get(
            "/api/v1/admin/usage?days=7", headers={"Authorization": f"Bearer {token}"}
        )
    assert response.status_code == 200
    payload = response.json()
    api_rows = payload["usage"]
    cli_rows = await usage_by_day(harness.sm, days=7, project_id=project)
    assert api_rows == cli_rows  # DONE: the console figure equals `brain usage` exactly
    totals = {r["capability"]: r["tokens"] for r in api_rows}
    assert totals["judge"] == 1200 and totals["reranker"] == 340
    assert payload["total_tokens"] == 1540
    assert payload["total_calls"] == 2
    assert payload["window_days"] == 7
    assert payload["project"] == project_slug
    assert payload["capability"] is None
    assert payload["capabilities"] == ["judge", "reranker"]
    assert sum(row["tokens"] for row in payload["daily_totals"]) == 1540

    async with _client(harness, tmp_path) as client:
        filtered = await client.get(
            "/api/v1/admin/usage?days=7&capability=judge",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert filtered.status_code == 200
    filtered_payload = filtered.json()
    assert {row["capability"] for row in filtered_payload["usage"]} == {"judge"}
    assert filtered_payload["total_tokens"] == 1200
    assert filtered_payload["total_calls"] == 1
    assert filtered_payload["capability"] == "judge"
    assert filtered_payload["capabilities"] == ["judge", "reranker"]


# --- FR-13.7 audit filters + CSV export, FR-13.9 privacy --------------------


async def test_audit_filters_and_csv_export(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["general"])
    await audit_mod.record_audit(harness.sm, scope, action="recall", tool="mcp", denied=False)
    await audit_mod.record_audit(harness.sm, scope, action="recall", tool="mcp", denied=True)
    await audit_mod.record_audit(harness.sm, scope, action="ingest", tool="cli", denied=False)

    token = await _mint_pat(harness, project)
    headers = {"Authorization": f"Bearer {token}"}
    async with _client(harness, tmp_path) as client:
        denied = await client.get("/api/v1/admin/audit?denied=true", headers=headers)
        assert denied.status_code == 200
        rows = denied.json()["audit"]
        assert rows and all(r["denied"] for r in rows)

        by_action = await client.get("/api/v1/admin/audit?action=ingest", headers=headers)
        assert all(r["action"] == "ingest" for r in by_action.json()["audit"])

        first_page = await client.get(
            "/api/v1/admin/audit?action=recall&limit=1&offset=0", headers=headers
        )
        first_payload = first_page.json()
        assert len(first_payload["audit"]) == 1
        assert first_payload["next_offset"] == 1
        assert first_payload["freshness"]
        second_page = await client.get(
            "/api/v1/admin/audit?action=recall&limit=1&offset=1", headers=headers
        )
        second_payload = second_page.json()
        assert len(second_payload["audit"]) == 1
        assert second_payload["next_offset"] is None
        assert first_payload["audit"][0]["id"] != second_payload["audit"][0]["id"]

        export = await client.get("/api/v1/admin/audit/export", headers=headers)
        assert export.status_code == 200
        assert export.headers["content-type"].startswith("text/csv")
        body = export.text
        assert "action" in body.splitlines()[0]  # CSV header
        # The export is itself audited (FR-4.5).
        after = await client.get("/api/v1/admin/audit?action=audit_export", headers=headers)
        assert after.json()["audit"]


async def test_audit_view_never_exposes_query_text_when_off(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    async with harness.sm() as session:
        proj = await session.get(models.Project, uuid.UUID(project))
        assert proj is not None
        proj.settings = {**(proj.settings or {}), "query_text_logging": False}
        await session.commit()
    scope = harness.scope(project, allowed_topics=["general"])
    # With logging OFF the recall path stores only the hash; simulate that stored row.
    await audit_mod.record_audit(
        harness.sm, scope, action="recall", tool="mcp", query_hash="abc123", denied=False
    )
    token = await _mint_pat(harness, project)
    async with _client(harness, tmp_path) as client:
        response = await client.get(
            "/api/v1/admin/audit?action=recall", headers={"Authorization": f"Bearer {token}"}
        )
    rows = response.json()["audit"]
    assert rows and all(r["query_text"] is None for r in rows)
    assert any(r["query_hash"] for r in rows)  # hash + topics remain


# --- FR-13.8 entity subgraph: bounded, paginated, permission-scoped ----------


async def _seed_star(harness: Harness, project: str, *, center: str, n: int, tag: str) -> None:
    """A star graph: `center` linked to `n` neighbours, plus one visible claim per node so they
    pass the permission filter."""
    scope = harness.scope(project, allowed_topics=[tag])
    graph = AgeGraphStore(harness.sm)
    await graph.create_graph(scope)
    center_id = str(entity_id("thing", center))
    nodes = [
        GraphNode(
            id=center_id, labels=frozenset({"Entity"}), properties={"name": center, "type": "thing"}
        )
    ]
    edges = []
    async with harness.sm() as session:
        session.add(
            models.Entity(
                project_id=uuid.UUID(project),
                name=center,
                normalized_name=center.casefold(),
                type="thing",
            )
        )
        session.add(
            models.Claim(
                project_id=uuid.UUID(project),
                text=f"{center} fact",
                subject=center,
                object="x",
                tags=[tag],
            )
        )
        for i in range(n):
            name = f"neighbor{i}"
            nid = f"nid-{i}"
            nodes.append(
                GraphNode(
                    id=nid, labels=frozenset({"Entity"}), properties={"name": name, "type": "thing"}
                )
            )
            edges.append(GraphEdge(source_id=center_id, target_id=nid, type="RELATES_TO"))
            session.add(
                models.Claim(
                    project_id=uuid.UUID(project),
                    text=f"{name} fact",
                    subject=name,
                    object="y",
                    tags=[tag],
                )
            )
        await session.commit()
    await graph.upsert_nodes(scope, nodes)
    await graph.upsert_edges(scope, edges)


async def test_neighborhood_hard_limit_and_pagination(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    await _seed_star(harness, project, center="hub", n=30, tag="general")
    scope = harness.scope(project, allowed_topics=["general"])
    graph = AgeGraphStore(harness.sm)

    page1 = await entity_neighborhood(harness.sm, graph, scope, name="hub", limit=10, offset=0)
    assert page1 is not None
    assert len(page1.neighbors) == 10  # hard cap, regardless of the hub's degree of 30
    assert page1.total == 30
    assert all(e.source == page1.center.id for e in page1.edges)

    page2 = await entity_neighborhood(harness.sm, graph, scope, name="hub", limit=10, offset=10)
    assert page2 is not None
    assert {n.id for n in page1.neighbors}.isdisjoint({n.id for n in page2.neighbors})


async def test_neighborhood_permission_gate_zero_leaks(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    await _seed_star(harness, project, center="classified", n=3, tag="secret")
    graph = AgeGraphStore(harness.sm)

    # A caller WITHOUT the sensitive tag cannot see the entity ⇒ indistinguishable from absent.
    deny = harness.scope(project, allowed_topics=["general"])
    assert await entity_neighborhood(harness.sm, graph, deny, name="classified") is None

    # A caller WITH the tag sees it.
    allow = harness.scope(project, allowed_topics=["general", "secret"])
    view = await entity_neighborhood(harness.sm, graph, allow, name="classified")
    assert view is not None and view.center.name == "classified"


async def test_neighborhood_absent_entity_is_none(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["general"])
    assert (
        await entity_neighborhood(harness.sm, AgeGraphStore(harness.sm), scope, name="ghost")
        is None
    )
