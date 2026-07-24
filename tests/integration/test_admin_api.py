"""REST admin API (FR-10.2) against the real container: admin-gated parity endpoints + OpenAPI.

A curator/admin PAT reaches the admin surface; a plain member is 403; no token is 401. Confirms
the console-facing endpoints (projects, topics, sources, pending docs, gaps, audit) exist and are
documented in the OpenAPI (which SPEC-07 consumes).
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import httpx
import pytest

from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.identity.service import IdentityService
from rsc_brain.stores.relational.store import PgRelationalStore
from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("general", 0), ("engineering", 0)]


async def _mint_pat(harness: Harness, project_id: str, *, can_curate: bool, role: str) -> str:
    user = (
        await PgRelationalStore(harness.sm)
        .users()
        .create_user(email=f"{unique_slug('admin')}@example.com", status="active", role=role)
    )
    identity = IdentityService(harness.sm)
    membership = await identity.add_membership(
        user.user_id, project_id, allowed_topics=("general",), can_curate=can_curate
    )
    return (await identity.issue_pat(membership)).token


def _client(harness: Harness, tmp_path: Path) -> httpx.AsyncClient:
    app = create_app(
        deps=ApiDeps(sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path))
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def test_admin_endpoints_reachable_by_curator(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    token = await _mint_pat(harness, project, can_curate=True, role="member")
    headers = {"Authorization": f"Bearer {token}"}

    async with _client(harness, tmp_path) as client:
        projects = await client.get("/api/v1/admin/projects", headers=headers)
        assert projects.status_code == 200, projects.text

        created = await client.post(
            "/api/v1/admin/topics",
            json={"slug": "finance", "name": "Finance", "sensitivity": 0},
            headers=headers,
        )
        assert created.status_code == 201

        for path in (
            "/api/v1/admin/sources",
            "/api/v1/admin/documents/pending",
            "/api/v1/admin/gaps",
            "/api/v1/admin/audit",
        ):
            response = await client.get(path, headers=headers)
            assert response.status_code == 200, f"{path}: {response.text}"


async def test_hunting_endpoints_round_trip(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """Persons CRUD → manual hunt (routed to the person) → hunts list/show → gaps audience view."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    token = await _mint_pat(harness, project, can_curate=True, role="member")
    headers = {"Authorization": f"Bearer {token}"}

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
            json={"language": "en"},
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

        removed = await client.delete(f"/api/v1/admin/persons/{person_id}", headers=headers)
        assert removed.status_code == 200


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
