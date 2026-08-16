"""RED HTTP contracts for complete console-governance lifecycles (T005).

The tests intentionally describe the management API that the console needs, rather than accepting
today's partial routes.  They keep all setup and probes real (ASGI + Postgres): a missing endpoint
therefore reports an assertion failure, never a fixture, JSON-shape, or resolver exception.

The login rate limiter is deliberately not asserted here.  It applies to the unauthenticated
``/auth/login`` lane, not to management commands, and its budget/429 behaviour is already owned by
``tests/permissions_suite/test_login_and_proxy_trust.py``.  This contract must not manufacture a
second, unrelated management limiter merely to obtain a 429.
"""

from __future__ import annotations

import datetime as dt
import time
import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import TypedDict

import httpx
import pytest
from sqlalchemy import select

from rsc_brain import security
from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.audit import query_audit_raw
from rsc_brain.identity.resolve import resolve_scope
from rsc_brain.identity.service import IdentityService
from rsc_brain.identity.sessions import resolve_session
from rsc_brain.stores.relational import models
from tests.integration.conftest import Harness, unique_slug

_PASSWORD = "correct horse battery staple"  # Integration fixture only.

pytestmark = pytest.mark.integration


class UserShape(TypedDict):
    id: str


@dataclass(frozen=True, slots=True)
class ActiveUser:
    """One fixture shape everywhere: callers use ``actor.user[\"id\"]`` only."""

    email: str
    user: UserShape


def _client(harness: Harness, tmp_path: Path) -> httpx.AsyncClient:
    app = create_app(
        deps=ApiDeps(sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path))
    )
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://test",
    )


async def _active_user(identity: IdentityService, *, platform_role: str = "member") -> ActiveUser:
    email = f"{unique_slug('governance-user')}@example.com"
    invitation = await identity.invite_user(email, role=platform_role)
    return ActiveUser(
        email=email,
        user={"id": await identity.accept_invitation(invitation.token, _PASSWORD)},
    )


async def _session(client: httpx.AsyncClient, actor: ActiveUser) -> tuple[dict[str, str], str]:
    login = await client.post(
        "/api/v1/auth/login", json={"email": actor.email, "password": _PASSWORD}
    )
    assert login.status_code == 200
    payload = login.json()
    assert isinstance(payload, dict) and isinstance(payload.get("session_token"), str)
    token = payload["session_token"]
    return {"Authorization": f"Bearer {token}"}, token


async def _actor_with_membership(
    identity: IdentityService,
    client: httpx.AsyncClient,
    project_id: str,
    *,
    platform_role: str = "member",
    project_role: str = "member",
    can_curate: bool = False,
    allowed_topics: tuple[str, ...] = ("general",),
) -> tuple[ActiveUser, dict[str, str], str]:
    actor = await _active_user(identity, platform_role=platform_role)
    await identity.add_membership(
        actor.user["id"],
        project_id,
        role=project_role,
        can_curate=can_curate,
        allowed_topics=allowed_topics,
    )
    headers, session_token = await _session(client, actor)
    return actor, headers, session_token


def _object(response: httpx.Response) -> dict[str, object] | None:
    try:
        payload = response.json()
    except ValueError:
        return None
    return payload if isinstance(payload, dict) else None


def _status(failures: list[str], label: str, response: httpx.Response, expected: int) -> None:
    if response.status_code != expected:
        payload = _object(response)
        shape = f"keys={sorted(payload)}" if payload is not None else "non-object response"
        failures.append(f"{label}: expected HTTP {expected}, got {response.status_code} ({shape})")


def _required(
    failures: list[str], label: str, response: httpx.Response, keys: set[str]
) -> dict[str, object] | None:
    payload = _object(response)
    if payload is None:
        failures.append(f"{label}: response must be an object")
        return None
    missing = keys - set(payload)
    if missing:
        failures.append(f"{label}: missing fields {sorted(missing)}")
        return None
    return payload


