"""Identity lifecycle completion (SPEC-10 increment D, FR-4.12): single-use password reset and
deactivation revoking ALL of a user's credentials (PAT + OAuth token + console session) in <5s.
"""

from __future__ import annotations

import datetime as dt
import time
import uuid

import pytest
from sqlalchemy import select

from rsc_brain import security
from rsc_brain.identity.resolve import resolve_scope
from rsc_brain.identity.service import IdentityService
from rsc_brain.identity.sessions import login, resolve_session
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker

pytestmark = pytest.mark.integration

P1 = "first-password-abc123"
P2 = "second-password-xyz789"


async def test_password_reset_is_single_use_and_swaps_credentials(migrated_dsn: str) -> None:
    engine = make_engine(migrated_dsn)
    sm = make_sessionmaker(engine)
    svc = IdentityService(sm)
    try:
        inv = await svc.invite_user("dana@example.com", role="member")
        await svc.accept_invitation(inv.token, P1)
        assert await login(sm, "dana@example.com", P1) is not None

        # Unknown email → no token leaked; known active email → a single-use reset token.
        assert await svc.request_password_reset("nobody@example.com") is None
        reset = await svc.request_password_reset("dana@example.com")
        assert reset is not None

        await svc.reset_password(reset.token, P2)
        assert await login(sm, "dana@example.com", P1) is None  # old password no longer works
        assert await login(sm, "dana@example.com", P2) is not None  # new one does

        with pytest.raises(ValueError, match="already-used"):
            await svc.reset_password(reset.token, "third-attempt-000")
    finally:
        await engine.dispose()


async def test_deactivation_revokes_every_credential_under_5s(migrated_dsn: str) -> None:
    engine = make_engine(migrated_dsn)
    sm = make_sessionmaker(engine)
    svc = IdentityService(sm)
    try:
        project_id = await svc.create_project("deact-proj", "Deact")
        inv = await svc.invite_user("evan@example.com", role="member")
        user_id = await svc.accept_invitation(inv.token, P1)
        membership_id = await svc.add_membership(
            user_id, project_id, role="member", allowed_topics=("general",)
        )
        pat = await svc.issue_pat(membership_id, name="cli")
        oauth_token = "oauth-access-deact"
        async with sm() as session:
            client = models.OAuthClient(client_id=f"c-{uuid.uuid4().hex[:8]}", client_metadata={})
            session.add(client)
            await session.flush()
            session.add(
                models.OAuthToken(
                    membership_id=uuid.UUID(membership_id),
                    client_id=client.id,
                    access_token_hash=security.token_hash(oauth_token),
                    expires_at=dt.datetime.now(dt.UTC) + dt.timedelta(hours=1),
                )
            )
            await session.commit()
        session_token = await login(sm, "evan@example.com", P1)
        assert session_token is not None

        # All three credentials resolve before deactivation.
        assert await resolve_scope(sm, pat.token) is not None
        assert await resolve_scope(sm, oauth_token) is not None
        assert await resolve_session(sm, session_token) is not None

        # Deactivate → every credential stops resolving, measured well under the 5s budget.
        start = time.monotonic()
        await svc.deactivate_user(user_id)
        assert await resolve_scope(sm, pat.token) is None
        assert await resolve_scope(sm, oauth_token) is None
        assert await resolve_session(sm, session_token) is None
        assert time.monotonic() - start < 5.0

        # Revocation is explicit + durable (revoked_at stamped on the OAuth token).
        async with sm() as session:
            row = await session.scalar(
                select(models.OAuthToken).where(
                    models.OAuthToken.access_token_hash == security.token_hash(oauth_token)
                )
            )
            assert row is not None and row.revoked_at is not None
    finally:
        await engine.dispose()
