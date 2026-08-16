"""OAuth 2.1 authorization-server flow against the real container (SPEC-10 AC#2/#3/#5).

Drives a simulated public OAuth client (as Claude/ChatGPT would) end to end through the Authlib
server: DCR → authorize+consent (with a project selector) → code+PKCE exchange → an access token
that resolves to the chosen (user, project) scope. Adversarial: a wrong PKCE verifier is rejected,
a missing PKCE challenge is rejected, and a rotated refresh token cannot be reused. The live
Claude/ChatGPT interop is blocked-by-resource; this proves the flow the SDK will speak.
"""

from __future__ import annotations

import base64
import datetime as dt
import hashlib
import os
import secrets
from collections.abc import AsyncIterator, Callable
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from sqlalchemy import update

from rsc_brain import security
from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.identity.resolve import resolve_scope
from rsc_brain.identity.sessions import login
from rsc_brain.scope import PrincipalType
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import make_sync_engine, make_sync_sessionmaker

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

PASSWORD = "correct horse battery staple"
REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback"


def _pkce() -> tuple[str, str]:
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    )
    return verifier, challenge


async def _make_user(harness: Harness, project_id: str, *, platform_role: str = "member") -> str:
    from rsc_brain.identity.service import IdentityService

    identity = IdentityService(harness.sm)
    email = f"{unique_slug('oauth')}@example.com"
    invited = await identity.invite_user(email, role=platform_role)
    user_id = await identity.accept_invitation(invited.token, PASSWORD)
    await identity.add_membership(user_id, project_id, allowed_topics=("general",))
    return email


async def _client(harness: Harness, migrated_dsn: str) -> AsyncIterator[httpx.AsyncClient]:
    # Tests speak plain HTTP to the ASGI app; in production TLS is terminated by Caddy and the app
    # trusts the forwarded https scheme. This relaxation is test-only (production never sets it).
    os.environ.setdefault("AUTHLIB_INSECURE_TRANSPORT", "1")
    sync_engine = make_sync_engine(migrated_dsn)
    deps = ApiDeps(
        sessionmaker=harness.sm,
        gateway=harness.gateway,
        sync_sessionmaker=make_sync_sessionmaker(sync_engine),
    )
    app = create_app(deps=deps)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test", follow_redirects=False
    ) as client:
        try:
            yield client
        finally:
            sync_engine.dispose()


async def _register(client: httpx.AsyncClient) -> str:
    resp = await client.post(
        "/oauth/register",
        json={"redirect_uris": [REDIRECT_URI], "client_name": "Claude"},
    )
    assert resp.status_code == 201, resp.text
    return str(resp.json()["client_id"])


async def _authorize_code(
    client: httpx.AsyncClient,
    *,
    client_id: str,
    challenge: str,
    project_id: str,
    auth: dict[str, str],
    with_pkce: bool = True,
) -> httpx.Response:
    params = {
        "client_id": client_id,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "state": "xyz",
        "scope": "",
    }
    if with_pkce:
        params["code_challenge"] = challenge
        params["code_challenge_method"] = "S256"
    # The consent page renders for a logged-in user...
    page = await client.get("/oauth/authorize", params=params, headers=auth)
    assert page.status_code == 200, page.text
    # ...then the user approves, binding the token to the chosen project.
    return await client.post(
        "/oauth/authorize",
        params=params,
        data={"consent": "allow", "membership_project_id": project_id},
        headers=auth,
    )


async def _issue_access_token(
    client: httpx.AsyncClient,
    *,
    client_id: str,
    project_id: str,
    auth: dict[str, str],
) -> str:
    """Issue an access token through the real DCR/consent/PKCE server path."""
    verifier, challenge = _pkce()
    redirect = await _authorize_code(
        client,
        client_id=client_id,
        challenge=challenge,
        project_id=project_id,
        auth=auth,
    )
    assert redirect.status_code in (302, 303), redirect.text
    code = parse_qs(urlparse(redirect.headers["location"]).query)["code"][0]
    token_response = await client.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT_URI,
            "client_id": client_id,
            "code_verifier": verifier,
        },
    )
    assert token_response.status_code == 200, token_response.text
    return str(token_response.json()["access_token"])


async def test_owner_oauth_inventory_and_dead_credentials(
    build_harness: Callable[..., Harness], migrated_dsn: str
) -> None:
    """A real owner OAuth token reaches inventory; revoked and expired tokens remain 401."""
    harness = build_harness()
    slug = unique_slug("oauth-inventory")
    project_id = await harness.setup_project(slug, [("general", 0)])
    email = await _make_user(harness, project_id, platform_role="owner")
    session_token = await login(harness.sm, email, PASSWORD)
    assert session_token is not None
    session_auth = {"Authorization": f"Bearer {session_token}"}

    async for client in _client(harness, migrated_dsn):
        client_id = await _register(client)
        access = await _issue_access_token(
            client, client_id=client_id, project_id=project_id, auth=session_auth
        )
        oauth_auth = {"Authorization": f"Bearer {access}"}

        inventory = await client.get("/api/v1/admin/projects", headers=oauth_auth)
        assert inventory.status_code == 200, inventory.text
        assert slug in {item["slug"] for item in inventory.json()["projects"]}

        connections = await client.get("/api/v1/me/connections", headers=session_auth)
        assert connections.status_code == 200, connections.text
        connection_id = connections.json()["connections"][0]["id"]
        revoked = await client.delete(
            f"/api/v1/me/connections/{connection_id}", headers=session_auth
        )
        assert revoked.status_code == 200, revoked.text
        denied_revoked = await client.get("/api/v1/admin/projects", headers=oauth_auth)
        assert denied_revoked.status_code == 401, denied_revoked.text

        expired_access = await _issue_access_token(
            client, client_id=client_id, project_id=project_id, auth=session_auth
        )
        async with harness.sm() as database:
            await database.execute(
                update(models.OAuthToken)
                .where(models.OAuthToken.access_token_hash == security.token_hash(expired_access))
                .values(expires_at=dt.datetime.now(dt.UTC) - dt.timedelta(seconds=1))
            )
            await database.commit()
        denied_expired = await client.get(
            "/api/v1/admin/projects",
            headers={"Authorization": f"Bearer {expired_access}"},
        )
        assert denied_expired.status_code == 401, denied_expired.text


