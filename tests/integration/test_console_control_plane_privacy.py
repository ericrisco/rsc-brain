"""RED privacy contracts for console control-plane read models (T003).

Every request crosses the mounted ASGI application, a real console session, real Postgres and,
for the graph contract, real AGE.  Each topic-bearing read model has one ``general`` row, one
``hidden`` row (sensitivity 4), and one mixed ``general`` + ``hidden`` row.  The mixed rows make
an overlap-only predicate observably unsafe: a general-only principal must not learn from them.

``TokenUsage`` and ``/admin/usage`` deliberately have no topic dimension.  They remain
project-scoped accounting and are outside this topic privacy filter; these contracts do not claim
otherwise.  Hunts and ingest errors *are* attributable through their owning gap and document,
respectively, so their aggregates belong in the filter.
"""

from __future__ import annotations

import datetime as dt
import json
import uuid
from base64 import urlsafe_b64decode, urlsafe_b64encode
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import httpx
import pytest

from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.identity.service import IdentityService
from rsc_brain.ingest.entity_resolution import entity_id, normalize_name
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.graph_store import GraphEdge, GraphNode
from rsc_brain.stores.relational import models
from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

_PASSWORD = "correct horse battery staple"
_VISIBLE = "general"
_HIDDEN = "hidden"


@dataclass(frozen=True, slots=True)
class _Seed:
    project_slug: str
    project_id: str
    other_project_slug: str
    other_project_id: str
    audit_day: str
    visible_document_id: str
    hidden_document_id: str
    mixed_document_id: str
    visible_audit_ids: tuple[str, str]


@dataclass(frozen=True, slots=True)
class _GraphSeed:
    center: str
    visible_neighbor: str
    hidden_neighbor: str
    mixed_neighbor: str
    foreign_neighbor: str


def _client(harness: Harness, tmp_path: Path) -> httpx.AsyncClient:
    app = create_app(
        deps=ApiDeps(sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path))
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _session_headers(
    harness: Harness,
    client: httpx.AsyncClient,
    project_id: str | None,
    *,
    topics: tuple[str, ...],
    platform_role: str = "member",
) -> dict[str, str]:
    """Create a real identity, explicit membership, and real console session."""
    identity = IdentityService(harness.sm)
    email = f"{unique_slug('privacy-console')}@example.com"
    invitation = await identity.invite_user(email, role=platform_role)
    user_id = await identity.accept_invitation(invitation.token, _PASSWORD)
    if project_id is not None:
        await identity.add_membership(
            user_id,
            project_id,
            role="member",
            allowed_topics=topics,
        )
    login = await client.post("/api/v1/auth/login", json={"email": email, "password": _PASSWORD})
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['session_token']}"}