def _int_field(
    failures: list[str], label: str, payload: dict[str, object] | None, name: str
) -> int | None:
    value = payload.get(name) if payload is not None else None
    if not isinstance(value, int):
        failures.append(f"{label}: {name} must be an integer server version")
        return None
    return value


def _value(
    failures: list[str], label: str, payload: dict[str, object] | None, name: str
) -> object | None:
    if payload is None or name not in payload:
        failures.append(f"{label}: missing {name}")
        return None
    return payload[name]


def _contains_secret(responses: Iterable[httpx.Response], secrets: Iterable[str]) -> bool:
    values = tuple(value for value in secrets if value)
    return any(any(value in response.text for value in values) for response in responses)


async def _issue_oauth(harness: Harness, membership_id: str, token: str) -> None:
    async with harness.sm() as session:
        client = models.OAuthClient(client_id=f"contract-{uuid.uuid4().hex}", client_metadata={})
        session.add(client)
        await session.flush()
        session.add(
            models.OAuthToken(
                membership_id=uuid.UUID(membership_id),
                client_id=client.id,
                access_token_hash=security.token_hash(token),
                expires_at=dt.datetime.now(dt.UTC) + dt.timedelta(hours=1),
            )
        )
        await session.commit()


async def _user_status(harness: Harness, user_id: str) -> str | None:
    async with harness.sm() as session:
        value = await session.scalar(
            select(models.User.status).where(models.User.id == uuid.UUID(user_id))
        )
    return value if isinstance(value, str) else None


async def _audit_correlation_exists(harness: Harness, project_id: str, correlation: str) -> bool:
    # The internal audit query is an oracle only.  The contract requires the public response to
    # correlate to a persisted audit row, not just emit a decorative non-empty string.
    rows = await query_audit_raw(harness.sm, project_id, limit=500)
    return any(row.get("id") == correlation for row in rows)


async def _require_audit_correlation(
    failures: list[str],
    label: str,
    harness: Harness,
    project_id: str,
    payload: dict[str, object] | None,
) -> None:
    correlation = _value(failures, label, payload, "audit_correlation")
    if not isinstance(correlation, str) or not correlation:
        failures.append(f"{label}: audit correlation must be non-empty")
    elif not await _audit_correlation_exists(harness, project_id, correlation):
        failures.append(f"{label}: audit correlation must identify a persisted audit record")


