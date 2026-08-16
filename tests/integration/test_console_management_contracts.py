"""RED HTTP contracts for complete console-governance lifecycles (T005).

The tests describe the management API the console needs rather than accepting today's partial
routes. Authorization, persistence and rate-limit probes use the real ASGI app and Postgres. The
management limiter is a deterministic wrapper around the production Postgres quota collaborator,
injected through the API dependency boundary that T006 must expose.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import time
import uuid
from collections.abc import AsyncIterator, Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, fields
from pathlib import Path
from typing import TypedDict, TypeGuard

import httpx
import pytest
from sqlalchemy import delete, select

from rsc_brain import security
from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.audit import query_audit_raw
from rsc_brain.identity.resolve import resolve_scope
from rsc_brain.identity.service import IdentityService
from rsc_brain.identity.sessions import resolve_session
from rsc_brain.mcp.quotas import QuotaConfig, QuotaService
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker
from tests.integration.conftest import Harness, unique_slug

_PASSWORD = "correct horse battery staple"  # Integration fixture only.

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
async def _isolate_management_projects(migrated_dsn: str) -> AsyncIterator[None]:
    """Keep exact inventory contracts independent on the session-scoped Postgres container.

    The integration container intentionally survives the whole pytest session. Management tests,
    however, assert exact tenant inventories, so every project created by one test must be removed
    before the next test starts. Global users may remain because every fixture address is unique.
    """

    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    async with sessionmaker() as session:
        await session.execute(delete(models.Project))
        await session.commit()
    try:
        yield
    finally:
        async with sessionmaker() as session:
            await session.execute(delete(models.Project))
            await session.commit()
        await engine.dispose()


class UserShape(TypedDict):
    id: str


@dataclass(frozen=True, slots=True)
class ActiveUser:
    """One fixture shape everywhere: callers use ``actor.user[\"id\"]`` only."""

    email: str
    user: UserShape


class FixedWindowManagementLimiter:
    """Real Postgres quota accounting behind T006's injectable management boundary."""

    def __init__(self, quota: QuotaService, *, now: dt.datetime) -> None:
        self._quota = quota
        self._now = now
        self.calls: list[tuple[str, str]] = []

    async def consume(self, scope: ProjectScope, operation: str) -> None:
        self.calls.append((scope.principal_id, operation))
        await self._quota.consume(scope, "write", now=self._now)


def _client(
    harness: Harness, tmp_path: Path, *, management_limiter: object | None = None
) -> httpx.AsyncClient:
    deps = ApiDeps(sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path))
    if management_limiter is not None and "management_limiter" in {
        field.name for field in fields(ApiDeps)
    }:
        object.__setattr__(deps, "management_limiter", management_limiter)
    app = create_app(deps=deps)
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
    payload = _object(response)
    if payload is not None and _contains_boolean_version(payload):
        failures.append(f"{label}: every response version must reject bool as an integer version")


def _contains_boolean_version(value: object) -> bool:
    if isinstance(value, dict):
        return any(
            (name == "version" and isinstance(item, bool)) or _contains_boolean_version(item)
            for name, item in value.items()
        )
    if isinstance(value, list):
        return any(_contains_boolean_version(item) for item in value)
    return False


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
    if not _is_version(value):
        failures.append(f"{label}: {name} must be an integer server version")
        return None
    return value


def _is_version(value: object) -> TypeGuard[int]:
    return not isinstance(value, bool) and isinstance(value, int)


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


def _idempotent_replay(
    failures: list[str],
    label: str,
    original: httpx.Response,
    replay: httpx.Response,
    *,
    original_status: int,
    secret_fields: Iterable[str] = (),
) -> tuple[dict[str, object] | None, dict[str, object] | None]:
    """Require one authoritative transition and an exact, non-secret replay envelope."""

    _status(failures, label, original, original_status)
    _status(failures, f"{label} replay", replay, 200)
    original_payload = _object(original)
    replay_payload = _object(replay)
    if original_payload is None or replay_payload is None:
        failures.append(f"{label}: original and replay must both be object envelopes")
        return original_payload, replay_payload
    expected = {
        name: value for name, value in original_payload.items() if name not in set(secret_fields)
    }
    expected["replayed"] = True
    if replay_payload != expected:
        failures.append(
            f"{label}: same idempotency key must return exact prior outcome plus replayed=true"
        )
    if replay_payload.get("audit_correlation") != original_payload.get("audit_correlation"):
        failures.append(f"{label}: replay must reuse the original persisted audit correlation")
    if any(name in replay_payload for name in secret_fields):
        failures.append(f"{label}: replay exposed a single-display secret")
    return original_payload, replay_payload


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


async def _user_row(harness: Harness, user_id: str) -> dict[str, object] | None:
    async with harness.sm() as session:
        row = await session.scalar(select(models.User).where(models.User.id == uuid.UUID(user_id)))
    if row is None:
        return None
    return {
        "id": str(row.id),
        "email": row.email,
        "display_name": row.display_name,
        "status": row.status,
        "role": row.role,
        "password_hash": row.password_hash,
        "version": getattr(row, "version", None),
    }


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
    forbidden_values: Iterable[str] = (),
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
    serialized = repr(row)
    if any(value and value in serialized for value in forbidden_values):
        failures.append(f"{label}: audit row leaked forbidden cross-project identifiers")


async def _matching_audits(
    harness: Harness,
    project_id: str,
    *,
    principal_id: str,
    action: str,
    denied: bool | None,
) -> list[dict[str, object]]:
    return await query_audit_raw(
        harness.sm,
        project_id,
        principal_type="human",
        principal_id=principal_id,
        action=action,
        tool="console",
        denied=denied,
        limit=500,
    )


async def _project_row(harness: Harness, slug: str) -> dict[str, object] | None:
    async with harness.sm() as session:
        row = await session.scalar(select(models.Project).where(models.Project.slug == slug))
    if row is None:
        return None
    return {
        "id": str(row.id),
        "slug": slug,
        "name": row.name,
        "settings": row.settings,
        "status": getattr(row, "status", None),
        "version": getattr(row, "version", None),
    }


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
        "status": getattr(row, "status", None),
        "version": getattr(row, "version", None),
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
    return {
        "id": str(row.id),
        "slug": row.slug,
        "name": row.name,
        "sensitivity": row.sensitivity,
        "hard_window_days": row.hard_window_days,
        "status": getattr(row, "status", None),
        "version": getattr(row, "version", None),
    }


async def _topic_state(
    harness: Harness, project_id: str
) -> tuple[tuple[str, str, str, int, int | None, object, object], ...]:
    async with harness.sm() as session:
        rows = (
            await session.scalars(
                select(models.Topic)
                .where(models.Topic.project_id == uuid.UUID(project_id))
                .order_by(models.Topic.slug)
            )
        ).all()
    return tuple(
        (
            str(row.id),
            row.slug,
            row.name,
            row.sensitivity,
            row.hard_window_days,
            getattr(row, "status", None),
            getattr(row, "version", None),
        )
        for row in rows
    )