async def _seed_read_models(harness: Harness) -> _Seed:
    """Seed two projects and all topic-attributable console read models."""
    project_slug = unique_slug("privacy-a")
    other_slug = unique_slug("privacy-b")
    project_id = await harness.setup_project(project_slug, [(_VISIBLE, 0), (_HIDDEN, 4)])
    other_id = await harness.setup_project(other_slug, [(_VISIBLE, 0), (_HIDDEN, 4)])
    project_uuid = uuid.UUID(project_id)
    other_uuid = uuid.UUID(other_id)
    audit_anchor = dt.datetime.now(dt.UTC).replace(microsecond=0)

    visible_document = models.Document(
        project_id=project_uuid,
        logical_id="visible-health",
        version=1,
        checksum="visible-health-checksum",
        title="VISIBLE health document",
        status="pending_approval",
        doc_tags=[_VISIBLE],
    )
    hidden_document = models.Document(
        project_id=project_uuid,
        logical_id="hidden-health",
        version=1,
        checksum="hidden-health-checksum",
        title="HIDDEN health document",
        status="pending_approval",
        doc_tags=[_HIDDEN],
    )
    mixed_document = models.Document(
        project_id=project_uuid,
        logical_id="mixed-health",
        version=1,
        checksum="mixed-health-checksum",
        title="MIXED hidden health document",
        status="pending_approval",
        doc_tags=[_VISIBLE, _HIDDEN],
    )
    visible_gap = models.Gap(
        project_id=project_uuid,
        query_hash="visible-product-gap",
        query_text="VISIBLE product gap",
        topics=[_VISIBLE],
        count=1,
        status="open",
    )
    hidden_gap = models.Gap(
        project_id=project_uuid,
        query_hash="hidden-product-gap",
        query_text="HIDDEN product gap",
        topics=[_HIDDEN],
        count=987,
        status="open",
    )
    mixed_gap = models.Gap(
        project_id=project_uuid,
        query_hash="mixed-product-gap",
        query_text="MIXED hidden product gap",
        topics=[_VISIBLE, _HIDDEN],
        count=654,
        status="open",
    )
    other_document = models.Document(
        project_id=other_uuid,
        logical_id="other-health",
        version=1,
        checksum="other-health-checksum",
        title="OTHER PROJECT health document",
        status="pending_approval",
        doc_tags=[_VISIBLE],
    )
    other_gap = models.Gap(
        project_id=other_uuid,
        query_hash="other-product-gap",
        query_text="OTHER PROJECT product gap",
        topics=[_VISIBLE],
        count=321,
        status="open",
    )
    visible_success_audit = models.AuditLog(
        project_id=project_uuid,
        principal_type="human",
        principal_id="visible-success-principal",
        action="recall",
        duration_ms=11,
        topics_used=[_VISIBLE],
        result_count=1,
        ts=audit_anchor,
    )
    hidden_audit = models.AuditLog(
        project_id=project_uuid,
        principal_type="human",
        principal_id="hidden-principal",
        action="recall",
        duration_ms=9_999,
        topics_used=[_HIDDEN],
        result_count=987,
        denied=True,
        ts=audit_anchor - dt.timedelta(seconds=1),
    )
    mixed_audit = models.AuditLog(
        project_id=project_uuid,
        principal_type="human",
        principal_id="mixed-hidden-principal",
        action="recall",
        duration_ms=8_888,
        topics_used=[_VISIBLE, _HIDDEN],
        result_count=654,
        denied=True,
        ts=audit_anchor - dt.timedelta(seconds=2),
    )
    visible_abstained_audit = models.AuditLog(
        project_id=project_uuid,
        principal_type="human",
        principal_id="visible-abstained-principal",
        action="recall",
        duration_ms=12,
        topics_used=[_VISIBLE],
        result_count=0,
        denied=True,
        ts=audit_anchor - dt.timedelta(seconds=3),
    )
    other_audit = models.AuditLog(
        project_id=other_uuid,
        principal_type="human",
        principal_id="other-principal",
        action="recall",
        duration_ms=321,
        topics_used=[_VISIBLE],
        result_count=321,
        ts=audit_anchor - dt.timedelta(seconds=4),
    )

    async with harness.sm() as session:
        session.add_all(
            [
                visible_document,
                hidden_document,
                mixed_document,
                other_document,
                visible_gap,
                hidden_gap,
                mixed_gap,
                other_gap,
            ]
        )
        await session.flush()
        session.add_all(
            [
                models.Claim(
                    project_id=project_uuid,
                    text="VISIBLE product claim",
                    subject="Visible",
                    predicate="knows",
                    object="Public",
                    tags=[_VISIBLE],
                ),
                models.Claim(
                    project_id=project_uuid,
                    text="HIDDEN disputed product claim",
                    subject="Hidden",
                    predicate="knows",
                    object="Secret",
                    tags=[_HIDDEN],
                    disputed=True,
                ),
                models.Claim(
                    project_id=project_uuid,
                    text="MIXED hidden disputed product claim",
                    subject="Mixed",
                    predicate="knows",
                    object="Secret",
                    tags=[_VISIBLE, _HIDDEN],
                    disputed=True,
                ),
                models.Claim(
                    project_id=other_uuid,
                    text="OTHER PROJECT claim",
                    subject="Other",
                    predicate="knows",
                    object="Elsewhere",
                    tags=[_VISIBLE],
                ),
                visible_success_audit,
                hidden_audit,
                mixed_audit,
                visible_abstained_audit,
                other_audit,
                models.Skill(
                    project_id=project_uuid,
                    slug="visible-playbook",
                    title="VISIBLE playbook",
                    description=None,
                    when_to_use=None,
                    when_not=None,
                    tags=[_VISIBLE],
                    state="active",
                    body="visible body",
                ),
                models.Skill(
                    project_id=project_uuid,
                    slug="hidden-playbook",
                    title="HIDDEN playbook",
                    description=None,
                    when_to_use=None,
                    when_not=None,
                    tags=[_HIDDEN],
                    state="active",
                    body="hidden body",
                ),
                models.Skill(
                    project_id=project_uuid,
                    slug="mixed-hidden-playbook",
                    title="MIXED hidden playbook",
                    description=None,
                    when_to_use=None,
                    when_not=None,
                    tags=[_VISIBLE, _HIDDEN],
                    state="active",
                    body="mixed hidden body",
                ),
                models.Skill(
                    project_id=other_uuid,
                    slug="other-playbook",
                    title="OTHER PROJECT playbook",
                    description=None,
                    when_to_use=None,
                    when_not=None,
                    tags=[_VISIBLE],
                    state="active",
                    body="other body",
                ),
                models.IngestError(
                    project_id=project_uuid,
                    document_id=visible_document.id,
                    chunk_ref="VISIBLE-error",
                    stage="extract",
                    error="VISIBLE extraction failure",
                ),
                models.IngestError(
                    project_id=project_uuid,
                    document_id=hidden_document.id,
                    chunk_ref="HIDDEN-error",
                    stage="extract",
                    error="HIDDEN extraction failure",
                ),
                models.IngestError(
                    project_id=project_uuid,
                    document_id=mixed_document.id,
                    chunk_ref="MIXED-hidden-error",
                    stage="extract",
                    error="MIXED hidden extraction failure",
                ),
                models.IngestError(
                    project_id=other_uuid,
                    document_id=other_document.id,
                    chunk_ref="OTHER-PROJECT-error",
                    stage="extract",
                    error="OTHER PROJECT extraction failure",
                ),
                models.IngestRun(
                    project_id=project_uuid,
                    document_id=visible_document.id,
                    phase="pending_approval",
                ),
                models.IngestRun(
                    project_id=project_uuid,
                    document_id=hidden_document.id,
                    phase="pending_approval",
                ),
                models.IngestRun(
                    project_id=project_uuid,
                    document_id=mixed_document.id,
                    phase="pending_approval",
                ),
                models.IngestRun(
                    project_id=other_uuid,
                    document_id=other_document.id,
                    phase="pending_approval",
                ),
                models.Hunt(
                    project_id=project_uuid,
                    gap_id=visible_gap.id,
                    state="ANSWERED",
                    question="VISIBLE hunt",
                ),
                models.Hunt(
                    project_id=project_uuid,
                    gap_id=hidden_gap.id,
                    state="ANSWERED",
                    question="HIDDEN hunt",
                ),
                models.Hunt(
                    project_id=project_uuid,
                    gap_id=mixed_gap.id,
                    state="ASKED",
                    question="MIXED hidden hunt",
                ),
                models.Hunt(
                    project_id=other_uuid,
                    gap_id=other_gap.id,
                    state="ANSWERED",
                    question="OTHER PROJECT hunt",
                ),
            ]
        )
        await session.commit()
    return _Seed(
        project_slug=project_slug,
        project_id=project_id,
        other_project_slug=other_slug,
        other_project_id=other_id,
        audit_day=str(audit_anchor.date()),
        visible_document_id=str(visible_document.id),
        hidden_document_id=str(hidden_document.id),
        mixed_document_id=str(mixed_document.id),
        visible_audit_ids=(str(visible_success_audit.id), str(visible_abstained_audit.id)),
    )


