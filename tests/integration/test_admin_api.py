"""REST admin API (FR-10.2) against the real container: role-gated parity endpoints + OpenAPI.

A **project-admin** PAT reaches the management surface; a curator-member, a plain member and a
missing token do not (AUDIT-020/R03/R54 — curation authorizes knowledge-review decisions only,
never administration). Confirms the console-facing endpoints (projects, topics, sources, pending
docs, gaps, audit) exist and are documented in the OpenAPI (which SPEC-07 consumes).
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import httpx
import pytest

from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.hunting.channels import NullChannel
from rsc_brain.hunting.service import HuntService
from rsc_brain.identity.service import IdentityService
from rsc_brain.stores.relational.store import PgRelationalStore
from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("general", 0), ("engineering", 0)]


async def _mint_pat(
    harness: Harness,
    project_id: str,
    *,
    can_curate: bool,
    role: str,
    project_role: str = "member",
    topics: tuple[str, ...] = ("general",),
) -> str:
    """Mint a PAT for a principal with an explicit global role AND project role (AUDIT-020).

    ``role`` is the platform role (owner|admin|member); ``project_role`` is the membership role
    (project-admin|member|viewer). The management matrix is a function of the project role and
    topic authority — never of ``can_curate``, which authorizes only knowledge-review decisions.
    """
    user = (
        await PgRelationalStore(harness.sm)
        .users()
        .create_user(email=f"{unique_slug('admin')}@example.com", status="active", role=role)
    )
    identity = IdentityService(harness.sm)
    membership = await identity.add_membership(
        user.user_id,
        project_id,
        role=project_role,
        allowed_topics=topics,
        can_curate=can_curate,
    )
    return (await identity.issue_pat(membership)).token


async def _project_admin_pat(harness: Harness, project_id: str) -> str:
    """The least principal the ratified matrix admits to the management surface."""
    return await _mint_pat(
        harness,
        project_id,
        can_curate=False,
        role="member",
        project_role="project-admin",
        topics=("general", "engineering"),
    )


def _client(harness: Harness, tmp_path: Path) -> httpx.AsyncClient:
    app = create_app(
        deps=ApiDeps(sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path))
    )
    # An install that HAS configured a delivery channel: without one, hunting reports its hunts as
    # undelivered rather than awaiting an answer (R28), which is a different test's subject. Assigned
    # through `app.state.hunts` because that is where `create_app` itself puts the configured service.
    app.state.hunts = HuntService(harness.sm, channel=NullChannel(), base_url="http://test")
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


MANAGEMENT_READS = (
    "/api/v1/admin/sources",
    "/api/v1/admin/documents/pending",
    "/api/v1/admin/gaps",
    "/api/v1/admin/audit",
)


async def test_project_admin_reaches_the_management_surface(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """R04 allow-side: the least ratified management role is admitted.

    A project administrator with topic authority is the principal the matrix assigns to this
    surface. It must work without curation capability — an authorization repair that locks the
    legitimate owner out is as much a defect as one that admits a curator.
    """
    harness = build_harness()
    slug = unique_slug("acme")
    project = await harness.setup_project(slug, TOPICS)
    headers = {"Authorization": f"Bearer {await _project_admin_pat(harness, project)}"}

    async with _client(harness, tmp_path) as client:
        created = await client.post(
            "/api/v1/admin/topics",
            json={"slug": "finance", "name": "Finance", "sensitivity": 0},
            headers=headers,
        )
        assert created.status_code == 201, created.text

        # T002: project administration stays useful inside its one project, but the global
        # inventory has a separate platform capability and must reject this PAT.
        inventory = await client.get("/api/v1/admin/projects", headers=headers)
        assert inventory.status_code == 403, inventory.text

        for path in MANAGEMENT_READS:
            response = await client.get(path, headers=headers)
            assert response.status_code == 200, f"{path}: {response.text}"


async def test_owner_pat_reaches_global_project_inventory(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """PAT compatibility does not turn its project binding into global authority.

    The credential resolves a current user identity; the owner role's independently decided
    platform capability is what admits inventory.  T002's session-only owner-without-membership
    control covers the complementary no-membership case.
    """
    harness = build_harness()
    slug = unique_slug("acme")
    project = await harness.setup_project(slug, TOPICS)
    headers = {
        "Authorization": f"Bearer {await _mint_pat(harness, project, can_curate=False, role='owner')}"
    }

    async with _client(harness, tmp_path) as client:
        response = await client.get("/api/v1/admin/projects", headers=headers)
    assert response.status_code == 200, response.text
    assert slug in {item["slug"] for item in response.json()["projects"]}


async def test_curator_member_is_denied_the_management_surface(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """R03/R54 deny-side: ``can_curate`` is knowledge-review authority, never administration.

    Ratified 2026-07-24 (AUDIT-020): ``can_curate`` grants no project, ontology, logging, gap,
    export, document-lifecycle or platform authority. This test previously asserted the opposite
    and so canonized the escalation as expected behaviour.
    """
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    token = await _mint_pat(harness, project, can_curate=True, role="member", project_role="member")
    headers = {"Authorization": f"Bearer {token}"}

    async with _client(harness, tmp_path) as client:
        for path in MANAGEMENT_READS:
            response = await client.get(path, headers=headers)
            assert response.status_code == 403, f"{path} admitted a curator-member: {response.text}"

        created = await client.post(
            "/api/v1/admin/topics",
            json={"slug": "finance", "name": "Finance", "sensitivity": 0},
            headers=headers,
        )
        assert created.status_code == 403, created.text

    # Denied means no side effect: the rejected topic was never created.
    async with _client(harness, tmp_path) as client:
        admin = {"Authorization": f"Bearer {await _project_admin_pat(harness, project)}"}
        topics = await client.get("/api/v1/admin/topics", headers=admin)
        if topics.status_code == 200:
            slugs = {t["slug"] for t in topics.json().get("topics", [])}
            assert "finance" not in slugs, "denied mutation still created the topic"


async def test_hunting_endpoints_round_trip(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """Persons CRUD → manual hunt (routed to the person) → hunts list/show → gaps audience view."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    headers = {"Authorization": f"Bearer {await _project_admin_pat(harness, project)}"}

    async with _client(harness, tmp_path) as client:
        created = await client.post(
            "/api/v1/admin/persons",
            json={"name": "Owner", "topics": ["engineering"], "channels": {"email": "o@x"}},
            headers=headers,
        )
        assert created.status_code == 201, created.text
        person_id = created.json()["person_id"]

        listed = await client.get("/api/v1/admin/persons", headers=headers)
        assert listed.status_code == 200
        assert any(p["id"] == person_id for p in listed.json()["persons"])

        patched = await client.patch(
            f"/api/v1/admin/persons/{person_id}",
            json={"language": "en", "expected_version": 1},
            headers=headers,
        )
        assert patched.status_code == 200

        asked = await client.post(
            "/api/v1/admin/hunts/ask",
            json={"question": "who owns deploys?", "topics": ["engineering"]},
            headers=headers,
        )
        assert asked.status_code == 201, asked.text
        body = asked.json()
        assert body["state"] == "AWAITING_ANSWER" and body["person_id"] == person_id

        hunts = await client.get("/api/v1/admin/hunts", headers=headers)
        assert hunts.status_code == 200
        assert len(hunts.json()["hunts"]) == 1
        one = await client.get(f"/api/v1/admin/hunts/{body['hunt_id']}", headers=headers)
        assert one.status_code == 200 and one.json()["hunt"]["type"] == "MANUAL"

        # The separate agent-gap view is empty (no agent gaps recorded); it never 500s.
        agent_gaps = await client.get("/api/v1/admin/gaps?audience=agent", headers=headers)
        assert agent_gaps.status_code == 200 and agent_gaps.json()["gaps"] == []

        removed = await client.delete(
            f"/api/v1/admin/persons/{person_id}",
            params={"expected_version": patched.json()["version"]},
            headers=headers,
        )
        assert removed.status_code == 409, "an active hunt must block removal of its owner"


async def test_timeline_endpoint_has_contract_parity(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """SPEC-17: the MCP `timeline` tool is mirrored by GET /admin/timeline (for the console lane)."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    headers = {"Authorization": f"Bearer {await _project_admin_pat(harness, project)}"}
    async with _client(harness, tmp_path) as client:
        response = await client.get("/api/v1/admin/timeline?topic=general", headers=headers)
    assert response.status_code == 200, response.text
    body = response.json()["timeline"]
    assert set(body) == {"found", "topic", "entity", "entries"} and body["topic"] == "general"


async def test_non_admin_is_forbidden(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    token = await _mint_pat(harness, project, can_curate=False, role="member")
    headers = {"Authorization": f"Bearer {token}"}
    async with _client(harness, tmp_path) as client:
        response = await client.get("/api/v1/admin/gaps", headers=headers)
    assert response.status_code == 403


async def test_missing_token_is_401(build_harness: Callable[..., Harness], tmp_path: Path) -> None:
    harness = build_harness()
    async with _client(harness, tmp_path) as client:
        response = await client.get("/api/v1/admin/projects")
    assert response.status_code == 401