async def _rate_window_count(
    harness: Harness, principal_id: str, window_start: dt.datetime
) -> int | None:
    async with harness.sm() as session:
        value = await session.scalar(
            select(models.PrincipalRateWindow.count).where(
                models.PrincipalRateWindow.principal_id == principal_id,
                models.PrincipalRateWindow.window_start == window_start,
            )
        )
    return value if isinstance(value, int) else None


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
) -> tuple[tuple[str, str | None, str, str | None, str | None, object, object], ...]:
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
                credential.token_hash,
                credential.expires_at.isoformat() if credential.expires_at is not None else None,
                credential.revoked_at.isoformat() if credential.revoked_at is not None else None,
                getattr(credential, "status", None),
                getattr(credential, "version", None),
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
    project_before = await _project_row(harness, project_slug)
    user_before = await _user_row(harness, target.user["id"])
    membership_before = await _membership_row(harness, project_id, target.user["id"])
    credential_before = await _membership_pat_state(harness, target_membership_id)
    topics_before = await _topic_state(harness, project_id)
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
        malformed_membership_before = await _membership_row(
            harness, project_id, owner_without_membership.user["id"]
        )
        malformed_user_before = await _user_row(harness, owner_without_membership.user["id"])

        platform_inventory = await client.get("/api/v1/admin/projects", headers=owner_headers)
        owner_project_read = await client.get(
            f"/api/v1/admin/projects/{project_slug}", headers=owner_headers
        )
        owner_user_list = await client.get(
            f"/api/v1/admin/users?project={project_slug}", headers=owner_headers
        )
        owner_credential_list = await client.get(
            f"/api/v1/admin/users/{target.user['id']}/credentials?project={project_slug}",
            headers=owner_headers,
        )
        owner_membership_list = await client.get(
            f"/api/v1/admin/memberships?project={project_slug}", headers=owner_headers
        )
        owner_topic_list = await client.get(
            f"/api/v1/admin/topics?project={project_slug}", headers=owner_headers
        )
        owner_disable = await client.post(
            f"/api/v1/admin/users/{target.user['id']}/disable?project={project_slug}",
            headers={**owner_headers, "Idempotency-Key": "actor-owner-disable"},
            json={"expected_status": "active", "impact_acknowledged": True},
        )
        owner_credential_revoke = await client.delete(
            f"/api/v1/admin/credentials/{target_pat.id}?project={project_slug}",
            headers={**owner_headers, "Idempotency-Key": "actor-owner-credential"},
            params={"expected_version": 1},
        )
        owner_membership_mutation = await client.patch(
            f"/api/v1/admin/memberships/{target.user['id']}?project={project_slug}",
            headers={**owner_headers, "Idempotency-Key": "actor-owner-membership"},
            json={"expected_version": 1, "role": "project-admin"},
        )
        owner_project_content = await client.post(
            f"/api/v1/admin/topics?project={project_slug}",
            headers={**owner_headers, "Idempotency-Key": "actor-owner-topic"},
            json={"slug": owner_slug, "name": "must stay hidden"},
        )
        admin_global_inventory = await client.get("/api/v1/admin/projects", headers=admin_headers)
        admin_global_create = await client.post(
            "/api/v1/admin/projects",
            headers={**admin_headers, "Idempotency-Key": "actor-admin-global"},
            json={"slug": denied_project_slug, "name": "must not exist"},
        )
        admin_project_content = await client.post(
            f"/api/v1/admin/topics?project={project_slug}",
            headers={**admin_headers, "Idempotency-Key": "actor-admin-topic"},
            json={"slug": admin_topic_slug, "name": "project control"},
        )
        curator_mutation = await client.post(
            f"/api/v1/admin/topics?project={project_slug}",
            headers={**curator_headers, "Idempotency-Key": "actor-curator-topic"},
            json={"slug": curator_slug, "name": "no admin write"},
        )
        member_mutation = await client.post(
            f"/api/v1/admin/topics?project={project_slug}",
            headers={**member_headers, "Idempotency-Key": "actor-member-topic"},
            json={"slug": member_slug, "name": "no admin write"},
        )
        viewer_mutation = await client.post(
            f"/api/v1/admin/topics?project={project_slug}",
            headers={**viewer_headers, "Idempotency-Key": "actor-viewer-topic"},
            json={"slug": viewer_slug, "name": "no admin write"},
        )
        foreign_project = await client.post(
            f"/api/v1/admin/topics?project={project_slug}",
            headers={**foreign_headers, "Idempotency-Key": "actor-foreign-topic"},
            json={"slug": foreign_topic_slug, "name": "foreign"},
        )
        foreign_project_read = await client.get(
            f"/api/v1/admin/projects/{project_slug}", headers=foreign_headers
        )
        foreign_project_settings = await client.patch(
            f"/api/v1/admin/projects/{project_slug}",
            headers={**foreign_headers, "Idempotency-Key": "actor-foreign-project"},
            json={"expected_version": 1, "settings": {"retention_days": 999}},
        )
        foreign_user_list = await client.get(
            f"/api/v1/admin/users?project={project_slug}", headers=foreign_headers
        )
        foreign_credential_list = await client.get(
            f"/api/v1/admin/users/{target.user['id']}/credentials?project={project_slug}",
            headers=foreign_headers,
        )
        foreign_membership_list = await client.get(
            f"/api/v1/admin/memberships?project={project_slug}", headers=foreign_headers
        )
        foreign_topic_list = await client.get(
            f"/api/v1/admin/topics?project={project_slug}", headers=foreign_headers
        )
        rejected_credential = await client.post(
            f"/api/v1/admin/topics?project={project_slug}",
            headers={
                "Authorization": "Bearer rejected-credential",
                "Idempotency-Key": "actor-rejected-credential",
            },
            json={"slug": invalid_slug, "name": "rejected"},
        )
        malformed_role = await client.post(
            f"/api/v1/admin/memberships?project={project_slug}",
            headers={**admin_headers, "Idempotency-Key": "actor-invalid-role"},
            json={"user_id": owner_without_membership.user["id"], "role": "not-a-project-role"},
        )
        denied_disable = await client.post(
            f"/api/v1/admin/users/{target.user['id']}/disable?project={project_slug}",
            headers={**viewer_headers, "Idempotency-Key": "actor-viewer-disable"},
            json={"expected_status": "active", "impact_acknowledged": True},
        )
        denied_credential = await client.post(
            f"/api/v1/admin/users/{target.user['id']}/credentials?project={project_slug}",
            headers={**curator_headers, "Idempotency-Key": "actor-curator-credential"},
            json={"name": "must-not-exist", "kind": "pat"},
        )
        denied_membership = await client.patch(
            f"/api/v1/admin/memberships/{target.user['id']}?project={project_slug}",
            headers={**member_headers, "Idempotency-Key": "actor-member-membership"},
            json={"expected_version": 1, "role": "project-admin"},
        )
        foreign_disable = await client.post(
            f"/api/v1/admin/users/{target.user['id']}/disable?project={project_slug}",
            headers={**foreign_headers, "Idempotency-Key": "actor-foreign-disable"},
            json={"expected_status": "active", "impact_acknowledged": True},
        )
        foreign_credential = await client.delete(
            f"/api/v1/admin/credentials/{target_pat.id}?project={project_slug}",
            headers={**foreign_headers, "Idempotency-Key": "actor-foreign-credential"},
            params={"expected_version": 1},
        )
        foreign_membership = await client.patch(
            f"/api/v1/admin/memberships/{target.user['id']}?project={project_slug}",
            headers={**foreign_headers, "Idempotency-Key": "actor-foreign-membership"},
            json={"expected_version": 1, "role": "project-admin"},
        )

    failures: list[str] = []
    for label, response, expected in (
        ("owner without membership reads platform inventory", platform_inventory, 200),
        ("owner without membership reads project lifecycle/settings", owner_project_read, 200),
        ("owner without membership cannot list project users", owner_user_list, 404),
        ("owner without membership cannot list project credentials", owner_credential_list, 404),
        ("owner without membership cannot list project memberships", owner_membership_list, 404),
        ("owner without membership cannot list project topics", owner_topic_list, 404),
        ("owner without membership cannot disable a project user", owner_disable, 404),
        (
            "owner without membership cannot revoke a project credential",
            owner_credential_revoke,
            404,
        ),
        (
            "owner without membership cannot alter a project membership",
            owner_membership_mutation,
            404,
        ),
        ("owner without membership cannot mutate project content", owner_project_content, 404),
        ("project-admin cannot read platform inventory", admin_global_inventory, 403),
        ("project-admin cannot create a global project", admin_global_create, 403),
        ("project-admin mutates its project", admin_project_content, 201),
        ("curator cannot mutate project configuration", curator_mutation, 403),
        ("member cannot mutate project configuration", member_mutation, 403),
        ("viewer cannot mutate project configuration", viewer_mutation, 403),
        ("project-admin cannot reach foreign project", foreign_project, 404),
        ("foreign project-admin cannot read project settings", foreign_project_read, 404),
        ("foreign project-admin cannot patch project settings", foreign_project_settings, 404),
        ("foreign project-admin cannot list users", foreign_user_list, 404),
        ("foreign project-admin cannot list credentials", foreign_credential_list, 404),
        ("foreign project-admin cannot list memberships", foreign_membership_list, 404),
        ("foreign project-admin cannot list topics", foreign_topic_list, 404),
        ("rejected credential", rejected_credential, 401),
        ("bad membership role", malformed_role, 400),
        ("viewer cannot disable users", denied_disable, 403),
        ("curator cannot create third-party credentials", denied_credential, 403),
        ("member cannot alter memberships", denied_membership, 403),
        ("foreign admin cannot disable project user", foreign_disable, 404),
        ("foreign admin cannot revoke project credential", foreign_credential, 404),
        ("foreign admin cannot alter project membership", foreign_membership, 404),
    ):
        _status(failures, label, response, expected)
    foreign_absent_responses = (
        ("foreign topic create", foreign_project),
        ("foreign project read", foreign_project_read),
        ("foreign project update", foreign_project_settings),
        ("foreign user list", foreign_user_list),
        ("foreign credential list", foreign_credential_list),
        ("foreign membership list", foreign_membership_list),
        ("foreign topic list", foreign_topic_list),
        ("foreign user mutation", foreign_disable),
        ("foreign credential mutation", foreign_credential),
        ("foreign membership mutation", foreign_membership),
    )
    foreign_fingerprints: list[tuple[int, frozenset[str], object, object]] = []
    cross_project_values = (
        project_id,
        project_slug,
        target.user["id"],
        target_pat.id,
        foreign_topic_slug,
    )
    for label, response in foreign_absent_responses:
        payload = _object(response)
        correlation = _correlation_id(failures, label, payload)
        if payload is None or set(payload) != {"detail", "audit_correlation"}:
            failures.append(f"{label}: 404 body must use the exact absence allowlist")
            continue
        fingerprint = (
            response.status_code,
            frozenset(payload),
            payload.get("detail"),
            type(payload.get("audit_correlation")),
        )
        foreign_fingerprints.append(fingerprint)
        if payload.get("detail") != "not found" or correlation is None:
            failures.append(f"{label}: 404 must be generic absence plus a safe correlation")
        if _contains_secret((response,), cross_project_values):
            failures.append(f"{label}: response/header leaked a project-B identifier")
    if foreign_fingerprints and len(set(foreign_fingerprints)) != 1:
        failures.append("foreign 404 responses are distinguishable by status, shape or detail")
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
    owner_project_payload = _required(
        failures,
        "owner project lifecycle/settings",
        owner_project_read,
        {"id", "slug", "name", "settings", "status", "version"},
    )
    if owner_project_payload is not None and (
        set(owner_project_payload) != {"id", "slug", "name", "settings", "status", "version"}
        or owner_project_payload.get("id") != (project_before or {}).get("id")
        or owner_project_payload.get("slug") != project_slug
        or owner_project_payload.get("name") != (project_before or {}).get("name")
        or owner_project_payload.get("settings") != (project_before or {}).get("settings")
        or owner_project_payload.get("status") != "active"
        or not _is_version(owner_project_payload.get("version"))
    ):
        failures.append("owner project read must be exact lifecycle/settings without content")
    if await _project_row(harness, project_slug) != project_before:
        failures.append("denied project operations changed the existing project")
    if await _project_row(harness, denied_project_slug) is not None:
        failures.append("denied project create persisted a project")
    if await _user_row(harness, target.user["id"]) != user_before:
        failures.append("denied user operations changed the target identity")
    if not await _pat_is_active(harness, target_pat.id):
        failures.append("denied credential mutation revoked the target credential")
    if await _membership_pat_state(harness, target_membership_id) != credential_before:
        failures.append("denied credential mutations changed persisted credentials")
    if await _membership_row(harness, project_id, target.user["id"]) != membership_before:
        failures.append("denied membership mutation changed persisted authority")
    if (
        malformed_membership_before is not None
        or await _membership_row(harness, project_id, owner_without_membership.user["id"])
        is not None
    ):
        failures.append("invalid membership role created or changed a membership")
    if await _user_row(harness, owner_without_membership.user["id"]) != malformed_user_before:
        failures.append("invalid membership role changed the target identity")
    for slug in forbidden_slugs:
        if await _topic_row(harness, project_id, slug) is not None:
            failures.append(f"denied topic mutation persisted {slug}")
    if await _topic_row(harness, project_id, admin_topic_slug) is None:
        failures.append("authorized project-admin topic mutation did not persist")
    topics_after = await _topic_state(harness, project_id)
    if tuple(row for row in topics_after if row[1] != admin_topic_slug) != topics_before:
        failures.append("denied topic operations changed the pre-existing taxonomy")
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
    for label, response, principal_id, action in (
        (
            "owner user list denial",
            owner_user_list,
            owner_without_membership.user["id"],
            f"identity:list target={project_slug}",
        ),
        (
            "owner credential list denial",
            owner_credential_list,
            owner_without_membership.user["id"],
            f"credential:list target={target.user['id']}",
        ),
        (
            "owner membership list denial",
            owner_membership_list,
            owner_without_membership.user["id"],
            f"membership:list target={project_slug}",
        ),
        (
            "owner topic list denial",
            owner_topic_list,
            owner_without_membership.user["id"],
            f"topic:list target={project_slug}",
        ),
        (
            "owner user mutation denial",
            owner_disable,
            owner_without_membership.user["id"],
            f"identity:disable target={target.user['id']}",
        ),
        (
            "owner credential mutation denial",
            owner_credential_revoke,
            owner_without_membership.user["id"],
            f"credential:revoke target={target_pat.id}",
        ),
        (
            "owner membership mutation denial",
            owner_membership_mutation,
            owner_without_membership.user["id"],
            f"membership:update target={target.user['id']}",
        ),
        (
            "owner topic create denial",
            owner_project_content,
            owner_without_membership.user["id"],
            f"topic:create target={owner_slug}",
        ),
        (
            "project-admin global list denial",
            admin_global_inventory,
            admin_actor.user["id"],
            "project:list target=global",
        ),
        (
            "project-admin global create denial",
            admin_global_create,
            admin_actor.user["id"],
            f"project:create target={denied_project_slug}",
        ),
        (
            "curator topic denial",
            curator_mutation,
            curator_actor.user["id"],
            f"topic:create target={curator_slug}",
        ),
        (
            "member topic denial",
            member_mutation,
            member_actor.user["id"],
            f"topic:create target={member_slug}",
        ),
        (
            "viewer topic denial",
            viewer_mutation,
            viewer_actor.user["id"],
            f"topic:create target={viewer_slug}",
        ),
        (
            "foreign topic create denial",
            foreign_project,
            foreign_admin.user["id"],
            "topic:create denied",
        ),
        (
            "foreign project read denial",
            foreign_project_read,
            foreign_admin.user["id"],
            "project:read denied",
        ),
        (
            "foreign project update denial",
            foreign_project_settings,
            foreign_admin.user["id"],
            "project:update denied",
        ),
        (
            "foreign user list denial",
            foreign_user_list,
            foreign_admin.user["id"],
            "identity:list denied",
        ),
        (
            "foreign credential list denial",
            foreign_credential_list,
            foreign_admin.user["id"],
            "credential:list denied",
        ),
        (
            "foreign membership list denial",
            foreign_membership_list,
            foreign_admin.user["id"],
            "membership:list denied",
        ),
        (
            "foreign topic list denial",
            foreign_topic_list,
            foreign_admin.user["id"],
            "topic:list denied",
        ),
        (
            "invalid role denial",
            malformed_role,
            admin_actor.user["id"],
            f"membership:create target={owner_without_membership.user['id']}",
        ),
        (
            "viewer user denial",
            denied_disable,
            viewer_actor.user["id"],
            "identity:disable denied",
        ),
        (
            "curator credential denial",
            denied_credential,
            curator_actor.user["id"],
            f"credential:create target={target.user['id']}",
        ),
        (
            "member membership denial",
            denied_membership,
            member_actor.user["id"],
            f"membership:update target={target.user['id']}",
        ),
        (
            "foreign user denial",
            foreign_disable,
            foreign_admin.user["id"],
            "identity:disable denied",
        ),
        (
            "foreign credential denial",
            foreign_credential,
            foreign_admin.user["id"],
            "credential:revoke denied",
        ),
        (
            "foreign membership denial",
            foreign_membership,
            foreign_admin.user["id"],
            "membership:update denied",
        ),
    ):
        await _require_audit(
            failures,
            label,
            harness,
            foreign_id if principal_id == foreign_admin.user["id"] else project_id,
            _object(response),
            principal_id=principal_id,
            action=action,
            denied=True,
            forbidden_values=(
                (project_id, project_slug, target.user["id"], target_pat.id, foreign_topic_slug)
                if principal_id == foreign_admin.user["id"]
                else ()
            ),
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
        create_headers = {**headers, "Idempotency-Key": "project-create-contract"}
        created = await client.post(
            "/api/v1/admin/projects",
            headers=create_headers,
            json={
                "slug": target_slug,
                "name": "Lifecycle original",
                "settings": {"retention_days": 14},
            },
        )
        create_replay = await client.post(
            "/api/v1/admin/projects",
            headers=create_headers,
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
        if not _is_version(created_version):
            created_version = -1
        created_db = await _project_row(harness, target_slug)
        if created_db is not None:
            await identity.create_topic(
                str(created_db["id"]), "known-topic", "Known", sensitivity=4
            )
        before = await client.get(f"/api/v1/admin/projects/{target_slug}", headers=headers)
        update_headers = {**headers, "Idempotency-Key": "project-update-contract"}
        update = await client.patch(
            f"/api/v1/admin/projects/{target_slug}",
            headers=update_headers,
            json={
                "expected_version": created_version,
                "name": "Lifecycle renamed",
                "settings": {"retention_days": 30},
            },
        )
        update_replay = await client.patch(
            f"/api/v1/admin/projects/{target_slug}",
            headers=update_headers,
            json={
                "expected_version": created_version,
                "name": "Lifecycle renamed",
                "settings": {"retention_days": 30},
            },
        )
        update_payload = _object(update)
        updated_after = update_payload.get("after") if isinstance(update_payload, dict) else None
        current_version = updated_after.get("version") if isinstance(updated_after, dict) else None
        if not _is_version(current_version):
            current_version = -1
        stale = await client.patch(
            f"/api/v1/admin/projects/{target_slug}",
            headers={**headers, "Idempotency-Key": "project-update-stale-contract"},
            json={
                "expected_version": created_version,
                "name": "stale",
            },
        )
        reread = await client.get(f"/api/v1/admin/projects/{target_slug}", headers=headers)
        inventory_before_delete = await client.get("/api/v1/admin/projects", headers=headers)
        impact = await client.get(
            f"/api/v1/admin/projects/{target_slug}/delete-impact", headers=headers
        )
        default_impact = await client.get(
            "/api/v1/admin/projects/default/delete-impact", headers=headers
        )
        default_payload = _object(default_before)
        default_version = default_payload.get("version") if default_payload is not None else None
        if not _is_version(default_version):
            default_version = -1
        default_delete = await client.delete(
            "/api/v1/admin/projects/default",
            headers={**headers, "Idempotency-Key": "project-delete-default-contract"},
            params={"expected_version": default_version, "confirm": "default"},
        )
        default_after = await client.get("/api/v1/admin/projects/default", headers=headers)
        default_impact_after = await client.get(
            "/api/v1/admin/projects/default/delete-impact", headers=headers
        )
        delete_headers = {**headers, "Idempotency-Key": "project-delete-contract"}
        removed = await client.delete(
            f"/api/v1/admin/projects/{target_slug}",
            headers=delete_headers,
            params={"expected_version": current_version, "confirm": target_slug},
        )
        removed_replay = await client.delete(
            f"/api/v1/admin/projects/{target_slug}",
            headers=delete_headers,
            params={"expected_version": current_version, "confirm": target_slug},
        )
        after_delete = await client.get(f"/api/v1/admin/projects/{target_slug}", headers=headers)
        inventory_after = await client.get("/api/v1/admin/projects", headers=headers)

    failures: list[str] = []
    for label, response, expected in (
        ("default project read before protection check", default_before, 200),
        ("project create", created, 201),
        ("project create replay", create_replay, 200),
        ("project reread before mutation", before, 200),
        ("project update", update, 200),
        ("project update replay", update_replay, 200),
        ("stale project update", stale, 409),
        ("project reread after mutation", reread, 200),
        ("pre-delete inventory", inventory_before_delete, 200),
        ("delete impact", impact, 200),
        ("default delete impact", default_impact, 200),
        ("default project protection", default_delete, 409),
        ("default survives rejected delete", default_after, 200),
        ("default impact survives rejected delete", default_impact_after, 200),
        ("confirmed project delete", removed, 200),
        ("confirmed project delete replay", removed_replay, 200),
        ("deleted project is absent", after_delete, 404),
        ("post-delete inventory", inventory_after, 200),
    ):
        _status(failures, label, response, expected)
    create_idempotent, _ = _idempotent_replay(
        failures, "project create", created, create_replay, original_status=201
    )
    update_idempotent, _ = _idempotent_replay(
        failures, "project update", update, update_replay, original_status=200
    )
    delete_idempotent, _ = _idempotent_replay(
        failures, "project delete", removed, removed_replay, original_status=200
    )
    create_envelope = _required(
        failures, "project create", created, {"project", "audit_correlation"}
    )
    create_state = _mapping_field(failures, "project create", create_envelope, "project")
    default_state = _required(
        failures,
        "default project",
        default_before,
        {"id", "slug", "name", "settings", "status", "version"},
    )
    default_version_checked = _int_field(failures, "default project", default_state, "version")
    expected_default: dict[str, object] = {
        "id": default_id,
        "slug": "default",
        "name": "Default",
        "settings": {},
        "status": "active",
        "version": default_version_checked,
    }
    if default_state != expected_default:
        failures.append(
            f"default project: expected exact protected state {expected_default}, got {default_state}"
        )
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
    stale_payload = _required(
        failures, "stale project update", stale, {"current", "audit_correlation"}
    )
    if _mapping_field(failures, "stale project update", stale_payload, "current") != update_after:
        failures.append("stale project update: conflict must return the unchanged current state")
    inventory_before_payload = _required(
        failures, "pre-delete inventory", inventory_before_delete, {"projects"}
    )
    inventory_before_rows = _list_field(
        failures, "pre-delete inventory", inventory_before_payload, "projects"
    )
    expected_inventory = {
        "default": {**(default_state or {}), "membership_count": 0},
        target_slug: {**(update_after or {}), "membership_count": 0},
    }
    inventory_by_slug = (
        {
            row.get("slug"): row
            for row in inventory_before_rows
            if isinstance(row, dict) and isinstance(row.get("slug"), str)
        }
        if inventory_before_rows is not None
        else {}
    )
    if inventory_before_rows is not None and (
        len(inventory_by_slug) != len(inventory_before_rows)
        or inventory_by_slug != expected_inventory
        or any(
            set(row)
            != {
                "id",
                "slug",
                "name",
                "settings",
                "status",
                "version",
                "membership_count",
            }
            for row in inventory_before_rows
            if isinstance(row, dict)
        )
    ):
        failures.append("project inventory: seeded rows, schema or lifecycle values are not exact")
    target_dependencies = {
        "topics": 1,
        "memberships": 0,
        "credentials": 0,
        "documents": 0,
        "claims": 0,
        "hunts": 0,
        "skills": 0,
    }
    default_dependencies = dict.fromkeys(target_dependencies, 0)
    impact_payload = _required(
        failures,
        "delete impact",
        impact,
        {"project", "version", "dependencies", "can_delete", "confirmation"},
    )
    expected_impact = {
        "project": update_after,
        "version": current_version_checked,
        "dependencies": target_dependencies,
        "can_delete": True,
        "confirmation": target_slug,
    }
    if impact_payload != expected_impact:
        failures.append(
            f"delete impact: expected exact dependency preview {expected_impact}, got {impact_payload}"
        )
    protected = _required(
        failures,
        "default delete impact",
        default_impact,
        {"project", "version", "dependencies", "can_delete", "confirmation"},
    )
    expected_default_impact = {
        "project": default_state,
        "version": default_version_checked,
        "dependencies": default_dependencies,
        "can_delete": False,
        "confirmation": "default",
    }
    if protected != expected_default_impact:
        failures.append("default delete impact: protected preview is not exact")
    default_conflict = _required(
        failures,
        "default project protection",
        default_delete,
        {
            "current",
            "dependencies",
            "can_delete",
            "confirmation",
            "reason",
            "audit_correlation",
        },
    )
    expected_default_conflict = {
        "current": default_state,
        "dependencies": default_dependencies,
        "can_delete": False,
        "confirmation": "default",
        "reason": "protected_default",
        "audit_correlation": (
            default_conflict.get("audit_correlation") if default_conflict is not None else None
        ),
    }
    if default_conflict != expected_default_conflict:
        failures.append("default delete conflict: exact protected state and impact are required")
    if _object(default_after) != default_state:
        failures.append("default project changed after a rejected delete")
    if _object(default_impact_after) != protected:
        failures.append("default dependency impact changed after the rejected delete")
    removed_payload = _required(
        failures, "project delete", removed, {"project", "status", "audit_correlation"}
    )
    if removed_payload is not None and (
        removed_payload.get("project") != target_slug or removed_payload.get("status") != "deleted"
    ):
        failures.append("project delete: authoritative outcome must name the deleted project")
    inventory_payload = _required(failures, "post-delete inventory", inventory_after, {"projects"})
    projects = _list_field(failures, "post-delete inventory", inventory_payload, "projects")
    if projects != [{**(default_state or {}), "membership_count": 0}]:
        failures.append("project delete: inventory must contain exactly the unchanged default row")
    if await _project_row(harness, target_slug) is not None:
        failures.append("project delete: target project remained in authoritative persistence")
    if await _project_row(harness, "default") is None:
        failures.append("default project was removed despite the conflict response")
    audit_project_id = target_id or str(uuid.UUID(int=0))
    for label, payload, action in (
        ("project create", create_idempotent, f"project:create target={target_slug}"),
        ("project update", update_idempotent, f"project:update target={target_slug}"),
        ("project delete", delete_idempotent, f"project:delete target={target_slug}"),
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
    await _require_audit(
        failures,
        "default project protection",
        harness,
        default_id,
        default_conflict,
        principal_id=owner.user["id"],
        action="project:delete target=default",
        denied=True,
    )
    await _require_audit(
        failures,
        "stale project update",
        harness,
        audit_project_id,
        stale_payload,
        principal_id=owner.user["id"],
        action=f"project:update target={target_slug}",
        denied=True,
    )
    for action in (
        f"project:create target={target_slug}",
        f"project:update target={target_slug}",
        f"project:delete target={target_slug}",
    ):
        audit_rows = await _matching_audits(
            harness,
            audit_project_id,
            principal_id=owner.user["id"],
            action=action,
            denied=False,
        )
        if len(audit_rows) != 1:
            failures.append(
                f"project idempotency: {action} persisted {len(audit_rows)} audit outcomes"
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
        invite_headers = {**admin_headers, "Idempotency-Key": "identity-invite-contract"}
        invited = await client.post(
            f"/api/v1/admin/users/invite?project={project_slug}",
            headers=invite_headers,
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
        invited_user_db_before_command_replay = (
            await _user_row(harness, invited_user_id) if invited_user_id is not None else None
        )
        invited_membership_db_before_command_replay = (
            await _membership_row(harness, project_id, invited_user_id)
            if invited_user_id is not None
            else None
        )
        invite_replay = await client.post(
            f"/api/v1/admin/users/invite?project={project_slug}",
            headers=invite_headers,
            json={
                "email": target_email,
                "platform_role": "member",
                "project_role": "project-admin",
                "allowed_topics": ["general"],
                "can_curate": False,
            },
        )
        invited_user_db_after_command_replay = (
            await _user_row(harness, invited_user_id) if invited_user_id is not None else None
        )
        invited_membership_db_after_command_replay = (
            await _membership_row(harness, project_id, invited_user_id)
            if invited_user_id is not None
            else None
        )
        accept = await client.post(
            "/api/v1/auth/invitations/accept",
            json={
                "token": invitation_token if isinstance(invitation_token, str) else "missing",
                "password": _PASSWORD,
            },
        )
        users_before_invitation_replay = await client.get(
            f"/api/v1/admin/users?project={project_slug}",
            headers=admin_headers,
            params={"limit": 100},
        )
        memberships_before_invitation_replay = await client.get(
            f"/api/v1/admin/memberships?project={project_slug}", headers=admin_headers
        )
        accepted_user_db_before_replay = (
            await _user_row(harness, invited_user_id) if invited_user_id is not None else None
        )
        accepted_membership_db_before_replay = (
            await _membership_row(harness, project_id, invited_user_id)
            if invited_user_id is not None
            else None
        )
        invitation_audit_before_replay = await query_audit_raw(harness.sm, project_id, limit=500)
        replay_password = "a replay must never replace the accepted password"
        accept_again = await client.post(
            "/api/v1/auth/invitations/accept",
            json={
                "token": invitation_token if isinstance(invitation_token, str) else "missing",
                "password": replay_password,
            },
        )
        invitation_audit_after_replay = await query_audit_raw(harness.sm, project_id, limit=500)
        users_after_invitation_replay = await client.get(
            f"/api/v1/admin/users?project={project_slug}",
            headers=admin_headers,
            params={"limit": 100},
        )
        memberships_after_invitation_replay = await client.get(
            f"/api/v1/admin/memberships?project={project_slug}", headers=admin_headers
        )
        accepted_user_db_after_replay = (
            await _user_row(harness, invited_user_id) if invited_user_id is not None else None
        )
        accepted_membership_db_after_replay = (
            await _membership_row(harness, project_id, invited_user_id)
            if invited_user_id is not None
            else None
        )
        accepted_password_login = await client.post(
            "/api/v1/auth/login", json={"email": target_email, "password": _PASSWORD}
        )
        replay_password_login = await client.post(
            "/api/v1/auth/login", json={"email": target_email, "password": replay_password}
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

        reset_headers = {**admin_headers, "Idempotency-Key": "identity-reset-contract"}
        reset_active = await client.post(
            f"/api/v1/admin/users/{target.user['id']}/password-reset?project={project_slug}",
            headers=reset_headers,
            json={"impact_acknowledged": True},
        )
        reset_payload = _object(reset_active)
        reset_token = reset_payload.get("reset_token") if reset_payload is not None else None
        reset_command_replay = await client.post(
            f"/api/v1/admin/users/{target.user['id']}/password-reset?project={project_slug}",
            headers=reset_headers,
            json={"impact_acknowledged": True},
        )
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
        disable_headers = {**admin_headers, "Idempotency-Key": "identity-disable-contract"}
        disabled = await client.post(
            f"/api/v1/admin/users/{target.user['id']}/disable?project={project_slug}",
            headers=disable_headers,
            json={"expected_status": "active", "impact_acknowledged": True},
        )
        disabled_user_db_before_replay = await _user_row(harness, target.user["id"])
        disabled_credentials_before_replay = await _membership_pat_state(harness, membership_id)
        disable_replay = await client.post(
            f"/api/v1/admin/users/{target.user['id']}/disable?project={project_slug}",
            headers=disable_headers,
            json={"expected_status": "active", "impact_acknowledged": True},
        )
        disabled_user_db_after_replay = await _user_row(harness, target.user["id"])
        disabled_credentials_after_replay = await _membership_pat_state(harness, membership_id)
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
        ("project-scoped user invite replay", invite_replay, 200),
        ("single-use invitation accept", accept, 200),
        ("invitation replay", accept_again, 400),
        ("users before invitation replay", users_before_invitation_replay, 200),
        ("memberships before invitation replay", memberships_before_invitation_replay, 200),
        ("users after invitation replay", users_after_invitation_replay, 200),
        ("memberships after invitation replay", memberships_after_invitation_replay, 200),
        ("accepted invitation password survives replay", accepted_password_login, 200),
        ("invitation replay password is invalid", replay_password_login, 401),
        ("users first page", users_page_one, 200),
        ("users second page", users_page_two, 200),
        ("old password after reset", old_login, 401),
        ("password reset completion", reset_complete, 200),
        ("password reset command replay", reset_command_replay, 200),
        ("new password after reset", current_login, 200),
        ("reset token replay", reset_replay, 400),
        ("live session before disable", before_session, 200),
        ("live PAT before disable", before_pat, 200),
        ("live OAuth before disable", before_oauth, 200),
        ("disabled session", after_session, 401),
        ("disabled PAT", after_pat, 401),
        ("disabled OAuth", after_oauth, 401),
        ("users reread after disable", users_after_disable, 200),
        ("disable command replay", disable_replay, 200),
    ):
        _status(failures, label, response, expected)
    invite_idempotent, _ = _idempotent_replay(
        failures,
        "user invite",
        invited,
        invite_replay,
        original_status=201,
        secret_fields={"invitation_token"},
    )
    reset_idempotent, _ = _idempotent_replay(
        failures,
        "password reset command",
        reset_active,
        reset_command_replay,
        original_status=201,
        secret_fields={"reset_token"},
    )
    disable_idempotent, _ = _idempotent_replay(
        failures,
        "disable command",
        disabled,
        disable_replay,
        original_status=200,
    )
    if (
        invited_user_db_before_command_replay is None
        or invited_user_db_before_command_replay != invited_user_db_after_command_replay
        or invited_membership_db_before_command_replay is None
        or invited_membership_db_before_command_replay != invited_membership_db_after_command_replay
    ):
        failures.append("user invite replay changed or duplicated persisted identity authority")
    if (
        disabled_user_db_before_replay is None
        or disabled_user_db_before_replay != disabled_user_db_after_replay
        or disabled_credentials_before_replay != disabled_credentials_after_replay
    ):
        failures.append("disable replay changed identity or credential revocation state")
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
        or not _is_version(invited_identity.get("version"))
    ):
        failures.append("user invite: identity must expose exact invited state and version")
    if invited_membership is not None and (
        invited_membership.get("role") != "project-admin"
        or invited_membership.get("allowed_topics") != ["general"]
        or invited_membership.get("can_curate") is not False
        or not _is_version(invited_membership.get("version"))
    ):
        failures.append("user invite: scoped restrictive membership differs from request")
    accept_payload = _required(
        failures, "invitation accept", accept, {"identity", "membership", "audit_correlation"}
    )
    accepted_identity = _mapping_field(failures, "invitation accept", accept_payload, "identity")
    accepted_membership = _mapping_field(
        failures, "invitation accept", accept_payload, "membership"
    )
    accepted_version = _int_field(
        failures, "invitation accept identity", accepted_identity, "version"
    )
    expected_accepted_identity = {
        **(invited_identity or {}),
        "status": "active",
        "version": accepted_version,
    }
    if accepted_identity != expected_accepted_identity:
        failures.append("invitation accept: identity transition is not exact")
    invited_version = invited_identity.get("version") if invited_identity is not None else None
    if (
        _is_version(invited_version)
        and accepted_version is not None
        and accepted_version <= invited_version
    ):
        failures.append("invitation accept: identity version did not advance")
    if accepted_membership != invited_membership:
        failures.append("invitation accept: project membership changed during activation")

    replay_user_payloads = (
        (
            "users before invitation replay",
            _required(
                failures,
                "users before invitation replay",
                users_before_invitation_replay,
                {"items", "next_cursor"},
            ),
        ),
        (
            "users after invitation replay",
            _required(
                failures,
                "users after invitation replay",
                users_after_invitation_replay,
                {"items", "next_cursor"},
            ),
        ),
    )
    replay_user_rows: list[dict[str, object] | None] = []
    for label, listing in replay_user_payloads:
        rows = _list_field(failures, label, listing, "items")
        replay_user_rows.append(
            next(
                (row for row in rows if isinstance(row, dict) and row.get("id") == invited_user_id),
                None,
            )
            if rows is not None
            else None
        )
    replay_membership_payloads = (
        (
            "memberships before invitation replay",
            _required(
                failures,
                "memberships before invitation replay",
                memberships_before_invitation_replay,
                {"memberships"},
            ),
        ),
        (
            "memberships after invitation replay",
            _required(
                failures,
                "memberships after invitation replay",
                memberships_after_invitation_replay,
                {"memberships"},
            ),
        ),
    )
    replay_membership_rows: list[dict[str, object] | None] = []
    for label, listing in replay_membership_payloads:
        rows = _list_field(failures, label, listing, "memberships")
        replay_membership_rows.append(
            next(
                (
                    row
                    for row in rows
                    if isinstance(row, dict) and row.get("user_id") == invited_user_id
                ),
                None,
            )
            if rows is not None
            else None
        )
    if (
        replay_user_rows[0] is None
        or replay_user_rows[0] != replay_user_rows[1]
        or any(
            replay_user_rows[0].get(name) != value
            for name, value in (accepted_identity or {}).items()
        )
    ):
        failures.append("invitation replay changed HTTP identity state or version")
    if (
        replay_membership_rows[0] is None
        or replay_membership_rows[0] != replay_membership_rows[1]
        or replay_membership_rows[0] != accepted_membership
    ):
        failures.append("invitation replay changed HTTP membership state or version")
    if (
        accepted_user_db_before_replay is None
        or accepted_user_db_before_replay != accepted_user_db_after_replay
        or accepted_membership_db_before_replay is None
        or accepted_membership_db_before_replay != accepted_membership_db_after_replay
    ):
        failures.append("invitation replay changed persisted identity or membership state")
    if invitation_audit_after_replay != invitation_audit_before_replay:
        failures.append("invitation replay changed the persisted audit trail")
    replay_payload = _object(accept_again)
    if replay_payload is not None and {
        "identity",
        "membership",
        "audit_correlation",
    }.intersection(replay_payload):
        failures.append("invitation replay returned mutable state or a second audit outcome")
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
    reset_complete_envelope = _required(
        failures,
        "password reset completion",
        reset_complete,
        {"identity", "status", "audit_correlation"},
    )
    reset_complete_identity = _mapping_field(
        failures, "password reset completion", reset_complete_envelope, "identity"
    )
    if reset_complete_envelope is not None and reset_complete_envelope.get("status") != "completed":
        failures.append("password reset completion: status must be exactly completed")
    if reset_complete_identity is not None and (
        reset_complete_identity.get("id") != target.user["id"]
        or reset_complete_identity.get("email") != target.email
        or reset_complete_identity.get("status") != "active"
        or not _is_version(reset_complete_identity.get("version"))
    ):
        failures.append("password reset completion: authoritative active identity is not exact")
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
        invite_replay,
        accept,
        accept_again,
        users_before_invitation_replay,
        memberships_before_invitation_replay,
        users_after_invitation_replay,
        memberships_after_invitation_replay,
        accepted_password_login,
        replay_password_login,
        users_page_one,
        users_page_two,
        reset_active,
        reset_command_replay,
        reset_complete,
        reset_replay,
        disabled,
        disable_replay,
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
        ("user invite", invite_idempotent, f"identity:invite target={target_email}"),
        ("invitation accept", accept_payload, f"identity:accept target={target.user['id']}"),
        ("password reset", reset_idempotent, f"identity:reset target={target.user['id']}"),
        (
            "password reset complete",
            reset_complete_envelope,
            f"identity:reset-complete target={target.user['id']}",
        ),
        ("disable", disable_idempotent, f"identity:disable target={target.user['id']}"),
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
    accept_action = f"identity:accept target={target.user['id']}"
    accepted_correlation = _correlation_id(failures, "invitation accept", accept_payload)
    accepted_audits = await _matching_audits(
        harness,
        project_id,
        principal_id=target.user["id"],
        action=accept_action,
        denied=None,
    )
    if (
        len(accepted_audits) != 1
        or accepted_correlation is None
        or accepted_audits[0].get("id") != accepted_correlation
    ):
        failures.append("invitation replay changed or duplicated the accepted audit outcome")
    for action in (
        f"identity:invite target={target_email}",
        f"identity:reset target={target.user['id']}",
        f"identity:disable target={target.user['id']}",
    ):
        identity_audit_rows = await _matching_audits(
            harness,
            project_id,
            principal_id=admin.user["id"],
            action=action,
            denied=False,
        )
        if len(identity_audit_rows) != 1:
            failures.append(
                f"identity idempotency: {action} persisted {len(identity_audit_rows)} audit outcomes"
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
        if not _is_version(rotate_version):
            rotate_version = -1
        if not _is_version(revoke_version):
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
    if created_id is None:
        failures.append("credential create: server id must be a canonical UUID")
    if created_meta is not None and (
        created_meta.get("id") != created_id
        or created_meta.get("user_id") != target.user["id"]
        or created_meta.get("project") != project_slug
        or created_meta.get("kind") != "pat"
        or created_meta.get("name") != "console-created"
        or created_meta.get("status") != "active"
        or not _is_version(created_meta.get("version"))
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
            or not _is_version(metadata.get("version"))
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
        or not _is_version(rotated_meta_version)
        or (_is_version(rotated_meta_version) and rotated_meta_version <= rotate_version)
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
    rotate_conflict = _required(
        failures,
        "credential stale rotate",
        rotate_stale,
        {"current", "audit_correlation"},
    )
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
        or not _is_version(revoked_meta_version)
        or (_is_version(revoked_meta_version) and revoked_meta_version <= revoke_version)
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
    revoke_conflict = _required(
        failures,
        "credential stale revoke",
        revoke_stale,
        {"current", "audit_correlation"},
    )
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
        elif matching_created[0] != created_meta:
            failures.append("credential reread changed the created UUID metadata")
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
    for label, payload, action in (
        ("credential stale rotate", rotate_conflict, f"credential:rotate target={rotate_id}"),
        ("credential stale revoke", revoke_conflict, f"credential:revoke target={revoke_id}"),
    ):
        await _require_audit(
            failures,
            label,
            harness,
            project_id,
            payload,
            principal_id=admin.user["id"],
            action=action,
            denied=True,
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
    credential_target = await _active_user(identity)
    credential_membership_id = await identity.add_membership(
        credential_target.user["id"], project_id, role="member", allowed_topics=("general",)
    )
    seed_credential = await identity.issue_pat(credential_membership_id, name="third-party-seed")
    membership_targets = {
        kind: await _active_user(identity) for kind in ("session", "pat", "oauth")
    }

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
        results: list[
            tuple[
                str,
                httpx.Response,
                httpx.Response,
                httpx.Response,
                ActiveUser,
                httpx.Response,
                httpx.Response,
                str,
                httpx.Response,
            ]
        ] = []
        for kind, headers, query in credential_headers:
            target = membership_targets[kind]
            topic_slug = unique_slug(f"parity-{kind}")
            idempotency_headers = {
                **headers,
                "Idempotency-Key": f"auth-parity-credential-{kind}",
            }
            users = await client.get(f"/api/v1/admin/users{query}", headers=headers)
            credentials = await client.get(
                f"/api/v1/admin/users/{credential_target.user['id']}/credentials{query}",
                headers=headers,
            )
            credential_create = await client.post(
                f"/api/v1/admin/users/{credential_target.user['id']}/credentials{query}",
                headers=idempotency_headers,
                json={"name": f"created-through-{kind}", "kind": "pat"},
            )
            membership_create = await client.post(
                f"/api/v1/admin/memberships{query}",
                headers={
                    **headers,
                    "Idempotency-Key": f"auth-parity-membership-{kind}",
                },
                json={
                    "user_id": target.user["id"],
                    "role": "viewer",
                    "allowed_topics": [],
                    "can_curate": False,
                },
            )
            topics = await client.get(f"/api/v1/admin/topics{query}", headers=headers)
            topic_create = await client.post(
                f"/api/v1/admin/topics{query}",
                headers={**headers, "Idempotency-Key": f"auth-parity-topic-{kind}"},
                json={"slug": topic_slug, "name": f"Created through {kind}"},
            )
            results.append(
                (
                    kind,
                    users,
                    credentials,
                    credential_create,
                    target,
                    membership_create,
                    topics,
                    topic_slug,
                    topic_create,
                )
            )

    if await resolve_scope(harness.sm, pat.token) is None:
        failures.append("auth parity control: PAT was not a live project credential")
    if await resolve_scope(harness.sm, oauth_token) is None:
        failures.append("auth parity control: OAuth token was not a live project credential")
    status_fingerprints: list[tuple[int, int, int, int, int, int]] = []
    for (
        kind,
        users,
        credentials,
        credential_create,
        membership_target,
        membership_create,
        topics,
        topic_slug,
        topic_create,
    ) in results:
        for surface, response, expected in (
            ("user list", users, 200),
            ("third-party credential list", credentials, 200),
            ("third-party credential create", credential_create, 201),
            ("membership create", membership_create, 201),
            ("topic list", topics, 200),
            ("topic create", topic_create, 201),
        ):
            _status(failures, f"{kind} {surface}", response, expected)
        status_fingerprints.append(
            (
                users.status_code,
                credentials.status_code,
                credential_create.status_code,
                membership_create.status_code,
                topics.status_code,
                topic_create.status_code,
            )
        )
        users_payload = _required(failures, f"{kind} user list", users, {"items"})
        user_rows = _list_field(failures, f"{kind} user list", users_payload, "items")
        if user_rows is not None and not any(
            isinstance(row, dict)
            and row.get("id") == credential_target.user["id"]
            and row.get("email") == credential_target.email
            and row.get("role") == "member"
            for row in user_rows
        ):
            failures.append(f"{kind} user list did not expose the same scoped target")
        credential_list_payload = _required(
            failures, f"{kind} credential list", credentials, {"items"}
        )
        credential_rows = _list_field(
            failures, f"{kind} credential list", credential_list_payload, "items"
        )
        if credential_rows is not None and not any(
            isinstance(row, dict)
            and row.get("id") == seed_credential.id
            and row.get("user_id") == credential_target.user["id"]
            and row.get("status") == "active"
            and _is_version(row.get("version"))
            for row in credential_rows
        ):
            failures.append(f"{kind} credential list did not expose exact third-party metadata")
        credential_payload = _required(
            failures,
            f"{kind} credential create",
            credential_create,
            {"credential", "secret", "audit_correlation"},
        )
        credential_meta = _mapping_field(
            failures, f"{kind} credential create", credential_payload, "credential"
        )
        credential_id = _uuid_string(
            credential_meta.get("id") if credential_meta is not None else None
        )
        credential_secret = _str_field(
            failures, f"{kind} credential create", credential_payload, "secret"
        )
        if credential_meta is not None and (
            credential_meta.get("id") != credential_id
            or credential_meta.get("user_id") != credential_target.user["id"]
            or credential_meta.get("project") != project_slug
            or credential_meta.get("kind") != "pat"
            or credential_meta.get("name") != f"created-through-{kind}"
            or credential_meta.get("status") != "active"
            or not _is_version(credential_meta.get("version"))
        ):
            failures.append(f"{kind} credential create returned non-authoritative metadata")
        if (
            credential_secret is not None
            and await resolve_scope(harness.sm, credential_secret) is None
        ):
            failures.append(f"{kind} third-party credential was not live after creation")
        membership_payload = _required(
            failures,
            f"{kind} membership create",
            membership_create,
            {"membership", "audit_correlation"},
        )
        membership_meta = _mapping_field(
            failures, f"{kind} membership create", membership_payload, "membership"
        )
        expected_membership = {
            "id": _uuid_string(membership_meta.get("id") if membership_meta is not None else None),
            "user_id": membership_target.user["id"],
            "role": "viewer",
            "allowed_topics": [],
            "can_curate": False,
            "status": "active",
            "version": membership_meta.get("version") if membership_meta is not None else None,
        }
        if (
            membership_meta != expected_membership
            or not _is_version(expected_membership["version"])
            or await _membership_row(harness, project_id, membership_target.user["id"]) is None
        ):
            failures.append(f"{kind} membership create did not persist exact authority")
        if await _topic_row(harness, project_id, topic_slug) is None:
            failures.append(f"{kind} topic mutation did not persist its topic")
        for label, payload, action in (
            (
                f"{kind} credential create",
                credential_payload,
                f"credential:create target={credential_id}",
            ),
            (
                f"{kind} membership create",
                membership_payload,
                f"membership:create target={membership_target.user['id']}",
            ),
            (
                f"{kind} topic create",
                _object(topic_create),
                f"topic:create target={topic_slug}",
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
    if status_fingerprints and len(set(status_fingerprints)) != 1:
        failures.append("session, PAT and OAuth produced different management decisions")
    assert not failures, "\n".join(failures)


async def test_management_rate_limit_is_a_deterministic_429_contract(
    build_harness: Callable[..., Harness],
    tmp_path: Path,
) -> None:
    harness = build_harness()
    identity = IdentityService(harness.sm)
    default_id = await identity.ensure_default_project()
    owner = await _active_user(identity, platform_role="owner")
    allowed = 2
    fixed_now = dt.datetime(2030, 1, 1, 12, 0, 43, tzinfo=dt.UTC)
    limiter = FixedWindowManagementLimiter(
        QuotaService(harness.sm, QuotaConfig(human_rate_per_min=allowed)), now=fixed_now
    )
    slugs = tuple(unique_slug(f"rate-project-{index}") for index in range(allowed + 1))
    limiter_is_injectable = "management_limiter" in {field.name for field in fields(ApiDeps)}

    async with _client(harness, tmp_path, management_limiter=limiter) as client:
        owner_headers, _ = await _session(client, owner)
        responses = tuple(
            [
                await client.post(
                    "/api/v1/admin/projects",
                    headers={**owner_headers, "Idempotency-Key": f"rate-contract-{index}"},
                    json={"slug": slug, "name": f"Rate contract {index}"},
                )
                for index, slug in enumerate(slugs)
            ]
        )

    failures: list[str] = []
    if not limiter_is_injectable:
        failures.append("management rate limit: ApiDeps must expose management_limiter")
    for index, response in enumerate(responses[:allowed]):
        _status(failures, f"management request {index + 1} within budget", response, 201)
    limited = responses[-1]
    _status(failures, "management request N+1", limited, 429)
    if limited.headers.get("Retry-After") != "17":
        failures.append("management rate limit: Retry-After must preserve the service delay")
    payload = _required(
        failures,
        "management request N+1",
        limited,
        {"detail", "retry_after", "audit_correlation"},
    )
    if payload is not None and (
        payload.get("detail") != "rate limit exceeded" or payload.get("retry_after") != 17
    ):
        failures.append("management rate limit: safe typed body differs from the service outcome")
    expected_calls = [(owner.user["id"], "project:create")] * (allowed + 1)
    if limiter.calls != expected_calls:
        failures.append(
            f"management rate limit: injectable boundary calls {limiter.calls} != {expected_calls}"
        )
    window_start = fixed_now.replace(second=0, microsecond=0)
    if await _rate_window_count(harness, owner.user["id"], window_start) != allowed + 1:
        failures.append("management rate limit: Postgres counter fingerprint is not exactly N+1")
    for index, (slug, response) in enumerate(
        zip(slugs[:allowed], responses[:allowed], strict=True)
    ):
        envelope = _required(
            failures,
            f"management request {index + 1} within budget",
            response,
            {"project", "audit_correlation"},
        )
        state = _mapping_field(
            failures, f"management request {index + 1} within budget", envelope, "project"
        )
        persisted = await _project_row(harness, slug)
        if (
            state is None
            or persisted is None
            or (
                state.get("id") != persisted.get("id")
                or state.get("slug") != slug
                or state.get("name") != f"Rate contract {index}"
                or state.get("settings") != {}
                or state.get("status") != "active"
                or not _is_version(state.get("version"))
            )
        ):
            failures.append(f"management rate limit: allowed DB fingerprint {index} is not exact")
    rejected_slug = slugs[-1]
    if await _project_row(harness, rejected_slug) is not None:
        failures.append("management rate limit: N+1 command changed the project DB fingerprint")
    await _require_audit(
        failures,
        "management request N+1",
        harness,
        default_id,
        payload,
        principal_id=owner.user["id"],
        action=f"project:create target={rejected_slug}",
        denied=True,
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
    failures: list[str] = []
    membership_before = await _membership_row(harness, project_id, target.user["id"])
    topics_before = await _topic_state(harness, project_id)

    async with _client(harness, tmp_path) as client:
        admin, admin_headers, _ = await _actor_with_membership(
            identity, client, project_id, project_role="project-admin"
        )
        target_session_headers, target_session = await _session(client, target)
        membership_headers = {**admin_headers, "Idempotency-Key": "membership-create-contract"}
        membership = await client.post(
            f"/api/v1/admin/memberships?project={project_slug}",
            headers=membership_headers,
            json={"user_id": target.user["id"], "role": "viewer", "can_curate": False},
        )
        membership_db_before_replay = await _membership_row(harness, project_id, target.user["id"])
        membership_replay = await client.post(
            f"/api/v1/admin/memberships?project={project_slug}",
            headers=membership_headers,
            json={"user_id": target.user["id"], "role": "viewer", "can_curate": False},
        )
        membership_db_after_replay = await _membership_row(harness, project_id, target.user["id"])
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
        if not _is_version(membership_version):
            membership_version = -1
        stored_membership = await _membership_row(harness, project_id, target.user["id"])
        if stored_membership is None:
            membership_id = await identity.add_membership(
                target.user["id"], project_id, role="viewer", allowed_topics=()
            )
        else:
            membership_id = str(stored_membership["id"])
        target_pat = await identity.issue_pat(membership_id, name="authority-transition")
        change_headers = {**admin_headers, "Idempotency-Key": "membership-update-contract"}
        changed = await client.patch(
            f"/api/v1/admin/memberships/{target.user['id']}?project={project_slug}",
            headers=change_headers,
            json={
                "expected_version": membership_version,
                "role": "member",
                "allowed_topics": ["general"],
                "can_curate": True,
            },
        )
        changed_db_before_replay = await _membership_row(harness, project_id, target.user["id"])
        changed_replay = await client.patch(
            f"/api/v1/admin/memberships/{target.user['id']}?project={project_slug}",
            headers=change_headers,
            json={
                "expected_version": membership_version,
                "role": "member",
                "allowed_topics": ["general"],
                "can_curate": True,
            },
        )
        changed_db_after_replay = await _membership_row(harness, project_id, target.user["id"])
        stale_membership = await client.patch(
            f"/api/v1/admin/memberships/{target.user['id']}?project={project_slug}",
            headers={**admin_headers, "Idempotency-Key": "membership-update-stale"},
            json={
                "expected_version": membership_version,
                "role": "project-admin",
            },
        )
        memberships_after_stale = await client.get(
            f"/api/v1/admin/memberships?project={project_slug}", headers=admin_headers
        )
        topic_headers = {**admin_headers, "Idempotency-Key": "topic-create-contract"}
        topic = await client.post(
            f"/api/v1/admin/topics?project={project_slug}",
            headers=topic_headers,
            json={
                "slug": topic_slug,
                "name": "Sensitive",
                "sensitivity": 4,
                "hard_window_days": 45,
            },
        )
        topic_db_before_replay = await _topic_row(harness, project_id, topic_slug)
        topic_replay = await client.post(
            f"/api/v1/admin/topics?project={project_slug}",
            headers=topic_headers,
            json={
                "slug": topic_slug,
                "name": "Sensitive",
                "sensitivity": 4,
                "hard_window_days": 45,
            },
        )
        topic_db_after_replay = await _topic_row(harness, project_id, topic_slug)
        topics_after_create = await client.get(
            f"/api/v1/admin/topics?project={project_slug}", headers=admin_headers
        )
        topic_payload = _object(topic)
        topic_meta_raw = topic_payload.get("topic") if topic_payload is not None else None
        topic_version = topic_meta_raw.get("version") if isinstance(topic_meta_raw, dict) else None
        if not _is_version(topic_version):
            topic_version = -1
        scope_after_topic_create = await resolve_scope(harness.sm, target_pat.token)
        topic_update_headers = {**admin_headers, "Idempotency-Key": "topic-update-contract"}
        edited_topic = await client.patch(
            f"/api/v1/admin/topics/{topic_slug}?project={project_slug}",
            headers=topic_update_headers,
            json={
                "expected_version": topic_version,
                "name": "Highly sensitive",
                "sensitivity": 5,
                "hard_window_days": 60,
            },
        )
        topic_update_db_before_replay = await _topic_row(harness, project_id, topic_slug)
        edited_topic_replay = await client.patch(
            f"/api/v1/admin/topics/{topic_slug}?project={project_slug}",
            headers=topic_update_headers,
            json={
                "expected_version": topic_version,
                "name": "Highly sensitive",
                "sensitivity": 5,
                "hard_window_days": 60,
            },
        )
        topic_update_db_after_replay = await _topic_row(harness, project_id, topic_slug)
        stale_topic = await client.patch(
            f"/api/v1/admin/topics/{topic_slug}?project={project_slug}",
            headers={**admin_headers, "Idempotency-Key": "topic-update-stale"},
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
        if not _is_version(changed_version):
            changed_version = -1
        grant_headers = {**admin_headers, "Idempotency-Key": "membership-grant-contract"}
        grant_sensitive = await client.patch(
            f"/api/v1/admin/memberships/{target.user['id']}?project={project_slug}",
            headers=grant_headers,
            json={
                "expected_version": changed_version,
                "role": "member",
                "allowed_topics": ["general", topic_slug],
                "can_curate": True,
            },
        )
        grant_db_before_replay = await _membership_row(harness, project_id, target.user["id"])
        grant_replay = await client.patch(
            f"/api/v1/admin/memberships/{target.user['id']}?project={project_slug}",
            headers=grant_headers,
            json={
                "expected_version": changed_version,
                "role": "member",
                "allowed_topics": ["general", topic_slug],
                "can_curate": True,
            },
        )
        grant_db_after_replay = await _membership_row(harness, project_id, target.user["id"])
        grant_payload_raw = _object(grant_sensitive)
        grant_after_raw = grant_payload_raw.get("after") if grant_payload_raw is not None else None
        grant_version = (
            grant_after_raw.get("version") if isinstance(grant_after_raw, dict) else None
        )
        if not _is_version(grant_version):
            grant_version = -1
        scope_after_grant = await resolve_scope(harness.sm, target_pat.token)
        pat_after_grant = await client.get(
            "/api/v1/me", headers={"Authorization": f"Bearer {target_pat.token}"}
        )
        started = time.monotonic()
        revoke_headers = {**admin_headers, "Idempotency-Key": "membership-revoke-contract"}
        revoke_sensitive = await client.patch(
            f"/api/v1/admin/memberships/{target.user['id']}?project={project_slug}",
            headers=revoke_headers,
            json={
                "expected_version": grant_version,
                "role": "member",
                "allowed_topics": ["general"],
                "can_curate": True,
            },
        )
        revoke_db_before_replay = await _membership_row(harness, project_id, target.user["id"])
        revoke_replay = await client.patch(
            f"/api/v1/admin/memberships/{target.user['id']}?project={project_slug}",
            headers=revoke_headers,
            json={
                "expected_version": grant_version,
                "role": "member",
                "allowed_topics": ["general"],
                "can_curate": True,
            },
        )
        revoke_db_after_replay = await _membership_row(harness, project_id, target.user["id"])
        scope_after_revoke = await resolve_scope(harness.sm, target_pat.token)
        pat_after_revoke = await client.get(
            "/api/v1/me", headers={"Authorization": f"Bearer {target_pat.token}"}
        )
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
        ("membership create replay", membership_replay, 200),
        ("membership immediate reread", memberships_after_create, 200),
        ("membership update", changed, 200),
        ("membership update replay", changed_replay, 200),
        ("stale membership update", stale_membership, 409),
        ("membership reread after stale update", memberships_after_stale, 200),
        ("topic create", topic, 201),
        ("topic create replay", topic_replay, 200),
        ("topic immediate reread", topics_after_create, 200),
        ("topic update", edited_topic, 200),
        ("topic update replay", edited_topic_replay, 200),
        ("stale topic update", stale_topic, 409),
        ("topic reread after stale update", topics_after_stale, 200),
        ("grant sensitive topic", grant_sensitive, 200),
        ("grant sensitive topic replay", grant_replay, 200),
        ("PAT reread after authority grant", pat_after_grant, 200),
        ("revoke sensitive topic", revoke_sensitive, 200),
        ("revoke sensitive topic replay", revoke_replay, 200),
        ("PAT reread after authority reduction", pat_after_revoke, 200),
        ("session reread after authority reduction", session_after_revoke, 200),
        ("membership final reread", memberships_final, 200),
    ):
        _status(failures, label, response, expected)
    created_membership_idempotent, _ = _idempotent_replay(
        failures,
        "membership create",
        membership,
        membership_replay,
        original_status=201,
    )
    changed_idempotent, _ = _idempotent_replay(
        failures, "membership update", changed, changed_replay, original_status=200
    )
    created_topic_idempotent, _ = _idempotent_replay(
        failures, "topic create", topic, topic_replay, original_status=201
    )
    edited_topic_idempotent, _ = _idempotent_replay(
        failures, "topic update", edited_topic, edited_topic_replay, original_status=200
    )
    grant_idempotent, _ = _idempotent_replay(
        failures, "membership topic grant", grant_sensitive, grant_replay, original_status=200
    )
    revoke_idempotent, _ = _idempotent_replay(
        failures, "membership topic revoke", revoke_sensitive, revoke_replay, original_status=200
    )
    for label, before_replay, after_replay in (
        (
            "membership create",
            membership_db_before_replay,
            membership_db_after_replay,
        ),
        ("membership update", changed_db_before_replay, changed_db_after_replay),
        ("topic create", topic_db_before_replay, topic_db_after_replay),
        ("topic update", topic_update_db_before_replay, topic_update_db_after_replay),
        ("membership topic grant", grant_db_before_replay, grant_db_after_replay),
        ("membership topic revoke", revoke_db_before_replay, revoke_db_after_replay),
    ):
        if before_replay is None or before_replay != after_replay:
            failures.append(f"{label}: replay changed or duplicated persisted state")
    if membership_before is not None:
        failures.append("membership create precondition: target already had project authority")
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
        "status": "active",
        "version": (
            created_membership_meta.get("version") if created_membership_meta is not None else None
        ),
    }
    if created_membership_meta != expected_membership_create or not _is_version(
        expected_membership_create["version"]
    ):
        failures.append(
            "membership create: exact restrictive state and integer server version are required"
        )
    if membership_db_before_replay != created_membership_meta:
        failures.append("membership create: HTTP state differs from complete persisted snapshot")
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
        _is_version(expected_membership_create["version"])
        and changed_after_version is not None
        and changed_after_version <= expected_membership_create["version"]
    ):
        failures.append("membership update: server version did not advance")
    stale_payload = _required(
        failures,
        "stale membership update",
        stale_membership,
        {"current", "audit_correlation"},
    )
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
        "hard_window_days": 45,
        "status": "active",
        "version": topic_create_version,
    }
    if created_topic_meta != expected_topic_create:
        failures.append("topic create: exact sensitive state and server version are required")
    if topic_db_before_replay != created_topic_meta:
        failures.append("topic create: HTTP state differs from complete persisted snapshot")
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
        "hard_window_days": 60,
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
    stale_topic_payload = _required(
        failures, "stale topic update", stale_topic, {"current", "audit_correlation"}
    )
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
    for label, response, expected_topics in (
        ("PAT after grant", pat_after_grant, ["general", topic_slug]),
        ("PAT after revoke", pat_after_revoke, ["general"]),
        ("session after revoke", session_after_revoke, ["general"]),
    ):
        me_payload = _required(failures, label, response, {"memberships"})
        me_memberships = _list_field(failures, label, me_payload, "memberships")
        me_membership = (
            next(
                (
                    row
                    for row in me_memberships
                    if isinstance(row, dict) and row.get("project") == project_slug
                ),
                None,
            )
            if me_memberships is not None
            else None
        )
        if (
            not isinstance(me_membership, dict)
            or me_membership.get("allowed_topics") != expected_topics
        ):
            failures.append(f"{label}: live credential retained stale effective authority")
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
    if changed_db_before_replay != changed_after:
        failures.append("membership update: HTTP after differs from complete persisted snapshot")
    if grant_db_before_replay != grant_after:
        failures.append("membership grant: HTTP after differs from complete persisted snapshot")
    if (
        revoke_db_before_replay != revoke_after
        or await _membership_row(harness, project_id, target.user["id"]) != revoke_after
    ):
        failures.append("membership revoke: final persisted authority is not exact")
    if (
        topic_update_db_before_replay != topic_after
        or await _topic_row(harness, project_id, topic_slug) != topic_after
    ):
        failures.append("topic update: HTTP after differs from complete persisted snapshot")
    topics_persisted = await _topic_state(harness, project_id)
    if (
        tuple(row for row in topics_persisted if row[1] != topic_slug) != topics_before
        or sum(row[1] == topic_slug for row in topics_persisted) != 1
    ):
        failures.append("topic idempotency changed baseline taxonomy or duplicated the topic")
    for label, payload, action in (
        (
            "membership create",
            created_membership_idempotent,
            f"membership:create target={target.user['id']}",
        ),
        (
            "membership update",
            changed_idempotent,
            f"membership:update target={target.user['id']}",
        ),
        ("topic create", created_topic_idempotent, f"topic:create target={topic_slug}"),
        ("topic update", edited_topic_idempotent, f"topic:update target={topic_slug}"),
        (
            "membership topic grant",
            grant_idempotent,
            f"membership:update target={target.user['id']}",
        ),
        (
            "membership topic revoke",
            revoke_idempotent,
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
    for label, payload, action in (
        (
            "stale membership update",
            stale_payload,
            f"membership:update target={target.user['id']}",
        ),
        ("stale topic update", stale_topic_payload, f"topic:update target={topic_slug}"),
    ):
        await _require_audit(
            failures,
            label,
            harness,
            project_id,
            payload,
            principal_id=admin.user["id"],
            action=action,
            denied=True,
        )
    for action, expected_count in (
        (f"membership:create target={target.user['id']}", 1),
        (f"membership:update target={target.user['id']}", 3),
        (f"topic:create target={topic_slug}", 1),
        (f"topic:update target={topic_slug}", 1),
    ):
        rows = await _matching_audits(
            harness,
            project_id,
            principal_id=admin.user["id"],
            action=action,
            denied=False,
        )
        if len(rows) != expected_count:
            failures.append(
                f"membership/topic idempotency: {action} persisted {len(rows)} audit outcomes"
            )
    assert target_session
    assert not failures, "\n".join(failures)


async def test_project_delete_saga_resumes_after_a_multistore_failure(
    build_harness: Callable[..., Harness],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A crash after the durable checkpoint must not strand or falsely replay the erasure."""

    from rsc_brain.knowledge import gdpr

    harness = build_harness()
    identity = IdentityService(harness.sm)
    await identity.ensure_default_project()
    owner = await _active_user(identity, platform_role="owner")
    project_slug = unique_slug("saga-delete")
    project_id = await identity.create_project(project_slug, "Saga delete")
    original = gdpr.hard_delete_project
    attempts = 0

    async def fail_once(*args: object, **kwargs: object) -> dict[str, int]:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("injected multistore interruption")
        return await original(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(gdpr, "hard_delete_project", fail_once)
    async with _client(harness, tmp_path) as client:
        session_headers, _ = await _session(client, owner)
        headers = {**session_headers, "Idempotency-Key": "delete-saga-recovery-contract"}
        params: dict[str, str | int] = {"expected_version": 1, "confirm": project_slug}
        interrupted = await client.delete(
            f"/api/v1/admin/projects/{project_slug}", headers=headers, params=params
        )
        resumed = await client.delete(
            f"/api/v1/admin/projects/{project_slug}", headers=headers, params=params
        )
        replay = await client.delete(
            f"/api/v1/admin/projects/{project_slug}", headers=headers, params=params
        )

    assert interrupted.status_code == 500
    assert resumed.status_code == 200
    resumed_payload = resumed.json()
    assert resumed_payload == {
        "project": project_slug,
        "status": "deleted",
        "audit_correlation": resumed_payload["audit_correlation"],
        "replayed": True,
    }
    assert replay.status_code == 200
    assert replay.json() == resumed_payload
    assert attempts == 2
    assert await _project_row(harness, project_slug) is None
    async with harness.sm() as session:
        command = await session.scalar(
            select(models.ManagementCommand).where(
                models.ManagementCommand.operation == f"project:delete target={project_slug}",
                models.ManagementCommand.idempotency_key == "delete-saga-recovery-contract",
            )
        )
        audit_count = len(
            list(
                await session.scalars(
                    select(models.AuditLog).where(
                        models.AuditLog.project_id == uuid.UUID(project_id),
                        models.AuditLog.action == f"project:delete target={project_slug}",
                    )
                )
            )
        )
    assert command is not None and command.status == "completed"
    assert audit_count == 1


async def test_project_admin_cannot_escalate_platform_role_or_disable_cross_project_identity(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    project_slug = unique_slug("authority-a")
    project_id = await harness.setup_project(project_slug, [("general", 0)])
    foreign_id = await harness.setup_project(unique_slug("authority-b"), [("general", 0)])
    identity = IdentityService(harness.sm)
    admin = await _active_user(identity)
    target = await _active_user(identity)
    await identity.add_membership(
        admin.user["id"], project_id, role="project-admin", allowed_topics=("general",)
    )
    await identity.add_membership(
        target.user["id"], project_id, role="member", allowed_topics=("general",)
    )
    await identity.add_membership(
        target.user["id"], foreign_id, role="member", allowed_topics=("general",)
    )
    escalated_email = f"{unique_slug('escalated')}@example.com"

    async with _client(harness, tmp_path) as client:
        session_headers, _ = await _session(client, admin)
        elevated = await client.post(
            f"/api/v1/admin/users/invite?project={project_slug}",
            headers={**session_headers, "Idempotency-Key": "deny-platform-escalation"},
            json={
                "email": escalated_email,
                "platform_role": "owner",
                "project_role": "member",
                "allowed_topics": ["general"],
            },
        )
        cross_project_disable = await client.post(
            f"/api/v1/admin/users/{target.user['id']}/disable?project={project_slug}",
            headers={**session_headers, "Idempotency-Key": "deny-cross-project-disable"},
            json={"expected_status": "active", "impact_acknowledged": True},
        )

    assert elevated.status_code == 403
    assert cross_project_disable.status_code == 403
    async with harness.sm() as session:
        escalated = await session.scalar(
            select(models.User.id).where(models.User.email == escalated_email)
        )
        target_row = await session.get(models.User, uuid.UUID(target.user["id"]))
        target_memberships = list(
            await session.scalars(
                select(models.ProjectMembership).where(
                    models.ProjectMembership.user_id == uuid.UUID(target.user["id"])
                )
            )
        )
    assert escalated is None
    assert target_row is not None and target_row.status == "active" and target_row.version == 1
    assert len(target_memberships) == 2


async def test_concurrent_same_key_commits_one_transition_audit_and_replay(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    project_slug = unique_slug("concurrent-command")
    project_id = await harness.setup_project(project_slug, [("general", 0)])
    identity = IdentityService(harness.sm)
    admin = await _active_user(identity)
    await identity.add_membership(
        admin.user["id"], project_id, role="project-admin", allowed_topics=("general",)
    )
    topic_slug = unique_slug("one-topic")

    async with _client(harness, tmp_path) as client:
        session_headers, _ = await _session(client, admin)
        headers = {**session_headers, "Idempotency-Key": "concurrent-topic-contract"}

        async def create() -> httpx.Response:
            return await client.post(
                f"/api/v1/admin/topics?project={project_slug}",
                headers=headers,
                json={"slug": topic_slug, "name": "One topic", "sensitivity": 2},
            )

        first, second = await asyncio.gather(create(), create())
        mismatch = await client.post(
            f"/api/v1/admin/topics?project={project_slug}",
            headers=headers,
            json={"slug": topic_slug, "name": "Different request", "sensitivity": 2},
        )

    assert sorted((first.status_code, second.status_code)) == [200, 201]
    original = first.json() if first.status_code == 201 else second.json()
    replay = second.json() if second.status_code == 200 else first.json()
    assert replay == {**original, "replayed": True}
    assert mismatch.status_code == 409
    assert set(mismatch.json()) == {"detail", "audit_correlation"}
    async with harness.sm() as session:
        topic_count = len(
            list(
                await session.scalars(
                    select(models.Topic).where(
                        models.Topic.project_id == uuid.UUID(project_id),
                        models.Topic.slug == topic_slug,
                    )
                )
            )
        )
        audit_count = len(
            list(
                await session.scalars(
                    select(models.AuditLog).where(
                        models.AuditLog.project_id == uuid.UUID(project_id),
                        models.AuditLog.action == f"topic:create target={topic_slug}",
                        models.AuditLog.denied.is_(False),
                    )
                )
            )
        )
        denied_audit_count = len(
            list(
                await session.scalars(
                    select(models.AuditLog).where(
                        models.AuditLog.project_id == uuid.UUID(project_id),
                        models.AuditLog.action == f"topic:create target={topic_slug}",
                        models.AuditLog.denied.is_(True),
                    )
                )
            )
        )
        command_count = len(
            list(
                await session.scalars(
                    select(models.ManagementCommand).where(
                        models.ManagementCommand.project_id == uuid.UUID(project_id),
                        models.ManagementCommand.operation == f"topic:create target={topic_slug}",
                    )
                )
            )
        )
    assert (topic_count, audit_count, denied_audit_count, command_count) == (1, 1, 1, 1)