async def test_actor_matrix_separates_platform_and_project_authority(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    project_slug = unique_slug("actor-matrix")
    project_id = await harness.setup_project(project_slug, [("general", 0)])
    foreign_slug = unique_slug("foreign")
    await harness.setup_project(foreign_slug, [("general", 0)])
    identity = IdentityService(harness.sm)

    async with _client(harness, tmp_path) as client:
        owner_without_membership = await _active_user(identity, platform_role="owner")
        owner_headers, _ = await _session(client, owner_without_membership)
        _, admin_headers, _ = await _actor_with_membership(
            identity, client, project_id, project_role="project-admin"
        )
        _, member_headers, _ = await _actor_with_membership(identity, client, project_id)
        _, curator_headers, _ = await _actor_with_membership(
            identity, client, project_id, can_curate=True
        )
        _, viewer_headers, _ = await _actor_with_membership(
            identity, client, project_id, project_role="viewer"
        )

        platform_create = await client.post(
            "/api/v1/admin/projects",
            headers=owner_headers,
            json={"slug": unique_slug("owner-platform"), "name": "Owner platform project"},
        )
        owner_project_content = await client.post(
            f"/api/v1/admin/topics?project={project_slug}",
            headers=owner_headers,
            json={"slug": unique_slug("owner-content"), "name": "must stay hidden"},
        )
        admin_project_content = await client.post(
            f"/api/v1/admin/topics?project={project_slug}",
            headers=admin_headers,
            json={"slug": unique_slug("admin-content"), "name": "project control"},
        )
        curator_mutation = await client.post(
            f"/api/v1/admin/topics?project={project_slug}",
            headers=curator_headers,
            json={"slug": unique_slug("curator-write"), "name": "no admin write"},
        )
        member_mutation = await client.post(
            f"/api/v1/admin/topics?project={project_slug}",
            headers=member_headers,
            json={"slug": unique_slug("member-write"), "name": "no admin write"},
        )
        viewer_mutation = await client.post(
            f"/api/v1/admin/topics?project={project_slug}",
            headers=viewer_headers,
            json={"slug": unique_slug("viewer-write"), "name": "no admin write"},
        )
        foreign_project = await client.post(
            f"/api/v1/admin/topics?project={foreign_slug}",
            headers=admin_headers,
            json={"slug": unique_slug("foreign-write"), "name": "foreign"},
        )
        rejected_credential = await client.post(
            f"/api/v1/admin/topics?project={project_slug}",
            headers={"Authorization": "Bearer rejected-credential"},
            json={"slug": unique_slug("rejected-write"), "name": "rejected"},
        )
        malformed_role = await client.post(
            f"/api/v1/admin/memberships?project={project_slug}",
            headers=admin_headers,
            json={"user_id": owner_without_membership.user["id"], "role": "not-a-project-role"},
        )

    failures: list[str] = []
    for label, response, expected in (
        ("owner without membership creates platform project", platform_create, 201),
        ("owner without membership cannot mutate project content", owner_project_content, 404),
        ("project-admin mutates its project", admin_project_content, 201),
        ("curator cannot mutate project configuration", curator_mutation, 403),
        ("member cannot mutate project configuration", member_mutation, 403),
        ("viewer cannot mutate project configuration", viewer_mutation, 403),
        ("project-admin cannot reach foreign project", foreign_project, 404),
        ("rejected credential", rejected_credential, 401),
        ("bad membership role", malformed_role, 400),
    ):
        _status(failures, label, response, expected)
    assert not failures, "\n".join(failures)


async def test_project_lifecycle_uses_response_versions_impact_and_real_delete(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    control_slug = unique_slug("project-control")
    control_id = await harness.setup_project(control_slug, [("general", 0)])
    target_slug = unique_slug("project-lifecycle")
    target_id = await harness.setup_project(target_slug, [("known-topic", 4)])
    identity = IdentityService(harness.sm)
    await identity.ensure_default_project()

    async with _client(harness, tmp_path) as client:
        _, headers, _ = await _actor_with_membership(
            identity, client, control_id, project_role="project-admin"
        )
        before = await client.get(f"/api/v1/admin/projects/{target_slug}", headers=headers)
        before_payload = _object(before)
        old_version = _int_field([], "project read", before_payload, "version")
        update = await client.patch(
            f"/api/v1/admin/projects/{target_slug}",
            headers=headers,
            json={
                "expected_version": old_version if old_version is not None else -1,
                "name": "Lifecycle renamed",
                "settings": {"retention_days": 30},
            },
        )
        update_payload = _object(update)
        current_version = _int_field([], "project update", update_payload, "version")
        stale = await client.patch(
            f"/api/v1/admin/projects/{target_slug}",
            headers=headers,
            json={
                "expected_version": old_version if old_version is not None else -1,
                "name": "stale",
            },
        )
        reread = await client.get(f"/api/v1/admin/projects/{target_slug}", headers=headers)
        impact = await client.get(
            f"/api/v1/admin/projects/{target_slug}/delete-impact", headers=headers
        )
        default_impact = await client.get(
            "/api/v1/admin/projects/default/delete-impact", headers=headers
        )
        default_delete = await client.delete(
            "/api/v1/admin/projects/default",
            headers=headers,
            params={"expected_version": 0, "confirm": "default"},
        )
        removed = await client.delete(
            f"/api/v1/admin/projects/{target_slug}",
            headers=headers,
            params={
                "expected_version": current_version if current_version is not None else -1,
                "confirm": target_slug,
            },
        )
        after_delete = await client.get(f"/api/v1/admin/projects/{target_slug}", headers=headers)

    failures: list[str] = []
    for label, response, expected in (
        ("project reread before mutation", before, 200),
        ("project update", update, 200),
        ("stale project update", stale, 409),
        ("project reread after mutation", reread, 200),
        ("delete impact", impact, 200),
        ("default delete impact", default_impact, 200),
        ("default project protection", default_delete, 409),
        ("confirmed project delete", removed, 200),
        ("deleted project is absent", after_delete, 404),
    ):
        _status(failures, label, response, expected)
    before_payload = _required(failures, "project before", before, {"slug", "name", "version"})
    updated = _required(
        failures, "project update", update, {"before", "after", "version", "audit_correlation"}
    )
    reread_payload = _required(
        failures, "project reread", reread, {"slug", "name", "settings", "version"}
    )
    old_version = _int_field(failures, "project before", before_payload, "version")
    current_version = _int_field(failures, "project update", updated, "version")
    if old_version is not None and current_version is not None and current_version <= old_version:
        failures.append(
            "project update: current version must advance from the response's old version"
        )
    if reread_payload is not None and reread_payload.get("name") != "Lifecycle renamed":
        failures.append("project reread: successful update was not persisted")
    impact_payload = _required(
        failures,
        "delete impact",
        impact,
        {"project", "version", "dependencies", "can_delete", "confirmation"},
    )
    if impact_payload is not None:
        dependencies = impact_payload.get("dependencies")
        if not isinstance(dependencies, dict) or dependencies.get("topics") != 1:
            failures.append("delete impact: known seeded topic count must be reported as topics=1")
        if (
            impact_payload.get("confirmation") != target_slug
            or impact_payload.get("can_delete") is not True
        ):
            failures.append(
                "delete impact: confirmation and can_delete must match the known target"
            )
    protected = _required(
        failures, "default delete impact", default_impact, {"can_delete", "confirmation"}
    )
    if protected is not None and protected.get("can_delete") is not False:
        failures.append("default delete impact: default project must be protected")
    await _require_audit_correlation(failures, "project update", harness, target_id, updated)
    if (
        target_id == control_id
    ):  # Defensive invariant: a fixture bug must not make delete destructive.
        failures.append("fixture projects must be distinct")
    assert not failures, "\n".join(failures)


async def test_disable_active_user_revokes_session_pat_and_oauth_within_five_seconds(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    project_slug = unique_slug("disable")
    project_id = await harness.setup_project(project_slug, [("general", 0)])
    identity = IdentityService(harness.sm)
    target = await _active_user(identity)
    membership_id = await identity.add_membership(
        target.user["id"], project_id, role="member", allowed_topics=("general",)
    )
    pat = await identity.issue_pat(membership_id, name="disable-contract")
    oauth_token = f"oauth-{uuid.uuid4().hex}"
    await _issue_oauth(harness, membership_id, oauth_token)
    assert await _user_status(harness, target.user["id"]) == "active"

    async with _client(harness, tmp_path) as client:
        target_headers, target_session = await _session(client, target)
        assert target_headers["Authorization"].endswith(target_session)
        _, admin_headers, _ = await _actor_with_membership(
            identity, client, project_id, project_role="project-admin"
        )
        # These are controls, not a simulated/no-op disable: all three credentials are live first.
        assert await resolve_session(harness.sm, target_session) is not None
        assert await resolve_scope(harness.sm, pat.token) is not None
        assert await resolve_scope(harness.sm, oauth_token) is not None
        reset_active = await client.post(
            f"/api/v1/admin/users/{target.user['id']}/password-reset?project={project_slug}",
            headers=admin_headers,
            json={"impact_acknowledged": True},
        )
        started = time.monotonic()
        disabled = await client.post(
            f"/api/v1/admin/users/{target.user['id']}/disable?project={project_slug}",
            headers=admin_headers,
            json={"expected_status": "active", "impact_acknowledged": True},
        )
        elapsed = time.monotonic() - started

    failures: list[str] = []
    _status(failures, "reset active user", reset_active, 201)
    reset_payload = _required(
        failures,
        "reset active user",
        reset_active,
        {"reset_token", "expires_at", "audit_correlation"},
    )
    await _require_audit_correlation(
        failures, "reset active user", harness, project_id, reset_payload
    )
    _status(failures, "disable active user", disabled, 200)
    payload = _required(
        failures, "disable", disabled, {"identity", "revocation", "audit_correlation"}
    )
    if payload is not None:
        if await _user_status(harness, target.user["id"]) != "disabled":
            failures.append("disable: database user status must become disabled")
        revocation = payload.get("revocation")
        if not isinstance(revocation, dict) or revocation.get("complete") is not True:
            failures.append("disable: response must confirm complete credential revocation")
        if elapsed >= 5.0:
            failures.append("disable: HTTP mutation and resolver checks exceeded five seconds")
        if await resolve_session(harness.sm, target_session) is not None:
            failures.append("disable: prior console session still resolves")
        if await resolve_scope(harness.sm, pat.token) is not None:
            failures.append("disable: prior PAT still resolves")
        if await resolve_scope(harness.sm, oauth_token) is not None:
            failures.append("disable: prior OAuth access token still resolves")
        await _require_audit_correlation(failures, "disable", harness, project_id, payload)
    assert not failures, "\n".join(failures)


async def test_credentials_are_secret_once_rotatable_revocable_and_audited(
    build_harness: Callable[..., Harness], tmp_path: Path, caplog: object
) -> None:
    harness = build_harness()
    project_slug = unique_slug("credentials")
    project_id = await harness.setup_project(project_slug, [("general", 0)])
    identity = IdentityService(harness.sm)
    target = await _active_user(identity)
    membership_id = await identity.add_membership(
        target.user["id"], project_id, role="member", allowed_topics=("general",)
    )
    rotate_target = await identity.issue_pat(membership_id, name="rotate-contract")
    revoke_target = await identity.issue_pat(membership_id, name="revoke-contract")

    async with _client(harness, tmp_path) as client:
        _, admin_headers, _ = await _actor_with_membership(
            identity, client, project_id, project_role="project-admin"
        )
        before = await client.get(
            f"/api/v1/admin/users/{target.user['id']}/credentials?project={project_slug}",
            headers=admin_headers,
        )
        created = await client.post(
            f"/api/v1/admin/users/{target.user['id']}/credentials?project={project_slug}",
            headers=admin_headers,
            json={"name": "console-created", "kind": "pat"},
        )
        rotated = await client.post(
            f"/api/v1/admin/credentials/{rotate_target.id}/rotate?project={project_slug}",
            headers=admin_headers,
            json={"expected_state": "active"},
        )
        revoked = await client.delete(
            f"/api/v1/admin/credentials/{revoke_target.id}?project={project_slug}",
            headers=admin_headers,
        )
        revoke_again = await client.delete(
            f"/api/v1/admin/credentials/{revoke_target.id}?project={project_slug}",
            headers=admin_headers,
        )
        after = await client.get(
            f"/api/v1/admin/users/{target.user['id']}/credentials?project={project_slug}",
            headers=admin_headers,
        )

    failures: list[str] = []
    for label, response, expected in (
        ("credential list", before, 200),
        ("credential create", created, 201),
        ("credential rotate", rotated, 201),
        ("credential revoke", revoked, 200),
        ("credential revoke idempotency", revoke_again, 200),
        ("credential reread", after, 200),
    ):
        _status(failures, label, response, expected)
    created_payload = _required(
        failures, "credential create", created, {"credential", "secret", "audit_correlation"}
    )
    rotated_payload = _required(
        failures, "credential rotate", rotated, {"credential", "secret", "audit_correlation"}
    )
    created_secret = _value(failures, "credential create", created_payload, "secret")
    rotated_secret = _value(failures, "credential rotate", rotated_payload, "secret")
    if not isinstance(created_secret, str) or not created_secret:
        failures.append("credential create: emitted secret must be non-empty")
    if not isinstance(rotated_secret, str) or not rotated_secret:
        failures.append("credential rotate: emitted secret must be non-empty")
    if isinstance(rotated_secret, str) and rotated_secret == rotate_target.token:
        failures.append("credential rotate: new secret must differ from the old secret")
    if isinstance(rotated_secret, str):
        if await resolve_scope(harness.sm, rotate_target.token) is not None:
            failures.append("credential rotate: old credential must stop resolving")
        if await resolve_scope(harness.sm, rotated_secret) is None:
            failures.append("credential rotate: new credential must resolve")
    if await resolve_scope(harness.sm, revoke_target.token) is not None:
        failures.append("credential revoke: revoked credential must stop resolving")
    exposed = [rotate_target.token, revoke_target.token]
    if isinstance(created_secret, str):
        exposed.append(created_secret)
    if isinstance(rotated_secret, str):
        exposed.append(rotated_secret)
    if _contains_secret((before, after, revoked, revoke_again), exposed):
        failures.append(
            "credential secret-once: credential value escaped a subsequent/list response"
        )
    caplog_text = getattr(caplog, "text", "")
    if isinstance(caplog_text, str) and any(value in caplog_text for value in exposed):
        failures.append("credential secret-once: credential value escaped diagnostics")
    await _require_audit_correlation(
        failures, "credential create", harness, project_id, created_payload
    )
    await _require_audit_correlation(
        failures, "credential rotate", harness, project_id, rotated_payload
    )
    assert not failures, "\n".join(failures)


async def test_membership_and_topic_transitions_use_current_versions_and_exact_rereads(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    project_slug = unique_slug("permissions")
    project_id = await harness.setup_project(project_slug, [("general", 0)])
    identity = IdentityService(harness.sm)
    target = await _active_user(identity)
    topic_slug = unique_slug("sensitive")

    async with _client(harness, tmp_path) as client:
        _, admin_headers, _ = await _actor_with_membership(
            identity, client, project_id, project_role="project-admin"
        )
        membership = await client.post(
            f"/api/v1/admin/memberships?project={project_slug}",
            headers=admin_headers,
            json={"user_id": target.user["id"], "role": "viewer", "can_curate": False},
        )
        memberships_after_create = await client.get(
            f"/api/v1/admin/memberships?project={project_slug}", headers=admin_headers
        )
        membership_payload = _object(membership)
        membership_version = _int_field([], "membership create", membership_payload, "version")
        changed = await client.patch(
            f"/api/v1/admin/memberships/{target.user['id']}?project={project_slug}",
            headers=admin_headers,
            json={
                "expected_version": membership_version if membership_version is not None else -1,
                "role": "member",
                "allowed_topics": ["general"],
                "can_curate": True,
            },
        )
        stale_membership = await client.patch(
            f"/api/v1/admin/memberships/{target.user['id']}?project={project_slug}",
            headers=admin_headers,
            json={
                "expected_version": membership_version if membership_version is not None else -1,
                "role": "project-admin",
            },
        )
        memberships_after_stale = await client.get(
            f"/api/v1/admin/memberships?project={project_slug}", headers=admin_headers
        )
        topic = await client.post(
            f"/api/v1/admin/topics?project={project_slug}",
            headers=admin_headers,
            json={"slug": topic_slug, "name": "Sensitive", "sensitivity": 4},
        )
        topics_after_create = await client.get(
            f"/api/v1/admin/topics?project={project_slug}", headers=admin_headers
        )
        topic_payload = _object(topic)
        topic_version = _int_field([], "topic create", topic_payload, "version")
        edited_topic = await client.patch(
            f"/api/v1/admin/topics/{topic_slug}?project={project_slug}",
            headers=admin_headers,
            json={
                "expected_version": topic_version if topic_version is not None else -1,
                "name": "Highly sensitive",
                "sensitivity": 5,
            },
        )
        stale_topic = await client.patch(
            f"/api/v1/admin/topics/{topic_slug}?project={project_slug}",
            headers=admin_headers,
            json={
                "expected_version": topic_version if topic_version is not None else -1,
                "sensitivity": 1,
            },
        )
        topics_after_stale = await client.get(
            f"/api/v1/admin/topics?project={project_slug}", headers=admin_headers
        )

    failures: list[str] = []
    for label, response, expected in (
        ("membership create", membership, 201),
        ("membership immediate reread", memberships_after_create, 200),
        ("membership update", changed, 200),
        ("stale membership update", stale_membership, 409),
        ("membership reread after stale update", memberships_after_stale, 200),
        ("topic create", topic, 201),
        ("topic immediate reread", topics_after_create, 200),
        ("topic update", edited_topic, 200),
        ("stale topic update", stale_topic, 409),
        ("topic reread after stale update", topics_after_stale, 200),
    ):
        _status(failures, label, response, expected)
    created_membership = _required(
        failures, "membership create", membership, {"membership", "version", "audit_correlation"}
    )
    created_topic = _required(
        failures, "topic create", topic, {"topic", "version", "audit_correlation"}
    )
    membership_listing = _required(
        failures, "membership immediate reread", memberships_after_create, {"memberships"}
    )
    if membership_listing is not None:
        rows = membership_listing.get("memberships")
        target_row = (
            next(
                (
                    row
                    for row in rows
                    if isinstance(row, dict) and row.get("user_id") == target.user["id"]
                ),
                None,
            )
            if isinstance(rows, list)
            else None
        )
        if not isinstance(target_row, dict) or target_row.get("allowed_topics") != []:
            failures.append(
                "membership default: a new membership must immediately expose allowed_topics=[]"
            )
    changed_payload = _required(
        failures, "membership update", changed, {"before", "after", "version", "audit_correlation"}
    )
    if changed_payload is not None:
        after = changed_payload.get("after")
        if (
            not isinstance(after, dict)
            or after.get("role") != "member"
            or after.get("allowed_topics") != ["general"]
            or after.get("can_curate") is not True
        ):
            failures.append("membership update: after must exactly reflect the requested authority")
        stale_listing = _required(
            failures,
            "membership reread after stale update",
            memberships_after_stale,
            {"memberships"},
        )
        stale_rows = stale_listing.get("memberships") if stale_listing is not None else None
        stale_row = (
            next(
                (
                    row
                    for row in stale_rows
                    if isinstance(row, dict) and row.get("user_id") == target.user["id"]
                ),
                None,
            )
            if isinstance(stale_rows, list)
            else None
        )
        if stale_row != after:
            failures.append(
                "stale membership update: reread must remain exactly at the current state"
            )
    topic_listing = _required(failures, "topic immediate reread", topics_after_create, {"topics"})
    if topic_listing is not None:
        rows = topic_listing.get("topics")
        target_row = (
            next(
                (row for row in rows if isinstance(row, dict) and row.get("slug") == topic_slug),
                None,
            )
            if isinstance(rows, list)
            else None
        )
        if (
            not isinstance(target_row, dict)
            or target_row.get("name") != "Sensitive"
            or target_row.get("sensitivity") != 4
        ):
            failures.append("topic create: immediate reread must expose exact topic values")
    edited_payload = _required(
        failures, "topic update", edited_topic, {"before", "after", "version", "audit_correlation"}
    )
    if edited_payload is not None:
        after = edited_payload.get("after")
        if (
            not isinstance(after, dict)
            or after.get("name") != "Highly sensitive"
            or after.get("sensitivity") != 5
        ):
            failures.append("topic update: after must expose exact edited values")
        stale_listing = _required(
            failures, "topic reread after stale update", topics_after_stale, {"topics"}
        )
        stale_rows = stale_listing.get("topics") if stale_listing is not None else None
        stale_row = (
            next(
                (
                    row
                    for row in stale_rows
                    if isinstance(row, dict) and row.get("slug") == topic_slug
                ),
                None,
            )
            if isinstance(stale_rows, list)
            else None
        )
        if stale_row != after:
            failures.append("stale topic update: reread must remain exactly at the current state")
    await _require_audit_correlation(
        failures, "membership create", harness, project_id, created_membership
    )
    await _require_audit_correlation(
        failures, "membership update", harness, project_id, changed_payload
    )
    await _require_audit_correlation(failures, "topic create", harness, project_id, created_topic)
    await _require_audit_correlation(failures, "topic update", harness, project_id, edited_payload)
    assert not failures, "\n".join(failures)
