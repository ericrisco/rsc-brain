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

_PLATFORM_ADMIN_CAPABILITIES = {
    "platform.project.create",
    "platform.user.invite",
    "platform.project.list_all",
    "platform.credential.revoke",
}
_PROJECT_ADMIN_CAPABILITIES = {
    "project.manage.read",
    "project.config.write",
    "project.settings.write",
    "document.decide",
    "gap.promote",
    "hunt.manage",
    "knowledge.read",
    "usage.read",
    "knowledge.review.decide",
    "correction.revert",
}
_CURATOR_MEMBER_CAPABILITIES = {
    "knowledge.read",
    "usage.read",
    "knowledge.review.decide",
}
_VIEWER_CAPABILITIES = {"knowledge.read", "usage.read"}


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


def _assert_capabilities(actual: object, expected: set[str]) -> None:
    assert isinstance(actual, list)
    assert len(actual) == len(expected)
    assert set(actual) == expected


def _assert_session_envelope(
    response: httpx.Response,
    *,
    user_id: str,
    email: str,
    platform_role: str,
    platform_capabilities: set[str],
    project_slug: str | None = None,
    project_role: str | None = None,
    project_capabilities: set[str] | None = None,
    can_curate: bool = False,
) -> None:
    """Pin the complete display-safe schema as well as its effective authority."""
    assert response.status_code == 200, response.text
    envelope = response.json()
    assert set(envelope) == {
        "identity",
        "user",  # Compatibility alias until all pre-control-plane clients have migrated.
        "is_owner",
        "platform_capabilities",
        "memberships",
        "preference_metadata",
    }
    expected_identity = {"id": user_id, "email": email, "role": platform_role}
    assert envelope["identity"] == expected_identity
    assert envelope["user"] == expected_identity
    assert envelope["is_owner"] is (platform_role == "owner")
    _assert_capabilities(envelope["platform_capabilities"], platform_capabilities)
    assert envelope["preference_metadata"] == {"theme": "system", "locale": "es"}

    if project_slug is None:
        assert envelope["memberships"] == []
        return
    assert len(envelope["memberships"]) == 1
    membership = envelope["memberships"][0]
    assert set(membership) == {
        "project",
        "role",
        "capabilities",
        "allowed_topics",
        "can_curate",
    }
    assert membership["project"] == project_slug
    assert membership["role"] == project_role
    assert membership["allowed_topics"] == ["general"]
    assert membership["can_curate"] is can_curate
    _assert_capabilities(membership["capabilities"], project_capabilities or set())


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
    owner_email, owner_id = await _session_for(
        harness,
        platform_role="owner",
        project_id=project_id,
        project_role="project-admin",
        can_curate=True,
    )
    curator_email, curator_id = await _session_for(
        harness,
        platform_role="member",
        project_id=project_id,
        project_role="member",
        can_curate=True,
    )
    viewer_email, viewer_id = await _session_for(
        harness,
        platform_role="member",
        project_id=project_id,
        project_role="viewer",
        can_curate=True,
    )
    platform_email, platform_id = await _session_for(harness, platform_role="owner")

    async with _client(harness, tmp_path) as client:
        owner = await client.get("/api/v1/me", headers=await _login(client, owner_email))
        curator = await client.get("/api/v1/me", headers=await _login(client, curator_email))
        viewer = await client.get("/api/v1/me", headers=await _login(client, viewer_email))
        platform_only = await client.get("/api/v1/me", headers=await _login(client, platform_email))

    _assert_session_envelope(
        owner,
        user_id=owner_id,
        email=owner_email,
        platform_role="owner",
        platform_capabilities=_PLATFORM_ADMIN_CAPABILITIES,
        project_slug=project_slug,
        project_role="project-admin",
        project_capabilities=_PROJECT_ADMIN_CAPABILITIES,
        can_curate=True,
    )
    _assert_session_envelope(
        curator,
        user_id=curator_id,
        email=curator_email,
        platform_role="member",
        platform_capabilities=set(),
        project_slug=project_slug,
        project_role="member",
        project_capabilities=_CURATOR_MEMBER_CAPABILITIES,
        can_curate=True,
    )
    _assert_session_envelope(
        viewer,
        user_id=viewer_id,
        email=viewer_email,
        platform_role="member",
        platform_capabilities=set(),
        project_slug=project_slug,
        project_role="viewer",
        project_capabilities=_VIEWER_CAPABILITIES,
        can_curate=True,
    )
    _assert_session_envelope(
        platform_only,
        user_id=platform_id,
        email=platform_email,
        platform_role="owner",
        platform_capabilities=_PLATFORM_ADMIN_CAPABILITIES,
    )


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
