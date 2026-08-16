"""RED HTTP contracts for complete console governance lifecycles (T005).

The dashboard must be able to complete an operation and present its authoritative result; a route
that only exposes a list or a decorative control is not a lifecycle.  These tests therefore pin
server-owned versions, before/after state, dependency impact, secret-once credentials, conflicts,
revocation, and audit correlation through the real ASGI app and Postgres identity store.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import httpx

from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.identity.service import IdentityService
from tests.integration.conftest import Harness, unique_slug

_PASSWORD = "correct horse battery staple"  # Integration fixture only.


def _client(harness: Harness, tmp_path: Path) -> httpx.AsyncClient:
    app = create_app(
        deps=ApiDeps(sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path))
    )
    # Missing conflict handlers are a contract failure (500), not a transport exception that masks
    # the remaining lifecycle responses we need to observe in the same test.
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://test",
    )


async def _active_user(
    identity: IdentityService, *, platform_role: str = "member"
) -> tuple[str, str]:
    email = f"{unique_slug('governance-user')}@example.com"
    invitation = await identity.invite_user(email, role=platform_role)
    user_id = await identity.accept_invitation(invitation.token, _PASSWORD)
    return email, user_id


async def _admin_session(
    harness: Harness, client: httpx.AsyncClient, project_id: str
) -> tuple[dict[str, str], str, str]:
    identity = IdentityService(harness.sm)
    email, user_id = await _active_user(identity, platform_role="owner")
    await identity.add_membership(
        user_id,
        project_id,
        role="project-admin",
        allowed_topics=("general",),
    )
    login = await client.post("/api/v1/auth/login", json={"email": email, "password": _PASSWORD})
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['session_token']}"}, email, user_id


def _record_status(
    failures: list[str], label: str, response: httpx.Response, expected: int
) -> None:
    if response.status_code != expected:
        try:
            payload = response.json()
        except ValueError:
            shape = f"body_type={response.headers.get('content-type', 'unknown')}"
        else:
            shape = (
                f"keys={sorted(payload)}"
                if isinstance(payload, dict)
                else f"body_type={type(payload).__name__}"
            )
        failures.append(f"{label}: expected {expected}, got {response.status_code}; {shape}")


def _require_keys(failures: list[str], label: str, payload: object, required: set[str]) -> None:
    if not isinstance(payload, dict):
        failures.append(f"{label}: expected object, got {type(payload).__name__}")
        return
    missing = required - set(payload)
    if missing:
        failures.append(f"{label}: missing {sorted(missing)}; available keys={sorted(payload)}")


async def test_project_lifecycle_exposes_version_impact_protection_and_audit(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    admin_slug = unique_slug("governance-admin")
    admin_project = await harness.setup_project(admin_slug, [("general", 0)])
    identity = IdentityService(harness.sm)
    await identity.ensure_default_project()
    target_slug = unique_slug("lifecycle")

    async with _client(harness, tmp_path) as client:
        headers, _, _ = await _admin_session(harness, client, admin_project)
        created = await client.post(
            f"/api/v1/admin/projects?project={admin_slug}",
            headers=headers,
            json={"slug": target_slug, "name": "Lifecycle"},
        )
        duplicate = await client.post(
            f"/api/v1/admin/projects?project={admin_slug}",
            headers=headers,
            json={"slug": target_slug, "name": "Duplicate"},
        )
        inventory = await client.get("/api/v1/admin/projects", headers=headers)
        renamed = await client.patch(
            f"/api/v1/admin/projects/{target_slug}",
            headers=headers,
            json={
                "expected_version": 1,
                "name": "Lifecycle renamed",
                "settings": {"retention_days": 30},
            },
        )
        stale = await client.patch(
            f"/api/v1/admin/projects/{target_slug}",
            headers=headers,
            json={"expected_version": 1, "name": "Stale overwrite"},
        )
        impact = await client.get(
            f"/api/v1/admin/projects/{target_slug}/delete-impact", headers=headers
        )
        default_impact = await client.get(
            "/api/v1/admin/projects/default/delete-impact", headers=headers
        )
        default_delete = await client.delete(
            "/api/v1/admin/projects/default",
            headers=headers,
            params={"expected_version": 1, "confirm": "default"},
        )
        removed = await client.delete(
            f"/api/v1/admin/projects/{target_slug}",
            headers=headers,
            params={"expected_version": 2, "confirm": target_slug},
        )

    failures: list[str] = []
    for label, response, expected in (
        ("create", created, 201),
        ("duplicate conflict", duplicate, 409),
        ("global inventory", inventory, 200),
        ("rename/settings", renamed, 200),
        ("stale version", stale, 409),
        ("delete impact", impact, 200),
        ("default impact", default_impact, 200),
        ("default protection", default_delete, 409),
        ("confirmed delete", removed, 200),
    ):
        _record_status(failures, label, response, expected)
    if created.status_code == 201:
        _require_keys(failures, "create", created.json(), {"project", "audit_correlation"})
    if inventory.status_code == 200:
        projects = inventory.json().get("projects")
        if not isinstance(projects, list) or not all(isinstance(item, dict) for item in projects):
            failures.append("global inventory: projects must be versioned metadata objects")
    if renamed.status_code == 200:
        _require_keys(failures, "rename", renamed.json(), {"before", "after", "audit_correlation"})
    if impact.status_code == 200:
        _require_keys(
            failures,
            "delete impact",
            impact.json(),
            {"project", "version", "dependencies", "can_delete", "confirmation"},
        )
    if default_impact.status_code == 200 and default_impact.json().get("can_delete") is not False:
        failures.append("default impact: protected project must report can_delete=false")
    if removed.status_code == 200:
        _require_keys(failures, "delete", removed.json(), {"deleted", "audit_correlation"})
    assert not failures, "\n".join(failures)


async def test_user_directory_invite_reset_and_disable_are_authoritative(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    project_slug = unique_slug("users")
    project_id = await harness.setup_project(project_slug, [("general", 0)])
    invited_email = f"{unique_slug('invite')}@example.com"

    async with _client(harness, tmp_path) as client:
        headers, _, _ = await _admin_session(harness, client, project_id)
        invited = await client.post(
            f"/api/v1/admin/users/invite?project={project_slug}",
            headers=headers,
            json={"email": invited_email, "role": "member"},
        )
        invited_id = (
            invited.json().get("user_id", "missing") if invited.status_code == 201 else "missing"
        )
        directory = await client.get(
            f"/api/v1/admin/users?project={project_slug}&limit=25", headers=headers
        )
        reset = await client.post(
            f"/api/v1/admin/users/{invited_id}/password-reset?project={project_slug}",
            headers=headers,
            json={"impact_acknowledged": True},
        )
        disabled = await client.post(
            f"/api/v1/admin/users/{invited_id}/disable?project={project_slug}",
            headers=headers,
            json={"impact_acknowledged": True, "expected_status": "invited"},
        )
        after = await client.get(
            f"/api/v1/admin/users?project={project_slug}&limit=25", headers=headers
        )

    failures: list[str] = []
    for label, response, expected in (
        ("invite", invited, 201),
        ("directory", directory, 200),
        ("password reset", reset, 201),
        ("disable", disabled, 200),
        ("directory after disable", after, 200),
    ):
        _record_status(failures, label, response, expected)
    if invited.status_code == 201:
        _require_keys(
            failures,
            "invite",
            invited.json(),
            {"user", "invitation_token", "audit_correlation"},
        )
    if directory.status_code == 200:
        _require_keys(
            failures, "directory", directory.json(), {"items", "next_cursor", "freshness"}
        )
        if "invitation_token" in directory.text or "password" in directory.text:
            failures.append("directory: secret/reset material was repeated")
    if reset.status_code == 201:
        _require_keys(
            failures,
            "password reset",
            reset.json(),
            {"reset_token", "expires_at", "audit_correlation"},
        )
    if disabled.status_code == 200:
        _require_keys(
            failures,
            "disable",
            disabled.json(),
            {"identity", "revocation", "audit_correlation"},
        )
        if disabled.json().get("revocation", {}).get("complete") is not True:
            failures.append("disable: response must authoritatively confirm revocation completion")
    assert not failures, "\n".join(failures)


async def test_third_party_credentials_are_secret_once_rotatable_and_revocable(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    project_slug = unique_slug("credentials")
    project_id = await harness.setup_project(project_slug, [("general", 0)])
    identity = IdentityService(harness.sm)
    _, target_id = await _active_user(identity)
    membership_id = await identity.add_membership(
        target_id, project_id, role="member", allowed_topics=("general",)
    )
    rotate_target = await identity.issue_pat(membership_id, name="rotate-me")
    revoke_target = await identity.issue_pat(membership_id, name="revoke-me")

    async with _client(harness, tmp_path) as client:
        headers, _, _ = await _admin_session(harness, client, project_id)
        before = await client.get(
            f"/api/v1/admin/users/{target_id}/credentials?project={project_slug}", headers=headers
        )
        created = await client.post(
            f"/api/v1/admin/users/{target_id}/credentials?project={project_slug}",
            headers=headers,
            json={"name": "console-created", "kind": "pat"},
        )
        rotated = await client.post(
            f"/api/v1/admin/credentials/{rotate_target.id}/rotate?project={project_slug}",
            headers=headers,
            json={"expected_state": "active"},
        )
        revoked = await client.delete(
            f"/api/v1/admin/credentials/{revoke_target.id}?project={project_slug}", headers=headers
        )
        after = await client.get(
            f"/api/v1/admin/users/{target_id}/credentials?project={project_slug}", headers=headers
        )
        revoked_probe = await client.get(
            "/api/v1/admin/topics",
            headers={"Authorization": f"Bearer {revoke_target.token}"},
        )

    failures: list[str] = []
    for label, response, expected in (
        ("credential list", before, 200),
        ("create", created, 201),
        ("rotate", rotated, 201),
        ("revoke", revoked, 200),
        ("credential list after", after, 200),
        ("revoked credential probe", revoked_probe, 401),
    ):
        _record_status(failures, label, response, expected)
    for label, response in (("create", created), ("rotate", rotated)):
        if response.status_code == 201:
            _require_keys(
                failures,
                label,
                response.json(),
                {"credential", "secret", "audit_correlation"},
            )
    for label, response in (("list", before), ("list after", after)):
        if response.status_code == 200 and any(
            marker in response.text for marker in ("token_hash", "access_token", "secret")
        ):
            failures.append(f"{label}: credential material escaped the secret-once response")
    if revoked.status_code == 200:
        _require_keys(
            failures,
            "revoke",
            revoked.json(),
            {"credential", "inactive", "audit_correlation"},
        )
    assert not failures, "\n".join(failures)


async def test_membership_and_topic_mutations_return_before_after_and_conflicts(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    project_slug = unique_slug("permissions")
    project_id = await harness.setup_project(project_slug, [("general", 0)])
    identity = IdentityService(harness.sm)
    _, target_id = await _active_user(identity)
    topic_slug = unique_slug("sensitive")

    async with _client(harness, tmp_path) as client:
        headers, _, _ = await _admin_session(harness, client, project_id)
        membership = await client.post(
            f"/api/v1/admin/memberships?project={project_slug}",
            headers=headers,
            json={"user_id": target_id, "role": "viewer", "can_curate": False},
        )
        duplicate_membership = await client.post(
            f"/api/v1/admin/memberships?project={project_slug}",
            headers=headers,
            json={"user_id": target_id, "role": "member", "can_curate": False},
        )
        changed = await client.patch(
            f"/api/v1/admin/memberships/{target_id}?project={project_slug}",
            headers=headers,
            json={
                "expected_version": 1,
                "role": "member",
                "allowed_topics": [],
                "can_curate": True,
            },
        )
        stale_membership = await client.patch(
            f"/api/v1/admin/memberships/{target_id}?project={project_slug}",
            headers=headers,
            json={"expected_version": 1, "role": "project-admin"},
        )
        topic = await client.post(
            f"/api/v1/admin/topics?project={project_slug}",
            headers=headers,
            json={"slug": topic_slug, "name": "Sensitive", "sensitivity": 4},
        )
        duplicate_topic = await client.post(
            f"/api/v1/admin/topics?project={project_slug}",
            headers=headers,
            json={"slug": topic_slug, "name": "Duplicate", "sensitivity": 0},
        )
        edited_topic = await client.patch(
            f"/api/v1/admin/topics/{topic_slug}?project={project_slug}",
            headers=headers,
            json={"expected_version": 1, "name": "Highly sensitive", "sensitivity": 5},
        )
        stale_topic = await client.patch(
            f"/api/v1/admin/topics/{topic_slug}?project={project_slug}",
            headers=headers,
            json={"expected_version": 1, "sensitivity": 1},
        )
        memberships = await client.get(
            f"/api/v1/admin/memberships?project={project_slug}", headers=headers
        )
        topics = await client.get(f"/api/v1/admin/topics?project={project_slug}", headers=headers)

    failures: list[str] = []
    for label, response, expected in (
        ("create membership", membership, 201),
        ("duplicate membership", duplicate_membership, 409),
        ("change membership", changed, 200),
        ("stale membership", stale_membership, 409),
        ("create topic", topic, 201),
        ("duplicate topic", duplicate_topic, 409),
        ("edit topic", edited_topic, 200),
        ("stale topic", stale_topic, 409),
        ("list memberships", memberships, 200),
        ("list topics", topics, 200),
    ):
        _record_status(failures, label, response, expected)
    for label, response in (("membership change", changed), ("topic edit", edited_topic)):
        if response.status_code == 200:
            _require_keys(
                failures,
                label,
                response.json(),
                {"before", "after", "audit_correlation"},
            )
    if membership.status_code == 201:
        _require_keys(
            failures,
            "membership create",
            membership.json(),
            {"membership", "audit_correlation"},
        )
    if memberships.status_code == 200:
        target = next(
            (
                item
                for item in memberships.json().get("memberships", [])
                if item.get("user_id") == target_id
            ),
            None,
        )
        if target is None or target.get("allowed_topics") != []:
            failures.append("membership default: new authority must start with no topics")
    if topics.status_code == 200:
        item = next(
            (
                candidate
                for candidate in topics.json().get("topics", [])
                if candidate.get("slug") == topic_slug
            ),
            None,
        )
        if not isinstance(item, dict) or not {"name", "sensitivity", "version"} <= set(item):
            failures.append("topic list: versioned taxonomy metadata missing")
    assert not failures, "\n".join(failures)