async def _seed_topic_graph(harness: Harness, project_id: str, other_project_id: str) -> _GraphSeed:
    """Wire homonymous project graphs to catch both topic and tenant leaks.

    The same claims that authorize graph identities carry the topic tags.  Thus the hidden
    neighbours are physical candidates, not homonymous fallbacks or fabricated 404 paths.  The
    foreign project deliberately reuses their deterministic identities under a visible claim: if
    the relational authorization drops its project predicate, those foreign claims authorize the
    current project's hidden physical nodes.  Its separate AGE graph also has one foreign-only
    neighbour, so losing graph-namespace isolation is observable too.
    """
    project_uuid = uuid.UUID(project_id)
    other_project_uuid = uuid.UUID(other_project_id)
    center = "VISIBLE graph center"
    visible_neighbor = "VISIBLE graph neighbor"
    hidden_neighbor = "HIDDEN graph neighbor"
    mixed_neighbor = "MIXED hidden graph neighbor"
    foreign_neighbor = "OTHER PROJECT graph neighbor"
    center_type = "team"
    neighbor_type = "person"
    center_id = str(entity_id(center_type, center))
    visible_id = str(entity_id(neighbor_type, visible_neighbor))
    hidden_id = str(entity_id(neighbor_type, hidden_neighbor))
    mixed_id = str(entity_id(neighbor_type, mixed_neighbor))
    foreign_id = str(entity_id(neighbor_type, foreign_neighbor))

    async with harness.sm() as session:
        session.add_all(
            [
                models.Entity(
                    project_id=project_uuid,
                    name=center,
                    normalized_name=normalize_name(center),
                    type=center_type,
                ),
                models.Entity(
                    project_id=project_uuid,
                    name=visible_neighbor,
                    normalized_name=normalize_name(visible_neighbor),
                    type=neighbor_type,
                ),
                models.Entity(
                    project_id=project_uuid,
                    name=hidden_neighbor,
                    normalized_name=normalize_name(hidden_neighbor),
                    type=neighbor_type,
                ),
                models.Entity(
                    project_id=project_uuid,
                    name=mixed_neighbor,
                    normalized_name=normalize_name(mixed_neighbor),
                    type=neighbor_type,
                ),
                models.Entity(
                    project_id=other_project_uuid,
                    name=center,
                    normalized_name=normalize_name(center),
                    type=center_type,
                ),
                models.Entity(
                    project_id=other_project_uuid,
                    name=hidden_neighbor,
                    normalized_name=normalize_name(hidden_neighbor),
                    type=neighbor_type,
                ),
                models.Entity(
                    project_id=other_project_uuid,
                    name=mixed_neighbor,
                    normalized_name=normalize_name(mixed_neighbor),
                    type=neighbor_type,
                ),
                models.Entity(
                    project_id=other_project_uuid,
                    name=foreign_neighbor,
                    normalized_name=normalize_name(foreign_neighbor),
                    type=neighbor_type,
                ),
                models.Claim(
                    project_id=project_uuid,
                    text="VISIBLE graph relation",
                    subject=center,
                    subject_entity_key=uuid.UUID(center_id),
                    predicate="relates_to",
                    object=visible_neighbor,
                    object_entity_key=uuid.UUID(visible_id),
                    tags=[_VISIBLE],
                ),
                models.Claim(
                    project_id=project_uuid,
                    text="HIDDEN graph relation",
                    subject=center,
                    subject_entity_key=uuid.UUID(center_id),
                    predicate="relates_to",
                    object=hidden_neighbor,
                    object_entity_key=uuid.UUID(hidden_id),
                    tags=[_HIDDEN],
                ),
                models.Claim(
                    project_id=project_uuid,
                    text="MIXED hidden graph relation",
                    subject=center,
                    subject_entity_key=uuid.UUID(center_id),
                    predicate="relates_to",
                    object=mixed_neighbor,
                    object_entity_key=uuid.UUID(mixed_id),
                    tags=[_VISIBLE, _HIDDEN],
                ),
                models.Claim(
                    project_id=other_project_uuid,
                    text="OTHER PROJECT visibly authorizes target hidden identity",
                    subject=center,
                    subject_entity_key=uuid.UUID(center_id),
                    predicate="relates_to",
                    object=hidden_neighbor,
                    object_entity_key=uuid.UUID(hidden_id),
                    tags=[_VISIBLE],
                ),
                models.Claim(
                    project_id=other_project_uuid,
                    text="OTHER PROJECT visibly authorizes target mixed identity",
                    subject=center,
                    subject_entity_key=uuid.UUID(center_id),
                    predicate="relates_to",
                    object=mixed_neighbor,
                    object_entity_key=uuid.UUID(mixed_id),
                    tags=[_VISIBLE],
                ),
                models.Claim(
                    project_id=other_project_uuid,
                    text="OTHER PROJECT exclusive graph relation",
                    subject=center,
                    subject_entity_key=uuid.UUID(center_id),
                    predicate="relates_to",
                    object=foreign_neighbor,
                    object_entity_key=uuid.UUID(foreign_id),
                    tags=[_VISIBLE],
                ),
            ]
        )
        await session.commit()

    graph = AgeGraphStore(harness.sm)
    graph_scope: ProjectScope = harness.scope(project_id, allowed_topics=[_VISIBLE, _HIDDEN])
    await graph.create_graph(graph_scope)
    await graph.upsert_nodes(
        graph_scope,
        [
            GraphNode(
                id=center_id,
                labels=frozenset({"Entity"}),
                properties={"name": center, "type": center_type},
            ),
            GraphNode(
                id=visible_id,
                labels=frozenset({"Entity"}),
                properties={"name": visible_neighbor, "type": neighbor_type},
            ),
            GraphNode(
                id=hidden_id,
                labels=frozenset({"Entity"}),
                properties={"name": hidden_neighbor, "type": neighbor_type},
            ),
            GraphNode(
                id=mixed_id,
                labels=frozenset({"Entity"}),
                properties={"name": mixed_neighbor, "type": neighbor_type},
            ),
        ],
    )
    await graph.upsert_edges(
        graph_scope,
        [
            GraphEdge(source_id=center_id, target_id=visible_id, type="RELATES_TO"),
            GraphEdge(source_id=center_id, target_id=hidden_id, type="HIDDEN_RELATES_TO"),
            GraphEdge(
                source_id=center_id,
                target_id=mixed_id,
                type="MIXED_HIDDEN_RELATES_TO",
            ),
        ],
    )
    other_graph_scope: ProjectScope = harness.scope(
        other_project_id, allowed_topics=[_VISIBLE, _HIDDEN]
    )
    await graph.create_graph(other_graph_scope)
    await graph.upsert_nodes(
        other_graph_scope,
        [
            GraphNode(
                id=center_id,
                labels=frozenset({"Entity"}),
                properties={"name": center, "type": center_type},
            ),
            GraphNode(
                id=hidden_id,
                labels=frozenset({"Entity"}),
                properties={"name": hidden_neighbor, "type": neighbor_type},
            ),
            GraphNode(
                id=mixed_id,
                labels=frozenset({"Entity"}),
                properties={"name": mixed_neighbor, "type": neighbor_type},
            ),
            GraphNode(
                id=foreign_id,
                labels=frozenset({"Entity"}),
                properties={"name": foreign_neighbor, "type": neighbor_type},
            ),
        ],
    )
    await graph.upsert_edges(
        other_graph_scope,
        [
            GraphEdge(source_id=center_id, target_id=hidden_id, type="FOREIGN_VISIBLE_ALIAS"),
            GraphEdge(source_id=center_id, target_id=mixed_id, type="FOREIGN_MIXED_ALIAS"),
            GraphEdge(source_id=center_id, target_id=foreign_id, type="FOREIGN_ONLY"),
        ],
    )
    return _GraphSeed(
        center=center,
        visible_neighbor=visible_neighbor,
        hidden_neighbor=hidden_neighbor,
        mixed_neighbor=mixed_neighbor,
        foreign_neighbor=foreign_neighbor,
    )


