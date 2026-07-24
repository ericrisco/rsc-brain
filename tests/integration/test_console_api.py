"""Console backend prerequisites (SPEC-07 Increment A) against the real container.

Session login on the single D11 identity, /me memberships, self-service PAT create→resolve→revoke,
logout + disabled-user stop the session resolving (<5s discipline). All through the API — the
contract the Next console consumes.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import httpx
import pytest
from sqlalchemy import update

from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.identity.resolve import resolve_scope
from rsc_brain.identity.service import IdentityService
from rsc_brain.stores.relational import models
from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

PASSWORD = "correct horse battery staple"


async def _make_user_with_password(harness: Harness, project_id: str) -> tuple[str, str]:
    """Invite + accept (sets the argon2 password + activates) + add a membership. Returns
    (email, user_id)."""
    identity = IdentityService(harness.sm)
    email = f"{unique_slug('console')}@example.com"
    invited = await identity.invite_user(email, role="member")
    user_id = await identity.accept_invitation(invited.token, PASSWORD)
    await identity.add_membership(user_id, project_id, allowed_topics=("general",))
    return email, user_id


def _client(harness: Harness, tmp_path: Path) -> httpx.AsyncClient:
    app = create_app(
        deps=ApiDeps(sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path))
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def test_login_me_and_self_pat_lifecycle(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    slug = unique_slug("acme")
    project = await harness.setup_project(slug, [("general", 0)])
    email, _ = await _make_user_with_password(harness, project)

    async with _client(harness, tmp_path) as client:
        # Wrong password → 401; correct → a session token.
        bad = await client.post("/api/v1/auth/login", json={"email": email, "password": "nope"})
        assert bad.status_code == 401
        login = await client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORD})
        assert login.status_code == 200, login.text
        session = login.json()["session_token"]
        auth = {"Authorization": f"Bearer {session}"}

        # /me returns the user + memberships (drives the project selector).
        me = await client.get("/api/v1/me", headers=auth)
        assert me.status_code == 200
        assert [m["project"] for m in me.json()["memberships"]] == [slug]

        # Create a self-service PAT; it resolves against the MCP/admin path.
        created = await client.post("/api/v1/me/pats", json={"project": slug}, headers=auth)
        assert created.status_code == 201
        pat_id, pat_token = created.json()["pat_id"], created.json()["token"]
        assert await resolve_scope(harness.sm, pat_token) is not None

        listed = await client.get("/api/v1/me/pats", headers=auth)
        assert any(p["id"] == pat_id for p in listed.json()["pats"])

        # Revoke it → it stops resolving (<5s discipline: next lookup fails).
        revoked = await client.delete(f"/api/v1/me/pats/{pat_id}", headers=auth)
        assert revoked.status_code == 200
        assert await resolve_scope(harness.sm, pat_token) is None

        # Logout → the session stops resolving.
        await client.post("/api/v1/auth/logout", headers=auth)
        after = await client.get("/api/v1/me", headers=auth)
        assert after.status_code == 401


async def test_disabled_user_session_stops_resolving(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    email, _user_id = await _make_user_with_password(harness, project)

    async with _client(harness, tmp_path) as client:
        session = (
            await client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORD})
        ).json()["session_token"]
        auth = {"Authorization": f"Bearer {session}"}
        assert (await client.get("/api/v1/me", headers=auth)).status_code == 200

        # Disable the user directly; the session must stop resolving on the next request.
        async with harness.sm() as db:
            await db.execute(
                update(models.User).where(models.User.email == email).values(status="disabled")
            )
            await db.commit()
        assert (await client.get("/api/v1/me", headers=auth)).status_code == 401


async def test_pat_for_foreign_project_is_404(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    email, _ = await _make_user_with_password(harness, project)
    async with _client(harness, tmp_path) as client:
        session = (
            await client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORD})
        ).json()["session_token"]
        auth = {"Authorization": f"Bearer {session}"}
        # The user is not a member of this project → denied ≡ absent.
        response = await client.post(
            "/api/v1/me/pats", json={"project": unique_slug("ghost")}, headers=auth
        )
    assert response.status_code == 404