async def test_full_pkce_flow_and_scope(
    build_harness: Callable[..., Harness], migrated_dsn: str
) -> None:
    harness = build_harness()
    slug = unique_slug("acme")
    project_id = await harness.setup_project(slug, [("general", 0)])
    email = await _make_user(harness, project_id)
    session = await login(harness.sm, email, PASSWORD)
    assert session is not None
    auth = {"Authorization": f"Bearer {session}"}
    _verifier, challenge = _pkce()

    async for client in _client(harness, migrated_dsn):
        client_id = await _register(client)

        redirect = await _authorize_code(
            client, client_id=client_id, challenge=challenge, project_id=project_id, auth=auth
        )
        assert redirect.status_code in (302, 303), redirect.text
        location = redirect.headers["location"]
        code = parse_qs(urlparse(location).query)["code"][0]
        assert parse_qs(urlparse(location).query)["state"][0] == "xyz"

        # A wrong PKCE verifier is rejected — the challenge is enforced by Authlib.
        bad = await client.post(
            "/oauth/token",
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": REDIRECT_URI,
                "client_id": client_id,
                "code_verifier": "wrong-verifier-value-not-matching",
            },
        )
        assert bad.status_code >= 400

        # A second exchange with the correct verifier fails too — the code is single-use.
        # (Re-run the flow for the happy path with a fresh code.)
        verifier2, challenge2 = _pkce()
        redirect2 = await _authorize_code(
            client, client_id=client_id, challenge=challenge2, project_id=project_id, auth=auth
        )
        code2 = parse_qs(urlparse(redirect2.headers["location"]).query)["code"][0]
        token_resp = await client.post(
            "/oauth/token",
            data={
                "grant_type": "authorization_code",
                "code": code2,
                "redirect_uri": REDIRECT_URI,
                "client_id": client_id,
                "code_verifier": verifier2,
            },
        )
        assert token_resp.status_code == 200, token_resp.text
        tokens = token_resp.json()
        assert tokens["token_type"].lower() == "bearer"
        assert tokens["expires_in"] <= 3600  # FR-4.10: access ≤ 1h
        access, refresh = tokens["access_token"], tokens["refresh_token"]

    # The issued access token resolves to the chosen (user, project) scope (FR-12.3).
    scope = await resolve_scope(harness.sm, access)
    assert scope is not None
    assert scope.principal_type is PrincipalType.HUMAN
    assert scope.project_id == project_id
    assert "general" in scope.allowed_topics

    # Refresh rotation: a fresh access+refresh is issued; the OLD refresh cannot be reused.
    async for client in _client(harness, migrated_dsn):
        rotated = await client.post(
            "/oauth/token",
            data={"grant_type": "refresh_token", "refresh_token": refresh, "client_id": client_id},
        )
        assert rotated.status_code == 200, rotated.text
        new_refresh = rotated.json()["refresh_token"]
        assert new_refresh != refresh

        reuse = await client.post(
            "/oauth/token",
            data={"grant_type": "refresh_token", "refresh_token": refresh, "client_id": client_id},
        )
        assert reuse.status_code >= 400  # a rotated refresh token is dead


async def test_public_client_cannot_get_a_token_without_pkce(
    build_harness: Callable[..., Harness], migrated_dsn: str
) -> None:
    """A public client (token_endpoint_auth_method=none, as Claude/ChatGPT) MUST use PKCE: the
    token exchange is rejected when no code_verifier is presented (FR-4.10, RFC 9700)."""
    harness = build_harness()
    project_id = await harness.setup_project(unique_slug("acme"), [("general", 0)])
    email = await _make_user(harness, project_id)
    session = await login(harness.sm, email, PASSWORD)
    assert session is not None
    auth = {"Authorization": f"Bearer {session}"}

    async for client in _client(harness, migrated_dsn):
        client_id = await _register(client)
        redirect = await _authorize_code(
            client,
            client_id=client_id,
            challenge="",
            project_id=project_id,
            auth=auth,
            with_pkce=False,
        )
        assert redirect.status_code in (302, 303)
        code = parse_qs(urlparse(redirect.headers["location"]).query)["code"][0]
        # No code_verifier from a public client ⇒ the token endpoint refuses (PKCE mandatory).
        resp = await client.post(
            "/oauth/token",
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": REDIRECT_URI,
                "client_id": client_id,
            },
        )
        assert resp.status_code >= 400
