"""Integration: OAuth 2.1 access-token resolution to scope (SPEC-10 increment A).

An issued OAuth access token resolves through the same scope-from-token path as a PAT
(FR-12.3): token hash → `oauth_tokens` → membership → `(user, project, allowed_topics)`.
Revoked, expired, or disabled-user tokens all resolve to ``None`` (denied ≡ absent, <5s).
"""

from __future__ import annotations

import datetime as dt
import uuid

import pytest

from rsc_brain import security
from rsc_brain.identity.resolve import resolve_scope
from rsc_brain.identity.service import IdentityService
from rsc_brain.scope import PrincipalType
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker

pytestmark = pytest.mark.integration


async def _issue_oauth_token(
    sessionmaker: object, membership_id: str, token: str, *, expires_in: dt.timedelta
) -> str:
    async with sessionmaker() as session:  # type: ignore[operator]
        client = models.OAuthClient(client_id=f"client-{uuid.uuid4().hex[:8]}", client_metadata={})
        session.add(client)
        await session.flush()
        oauth = models.OAuthToken(
            membership_id=uuid.UUID(membership_id),
            client_id=client.id,
            access_token_hash=security.token_hash(token),
            refresh_token_hash=security.token_hash(token + "-refresh"),
            expires_at=dt.datetime.now(dt.UTC) + expires_in,
        )
        session.add(oauth)
        await session.commit()
        return str(oauth.id)


async def test_oauth_access_token_resolves_and_revokes(migrated_dsn: str) -> None:
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    svc = IdentityService(sessionmaker)
    try:
        project_id = await svc.create_project("oauth-proj", "OAuth")
        inv = await svc.invite_user("bob@example.com", role="member")
        user_id = await svc.accept_invitation(inv.token, "s3cret-password-abc")
        membership_id = await svc.add_membership(
            user_id, project_id, role="member", allowed_topics=("general",)
        )

        token = "oauth-access-live"
        oauth_id = await _issue_oauth_token(
            sessionmaker, membership_id, token, expires_in=dt.timedelta(hours=1)
        )

        # Resolves exactly like a PAT: human principal, the bound project + topics, scope from token.
        scope = await resolve_scope(sessionmaker, token)
        assert scope is not None
        assert scope.principal_type is PrincipalType.HUMAN
        assert scope.principal_id == user_id
        assert scope.project_id == project_id
        assert "general" in scope.allowed_topics

        # Revoking the token stops resolution immediately (direct lookup, no cache).
        async with sessionmaker() as session:
            row = await session.get(models.OAuthToken, uuid.UUID(oauth_id))
            assert row is not None
            row.revoked_at = dt.datetime.now(dt.UTC)
            await session.commit()
        assert await resolve_scope(sessionmaker, token) is None
    finally:
        await engine.dispose()


async def test_oauth_token_expiry_and_disabled_user(migrated_dsn: str) -> None:
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    svc = IdentityService(sessionmaker)
    try:
        project_id = await svc.create_project("oauth-proj2", "OAuth2")
        inv = await svc.invite_user("carol@example.com", role="member")
        user_id = await svc.accept_invitation(inv.token, "s3cret-password-xyz")
        membership_id = await svc.add_membership(user_id, project_id, role="member")

        # An expired access token never resolves.
        expired = "oauth-access-expired"
        await _issue_oauth_token(
            sessionmaker, membership_id, expired, expires_in=dt.timedelta(hours=-1)
        )
        assert await resolve_scope(sessionmaker, expired) is None

        # A live token stops resolving the moment the user is deactivated (FR-4.12).
        live = "oauth-access-until-disabled"
        await _issue_oauth_token(
            sessionmaker, membership_id, live, expires_in=dt.timedelta(hours=1)
        )
        assert await resolve_scope(sessionmaker, live) is not None
        await svc.deactivate_user(user_id)
        assert await resolve_scope(sessionmaker, live) is None
    finally:
        await engine.dispose()