async def test_allow_side_full_topic_read_models_are_complete(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """The authorized control proves every seeded row is real and reachable."""
    harness = build_harness()
    seed = await _seed_read_models(harness)
    graph_seed = await _seed_topic_graph(harness, seed.project_id, seed.other_project_id)
    async with _client(harness, tmp_path) as client:
        headers = await _session_headers(
            harness, client, seed.project_id, topics=(_VISIBLE, _HIDDEN)
        )
        metrics = await client.get(
            f"/api/v1/admin/metrics/product?project={seed.project_slug}", headers=headers
        )
        health = await client.get(
            f"/api/v1/admin/observability/health?project={seed.project_slug}", headers=headers
        )
        ingest = await client.get(
            f"/api/v1/admin/observability/ingest?project={seed.project_slug}", headers=headers
        )
        skills = await client.get(
            f"/api/v1/admin/skills?project={seed.project_slug}", headers=headers
        )
        graph = await client.get(
            "/api/v1/admin/graph/entity",
            params={"project": seed.project_slug, "name": graph_seed.center, "limit": 3},
            headers=headers,
        )

    assert metrics.status_code == 200, metrics.text
    assert metrics.json()["adoption"] == {
        "recalls": 4,
        "active_principals": 4,
        "recalls_per_day": [{"day": seed.audit_day, "recalls": 4}],
    }
    assert metrics.json()["quality"] == {"abstention_rate": 0.75, "hunts_answered_pct": 0.667}
    # The graph's three topic-tagged relations are claims too; all six are authorized here.
    assert metrics.json()["knowledge"] == {"claims": 6, "disputed": 2, "open_gaps": 3}
    assert metrics.json()["health"]["extraction_errors"] == 3
    assert health.status_code == 200, health.text
    assert health.json()["pending_approval"] == 3
    assert health.json()["ingest_errors"] == 3
    assert ingest.status_code == 200, ingest.text
    runs = ingest.json()["runs"]
    assert len(runs) == 3, "the full-topic run control must not hide or duplicate rows"
    assert {run["document_id"] for run in runs} == {
        seed.visible_document_id,
        seed.hidden_document_id,
        seed.mixed_document_id,
    }
    errors = ingest.json()["errors"]
    assert len(errors) == 3, "the full-topic error control must not hide or duplicate rows"
    assert {error["chunk"] for error in errors} == {
        "VISIBLE-error",
        "HIDDEN-error",
        "MIXED-hidden-error",
    }
    assert skills.status_code == 200, skills.text
    skill_rows = skills.json()["skills"]
    assert len(skill_rows) == 3, "the full-topic skill control must not hide or duplicate rows"
    assert {skill["slug"] for skill in skill_rows} == {
        "visible-playbook",
        "hidden-playbook",
        "mixed-hidden-playbook",
    }
    assert graph.status_code == 200, graph.text
    neighbors = graph.json()["neighbors"]
    assert len(neighbors) == 3, "the target graph must not import or duplicate foreign nodes"
    assert {neighbor["name"] for neighbor in neighbors} == {
        graph_seed.visible_neighbor,
        graph_seed.hidden_neighbor,
        graph_seed.mixed_neighbor,
    }
    edges = graph.json()["edges"]
    assert len(edges) == 3, "the target graph must not import or duplicate foreign edges"
    assert {edge["type"] for edge in edges} == {
        "RELATES_TO",
        "HIDDEN_RELATES_TO",
        "MIXED_HIDDEN_RELATES_TO",
    }
    assert graph.json()["total"] == 3
    assert graph_seed.foreign_neighbor not in graph.text
    assert "FOREIGN_ONLY" not in graph.text


@pytest.mark.parametrize(
    "surface",
    ("metrics", "health", "activity", "recalls", "ingest", "skills", "graph"),
)
async def test_platform_owner_without_membership_cannot_read_project_content(
    surface: str, build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """A platform role alone never grants any project content surface."""
    harness = build_harness()
    seed = await _seed_read_models(harness)
    graph_name = "VISIBLE graph center"
    if surface == "graph":
        graph_seed = await _seed_topic_graph(harness, seed.project_id, seed.other_project_id)
        graph_name = graph_seed.center
    routes: dict[str, tuple[str, dict[str, str]]] = {
        "metrics": ("/api/v1/admin/metrics/product", {"project": seed.project_slug}),
        "health": ("/api/v1/admin/observability/health", {"project": seed.project_slug}),
        "activity": ("/api/v1/admin/observability/activity", {"project": seed.project_slug}),
        "recalls": ("/api/v1/admin/observability/recalls", {"project": seed.project_slug}),
        "ingest": ("/api/v1/admin/observability/ingest", {"project": seed.project_slug}),
        "skills": ("/api/v1/admin/skills", {"project": seed.project_slug}),
        "graph": (
            "/api/v1/admin/graph/entity",
            {"project": seed.project_slug, "name": graph_name},
        ),
    }
    path, params = routes[surface]
    async with _client(harness, tmp_path) as client:
        owner_without_membership = await _session_headers(
            harness, client, None, topics=(), platform_role="owner"
        )
        response = await client.get(path, params=params, headers=owner_without_membership)

    assert response.status_code == 404, f"{surface}: {response.text}"


async def test_general_only_metrics_filter_mixed_topic_aggregates_before_counting(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """RED: mixed rows overlap ``general`` but still disclose the hidden topic if counted."""
    harness = build_harness()
    seed = await _seed_read_models(harness)
    async with _client(harness, tmp_path) as client:
        headers = await _session_headers(harness, client, seed.project_id, topics=(_VISIBLE,))
        response = await client.get(
            f"/api/v1/admin/metrics/product?project={seed.project_slug}", headers=headers
        )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["adoption"] == {
        "recalls": 2,
        "active_principals": 2,
        "recalls_per_day": [{"day": seed.audit_day, "recalls": 2}],
    }, "hidden and mixed audit rows leaked through activity aggregates"
    assert payload["quality"] == {"abstention_rate": 0.5, "hunts_answered_pct": 1.0}, (
        "hidden and mixed audit/gap-backed hunt rows changed quality aggregates"
    )
    assert payload["knowledge"] == {"claims": 1, "disputed": 0, "open_gaps": 1}, (
        "hidden or mixed claims/gaps changed product knowledge aggregates"
    )
    assert payload["health"]["extraction_errors"] == 1, (
        "hidden or mixed document-backed extraction errors changed product health"
    )
    assert payload["health"]["recall_p95_ms"] == 12.0


async def test_general_only_recall_cursor_pages_the_authorized_set_without_metadata_leaks(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """RED: the opaque cursor advances across authorized rows, never the raw tenant set.

    The physical ordering is visible, hidden, mixed, visible, then foreign.  A raw-row cursor or
    overlap-only filter therefore creates a hole, repeats a row, inflates ``total`` or carries
    forbidden metadata.  This deliberately requires T004's ``ReadPage`` instead of preserving the
    legacy offset/limit response.
    """
    harness = build_harness()
    seed = await _seed_read_models(harness)
    async with _client(harness, tmp_path) as client:
        headers = await _session_headers(harness, client, seed.project_id, topics=(_VISIBLE,))
        first_page = await client.get(
            "/api/v1/admin/observability/recalls",
            params={"project": seed.project_slug, "limit": 1},
            headers=headers,
        )

        assert first_page.status_code == 200, first_page.text
        first = first_page.json()
        assert isinstance(first, dict)
        assert set(first) == {"items", "next_cursor", "total", "freshness"}, (
            "recalls must expose the T004 ReadPage contract, not the legacy unpaged envelope"
        )
        assert isinstance(first["items"], list)
        assert len(first["items"]) == 1
        assert first["total"] == 2, "count disclosed hidden, mixed, or foreign recall rows"
        assert first["items"][0]["id"] == seed.visible_audit_ids[0]
        assert first["freshness"] is not None
        cursor = first["next_cursor"]
        assert isinstance(cursor, str) and cursor
        assert not any(
            marker in cursor
            for marker in ("hidden-principal", "mixed-hidden-principal", "other-principal")
        ), "opaque continuation carried forbidden row metadata"

        second_page = await client.get(
            "/api/v1/admin/observability/recalls",
            params={"project": seed.project_slug, "limit": 1, "cursor": cursor},
            headers=headers,
        )

    assert second_page.status_code == 200, second_page.text
    second = second_page.json()
    assert isinstance(second, dict)
    assert set(second) == {"items", "next_cursor", "total", "freshness"}
    assert isinstance(second["items"], list)
    assert len(second["items"]) == 1
    assert second["total"] == 2
    assert second["items"][0]["id"] == seed.visible_audit_ids[1]
    assert second["next_cursor"] is None
    assert second["freshness"] is not None

    collected = [first["items"][0]["id"], second["items"][0]["id"]]
    assert collected == list(seed.visible_audit_ids), "authorized cursor pages had a gap or repeat"
    combined = first_page.text + second_page.text
    assert "hidden-principal" not in combined
    assert "mixed-hidden-principal" not in combined
    assert "other-principal" not in combined
    assert _HIDDEN not in combined


def _forge_cursor_position(cursor: str) -> str:
    """Rewrite the visible position while retaining any integrity suffix unchanged."""
    position, separator, integrity = cursor.partition(".")
    padding = "=" * (-len(position) % 4)
    payload = json.loads(urlsafe_b64decode(f"{position}{padding}"))
    payload["id"] = int(payload["id"]) + 1
    rewritten = (
        urlsafe_b64encode(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
        .decode()
        .rstrip("=")
    )
    return f"{rewritten}{separator}{integrity}"


async def test_recall_cursor_rejects_a_forged_position(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    seed = await _seed_read_models(harness)
    async with _client(harness, tmp_path) as client:
        headers = await _session_headers(harness, client, seed.project_id, topics=(_VISIBLE,))
        first = await client.get(
            "/api/v1/admin/observability/recalls",
            params={"project": seed.project_slug, "limit": 1},
            headers=headers,
        )
        cursor = first.json()["next_cursor"]
        assert isinstance(cursor, str) and cursor
        forged = await client.get(
            "/api/v1/admin/observability/recalls",
            params={
                "project": seed.project_slug,
                "limit": 1,
                "cursor": _forge_cursor_position(cursor),
            },
            headers=headers,
        )

    assert forged.status_code == 400
    assert "hidden-principal" not in forged.text


async def test_recall_cursor_is_bound_to_project_scope(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    seed = await _seed_read_models(harness)
    identity = IdentityService(harness.sm)
    email = f"{unique_slug('privacy-cursor-project')}@example.com"
    invitation = await identity.invite_user(email)
    user_id = await identity.accept_invitation(invitation.token, _PASSWORD)
    await identity.add_membership(user_id, seed.project_id, allowed_topics=(_VISIBLE,))
    await identity.add_membership(user_id, seed.other_project_id, allowed_topics=(_VISIBLE,))

    async with _client(harness, tmp_path) as client:
        login = await client.post(
            "/api/v1/auth/login", json={"email": email, "password": _PASSWORD}
        )
        headers = {"Authorization": f"Bearer {login.json()['session_token']}"}
        first = await client.get(
            "/api/v1/admin/observability/recalls",
            params={"project": seed.project_slug, "limit": 1},
            headers=headers,
        )
        cursor = first.json()["next_cursor"]
        assert isinstance(cursor, str) and cursor
        replay = await client.get(
            "/api/v1/admin/observability/recalls",
            params={"project": seed.other_project_slug, "limit": 1, "cursor": cursor},
            headers=headers,
        )

    assert replay.status_code == 400
    assert "other-principal" not in replay.text


async def test_recall_cursor_is_bound_to_principal_identity(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    seed = await _seed_read_models(harness)
    async with _client(harness, tmp_path) as client:
        first_headers = await _session_headers(harness, client, seed.project_id, topics=(_VISIBLE,))
        second_headers = await _session_headers(
            harness, client, seed.project_id, topics=(_VISIBLE,)
        )
        first = await client.get(
            "/api/v1/admin/observability/recalls",
            params={"project": seed.project_slug, "limit": 1},
            headers=first_headers,
        )
        cursor = first.json()["next_cursor"]
        assert isinstance(cursor, str) and cursor
        replay = await client.get(
            "/api/v1/admin/observability/recalls",
            params={"project": seed.project_slug, "limit": 1, "cursor": cursor},
            headers=second_headers,
        )

    assert replay.status_code == 400
    assert "hidden-principal" not in replay.text


async def test_recall_cursor_is_bound_to_filters(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    seed = await _seed_read_models(harness)
    async with _client(harness, tmp_path) as client:
        headers = await _session_headers(harness, client, seed.project_id, topics=(_VISIBLE,))
        first = await client.get(
            "/api/v1/admin/observability/recalls",
            params={"project": seed.project_slug, "limit": 1},
            headers=headers,
        )
        cursor = first.json()["next_cursor"]
        assert isinstance(cursor, str) and cursor
        replay = await client.get(
            "/api/v1/admin/observability/recalls",
            params={
                "project": seed.project_slug,
                "limit": 1,
                "cursor": cursor,
                "denied": True,
            },
            headers=headers,
        )

    assert replay.status_code == 400
    assert "hidden-principal" not in replay.text


async def test_general_only_observability_filters_document_backed_posture_and_errors(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """RED: a mixed document must not inflate health or reveal its extraction failure."""
    harness = build_harness()
    seed = await _seed_read_models(harness)
    async with _client(harness, tmp_path) as client:
        headers = await _session_headers(harness, client, seed.project_id, topics=(_VISIBLE,))
        health = await client.get(
            f"/api/v1/admin/observability/health?project={seed.project_slug}", headers=headers
        )
        ingest = await client.get(
            f"/api/v1/admin/observability/ingest?project={seed.project_slug}", headers=headers
        )

    assert health.status_code == 200, health.text
    assert health.json()["pending_approval"] == 1, (
        "a hidden or mixed pending document changed the posture queue depth"
    )
    assert health.json()["ingest_errors"] == 1, (
        "a hidden or mixed document changed the ingest error aggregate"
    )
    assert ingest.status_code == 200, ingest.text
    assert [run["document_id"] for run in ingest.json()["runs"]] == [seed.visible_document_id], (
        "a hidden or mixed document-backed ingest run was served"
    )
    assert [error["chunk"] for error in ingest.json()["errors"]] == ["VISIBLE-error"], (
        "a hidden or mixed document-backed extraction error was served"
    )


async def test_general_only_skills_exclude_mixed_topic_overlap(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """RED: overlap with general is insufficient for a skill carrying hidden sensitivity 4."""
    harness = build_harness()
    seed = await _seed_read_models(harness)
    async with _client(harness, tmp_path) as client:
        headers = await _session_headers(harness, client, seed.project_id, topics=(_VISIBLE,))
        response = await client.get(
            f"/api/v1/admin/skills?project={seed.project_slug}", headers=headers
        )

    assert response.status_code == 200, response.text
    assert [skill["slug"] for skill in response.json()["skills"]] == ["visible-playbook"], (
        "a hidden or mixed skill appears in the console list"
    )


async def test_graph_filters_real_hidden_candidate_before_counting_edges_or_paging(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """RED: a visible centre returns 200, but its physical hidden neighbour must stay invisible."""
    harness = build_harness()
    seed = await _seed_read_models(harness)
    graph_seed = await _seed_topic_graph(harness, seed.project_id, seed.other_project_id)
    async with _client(harness, tmp_path) as client:
        headers = await _session_headers(harness, client, seed.project_id, topics=(_VISIBLE,))
        first_page = await client.get(
            "/api/v1/admin/graph/entity",
            params={
                "project": seed.project_slug,
                "name": graph_seed.center,
                "limit": 1,
                "offset": 0,
            },
            headers=headers,
        )
        second_page = await client.get(
            "/api/v1/admin/graph/entity",
            params={
                "project": seed.project_slug,
                "name": graph_seed.center,
                "limit": 1,
                "offset": 1,
            },
            headers=headers,
        )

    assert first_page.status_code == 200, first_page.text
    first = first_page.json()
    assert first["center"]["name"] == graph_seed.center
    assert first["total"] == 1 and first["limit"] == 1 and first["offset"] == 0
    assert [neighbor["name"] for neighbor in first["neighbors"]] == [graph_seed.visible_neighbor]
    assert [edge["type"] for edge in first["edges"]] == ["RELATES_TO"]
    assert graph_seed.hidden_neighbor not in first_page.text
    assert "HIDDEN_RELATES_TO" not in first_page.text
    assert graph_seed.mixed_neighbor not in first_page.text
    assert "MIXED_HIDDEN_RELATES_TO" not in first_page.text
    assert graph_seed.foreign_neighbor not in first_page.text
    assert "FOREIGN_ONLY" not in first_page.text
    assert "FOREIGN_VISIBLE_ALIAS" not in first_page.text
    assert "FOREIGN_MIXED_ALIAS" not in first_page.text

    assert second_page.status_code == 200, second_page.text
    second = second_page.json()
    assert second["total"] == 1 and second["limit"] == 1 and second["offset"] == 1
    assert second["neighbors"] == [] and second["edges"] == []
    assert graph_seed.foreign_neighbor not in second_page.text
    assert "FOREIGN_ONLY" not in second_page.text


async def test_empty_topic_membership_returns_empty_every_topic_filtered_read_model(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """An empty grant selects no topic-bearing metrics, posture, activity, skills, or graph."""
    harness = build_harness()
    seed = await _seed_read_models(harness)
    graph_seed = await _seed_topic_graph(harness, seed.project_id, seed.other_project_id)
    async with _client(harness, tmp_path) as client:
        headers = await _session_headers(harness, client, seed.project_id, topics=())
        metrics = await client.get(
            f"/api/v1/admin/metrics/product?project={seed.project_slug}", headers=headers
        )
        health = await client.get(
            f"/api/v1/admin/observability/health?project={seed.project_slug}", headers=headers
        )
        activity = await client.get(
            f"/api/v1/admin/observability/activity?project={seed.project_slug}", headers=headers
        )
        recalls = await client.get(
            "/api/v1/admin/observability/recalls",
            params={"project": seed.project_slug, "limit": 1},
            headers=headers,
        )
        ingest = await client.get(
            f"/api/v1/admin/observability/ingest?project={seed.project_slug}", headers=headers
        )
        skills = await client.get(
            f"/api/v1/admin/skills?project={seed.project_slug}", headers=headers
        )
        graph = await client.get(
            "/api/v1/admin/graph/entity",
            params={"project": seed.project_slug, "name": graph_seed.center},
            headers=headers,
        )

    assert metrics.status_code == 200, metrics.text
    assert metrics.json()["adoption"] == {
        "recalls": 0,
        "active_principals": 0,
        "recalls_per_day": [],
    }
    assert metrics.json()["quality"] == {"abstention_rate": 0.0, "hunts_answered_pct": 0.0}
    assert metrics.json()["knowledge"] == {"claims": 0, "disputed": 0, "open_gaps": 0}
    assert metrics.json()["health"]["extraction_errors"] == 0
    assert health.status_code == 200, health.text
    assert health.json()["pending_approval"] == 0
    assert health.json()["ingest_errors"] == 0
    assert activity.status_code == 200, activity.text
    assert activity.json() == {
        "recalls": 0,
        "denied": 0,
        "active_principals": 0,
        "p95_duration_ms": None,
        "recalls_per_day": [],
    }
    assert recalls.status_code == 200, recalls.text
    recall_page = recalls.json()
    assert isinstance(recall_page, dict)
    assert set(recall_page) == {"items", "next_cursor", "total", "freshness"}
    assert recall_page["items"] == []
    assert recall_page["next_cursor"] is None
    assert recall_page["total"] == 0
    assert recall_page["freshness"] is not None
    assert ingest.status_code == 200, ingest.text
    assert ingest.json()["runs"] == []
    assert ingest.json()["errors"] == []
    assert skills.status_code == 200, skills.text
    assert skills.json()["skills"] == []
    assert graph.status_code == 404, graph.text
