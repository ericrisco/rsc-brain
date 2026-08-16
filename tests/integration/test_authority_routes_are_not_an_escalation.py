"""AUDIT-078 (integration): the five authority routes, driven as HTTP.

An adversarial review of my AUDIT-073/074 diff pointed out that **no test exercised any of the five
new routes** — they were reviewed by their docstrings. It then found a privilege escalation in them.
These tests run the exploit rather than describing it.
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

TOPICS = [("general", 0), ("payroll", 4)]


async def _principal(
    harness: Harness, project_id: str, *, project_role: str, topics: tuple[str, ...]
) -> tuple[str, str]:
    """Return (user_id, PAT) for a principal with an explicit project role and topic authority."""
    user = (
        await PgRelationalStore(harness.sm)
        .users()
        .create_user(email=f"{unique_slug('p')}@example.com", status="active", role="member")
    )
    identity = IdentityService(harness.sm)
    membership = await identity.add_membership(
        user.user_id, project_id, role=project_role, allowed_topics=topics, can_curate=False
    )
    return user.user_id, (await identity.issue_pat(membership)).token


def _client(harness: Harness, tmp_path: Path) -> httpx.AsyncClient:
    app = create_app(
        deps=ApiDeps(sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path))
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def test_a_project_admin_cannot_grant_itself_a_topic_it_does_not_hold(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """THE exploit, run end to end.

    Before the fix this returned 201 and the caller's next request carried `payroll` — every
    sensitivity-4 chunk they had been deliberately excluded from. One call, no race, no guessing.
    """
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    attacker, token = await _principal(
        harness, project, project_role="project-admin", topics=("general",)
    )
    headers = {"Authorization": f"Bearer {token}"}

    async with _client(harness, tmp_path) as client:
        response = await client.post(
            "/api/v1/admin/topics/payroll/grants", json={"user_id": attacker}, headers=headers
        )
    assert response.status_code == 403, (
        f"a project-admin holding only 'general' escalated to 'payroll' ({response.status_code}); "
        "project-admin must not imply topic authority (R01, AUDIT-020)"
    )
    remaining = await IdentityService(harness.sm).membership_topics(attacker, project)
    assert remaining is not None and "payroll" not in remaining, (
        "the grant was refused and applied anyway"
    )


async def test_granting_a_held_topic_to_someone_else_still_works(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """The fix must not break the operation AUDIT-073 exists to provide."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    _, admin_token = await _principal(
        harness, project, project_role="project-admin", topics=("general", "payroll")
    )
    colleague, _ = await _principal(harness, project, project_role="member", topics=())
    headers = {"Authorization": f"Bearer {admin_token}"}

    async with _client(harness, tmp_path) as client:
        granted = await client.post(
            "/api/v1/admin/topics/payroll/grants", json={"user_id": colleague}, headers=headers
        )
        assert granted.status_code == 201, granted.text
        assert "payroll" in granted.json()["allowed_topics"]

        revoked = await client.delete(
            f"/api/v1/admin/topics/payroll/grants/{colleague}", headers=headers
        )
        assert revoked.status_code == 200, revoked.text
        assert "payroll" not in revoked.json()["allowed_topics"]


async def test_a_malformed_target_answers_absent_rather_than_crashing(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """`uuid.UUID('not-a-uuid')` raised through the service and surfaced as a 500 with a traceback —
    a third response class, emitted before the membership lookup and free to observe."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    _, token = await _principal(
        harness, project, project_role="project-admin", topics=("general", "payroll")
    )
    headers = {"Authorization": f"Bearer {token}"}

    async with _client(harness, tmp_path) as client:
        for response in (
            await client.post(
                "/api/v1/admin/memberships",
                json={"user_id": "../../etc/passwd", "role": "member"},
                headers=headers,
            ),
            await client.delete("/api/v1/admin/memberships/not-a-uuid", headers=headers),
            await client.post(
                "/api/v1/admin/topics/general/grants", json={"user_id": "x"}, headers=headers
            ),
            await client.delete("/api/v1/admin/topics/general/grants/x", headers=headers),
        ):
            assert response.status_code == 404, (
                f"a malformed identifier returned {response.status_code}; it must be absent, not an "
                "error that confirms the route"
            )


async def test_a_duplicate_membership_answers_conflict(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    _, token = await _principal(harness, project, project_role="project-admin", topics=("general",))
    existing, _ = await _principal(harness, project, project_role="member", topics=())
    headers = {"Authorization": f"Bearer {token}"}

    async with _client(harness, tmp_path) as client:
        response = await client.post(
            "/api/v1/admin/memberships",
            json={"user_id": existing, "role": "member"},
            headers=headers,
        )
    assert response.status_code == 409, response.text


async def test_a_plain_member_reaches_none_of_the_authority_routes(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """The deny side: authority mutation is project administration, not membership."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    member, token = await _principal(
        harness, project, project_role="member", topics=("general", "payroll")
    )
    headers = {"Authorization": f"Bearer {token}"}

    async with _client(harness, tmp_path) as client:
        for response in (
            await client.post(
                "/api/v1/admin/memberships",
                json={"user_id": member, "role": "member"},
                headers=headers,
            ),
            await client.post(
                "/api/v1/admin/topics/payroll/grants", json={"user_id": member}, headers=headers
            ),
            await client.delete(f"/api/v1/admin/topics/payroll/grants/{member}", headers=headers),
            await client.delete(f"/api/v1/admin/memberships/{member}", headers=headers),
        ):
            assert response.status_code == 403, (
                f"a plain member reached an authority route ({response.status_code})"
            )
