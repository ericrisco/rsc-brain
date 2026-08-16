"""RED privacy contracts for console control-plane read models (T003).

Every request exercises the mounted ASGI application with a DB-backed console session.  The
fixture deliberately puts a conspicuous ``hidden`` row next to a ``general`` row in the same
project (and a second project), so an aggregate, list, or graph selection can only pass when its
topic predicate is applied before the observable is derived.

The current routes have not yet adopted the planned ``ReadPage``/``PostureEnvelope`` shapes, so
these contracts pin the observable fields that really exist today.  They do not manufacture a
cursor-only route merely to obtain a 404.
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable
from pathlib import Path

import httpx

from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.identity.service import IdentityService
from rsc_brain.ingest.entity_resolution import entity_id, normalize_name
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.graph_store import GraphNode
from rsc_brain.stores.relational import models
from tests.integration.conftest import Harness, unique_slug

_PASSWORD = "correct horse battery staple"
_VISIBLE = "general"
_HIDDEN = "hidden"


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


async def _seed_read_models(harness: Harness) -> tuple[str, str, str]:
    """Seed visible, hidden, and other-project rows whose values cannot be confused."""
    project_slug = unique_slug("privacy-a")
    other_slug = unique_slug("privacy-b")
    project_id = await harness.setup_project(project_slug, [(_VISIBLE, 0), (_HIDDEN, 4)])
    other_id = await harness.setup_project(other_slug, [(_VISIBLE, 0), (_HIDDEN, 4)])
    project_uuid = uuid.UUID(project_id)
    other_uuid = uuid.UUID(other_id)
    today = dt.datetime.now(dt.UTC).date()

    async with harness.sm() as session:
        session.add_all(
            [
                models.Document(
                    project_id=project_uuid,
                    logical_id="visible-health",
                    version=1,
                    checksum="visible-health-checksum",
                    title="Visible health document",
                    status="pending_approval",
                    doc_tags=[_VISIBLE],
                ),
                models.Document(
                    project_id=project_uuid,
                    logical_id="hidden-health",
                    version=1,
                    checksum="hidden-health-checksum",
                    title="HIDDEN health document",
                    status="pending_approval",
                    doc_tags=[_HIDDEN],
                ),
                models.Document(
                    project_id=other_uuid,
                    logical_id="other-health",
                    version=1,
                    checksum="other-health-checksum",
                    title="OTHER PROJECT health document",
                    status="pending_approval",
                    doc_tags=[_VISIBLE],
                ),
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
                    text="HIDDEN product claim",
                    subject="Hidden",
                    predicate="knows",
                    object="Secret",
                    tags=[_HIDDEN],
                ),
                models.Claim(
                    project_id=other_uuid,
                    text="OTHER PROJECT claim",
                    subject="Other",
                    predicate="knows",
                    object="Elsewhere",
                    tags=[_VISIBLE],
                ),
                models.Gap(
                    project_id=project_uuid,
                    query_hash="visible-product-gap",
                    query_text="VISIBLE product gap",
                    topics=[_VISIBLE],
                    count=1,
                    status="open",
                ),
                models.Gap(
                    project_id=project_uuid,
                    query_hash="hidden-product-gap",
                    query_text="HIDDEN product gap",
                    topics=[_HIDDEN],
                    count=987,
                    status="open",
                ),
                models.Gap(
                    project_id=other_uuid,
                    query_hash="other-product-gap",
                    query_text="OTHER PROJECT product gap",
                    topics=[_VISIBLE],
                    count=321,
                    status="open",
                ),
                models.TokenUsage(
                    id=uuid.uuid4(),
                    project_id=project_uuid,
                    capability="visible.embed",
                    day=today,
                    tokens=13,
                    calls=1,
                ),
                models.TokenUsage(
                    id=uuid.uuid4(),
                    project_id=project_uuid,
                    capability="hidden.embed",
                    day=today,
                    tokens=987_654,
                    calls=99,
                ),
                models.TokenUsage(
                    id=uuid.uuid4(),
                    project_id=other_uuid,
                    capability="other.embed",
                    day=today,
                    tokens=321_000,
                    calls=32,
                ),
                models.AuditLog(
                    project_id=project_uuid,
                    principal_type="human",
                    principal_id="visible-principal",
                    action="recall",
                    duration_ms=11,
                    topics_used=[_VISIBLE],
                    result_count=1,
                ),
                models.AuditLog(
                    project_id=project_uuid,
                    principal_type="human",
                    principal_id="hidden-principal",
                    action="recall",
                    duration_ms=9_999,
                    topics_used=[_HIDDEN],
                    result_count=987,
                ),
                models.AuditLog(
                    project_id=other_uuid,
                    principal_type="human",
                    principal_id="other-principal",
                    action="recall",
                    duration_ms=321,
                    topics_used=[_VISIBLE],
                    result_count=321,
                ),
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
            ]
        )
        await session.commit()
    return project_slug, project_id, other_slug


async def _seed_ambiguous_graph(harness: Harness, project_id: str) -> str:
    """A legacy keyless claim must not choose between a visible and hidden same-name entity."""
    project_uuid = uuid.UUID(project_id)
    name = "Shared identity"
    hidden_type = "restricted-codename"
    visible_type = "person"
    async with harness.sm() as session:
        session.add_all(
            [
                models.Entity(
                    project_id=project_uuid,
                    name=name,
                    normalized_name=normalize_name(name),
                    type=hidden_type,
                ),
                models.Entity(
                    project_id=project_uuid,
                    name=name,
                    normalized_name=normalize_name(name),
                    type=visible_type,
                ),
                # Existing historical rows can lack entity keys. Such a claim is insufficient to
                # select one of two identities with the same name.
                models.Claim(
                    project_id=project_uuid,
                    text="VISIBLE legacy claim",
                    subject=name,
                    predicate="mentions",
                    object="Public counterpart",
                    tags=[_VISIBLE],
                ),
                models.Claim(
                    project_id=project_uuid,
                    text="HIDDEN typed claim",
                    subject=name,
                    subject_entity_key=entity_id(hidden_type, name),
                    predicate="mentions",
                    object="Restricted counterpart",
                    tags=[_HIDDEN],
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
                id=str(entity_id(hidden_type, name)),
                labels=frozenset({"Entity"}),
                properties={"name": name, "type": hidden_type},
            ),
            GraphNode(
                id=str(entity_id(visible_type, name)),
                labels=frozenset({"Entity"}),
                properties={"name": name, "type": visible_type},
            ),
        ],
    )
    return name


async def test_allow_side_full_topic_metrics_are_reachable_and_complete(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    slug, project_id, _ = await _seed_read_models(harness)
    async with _client(harness, tmp_path) as client:
        headers = await _session_headers(harness, client, project_id, topics=(_VISIBLE, _HIDDEN))
        response = await client.get(
            f"/api/v1/admin/metrics/product?project={slug}", headers=headers
        )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["adoption"]["recalls"] == 2
    assert payload["knowledge"] == {"claims": 2, "disputed": 0, "open_gaps": 2}


async def test_allow_side_full_topic_observability_is_reachable_and_complete(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    slug, project_id, _ = await _seed_read_models(harness)
    async with _client(harness, tmp_path) as client:
        headers = await _session_headers(harness, client, project_id, topics=(_VISIBLE, _HIDDEN))
        response = await client.get(
            f"/api/v1/admin/observability/health?project={slug}", headers=headers
        )

    assert response.status_code == 200, response.text
    assert response.json()["pending_approval"] == 2


async def test_allow_side_full_topic_skills_are_reachable_and_complete(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    slug, project_id, _ = await _seed_read_models(harness)
    async with _client(harness, tmp_path) as client:
        headers = await _session_headers(harness, client, project_id, topics=(_VISIBLE, _HIDDEN))
        response = await client.get(f"/api/v1/admin/skills?project={slug}", headers=headers)

    assert response.status_code == 200, response.text
    assert {skill["slug"] for skill in response.json()["skills"]} == {
        "visible-playbook",
        "hidden-playbook",
    }


async def test_allow_side_full_topic_graph_is_reachable(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    slug, project_id, _ = await _seed_read_models(harness)
    name = await _seed_ambiguous_graph(harness, project_id)
    async with _client(harness, tmp_path) as client:
        headers = await _session_headers(harness, client, project_id, topics=(_VISIBLE, _HIDDEN))
        response = await client.get(
            "/api/v1/admin/graph/entity",
            params={"project": slug, "name": name},
            headers=headers,
        )

    assert response.status_code == 200, response.text
    assert response.json()["center"]["name"] == name


async def test_platform_owner_and_empty_topic_membership_do_not_widen_activity(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """§0 matrix controls: a platform role is not content authority; empty is not all."""
    harness = build_harness()
    slug, project_id, _ = await _seed_read_models(harness)
    async with _client(harness, tmp_path) as client:
        owner_without_membership = await _session_headers(
            harness, client, None, topics=(), platform_role="owner"
        )
        no_topic_member = await _session_headers(harness, client, project_id, topics=())
        owner = await client.get(
            f"/api/v1/admin/observability/activity?project={slug}",
            headers=owner_without_membership,
        )
        empty = await client.get(
            f"/api/v1/admin/observability/activity?project={slug}", headers=no_topic_member
        )

    assert owner.status_code == 404, owner.text
    assert empty.status_code == 200, empty.text
    assert empty.json()["recalls"] == 0
    assert empty.json()["recalls_per_day"] == []


async def test_product_metrics_exclude_hidden_counts_tokens_and_activity_series(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """RED: hidden rows must not change product totals, score-like p95, or the daily series."""
    harness = build_harness()
    slug, project_id, _ = await _seed_read_models(harness)
    async with _client(harness, tmp_path) as client:
        headers = await _session_headers(harness, client, project_id, topics=(_VISIBLE,))
        response = await client.get(
            f"/api/v1/admin/metrics/product?project={slug}", headers=headers
        )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["adoption"]["recalls"] == 1
    assert [point["recalls"] for point in payload["adoption"]["recalls_per_day"]] == [1]
    assert payload["health"]["recall_p95_ms"] == 11.0
    assert payload["knowledge"] == {"claims": 1, "disputed": 0, "open_gaps": 1}


async def test_observability_health_excludes_hidden_pending_queue_depth(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """RED: hidden documents must not inflate the dashboard posture aggregate."""
    harness = build_harness()
    slug, project_id, _ = await _seed_read_models(harness)
    async with _client(harness, tmp_path) as client:
        headers = await _session_headers(harness, client, project_id, topics=(_VISIBLE,))
        response = await client.get(
            f"/api/v1/admin/observability/health?project={slug}", headers=headers
        )

    assert response.status_code == 200, response.text
    assert response.json()["pending_approval"] == 1, (
        "a hidden pending document changed the posture queue depth"
    )


async def test_skills_filter_hidden_items_before_the_console_list_is_built(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """RED: a hidden skill cannot be disclosed through this unpaginated read model."""
    harness = build_harness()
    slug, project_id, _ = await _seed_read_models(harness)
    async with _client(harness, tmp_path) as client:
        headers = await _session_headers(harness, client, project_id, topics=(_VISIBLE,))
        response = await client.get(f"/api/v1/admin/skills?project={slug}", headers=headers)

    assert response.status_code == 200, response.text
    assert [skill["slug"] for skill in response.json()["skills"]] == ["visible-playbook"], (
        "the hidden skill appears in the console list"
    )


async def test_graph_refuses_ambiguous_legacy_name_before_selecting_a_hidden_identity(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """RED: a keyless visible claim cannot select a same-name hidden graph identity."""
    harness = build_harness()
    slug, project_id, _ = await _seed_read_models(harness)
    name = await _seed_ambiguous_graph(harness, project_id)
    async with _client(harness, tmp_path) as client:
        headers = await _session_headers(harness, client, project_id, topics=(_VISIBLE,))
        response = await client.get(
            "/api/v1/admin/graph/entity",
            params={"project": slug, "name": name},
            headers=headers,
        )

    assert response.status_code == 404, (
        "an ambiguous legacy name selected a graph identity; a hidden type/id may now be observed"
    )
