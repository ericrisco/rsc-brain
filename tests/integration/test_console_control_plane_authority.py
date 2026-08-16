"""RED contracts for the console control-plane authority boundary (T001).

These tests exercise the actual ASGI application, database-backed console sessions, and
authorization rules.  They deliberately describe the pre-implementation API boundary:
the session must be an authoritative capability envelope, and platform inventory must not
be forced through a project membership or become reachable through a project-scoped URL.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import httpx

from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.identity.service import IdentityService
from tests.integration.conftest import Harness, unique_slug

_PASSWORD = "correct horse battery staple"  # Test fixture credential; never a production secret.


def _client(harness: Harness, tmp_path: Path) -> httpx.AsyncClient:
    app = create_app(
        deps=ApiDeps(sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path))
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _session_for(
    harness: Harness,
    *,
    platform_role: str,
    project_id: str | None = None,
    project_role: str = "member",
    topics: tuple[str, ...] = ("general",),
    can_curate: bool = False,
) -> tuple[str, str]:
    """Create an active user and obtain a real console session.

    A membership is optional on purpose: platform inventory is an explicit platform
    capability and must remain available to an owner who has no project membership.
    """
    identity = IdentityService(harness.sm)
    email = f"{unique_slug('console-authority')}@example.com"
    invited = await identity.invite_user(email, role=platform_role)
    user_id = await identity.accept_invitation(invited.token, _PASSWORD)
    if project_id is not None:
        await identity.add_membership(
            user_id,
            project_id,
            role=project_role,
            allowed_topics=topics,
            can_curate=can_curate,
        )
    return email, user_id


async def _login(client: httpx.AsyncClient, email: str) -> dict[str, str]:
    response = await client.post("/api/v1/auth/login", json={"email": email, "password": _PASSWORD})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['session_token']}"}


async def test_session_is_an_authoritative_capability_envelope(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """The console receives effective capabilities, never role-derived authority.

    The status and membership control establish that this is a real authenticated session
    before the assertions specify the T002 envelope fields missing from the current API.
    """
    harness = build_harness()
    project_slug = unique_slug("capability-envelope")
    project_id = await harness.setup_project(project_slug, [("general", 0)])
    email, user_id = await _session_for(
        harness,
        platform_role="owner",
        project_id=project_id,
        project_role="project-admin",
        can_curate=True,
    )

    async with _client(harness, tmp_path) as client:
        response = await client.get("/api/v1/me", headers=await _login(client, email))

    assert response.status_code == 200, response.text
    # Existing membership data is the allow-side control; the next fields are the missing contract.
    assert response.json()["memberships"][0]["project"] == project_slug
    envelope = response.json()
    assert "identity" in envelope, envelope
    assert envelope["identity"]["id"] == user_id
    assert envelope["identity"]["email"] == email
    assert set(envelope["identity"]).isdisjoint(
        {"password", "password_hash", "session_token", "token", "token_hash"}
    )
    assert "platform.project.list_all" in envelope["platform_capabilities"]
    membership = envelope["memberships"][0]
    assert membership["allowed_topics"] == ["general"]
    assert membership["can_curate"] is True
    assert "project.manage.read" in membership["capabilities"]
    assert all(
        capability.startswith("platform.") for capability in envelope["platform_capabilities"]
    )
    assert all(not capability.startswith("platform.") for capability in membership["capabilities"])
    assert envelope["preference_metadata"] == {"theme": "system", "locale": "es"}


async def test_owner_platform_inventory_does_not_require_project_membership(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """Platform inventory is global posture, not project content (AC-020)."""
    harness = build_harness()
    first_project = unique_slug("inventory-a")
    second_project = unique_slug("inventory-b")
    await harness.setup_project(first_project, [("general", 0)])
    await harness.setup_project(second_project, [("general", 0)])
    email, _ = await _session_for(harness, platform_role="owner")

    async with _client(harness, tmp_path) as client:
        headers = await _login(client, email)
        session = await client.get("/api/v1/me", headers=headers)
        response = await client.get("/api/v1/admin/projects", headers=headers)

    # This proves the owner intentionally has no project scope; no synthetic principal is used.
    assert session.status_code == 200, session.text
    assert session.json()["memberships"] == []
    assert response.status_code == 200, response.text
    assert {project["slug"] for project in response.json()["projects"]} >= {
        first_project,
        second_project,
    }


async def test_project_admin_cannot_bypass_platform_inventory_via_direct_api_url(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """A hidden navigation control cannot be bypassed with either API URL form (AC-007)."""
    harness = build_harness()
    project_slug = unique_slug("direct-url")
    project_id = await harness.setup_project(project_slug, [("general", 0)])
    email, _ = await _session_for(
        harness,
        platform_role="member",
        project_id=project_id,
        project_role="project-admin",
    )

    async with _client(harness, tmp_path) as client:
        headers = await _login(client, email)
        session = await client.get("/api/v1/me", headers=headers)
        direct = await client.get("/api/v1/admin/projects", headers=headers)
        project_parameter = await client.get(
            f"/api/v1/admin/projects?project={project_slug}", headers=headers
        )

    # The membership is real and useful, but it must not become platform inventory authority.
    assert session.status_code == 200, session.text
    assert session.json()["memberships"][0]["project"] == project_slug
    assert (direct.status_code, project_parameter.status_code) == (403, 403), {
        "direct": direct.text,
        "with_project": project_parameter.text,
    }
    envelope = session.json()
    assert "platform.project.list_all" not in envelope["platform_capabilities"]
    assert "platform.project.list_all" not in envelope["memberships"][0]["capabilities"]
