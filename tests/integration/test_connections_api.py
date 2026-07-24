"""Connections API (SPEC-10 increment E, FR-4.13): a user lists/revokes their own OAuth
connections; an admin revokes anyone's. Revocation stops the token resolving (<5s)."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable
from pathlib import Path

import httpx
import pytest

from rsc_brain import security
from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.identity.resolve import resolve_scope
from rsc_brain.identity.service import IdentityService
from rsc_brain.identity.sessions import login
from rsc_brain.stores.relational import models

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

PASSWORD = "correct horse battery staple"


def _client(harness: Harness, tmp_path: Path) -> httpx.AsyncClient:
    app = create_app(
        deps=ApiDeps(sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path))
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _seed(harness: Harness, project_id: str, token: str) -> tuple[str, str]:
    identity = IdentityService(harness.sm)
    email = f"{unique_slug('conn')}@example.com"
    inv = await identity.invite_user(email, role="member")
    user_id = await identity.accept_invitation(inv.token, PASSWORD)
    membership_id = await identity.add_membership(user_id, project_id, allowed_topics=("general",))
    async with harness.sm() as session:
        client = models.OAuthClient(
            client_id=f"c-{uuid.uuid4().hex[:8]}", client_metadata={"client_name": "Claude"}
        )
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
    return email, user_id


async def test_user_lists_and_revokes_own_connection(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    token = "oauth-conn-live"
    email, _ = await _seed(harness, project_id, token)
    session = await login(harness.sm, email, PASSWORD)
    assert session is not None
    auth = {"Authorization": f"Bearer {session}"}

    async with _client(harness, tmp_path) as client:
        listed = await client.get("/api/v1/me/connections", headers=auth)
        assert listed.status_code == 200
        conns = listed.json()["connections"]
        assert len(conns) == 1
        assert conns[0]["client"] == "Claude"
        connection_id = conns[0]["id"]

        assert await resolve_scope(harness.sm, token) is not None
        revoked = await client.delete(f"/api/v1/me/connections/{connection_id}", headers=auth)
        assert revoked.status_code == 200
        assert await resolve_scope(harness.sm, token) is None  # stops resolving after revoke


async def test_non_owner_cannot_revoke_anothers_connection(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    token = "oauth-conn-victim"
    await _seed(harness, project_id, token)  # the owner
    # A second, unrelated user tries to revoke the first user's connection.
    other_email, _ = await _seed(harness, project_id, "oauth-other")
    session = await login(harness.sm, other_email, PASSWORD)
    assert session is not None
    auth = {"Authorization": f"Bearer {session}"}

    async with harness.sm() as db:
        from sqlalchemy import select

        victim_id = await db.scalar(
            select(models.OAuthToken.id).where(
                models.OAuthToken.access_token_hash == security.token_hash(token)
            )
        )

    async with _client(harness, tmp_path) as client:
        resp = await client.delete(f"/api/v1/me/connections/{victim_id}", headers=auth)
        assert resp.status_code == 404  # denied ≡ absent
    assert await resolve_scope(harness.sm, token) is not None  # untouched
