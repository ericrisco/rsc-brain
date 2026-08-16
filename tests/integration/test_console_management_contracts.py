"""RED HTTP contracts for complete console-governance lifecycles (T005).

The tests describe the management API the console needs rather than accepting today's partial
routes.  Authorization and persistence probes use the real ASGI app and Postgres.  The sole fault
injection is a deterministic rate-limit outcome at the service boundary: it proves HTTP translation
without introducing a timing-sensitive global request counter.
"""

from __future__ import annotations

import datetime as dt
import logging
import time
import uuid
from collections.abc import Callable, Iterable, Mapping, Sequence
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
from rsc_brain.mcp.auth import RateLimitedError
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


async def _session(
    client: httpx.AsyncClient, actor: ActiveUser, *, password: str = _PASSWORD
) -> tuple[dict[str, str], str]:
    login = await client.post(
        "/api/v1/auth/login", json={"email": actor.email, "password": password}
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


def _mapping_field(
    failures: list[str], label: str, payload: Mapping[str, object] | None, name: str
) -> dict[str, object] | None:
    value = payload.get(name) if payload is not None else None
    if not isinstance(value, dict):
        failures.append(f"{label}: {name} must be an object")
        return None
    return value


def _list_field(
    failures: list[str], label: str, payload: Mapping[str, object] | None, name: str
) -> list[object] | None:
    value = payload.get(name) if payload is not None else None
    if not isinstance(value, list):
        failures.append(f"{label}: {name} must be a list")
        return None
    return value


def _int_field(
    failures: list[str], label: str, payload: Mapping[str, object] | None, name: str
) -> int | None:
    value = payload.get(name) if payload is not None else None
    if not isinstance(value, int):
        failures.append(f"{label}: {name} must be an integer server version")
        return None
    return value


def _str_field(
    failures: list[str], label: str, payload: Mapping[str, object] | None, name: str
) -> str | None:
    value = payload.get(name) if payload is not None else None
    if not isinstance(value, str) or not value:
        failures.append(f"{label}: {name} must be a non-empty string")
        return None
    return value


def _uuid_string(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        return str(uuid.UUID(value))
    except ValueError:
        return None


def _value(
    failures: list[str], label: str, payload: Mapping[str, object] | None, name: str
) -> object | None:
    if payload is None or name not in payload:
        failures.append(f"{label}: missing {name}")
        return None
    return payload[name]


def _contains_secret(responses: Iterable[httpx.Response], secrets: Iterable[str]) -> bool:
    values = tuple(value for value in secrets if value)
    return any(
        any(
            value in response.text or any(value in header for header in response.headers.values())
            for value in values
        )
        for response in responses
    )


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


def _correlation_id(
    failures: list[str], label: str, payload: Mapping[str, object] | None
) -> int | None:
    value = _value(failures, label, payload, "audit_correlation")
    if isinstance(value, bool):
        failures.append(f"{label}: audit correlation cannot be boolean")
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdecimal():
        return int(value)
    failures.append(f"{label}: audit correlation must identify an integer audit row")
    return None


async def _require_audit(
    failures: list[str],
    label: str,
    harness: Harness,
    project_id: str,
    payload: Mapping[str, object] | None,
    *,
    principal_id: str,
    action: str,
    denied: bool = False,
) -> None:
    correlation = _correlation_id(failures, label, payload)
    if correlation is None:
        return
    rows = await query_audit_raw(harness.sm, project_id, limit=500)
    row = next((candidate for candidate in rows if candidate.get("id") == correlation), None)
    if row is None:
        failures.append(f"{label}: correlation must identify a persisted audit row in the scope")
        return
    expected = {
        "project_id": project_id,
        "principal_type": "human",
        "principal_id": principal_id,
        "action": action,
        "tool": "console",
        "denied": denied,
    }
    actual = {name: row.get(name) for name in expected}
    if actual != expected:
        failures.append(f"{label}: persisted audit mismatch; expected {expected}, got {actual}")


async def _project_row(harness: Harness, slug: str) -> dict[str, object] | None:
    async with harness.sm() as session:
        row = (
            await session.execute(
                select(models.Project.id, models.Project.name, models.Project.settings).where(
                    models.Project.slug == slug
                )
            )
        ).one_or_none()
    if row is None:
        return None
    return {"id": str(row.id), "slug": slug, "name": row.name, "settings": row.settings}


async def _membership_row(
    harness: Harness, project_id: str, user_id: str
) -> dict[str, object] | None:
    async with harness.sm() as session:
        row = await session.scalar(
            select(models.ProjectMembership).where(
                models.ProjectMembership.project_id == uuid.UUID(project_id),
                models.ProjectMembership.user_id == uuid.UUID(user_id),
            )
        )
    if row is None:
        return None
    return {
        "id": str(row.id),
        "user_id": user_id,
        "role": row.role,
        "allowed_topics": list(row.allowed_topics),
        "can_curate": row.can_curate,
    }


async def _topic_row(harness: Harness, project_id: str, slug: str) -> dict[str, object] | None:
    async with harness.sm() as session:
        row = await session.scalar(
            select(models.Topic).where(
                models.Topic.project_id == uuid.UUID(project_id), models.Topic.slug == slug
            )
        )
    if row is None:
        return None
    return {"slug": row.slug, "name": row.name, "sensitivity": row.sensitivity}


async def _pat_is_active(harness: Harness, pat_id: str) -> bool:
    async with harness.sm() as session:
        credential = await session.scalar(
            select(models.PersonalAccessToken).where(
                models.PersonalAccessToken.id == uuid.UUID(pat_id)
            )
        )
    return credential is not None and credential.revoked_at is None


async def _membership_pat_state(
    harness: Harness, membership_id: str
) -> tuple[tuple[str, str | None, str | None], ...]:
    async with harness.sm() as session:
        credentials = (
            await session.scalars(
                select(models.PersonalAccessToken).where(
                    models.PersonalAccessToken.membership_id == uuid.UUID(membership_id)
                )
            )
        ).all()
    return tuple(
        sorted(
            (
                str(credential.id),
                credential.name,
                credential.revoked_at.isoformat() if credential.revoked_at is not None else None,
            )
            for credential in credentials
        )
    )


async def test_actor_matrix_separates_platform_and_project_authority(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    project_slug = unique_slug("actor-matrix")
    project_id = await harness.setup_project(project_slug, [("general", 0)])
    foreign_slug = unique_slug("foreign")
    foreign_id = await harness.setup_project(foreign_slug, [("general", 0)])
    identity = IdentityService(harness.sm)
    target = await _active_user(identity)
    target_membership_id = await identity.add_membership(
        target.user["id"], project_id, role="member", allowed_topics=("general",)
    )
    target_pat = await identity.issue_pat(target_membership_id, name="matrix-target")
    membership_before = await _membership_row(harness, project_id, target.user["id"])
    credential_before = await _membership_pat_state(harness, target_membership_id)
    denied_project_slug = unique_slug("admin-global-denied")
    admin_topic_slug = unique_slug("admin-content")
    owner_slug = unique_slug("owner-content")
    curator_slug = unique_slug("curator-write")
    member_slug = unique_slug("member-write")
    viewer_slug = unique_slug("viewer-write")
    foreign_topic_slug = unique_slug("foreign-write")
    invalid_slug = unique_slug("invalid-write")
    forbidden_slugs = {
        owner_slug,
        curator_slug,
        member_slug,
        viewer_slug,
        foreign_topic_slug,
        invalid_slug,
    }

    async with _client(harness, tmp_path) as client:
        owner_without_membership = await _active_user(identity, platform_role="owner")
        owner_headers, _ = await _session(client, owner_without_membership)
        admin_actor, admin_headers, _ = await _actor_with_membership(
            identity, client, project_id, project_role="project-admin"
        )
        foreign_admin, foreign_headers, _ = await _actor_with_membership(
            identity, client, foreign_id, project_role="project-admin"
        )
        member_actor, member_headers, _ = await _actor_with_membership(identity, client, project_id)
        curator_actor, curator_headers, _ = await _actor_with_membership(
            identity, client, project_id, can_curate=True
        )
        viewer_actor, viewer_headers, _ = await _actor_with_membership(
            identity, client, project_id, project_role="viewer"
        )

        platform_inventory = await client.get("/api/v1/admin/projects", headers=owner_headers)
        owner_project_content = await client.post(
            f"/api/v1/admin/topics?project={project_slug}",
            headers=owner_headers,
            json={"slug": owner_slug, "name": "must stay hidden"},
        )
        admin_global_inventory = await client.get("/api/v1/admin/projects", headers=admin_headers)
        admin_global_create = await client.post(
            "/api/v1/admin/projects",
            headers=admin_headers,
            json={"slug": denied_project_slug, "name": "must not exist"},
        )
        admin_project_content = await client.post(
            f"/api/v1/admin/topics?project={project_slug}",
            headers=admin_headers,
            json={"slug": admin_topic_slug, "name": "project control"},
        )
        curator_mutation = await client.post(
            f"/api/v1/admin/topics?project={project_slug}",
            headers=curator_headers,
            json={"slug": curator_slug, "name": "no admin write"},
        )
        member_mutation = await client.post(
            f"/api/v1/admin/topics?project={project_slug}",
            headers=member_headers,
            json={"slug": member_slug, "name": "no admin write"},
        )
        viewer_mutation = await client.post(
            f"/api/v1/admin/topics?project={project_slug}",
            headers=viewer_headers,
            json={"slug": viewer_slug, "name": "no admin write"},
        )
        foreign_project = await client.post(
            f"/api/v1/admin/topics?project={project_slug}",
            headers=foreign_headers,
            json={"slug": foreign_topic_slug, "name": "foreign"},
        )
        rejected_credential = await client.post(
            f"/api/v1/admin/topics?project={project_slug}",
            headers={"Authorization": "Bearer rejected-credential"},
            json={"slug": invalid_slug, "name": "rejected"},
        )
        malformed_role = await client.post(
            f"/api/v1/admin/memberships?project={project_slug}",
            headers=admin_headers,
            json={"user_id": owner_without_membership.user["id"], "role": "not-a-project-role"},
        )
        denied_disable = await client.post(
            f"/api/v1/admin/users/{target.user['id']}/disable?project={project_slug}",
            headers=viewer_headers,
            json={"expected_status": "active", "impact_acknowledged": True},
        )
        denied_credential = await client.post(
            f"/api/v1/admin/users/{target.user['id']}/credentials?project={project_slug}",
            headers=curator_headers,
            json={"name": "must-not-exist", "kind": "pat"},
        )
        denied_membership = await client.patch(
            f"/api/v1/admin/memberships/{target.user['id']}?project={project_slug}",
            headers=member_headers,
            json={"expected_version": 1, "role": "project-admin"},
        )
        foreign_disable = await client.post(
            f"/api/v1/admin/users/{target.user['id']}/disable?project={project_slug}",
            headers=foreign_headers,
            json={"expected_status": "active", "impact_acknowledged": True},
        )
        foreign_credential = await client.delete(
            f"/api/v1/admin/credentials/{target_pat.id}?project={project_slug}",
            headers=foreign_headers,
            params={"expected_version": 1},
        )

    failures: list[str] = []
    for label, response, expected in (
        ("owner without membership reads platform inventory", platform_inventory, 200),
        ("owner without membership cannot mutate project content", owner_project_content, 404),
        ("project-admin cannot read platform inventory", admin_global_inventory, 403),
        ("project-admin cannot create a global project", admin_global_create, 403),
        ("project-admin mutates its project", admin_project_content, 201),
        ("curator cannot mutate project configuration", curator_mutation, 403),
        ("member cannot mutate project configuration", member_mutation, 403),
        ("viewer cannot mutate project configuration", viewer_mutation, 403),
        ("project-admin cannot reach foreign project", foreign_project, 404),
        ("rejected credential", rejected_credential, 401),
        ("bad membership role", malformed_role, 400),
        ("viewer cannot disable users", denied_disable, 403),
        ("curator cannot create third-party credentials", denied_credential, 403),
        ("member cannot alter memberships", denied_membership, 403),
        ("foreign admin cannot disable project user", foreign_disable, 404),
        ("foreign admin cannot revoke project credential", foreign_credential, 404),
    ):
        _status(failures, label, response, expected)
    inventory_payload = _required(
        failures, "owner platform inventory", platform_inventory, {"projects"}
    )
    inventory_projects = _list_field(
        failures, "owner platform inventory", inventory_payload, "projects"
    )
    inventory_metadata = {
        "id",
        "slug",
        "name",
        "status",
        "version",
        "settings",
        "membership_count",
        "created_at",
        "updated_at",
    }
    if inventory_projects is not None and any(
        not isinstance(project, dict) or not set(project).issubset(inventory_metadata)
        for project in inventory_projects
    ):
        failures.append("owner platform inventory exposed fields outside lifecycle metadata")
    if await _project_row(harness, denied_project_slug) is not None:
        failures.append("denied project create persisted a project")
    if await _user_status(harness, target.user["id"]) != "active":
        failures.append("denied user mutation changed the target status")
    if not await _pat_is_active(harness, target_pat.id):
        failures.append("denied credential mutation revoked the target credential")
    if await _membership_pat_state(harness, target_membership_id) != credential_before:
        failures.append("denied credential mutations changed persisted credentials")
    if await _membership_row(harness, project_id, target.user["id"]) != membership_before:
        failures.append("denied membership mutation changed persisted authority")
    for slug in forbidden_slugs:
        if await _topic_row(harness, project_id, slug) is not None:
            failures.append(f"denied topic mutation persisted {slug}")
    if await _topic_row(harness, project_id, admin_topic_slug) is None:
        failures.append("authorized project-admin topic mutation did not persist")
    admin_payload = _object(admin_project_content)
    await _require_audit(
        failures,
        "authorized topic create",
        harness,
        project_id,
        admin_payload,
        principal_id=admin_actor.user["id"],
        action=f"topic:create target={admin_topic_slug}",
    )
    for label, response, actor, action in (
        (
            "curator topic denial",
            curator_mutation,
            curator_actor,
            f"topic:create target={curator_slug}",
        ),
        (
            "member membership denial",
            denied_membership,
            member_actor,
            f"membership:update target={target.user['id']}",
        ),
        (
            "viewer user denial",
            denied_disable,
            viewer_actor,
            f"identity:disable target={target.user['id']}",
        ),
        (
            "curator credential denial",
            denied_credential,
            curator_actor,
            f"credential:create target={target.user['id']}",
        ),
    ):
        await _require_audit(
            failures,
            label,
            harness,
            project_id,
            _object(response),
            principal_id=actor.user["id"],
            action=action,
            denied=True,
        )
    assert foreign_admin.user["id"] != admin_actor.user["id"]
    assert not failures, "\n".join(failures)


async def test_project_lifecycle_uses_response_versions_impact_and_real_delete(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    target_slug = unique_slug("project-lifecycle")
    identity = IdentityService(harness.sm)
    default_id = await identity.ensure_default_project()
    owner = await _active_user(identity, platform_role="owner")

    async with _client(harness, tmp_path) as client:
        headers, _ = await _session(client, owner)
        default_before = await client.get("/api/v1/admin/projects/default", headers=headers)
        created = await client.post(
            "/api/v1/admin/projects",
            headers=headers,
            json={
                "slug": target_slug,
                "name": "Lifecycle original",
                "settings": {"retention_days": 14},
            },
        )
        created_payload = _object(created)
        created_project = (
            created_payload.get("project") if isinstance(created_payload, dict) else None
        )
        created_version = (
            created_project.get("version") if isinstance(created_project, dict) else None
        )
        if not isinstance(created_version, int):
            created_version = -1
        created_db = await _project_row(harness, target_slug)
        if created_db is not None:
            await identity.create_topic(
                str(created_db["id"]), "known-topic", "Known", sensitivity=4
            )
        before = await client.get(f"/api/v1/admin/projects/{target_slug}", headers=headers)
        update = await client.patch(
            f"/api/v1/admin/projects/{target_slug}",
            headers=headers,
            json={
                "expected_version": created_version,
                "name": "Lifecycle renamed",
                "settings": {"retention_days": 30},
            },
        )
        update_payload = _object(update)
        updated_after = update_payload.get("after") if isinstance(update_payload, dict) else None
        current_version = updated_after.get("version") if isinstance(updated_after, dict) else None
        if not isinstance(current_version, int):
            current_version = -1
        stale = await client.patch(
            f"/api/v1/admin/projects/{target_slug}",
            headers=headers,
            json={
                "expected_version": created_version,
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
        default_payload = _object(default_before)
        default_version = default_payload.get("version") if default_payload is not None else None
        if not isinstance(default_version, int):
            default_version = -1
        default_delete = await client.delete(
            "/api/v1/admin/projects/default",
            headers=headers,
            params={"expected_version": default_version, "confirm": "default"},
        )
        default_after = await client.get("/api/v1/admin/projects/default", headers=headers)
        removed = await client.delete(
            f"/api/v1/admin/projects/{target_slug}",
            headers=headers,
            params={"expected_version": current_version, "confirm": target_slug},
        )
        after_delete = await client.get(f"/api/v1/admin/projects/{target_slug}", headers=headers)
        inventory_after = await client.get("/api/v1/admin/projects", headers=headers)

    failures: list[str] = []
    for label, response, expected in (
        ("default project read before protection check", default_before, 200),
        ("project create", created, 201),
        ("project reread before mutation", before, 200),
        ("project update", update, 200),
        ("stale project update", stale, 409),
        ("project reread after mutation", reread, 200),
        ("delete impact", impact, 200),
        ("default delete impact", default_impact, 200),
        ("default project protection", default_delete, 409),
        ("default survives rejected delete", default_after, 200),
        ("confirmed project delete", removed, 200),
        ("deleted project is absent", after_delete, 404),
        ("post-delete inventory", inventory_after, 200),
    ):
        _status(failures, label, response, expected)
    create_envelope = _required(
        failures, "project create", created, {"project", "audit_correlation"}
    )
    create_state = _mapping_field(failures, "project create", create_envelope, "project")
    before_payload = _required(
        failures, "project before", before, {"id", "slug", "name", "settings", "version"}
    )
    updated = _required(
        failures, "project update", update, {"before", "after", "audit_correlation"}
    )
    update_before = _mapping_field(failures, "project update", updated, "before")
    update_after = _mapping_field(failures, "project update", updated, "after")
    reread_payload = _required(
        failures, "project reread", reread, {"id", "slug", "name", "settings", "version"}
    )
    old_version = _int_field(failures, "project before", before_payload, "version")
    current_version_checked = _int_field(failures, "project update", update_after, "version")
    target_id = _str_field(failures, "project create", create_state, "id")
    expected_create = {
        "id": target_id,
        "slug": target_slug,
        "name": "Lifecycle original",
        "settings": {"retention_days": 14},
        "status": "active",
        "version": old_version,
    }
    if create_state != expected_create:
        failures.append(
            f"project create: expected authoritative state {expected_create}, got {create_state}"
        )
    if before_payload != create_state:
        failures.append(
            "project create: immediate reread must equal the authoritative create state"
        )
    if update_before != before_payload:
        failures.append("project update: before must equal the last server reread")
    expected_update = {
        **(before_payload or {}),
        "name": "Lifecycle renamed",
        "settings": {"retention_days": 30},
        "version": current_version_checked,
    }
    if update_after != expected_update or reread_payload != expected_update:
        failures.append("project update: response and reread must expose exact persisted settings")
    if (
        old_version is not None
        and current_version_checked is not None
        and current_version_checked <= old_version
    ):
        failures.append(
            "project update: current version must advance from the response's old version"
        )
    stale_payload = _required(failures, "stale project update", stale, {"current"})
    if _mapping_field(failures, "stale project update", stale_payload, "current") != update_after:
        failures.append("stale project update: conflict must return the unchanged current state")
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
    if _object(default_after) != _object(default_before):
        failures.append("default project changed after a rejected delete")
    removed_payload = _required(
        failures, "project delete", removed, {"project", "status", "audit_correlation"}
    )
    if removed_payload is not None and (
        removed_payload.get("project") != target_slug or removed_payload.get("status") != "deleted"
    ):
        failures.append("project delete: authoritative outcome must name the deleted project")
    inventory_payload = _required(failures, "post-delete inventory", inventory_after, {"projects"})
    projects = _list_field(failures, "post-delete inventory", inventory_payload, "projects")
    if projects is not None and any(
        isinstance(project, dict) and project.get("slug") == target_slug for project in projects
    ):
        failures.append("project delete: deleted project remained in platform inventory")
    if await _project_row(harness, target_slug) is not None:
        failures.append("project delete: target project remained in authoritative persistence")
    if await _project_row(harness, "default") is None:
        failures.append("default project was removed despite the conflict response")
    audit_project_id = target_id or str(uuid.UUID(int=0))
    for label, payload, action in (
        ("project create", create_envelope, f"project:create target={target_slug}"),
        ("project update", updated, f"project:update target={target_slug}"),
        ("project delete", removed_payload, f"project:delete target={target_slug}"),
    ):
        await _require_audit(
            failures,
            label,
            harness,
            audit_project_id,
            payload,
            principal_id=owner.user["id"],
            action=action,
        )
    assert default_id != audit_project_id
    assert not failures, "\n".join(failures)


async def test_user_invite_reset_disable_is_http_only_single_use_and_revokes_every_credential(
    build_harness: Callable[..., Harness],
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    harness = build_harness()
    project_slug = unique_slug("users")
    project_id = await harness.setup_project(project_slug, [("general", 0)])
    identity = IdentityService(harness.sm)
    admin = await _active_user(identity)
    await identity.add_membership(
        admin.user["id"],
        project_id,
        role="project-admin",
        allowed_topics=("general",),
    )
    failures: list[str] = []
    target_email = f"{unique_slug('http-invite')}@example.com"
    new_password = "new correct horse battery staple"
    caplog.set_level(logging.DEBUG)

    async with _client(harness, tmp_path) as client:
        # Re-login the real admin on this client; every user lifecycle call itself stays HTTP-only.
        admin_headers, _ = await _session(client, admin)
        invited = await client.post(
            f"/api/v1/admin/users/invite?project={project_slug}",
            headers=admin_headers,
            json={
                "email": target_email,
                "platform_role": "member",
                "project_role": "project-admin",
                "allowed_topics": ["general"],
                "can_curate": False,
            },
        )
        invite_payload = _object(invited)
        invite_identity = (
            invite_payload.get("identity") if isinstance(invite_payload, dict) else None
        )
        invited_user_id = _uuid_string(
            invite_identity.get("id") if isinstance(invite_identity, dict) else None
        )
        invitation_token = (
            invite_payload.get("invitation_token") if isinstance(invite_payload, dict) else None
        )
        accept = await client.post(
            "/api/v1/auth/invitations/accept",
            json={
                "token": invitation_token if isinstance(invitation_token, str) else "missing",
                "password": _PASSWORD,
            },
        )
        accept_again = await client.post(
            "/api/v1/auth/invitations/accept",
            json={
                "token": invitation_token if isinstance(invitation_token, str) else "missing",
                "password": _PASSWORD,
            },
        )

        # A total-safe continuation keeps later contracts observable while the HTTP create lane is
        # RED.  The recorded HTTP assertions still fail, so this fallback can never manufacture green.
        if invited_user_id is None or await _user_status(harness, invited_user_id) != "active":
            target = await _active_user(identity)
        else:
            target = ActiveUser(email=target_email, user={"id": invited_user_id})
        membership = await _membership_row(harness, project_id, target.user["id"])
        if membership is None:
            membership_id = await identity.add_membership(
                target.user["id"],
                project_id,
                role="project-admin",
                allowed_topics=("general",),
            )
        else:
            membership_id = str(membership["id"])

        users_page_one = await client.get(
            f"/api/v1/admin/users?project={project_slug}",
            headers=admin_headers,
            params={"limit": 1},
        )
        first_payload = _object(users_page_one)
        first_cursor = first_payload.get("next_cursor") if first_payload is not None else None
        users_page_two = await client.get(
            f"/api/v1/admin/users?project={project_slug}",
            headers=admin_headers,
            params={
                "limit": 1,
                "cursor": first_cursor if isinstance(first_cursor, str) else "missing",
            },
        )

        reset_active = await client.post(
            f"/api/v1/admin/users/{target.user['id']}/password-reset?project={project_slug}",
            headers=admin_headers,
            json={"impact_acknowledged": True},
        )
        reset_payload = _object(reset_active)
        reset_token = reset_payload.get("reset_token") if reset_payload is not None else None
        reset_complete = await client.post(
            "/api/v1/auth/password-reset/complete",
            json={
                "token": reset_token if isinstance(reset_token, str) else "missing",
                "new_password": new_password,
            },
        )
        reset_replay = await client.post(
            "/api/v1/auth/password-reset/complete",
            json={
                "token": reset_token if isinstance(reset_token, str) else "missing",
                "new_password": "must-not-win",
            },
        )
        old_login = await client.post(
            "/api/v1/auth/login", json={"email": target.email, "password": _PASSWORD}
        )
        active_password = new_password if reset_complete.status_code == 200 else _PASSWORD
        current_login = await client.post(
            "/api/v1/auth/login", json={"email": target.email, "password": active_password}
        )
        current_login_payload = _object(current_login)
        target_session = (
            current_login_payload.get("session_token")
            if current_login_payload is not None
            else None
        )
        if not isinstance(target_session, str):
            target_session = "missing-session"
        pat = await identity.issue_pat(membership_id, name="disable-contract")
        oauth_token = f"oauth-{uuid.uuid4().hex}"
        await _issue_oauth(harness, membership_id, oauth_token)
        session_headers = {"Authorization": f"Bearer {target_session}"}
        pat_headers = {"Authorization": f"Bearer {pat.token}"}
        oauth_headers = {"Authorization": f"Bearer {oauth_token}"}
        before_session = await client.get(
            f"/api/v1/admin/topics?project={project_slug}", headers=session_headers
        )
        before_pat = await client.get("/api/v1/admin/topics", headers=pat_headers)
        before_oauth = await client.get("/api/v1/admin/topics", headers=oauth_headers)

        started = time.monotonic()
        disabled = await client.post(
            f"/api/v1/admin/users/{target.user['id']}/disable?project={project_slug}",
            headers=admin_headers,
            json={"expected_status": "active", "impact_acknowledged": True},
        )
        after_session = await client.get(
            f"/api/v1/admin/topics?project={project_slug}", headers=session_headers
        )
        after_pat = await client.get("/api/v1/admin/topics", headers=pat_headers)
        after_oauth = await client.get("/api/v1/admin/topics", headers=oauth_headers)
        resolved_session = await resolve_session(harness.sm, target_session)
        resolved_pat = await resolve_scope(harness.sm, pat.token)
        resolved_oauth = await resolve_scope(harness.sm, oauth_token)
        elapsed = time.monotonic() - started
        users_after_disable = await client.get(
            f"/api/v1/admin/users?project={project_slug}",
            headers=admin_headers,
            params={"limit": 100},
        )

    for label, response, expected in (
        ("project-scoped user invite", invited, 201),
        ("single-use invitation accept", accept, 200),
        ("invitation replay", accept_again, 400),
        ("users first page", users_page_one, 200),
        ("users second page", users_page_two, 200),
        ("old password after reset", old_login, 401),
        ("new password after reset", current_login, 200),
        ("reset token replay", reset_replay, 400),
        ("live session before disable", before_session, 200),
        ("live PAT before disable", before_pat, 200),
        ("live OAuth before disable", before_oauth, 200),
        ("disabled session", after_session, 401),
        ("disabled PAT", after_pat, 401),
        ("disabled OAuth", after_oauth, 401),
        ("users reread after disable", users_after_disable, 200),
    ):
        _status(failures, label, response, expected)
    invite_envelope = _required(
        failures,
        "user invite",
        invited,
        {"identity", "membership", "invitation_token", "expires_at", "audit_correlation"},
    )
    invited_identity = _mapping_field(failures, "user invite", invite_envelope, "identity")
    invited_membership = _mapping_field(failures, "user invite", invite_envelope, "membership")
    if invited_identity is not None and (
        invited_identity.get("email") != target_email
        or invited_identity.get("status") != "invited"
        or not isinstance(invited_identity.get("version"), int)
    ):
        failures.append("user invite: identity must expose exact invited state and version")
    if invited_membership is not None and (
        invited_membership.get("role") != "project-admin"
        or invited_membership.get("allowed_topics") != ["general"]
        or invited_membership.get("can_curate") is not False
        or not isinstance(invited_membership.get("version"), int)
    ):
        failures.append("user invite: scoped restrictive membership differs from request")
    accept_payload = _required(
        failures, "invitation accept", accept, {"identity", "audit_correlation"}
    )
    accepted_identity = _mapping_field(failures, "invitation accept", accept_payload, "identity")
    if accepted_identity is not None and accepted_identity.get("status") != "active":
        failures.append("invitation accept: identity did not become active")
    page_items: list[object] = []
    for label, response in (
        ("users first page", users_page_one),
        ("users second page", users_page_two),
    ):
        page = _required(failures, label, response, {"items", "next_cursor"})
        rows = _list_field(failures, label, page, "items")
        if rows is not None:
            page_items.extend(rows)
    if not isinstance(first_cursor, str) or not first_cursor:
        failures.append("users pagination: first bounded page must return an opaque cursor")
    if not any(
        isinstance(row, dict)
        and row.get("id") == target.user["id"]
        and row.get("email") == target.email
        and row.get("status") == "active"
        and row.get("role") == "project-admin"
        and row.get("allowed_topics") == ["general"]
        for row in page_items
    ):
        failures.append("users pagination: accepted scoped user is absent or incomplete")
    _status(failures, "reset active user", reset_active, 201)
    reset_envelope = _required(
        failures,
        "reset active user",
        reset_active,
        {"reset_token", "expires_at", "audit_correlation"},
    )
    reset_secret = _str_field(failures, "reset active user", reset_envelope, "reset_token")
    _status(failures, "disable active user", disabled, 200)
    payload = _required(
        failures, "disable", disabled, {"identity", "revocation", "audit_correlation"}
    )
    if payload is not None:
        if await _user_status(harness, target.user["id"]) != "disabled":
            failures.append("disable: database user status must become disabled")
        revocation = payload.get("revocation")
        if (
            not isinstance(revocation, dict)
            or revocation.get("complete") is not True
            or revocation.get("sessions") != "revoked"
            or revocation.get("pats") != "revoked"
            or revocation.get("oauth") != "revoked"
        ):
            failures.append("disable: response must confirm complete credential revocation")
        identity_state = payload.get("identity")
        if not isinstance(identity_state, dict) or (
            identity_state.get("id") != target.user["id"]
            or identity_state.get("status") != "disabled"
        ):
            failures.append("disable: authoritative identity state is not the disabled target")
        if resolved_session is not None:
            failures.append("disable: prior console session still resolves")
        if resolved_pat is not None:
            failures.append("disable: prior PAT still resolves")
        if resolved_oauth is not None:
            failures.append("disable: prior OAuth access token still resolves")
    if elapsed >= 5.0:
        failures.append(f"disable: API and resolver revocation took {elapsed:.3f}s (must be <5s)")
    after_payload = _required(failures, "users after disable", users_after_disable, {"items"})
    after_items = _list_field(failures, "users after disable", after_payload, "items")
    if after_items is not None and not any(
        isinstance(row, dict)
        and row.get("id") == target.user["id"]
        and row.get("status") == "disabled"
        for row in after_items
    ):
        failures.append("disable: users reread does not show the disabled target")
    invite_secret = _str_field(failures, "user invite", invite_envelope, "invitation_token")
    secret_responses: Sequence[httpx.Response] = (
        accept,
        accept_again,
        users_page_one,
        users_page_two,
        reset_active,
        reset_complete,
        reset_replay,
        disabled,
        users_after_disable,
    )
    if invite_secret is not None and (
        invited.text.count(invite_secret) != 1
        or any(invite_secret in value for value in invited.headers.values())
        or _contains_secret(secret_responses, (invite_secret,))
    ):
        failures.append("invitation secret must appear exactly once and never cross responses")
    reset_others = tuple(response for response in secret_responses if response is not reset_active)
    if reset_secret is not None and (
        reset_active.text.count(reset_secret) != 1
        or any(reset_secret in value for value in reset_active.headers.values())
        or _contains_secret(reset_others, (reset_secret,))
    ):
        failures.append("reset secret must appear exactly once and never cross responses")
    emitted_secrets = tuple(
        secret for secret in (invite_secret, reset_secret) if secret is not None
    )
    if any(secret in caplog.text for secret in emitted_secrets):
        failures.append("identity lifecycle secret escaped DEBUG diagnostics")
    for label, audit_payload, action in (
        ("user invite", invite_envelope, f"identity:invite target={target_email}"),
        ("invitation accept", accept_payload, f"identity:accept target={target.user['id']}"),
        ("password reset", reset_envelope, f"identity:reset target={target.user['id']}"),
        (
            "password reset complete",
            _object(reset_complete),
            f"identity:reset-complete target={target.user['id']}",
        ),
        ("disable", payload, f"identity:disable target={target.user['id']}"),
    ):
        await _require_audit(
            failures,
            label,
            harness,
            project_id,
            audit_payload,
            principal_id=(
                admin.user["id"]
                if label in {"user invite", "password reset", "disable"}
                else target.user["id"]
            ),
            action=action,
        )
    assert not failures, "\n".join(failures)


async def test_credentials_are_secret_once_rotatable_revocable_and_audited(
    build_harness: Callable[..., Harness],
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
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
    failures: list[str] = []
    if await resolve_scope(harness.sm, rotate_target.token) is None:
        failures.append("credential rotate control: old credential was not live before rotation")
    if await resolve_scope(harness.sm, revoke_target.token) is None:
        failures.append("credential revoke control: credential was not live before revocation")
    caplog.set_level(logging.DEBUG)

    async with _client(harness, tmp_path) as client:
        admin, admin_headers, _ = await _actor_with_membership(
            identity, client, project_id, project_role="project-admin"
        )
        before = await client.get(
            f"/api/v1/admin/users/{target.user['id']}/credentials?project={project_slug}",
            headers=admin_headers,
        )
        before_payload = _object(before)
        before_items = before_payload.get("items") if before_payload is not None else None

        def metadata_named(name: str) -> dict[str, object] | None:
            if not isinstance(before_items, list):
                return None
            return next(
                (
                    item
                    for item in before_items
                    if isinstance(item, dict) and item.get("name") == name
                ),
                None,
            )

        rotate_before = metadata_named("rotate-contract")
        revoke_before = metadata_named("revoke-contract")
        rotate_id = (
            _uuid_string(rotate_before.get("id") if rotate_before is not None else rotate_target.id)
            or rotate_target.id
        )
        revoke_id = (
            _uuid_string(revoke_before.get("id") if revoke_before is not None else revoke_target.id)
            or revoke_target.id
        )
        rotate_version = rotate_before.get("version") if rotate_before is not None else None
        revoke_version = revoke_before.get("version") if revoke_before is not None else None
        if not isinstance(rotate_version, int):
            rotate_version = -1
        if not isinstance(revoke_version, int):
            revoke_version = -1

        create_headers = {**admin_headers, "Idempotency-Key": "credential-create-contract"}
        created = await client.post(
            f"/api/v1/admin/users/{target.user['id']}/credentials?project={project_slug}",
            headers=create_headers,
            json={"name": "console-created", "kind": "pat"},
        )
        create_replay = await client.post(
            f"/api/v1/admin/users/{target.user['id']}/credentials?project={project_slug}",
            headers=create_headers,
            json={"name": "console-created", "kind": "pat"},
        )
        rotate_headers = {**admin_headers, "Idempotency-Key": "credential-rotate-contract"}
        rotated = await client.post(
            f"/api/v1/admin/credentials/{rotate_id}/rotate?project={project_slug}",
            headers=rotate_headers,
            json={"expected_version": rotate_version},
        )
        rotate_replay = await client.post(
            f"/api/v1/admin/credentials/{rotate_id}/rotate?project={project_slug}",
            headers=rotate_headers,
            json={"expected_version": rotate_version},
        )
        rotate_stale = await client.post(
            f"/api/v1/admin/credentials/{rotate_id}/rotate?project={project_slug}",
            headers={**admin_headers, "Idempotency-Key": "credential-rotate-stale"},
            json={"expected_version": rotate_version},
        )
        revoke_headers = {**admin_headers, "Idempotency-Key": "credential-revoke-contract"}
        revoked = await client.delete(
            f"/api/v1/admin/credentials/{revoke_id}?project={project_slug}",
            headers=revoke_headers,
            params={"expected_version": revoke_version},
        )
        revoke_replay = await client.delete(
            f"/api/v1/admin/credentials/{revoke_id}?project={project_slug}",
            headers=revoke_headers,
            params={"expected_version": revoke_version},
        )
        revoke_stale = await client.delete(
            f"/api/v1/admin/credentials/{revoke_id}?project={project_slug}",
            headers={**admin_headers, "Idempotency-Key": "credential-revoke-stale"},
            params={"expected_version": revoke_version},
        )
        after = await client.get(
            f"/api/v1/admin/users/{target.user['id']}/credentials?project={project_slug}",
            headers=admin_headers,
        )

    for label, response, expected in (
        ("credential list", before, 200),
        ("credential create", created, 201),
        ("credential create idempotent replay", create_replay, 200),
        ("credential rotate", rotated, 201),
        ("credential rotate idempotent replay", rotate_replay, 200),
        ("credential stale rotate", rotate_stale, 409),
        ("credential revoke", revoked, 200),
        ("credential revoke idempotent replay", revoke_replay, 200),
        ("credential stale revoke", revoke_stale, 409),
        ("credential reread", after, 200),
    ):
        _status(failures, label, response, expected)
    created_payload = _required(
        failures, "credential create", created, {"credential", "secret", "audit_correlation"}
    )
    rotated_payload = _required(
        failures, "credential rotate", rotated, {"credential", "secret", "audit_correlation"}
    )
    created_meta = _mapping_field(failures, "credential create", created_payload, "credential")
    rotated_meta = _mapping_field(failures, "credential rotate", rotated_payload, "credential")
    created_secret = _str_field(failures, "credential create", created_payload, "secret")
    rotated_secret = _str_field(failures, "credential rotate", rotated_payload, "secret")
    created_id = _uuid_string(created_meta.get("id") if created_meta is not None else None)
    if created_meta is not None and (
        created_meta.get("user_id") != target.user["id"]
        or created_meta.get("project") != project_slug
        or created_meta.get("kind") != "pat"
        or created_meta.get("name") != "console-created"
        or created_meta.get("status") != "active"
        or not isinstance(created_meta.get("version"), int)
    ):
        failures.append("credential create: metadata is not the exact active target credential")
    if rotate_before is None or revoke_before is None:
        failures.append("credential list: seeded rotate/revoke credentials are absent")
    for label, metadata, credential_id in (
        ("rotate list metadata", rotate_before, rotate_target.id),
        ("revoke list metadata", revoke_before, revoke_target.id),
    ):
        if metadata is None or (
            metadata.get("id") != credential_id
            or metadata.get("user_id") != target.user["id"]
            or metadata.get("project") != project_slug
            or metadata.get("kind") != "pat"
            or metadata.get("status") != "active"
            or not isinstance(metadata.get("version"), int)
        ):
            failures.append(f"{label}: missing exact id/version/status from server list")
    if isinstance(rotated_secret, str) and rotated_secret == rotate_target.token:
        failures.append("credential rotate: new secret must differ from the old secret")
    if created_secret is not None and await resolve_scope(harness.sm, created_secret) is None:
        failures.append("credential create: returned secret does not resolve")
    if rotated_secret is not None:
        if await resolve_scope(harness.sm, rotate_target.token) is not None:
            failures.append("credential rotate: old credential must stop resolving")
        if await resolve_scope(harness.sm, rotated_secret) is None:
            failures.append("credential rotate: new credential must resolve")
    if await resolve_scope(harness.sm, revoke_target.token) is not None:
        failures.append("credential revoke: revoked credential must stop resolving")
    rotated_meta_version = rotated_meta.get("version") if rotated_meta is not None else None
    if rotated_meta is not None and (
        rotated_meta.get("id") != rotate_id
        or rotated_meta.get("status") != "active"
        or not isinstance(rotated_meta_version, int)
        or (isinstance(rotated_meta_version, int) and rotated_meta_version <= rotate_version)
    ):
        failures.append("credential rotate: metadata must advance the listed server version")
    create_replay_payload = _required(
        failures,
        "credential create replay",
        create_replay,
        {"credential", "replayed", "audit_correlation"},
    )
    rotate_replay_payload = _required(
        failures,
        "credential rotate replay",
        rotate_replay,
        {"credential", "replayed", "audit_correlation"},
    )
    created_correlation = (
        created_payload.get("audit_correlation") if created_payload is not None else None
    )
    rotated_correlation = (
        rotated_payload.get("audit_correlation") if rotated_payload is not None else None
    )
    if create_replay_payload is not None and (
        create_replay_payload.get("credential") != created_meta
        or create_replay_payload.get("replayed") is not True
        or create_replay_payload.get("audit_correlation") != created_correlation
        or "secret" in create_replay_payload
    ):
        failures.append("credential create replay duplicated state or redisplayed the secret")
    if rotate_replay_payload is not None and (
        rotate_replay_payload.get("credential") != rotated_meta
        or rotate_replay_payload.get("replayed") is not True
        or rotate_replay_payload.get("audit_correlation") != rotated_correlation
        or "secret" in rotate_replay_payload
    ):
        failures.append("credential rotate replay duplicated state or redisplayed the secret")
    rotate_conflict = _required(failures, "credential stale rotate", rotate_stale, {"current"})
    if rotate_conflict is not None and rotate_conflict.get("current") != rotated_meta:
        failures.append("credential stale rotate did not return the unchanged current metadata")
    revoked_payload = _required(
        failures, "credential revoke", revoked, {"credential", "audit_correlation"}
    )
    revoked_meta = _mapping_field(failures, "credential revoke", revoked_payload, "credential")
    revoked_meta_version = revoked_meta.get("version") if revoked_meta is not None else None
    if revoked_meta is not None and (
        revoked_meta.get("id") != revoke_id
        or revoked_meta.get("status") != "revoked"
        or not isinstance(revoked_meta_version, int)
        or (isinstance(revoked_meta_version, int) and revoked_meta_version <= revoke_version)
    ):
        failures.append("credential revoke: state/version did not advance to revoked")
    revoke_replay_payload = _required(
        failures,
        "credential revoke replay",
        revoke_replay,
        {"credential", "replayed", "audit_correlation"},
    )
    revoked_correlation = (
        revoked_payload.get("audit_correlation") if revoked_payload is not None else None
    )
    if revoke_replay_payload is not None and (
        revoke_replay_payload.get("credential") != revoked_meta
        or revoke_replay_payload.get("replayed") is not True
        or revoke_replay_payload.get("audit_correlation") != revoked_correlation
    ):
        failures.append("credential revoke replay was not the same authoritative outcome")
    revoke_conflict = _required(failures, "credential stale revoke", revoke_stale, {"current"})
    if revoke_conflict is not None and revoke_conflict.get("current") != revoked_meta:
        failures.append("credential stale revoke did not preserve the revoked current state")
    after_payload = _required(failures, "credential reread", after, {"items"})
    after_items = _list_field(failures, "credential reread", after_payload, "items")
    expected_after = tuple(
        item for item in (created_meta, rotated_meta, revoked_meta) if item is not None
    )
    if after_items is not None and any(item not in after_items for item in expected_after):
        failures.append("credential reread: authoritative create/rotate/revoke states are missing")
    if after_items is not None and created_id is not None:
        matching_created = [
            item for item in after_items if isinstance(item, dict) and item.get("id") == created_id
        ]
        if len(matching_created) != 1:
            failures.append("credential create replay duplicated the credential")
    if after_items is not None and isinstance(before_items, list):
        if len(after_items) != len(before_items) + 1:
            failures.append(
                "credential create replay changed credential cardinality more than once"
            )
        if (
            sum(
                1
                for item in after_items
                if isinstance(item, dict) and item.get("name") == "console-created"
            )
            != 1
        ):
            failures.append("credential create replay did not leave exactly one named credential")
    all_responses = (
        before,
        created,
        create_replay,
        rotated,
        rotate_replay,
        rotate_stale,
        revoked,
        revoke_replay,
        revoke_stale,
        after,
    )
    fixture_secrets = (rotate_target.token, revoke_target.token)
    if _contains_secret(all_responses, fixture_secrets):
        failures.append("credential secret-once: an existing secret escaped an API response/header")
    if created_secret is not None and (
        created.text.count(created_secret) != 1
        or any(created_secret in value for value in created.headers.values())
        or _contains_secret(
            tuple(response for response in all_responses if response is not created),
            (created_secret,),
        )
    ):
        failures.append("credential create secret was not confined to its one successful response")
    if rotated_secret is not None and (
        rotated.text.count(rotated_secret) != 1
        or any(rotated_secret in value for value in rotated.headers.values())
        or _contains_secret(
            tuple(response for response in all_responses if response is not rotated),
            (rotated_secret,),
        )
    ):
        failures.append("credential rotate secret was not confined to its one successful response")
    exposed = tuple(
        value
        for value in (*fixture_secrets, created_secret, rotated_secret)
        if isinstance(value, str)
    )
    if any(value in caplog.text for value in exposed):
        failures.append("credential secret-once: credential value escaped diagnostics")
    for label, payload, action in (
        ("credential create", created_payload, f"credential:create target={created_id}"),
        ("credential rotate", rotated_payload, f"credential:rotate target={rotate_id}"),
        ("credential revoke", revoked_payload, f"credential:revoke target={revoke_id}"),
    ):
        await _require_audit(
            failures,
            label,
            harness,
            project_id,
            payload,
            principal_id=admin.user["id"],
            action=action,
        )
    assert not failures, "\n".join(failures)


async def test_admin_session_pat_and_oauth_share_one_authority_and_audit_contract(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    project_slug = unique_slug("admin-auth-parity")
    project_id = await harness.setup_project(project_slug, [("general", 0)])
    identity = IdentityService(harness.sm)
    failures: list[str] = []

    async with _client(harness, tmp_path) as client:
        admin, session_headers, _ = await _actor_with_membership(
            identity, client, project_id, project_role="project-admin"
        )
        membership = await _membership_row(harness, project_id, admin.user["id"])
        if membership is None:
            failures.append("auth parity fixture: admin membership disappeared")
            membership_id = str(uuid.UUID(int=0))
        else:
            membership_id = str(membership["id"])
        pat = await identity.issue_pat(membership_id, name="admin-parity")
        oauth_token = f"oauth-{uuid.uuid4().hex}"
        await _issue_oauth(harness, membership_id, oauth_token)
        credential_headers = (
            ("session", session_headers, f"?project={project_slug}"),
            ("pat", {"Authorization": f"Bearer {pat.token}"}, ""),
            ("oauth", {"Authorization": f"Bearer {oauth_token}"}, ""),
        )
        reads: list[tuple[str, httpx.Response]] = []
        writes: list[tuple[str, str, httpx.Response]] = []
        for kind, headers, query in credential_headers:
            reads.append((kind, await client.get(f"/api/v1/admin/topics{query}", headers=headers)))
            slug = unique_slug(f"parity-{kind}")
            writes.append(
                (
                    kind,
                    slug,
                    await client.post(
                        f"/api/v1/admin/topics{query}",
                        headers=headers,
                        json={"slug": slug, "name": f"Created through {kind}"},
                    ),
                )
            )

    if await resolve_scope(harness.sm, pat.token) is None:
        failures.append("auth parity control: PAT was not a live project credential")
    if await resolve_scope(harness.sm, oauth_token) is None:
        failures.append("auth parity control: OAuth token was not a live project credential")
    for kind, response in reads:
        _status(failures, f"{kind} admin read", response, 200)
    for kind, slug, response in writes:
        _status(failures, f"{kind} admin mutation", response, 201)
        if await _topic_row(harness, project_id, slug) is None:
            failures.append(f"{kind} admin mutation did not persist its topic")
        await _require_audit(
            failures,
            f"{kind} admin mutation",
            harness,
            project_id,
            _object(response),
            principal_id=admin.user["id"],
            action=f"topic:create target={slug}",
        )
    assert not failures, "\n".join(failures)


async def test_management_rate_limit_is_a_deterministic_429_contract(
    build_harness: Callable[..., Harness],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    harness = build_harness()
    identity = IdentityService(harness.sm)
    owner = await _active_user(identity, platform_role="owner")
    slug = unique_slug("rate-limited-project")

    async def limited_create(_service: IdentityService, *_args: object, **_kwargs: object) -> str:
        raise RateLimitedError("management command budget exhausted", retry_after=17)

    # Fault injection is only at the rate-limit boundary. Authentication, authorization, ASGI and
    # persistence remain real; there is no request-count race or global mutable budget.
    monkeypatch.setattr(IdentityService, "create_project", limited_create)
    async with _client(harness, tmp_path) as client:
        owner_headers, _ = await _session(client, owner)
        response = await client.post(
            "/api/v1/admin/projects",
            headers=owner_headers,
            json={"slug": slug, "name": "Must be rate limited"},
        )

    failures: list[str] = []
    _status(failures, "management rate limit", response, 429)
    if response.headers.get("Retry-After") != "17":
        failures.append("management rate limit: Retry-After must preserve the service delay")
    payload = _required(failures, "management rate limit", response, {"detail", "retry_after"})
    if payload is not None and (
        payload.get("detail") != "management command budget exhausted"
        or payload.get("retry_after") != 17
    ):
        failures.append("management rate limit: safe typed body differs from the service outcome")
    if await _project_row(harness, slug) is not None:
        failures.append("management rate limit: rejected command persisted a project")
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
    failures: list[str] = []

    async with _client(harness, tmp_path) as client:
        admin, admin_headers, _ = await _actor_with_membership(
            identity, client, project_id, project_role="project-admin"
        )
        target_session_headers, target_session = await _session(client, target)
        membership = await client.post(
            f"/api/v1/admin/memberships?project={project_slug}",
            headers=admin_headers,
            json={"user_id": target.user["id"], "role": "viewer", "can_curate": False},
        )
        memberships_after_create = await client.get(
            f"/api/v1/admin/memberships?project={project_slug}", headers=admin_headers
        )
        membership_payload = _object(membership)
        created_meta_raw = (
            membership_payload.get("membership") if membership_payload is not None else None
        )
        membership_version = (
            created_meta_raw.get("version") if isinstance(created_meta_raw, dict) else None
        )
        if not isinstance(membership_version, int):
            membership_version = -1
        stored_membership = await _membership_row(harness, project_id, target.user["id"])
        if stored_membership is None:
            membership_id = await identity.add_membership(
                target.user["id"], project_id, role="viewer", allowed_topics=()
            )
        else:
            membership_id = str(stored_membership["id"])
        target_pat = await identity.issue_pat(membership_id, name="authority-transition")
        changed = await client.patch(
            f"/api/v1/admin/memberships/{target.user['id']}?project={project_slug}",
            headers=admin_headers,
            json={
                "expected_version": membership_version,
                "role": "member",
                "allowed_topics": ["general"],
                "can_curate": True,
            },
        )
        stale_membership = await client.patch(
            f"/api/v1/admin/memberships/{target.user['id']}?project={project_slug}",
            headers=admin_headers,
            json={
                "expected_version": membership_version,
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
        topic_meta_raw = topic_payload.get("topic") if topic_payload is not None else None
        topic_version = topic_meta_raw.get("version") if isinstance(topic_meta_raw, dict) else None
        if not isinstance(topic_version, int):
            topic_version = -1
        scope_after_topic_create = await resolve_scope(harness.sm, target_pat.token)
        edited_topic = await client.patch(
            f"/api/v1/admin/topics/{topic_slug}?project={project_slug}",
            headers=admin_headers,
            json={
                "expected_version": topic_version,
                "name": "Highly sensitive",
                "sensitivity": 5,
            },
        )
        stale_topic = await client.patch(
            f"/api/v1/admin/topics/{topic_slug}?project={project_slug}",
            headers=admin_headers,
            json={
                "expected_version": topic_version,
                "sensitivity": 1,
            },
        )
        changed_payload_raw = _object(changed)
        changed_after_raw = (
            changed_payload_raw.get("after") if changed_payload_raw is not None else None
        )
        changed_version = (
            changed_after_raw.get("version") if isinstance(changed_after_raw, dict) else None
        )
        if not isinstance(changed_version, int):
            changed_version = -1
        grant_sensitive = await client.patch(
            f"/api/v1/admin/memberships/{target.user['id']}?project={project_slug}",
            headers=admin_headers,
            json={
                "expected_version": changed_version,
                "role": "member",
                "allowed_topics": ["general", topic_slug],
                "can_curate": True,
            },
        )
        grant_payload_raw = _object(grant_sensitive)
        grant_after_raw = grant_payload_raw.get("after") if grant_payload_raw is not None else None
        grant_version = (
            grant_after_raw.get("version") if isinstance(grant_after_raw, dict) else None
        )
        if not isinstance(grant_version, int):
            grant_version = -1
        scope_after_grant = await resolve_scope(harness.sm, target_pat.token)
        started = time.monotonic()
        revoke_sensitive = await client.patch(
            f"/api/v1/admin/memberships/{target.user['id']}?project={project_slug}",
            headers=admin_headers,
            json={
                "expected_version": grant_version,
                "role": "member",
                "allowed_topics": ["general"],
                "can_curate": True,
            },
        )
        scope_after_revoke = await resolve_scope(harness.sm, target_pat.token)
        session_after_revoke = await client.get("/api/v1/me", headers=target_session_headers)
        revocation_elapsed = time.monotonic() - started
        topics_after_stale = await client.get(
            f"/api/v1/admin/topics?project={project_slug}", headers=admin_headers
        )
        memberships_final = await client.get(
            f"/api/v1/admin/memberships?project={project_slug}", headers=admin_headers
        )

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
        ("grant sensitive topic", grant_sensitive, 200),
        ("revoke sensitive topic", revoke_sensitive, 200),
        ("session reread after authority reduction", session_after_revoke, 200),
        ("membership final reread", memberships_final, 200),
    ):
        _status(failures, label, response, expected)
    created_membership = _required(
        failures, "membership create", membership, {"membership", "audit_correlation"}
    )
    created_membership_meta = _mapping_field(
        failures, "membership create", created_membership, "membership"
    )
    created_topic = _required(failures, "topic create", topic, {"topic", "audit_correlation"})
    created_topic_meta = _mapping_field(failures, "topic create", created_topic, "topic")
    expected_membership_create = {
        "id": _uuid_string(
            created_membership_meta.get("id") if created_membership_meta is not None else None
        ),
        "user_id": target.user["id"],
        "role": "viewer",
        "allowed_topics": [],
        "can_curate": False,
        "version": (
            created_membership_meta.get("version") if created_membership_meta is not None else None
        ),
    }
    if created_membership_meta != expected_membership_create or not isinstance(
        expected_membership_create["version"], int
    ):
        failures.append(
            "membership create: exact restrictive state and integer server version are required"
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
        if target_row != created_membership_meta:
            failures.append("membership create: immediate reread differs from the create state")
    changed_payload = _required(
        failures, "membership update", changed, {"before", "after", "audit_correlation"}
    )
    changed_before = _mapping_field(failures, "membership update", changed_payload, "before")
    changed_after = _mapping_field(failures, "membership update", changed_payload, "after")
    changed_after_version = _int_field(failures, "membership update", changed_after, "version")
    if changed_before != created_membership_meta:
        failures.append("membership update: before must equal the last authoritative state")
    expected_changed = {
        **(created_membership_meta or {}),
        "role": "member",
        "allowed_topics": ["general"],
        "can_curate": True,
        "version": changed_after_version,
    }
    if changed_after != expected_changed:
        failures.append("membership update: after must exactly reflect requested authority")
    if (
        isinstance(expected_membership_create["version"], int)
        and changed_after_version is not None
        and changed_after_version <= expected_membership_create["version"]
    ):
        failures.append("membership update: server version did not advance")
    stale_payload = _required(failures, "stale membership update", stale_membership, {"current"})
    if stale_payload is not None and stale_payload.get("current") != changed_after:
        failures.append("stale membership update: conflict did not return unchanged current state")
    stale_listing = _required(
        failures,
        "membership reread after stale update",
        memberships_after_stale,
        {"memberships"},
    )
    stale_rows = _list_field(
        failures, "membership reread after stale update", stale_listing, "memberships"
    )
    stale_row = (
        next(
            (
                row
                for row in stale_rows
                if isinstance(row, dict) and row.get("user_id") == target.user["id"]
            ),
            None,
        )
        if stale_rows is not None
        else None
    )
    if stale_row != changed_after:
        failures.append("stale membership update: reread changed despite the conflict")
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
        if target_row != created_topic_meta:
            failures.append("topic create: immediate reread differs from the create state")
    topic_create_version = _int_field(failures, "topic create", created_topic_meta, "version")
    expected_topic_create = {
        "id": _uuid_string(
            created_topic_meta.get("id") if created_topic_meta is not None else None
        ),
        "slug": topic_slug,
        "name": "Sensitive",
        "sensitivity": 4,
        "status": "active",
        "version": topic_create_version,
    }
    if created_topic_meta != expected_topic_create:
        failures.append("topic create: exact sensitive state and server version are required")
    edited_payload = _required(
        failures, "topic update", edited_topic, {"before", "after", "audit_correlation"}
    )
    topic_before = _mapping_field(failures, "topic update", edited_payload, "before")
    topic_after = _mapping_field(failures, "topic update", edited_payload, "after")
    topic_after_version = _int_field(failures, "topic update", topic_after, "version")
    expected_topic_after = {
        **(created_topic_meta or {}),
        "name": "Highly sensitive",
        "sensitivity": 5,
        "version": topic_after_version,
    }
    if topic_before != created_topic_meta or topic_after != expected_topic_after:
        failures.append("topic update: before/after does not describe the exact transition")
    if (
        topic_create_version is not None
        and topic_after_version is not None
        and topic_after_version <= topic_create_version
    ):
        failures.append("topic update: server version did not advance")
    stale_topic_payload = _required(failures, "stale topic update", stale_topic, {"current"})
    if stale_topic_payload is not None and stale_topic_payload.get("current") != topic_after:
        failures.append("stale topic update: conflict did not return unchanged current state")
    topic_final_listing = _required(
        failures, "topic reread after stale update", topics_after_stale, {"topics"}
    )
    topic_final_rows = _list_field(
        failures, "topic reread after stale update", topic_final_listing, "topics"
    )
    topic_final = (
        next(
            (
                row
                for row in topic_final_rows
                if isinstance(row, dict) and row.get("slug") == topic_slug
            ),
            None,
        )
        if topic_final_rows is not None
        else None
    )
    if topic_final != topic_after:
        failures.append("stale topic update: reread changed despite the conflict")
    if scope_after_topic_create is None or topic_slug in scope_after_topic_create.allowed_topics:
        failures.append("sensitive topic default: existing membership gained the new topic")
    grant_payload = _required(
        failures, "grant sensitive topic", grant_sensitive, {"before", "after", "audit_correlation"}
    )
    grant_before = _mapping_field(failures, "grant sensitive topic", grant_payload, "before")
    grant_after = _mapping_field(failures, "grant sensitive topic", grant_payload, "after")
    grant_after_version = _int_field(failures, "grant sensitive topic", grant_after, "version")
    expected_grant = {
        **(changed_after or {}),
        "allowed_topics": ["general", topic_slug],
        "version": grant_after_version,
    }
    if grant_before != changed_after or grant_after != expected_grant:
        failures.append("membership topic grant: before/after is not exact")
    if scope_after_grant is None or topic_slug not in scope_after_grant.allowed_topics:
        failures.append("membership topic grant: live PAT authority did not update")
    revoke_payload = _required(
        failures,
        "revoke sensitive topic",
        revoke_sensitive,
        {"before", "after", "audit_correlation"},
    )
    revoke_before = _mapping_field(failures, "revoke sensitive topic", revoke_payload, "before")
    revoke_after = _mapping_field(failures, "revoke sensitive topic", revoke_payload, "after")
    revoke_after_version = _int_field(failures, "revoke sensitive topic", revoke_after, "version")
    expected_revoke = {
        **(grant_after or {}),
        "allowed_topics": ["general"],
        "version": revoke_after_version,
    }
    if revoke_before != grant_after or revoke_after != expected_revoke:
        failures.append("membership topic revoke: before/after is not exact")
    if scope_after_revoke is None or topic_slug in scope_after_revoke.allowed_topics:
        failures.append("membership topic revoke: live PAT retained withdrawn authority")
    if revocation_elapsed >= 5.0:
        failures.append(
            f"membership topic revoke took {revocation_elapsed:.3f}s to reach PAT/session reads"
        )
    session_payload = _object(session_after_revoke)
    session_memberships = (
        session_payload.get("memberships") if session_payload is not None else None
    )
    session_membership = (
        next(
            (
                row
                for row in session_memberships
                if isinstance(row, dict) and row.get("project") == project_slug
            ),
            None,
        )
        if isinstance(session_memberships, list)
        else None
    )
    if not isinstance(session_membership, dict) or session_membership.get("allowed_topics") != [
        "general"
    ]:
        failures.append("membership topic revoke: live console session retained stale authority")
    final_listing = _required(
        failures, "membership final reread", memberships_final, {"memberships"}
    )
    final_rows = _list_field(failures, "membership final reread", final_listing, "memberships")
    final_row = (
        next(
            (
                row
                for row in final_rows
                if isinstance(row, dict) and row.get("user_id") == target.user["id"]
            ),
            None,
        )
        if final_rows is not None
        else None
    )
    if final_row != revoke_after:
        failures.append("membership final reread differs from the last authoritative transition")
    for label, payload, action in (
        ("membership create", created_membership, f"membership:create target={target.user['id']}"),
        ("membership update", changed_payload, f"membership:update target={target.user['id']}"),
        ("topic create", created_topic, f"topic:create target={topic_slug}"),
        ("topic update", edited_payload, f"topic:update target={topic_slug}"),
        ("membership topic grant", grant_payload, f"membership:update target={target.user['id']}"),
        (
            "membership topic revoke",
            revoke_payload,
            f"membership:update target={target.user['id']}",
        ),
    ):
        await _require_audit(
            failures,
            label,
            harness,
            project_id,
            payload,
            principal_id=admin.user["id"],
            action=action,
        )
    assert target_session
    assert not failures, "\n".join(failures)
