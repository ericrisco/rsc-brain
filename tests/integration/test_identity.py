"""Integration: identity lifecycle, PAT scope resolution, timed <5s revocation (SPEC-04)."""

from __future__ import annotations

import time

import pytest

from rsc_brain.identity.resolve import resolve_scope
from rsc_brain.identity.service import IdentityService
from rsc_brain.scope import PrincipalType
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker

pytestmark = pytest.mark.integration


async def test_identity_lifecycle_and_timed_revocation(migrated_dsn: str) -> None:
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    svc = IdentityService(sessionmaker)
    try:
        default_id = await svc.ensure_default_project()
        assert "default" in await svc.list_projects()

        invitation = await svc.invite_user("alice@example.com", role="member")
        user_id = await svc.accept_invitation(invitation.token, "s3cret-password-abc")
        with pytest.raises(ValueError):  # single-use invitation
            await svc.accept_invitation(invitation.token, "second-try-xyz")

        membership_id = await svc.add_membership(
            user_id, default_id, role="member", allowed_topics=("finance",)
        )
        # A slug the bootstrap does not already own: it now creates the ingestion fallback
        # topic itself (AUDIT-066), and `create_topic` rightly refuses a duplicate.
        await svc.create_topic(default_id, "finance", "Finance", sensitivity=0)
        pat = await svc.issue_pat(membership_id, name="cli")

        scope = await resolve_scope(sessionmaker, pat.token)
        assert scope is not None
        assert scope.principal_type is PrincipalType.HUMAN
        assert scope.project_id == default_id
        assert "finance" in scope.allowed_topics
        # Unknown token resolves to None (indistinguishable from a revoked one).
        assert await resolve_scope(sessionmaker, "ck_does-not-exist") is None

        # Revocation takes effect immediately (direct lookup, no cache) — measured < 5s.
        start = time.monotonic()
        await svc.revoke_pat(pat.id)
        assert await resolve_scope(sessionmaker, pat.token) is None
        assert time.monotonic() - start < 5.0

        # Deactivating the user revokes their other PATs too.
        pat2 = await svc.issue_pat(membership_id)
        assert await resolve_scope(sessionmaker, pat2.token) is not None
        await svc.deactivate_user(user_id)
        assert await resolve_scope(sessionmaker, pat2.token) is None
    finally:
        await engine.dispose()


async def test_agent_authenticates_with_its_own_identity(migrated_dsn: str) -> None:
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    svc = IdentityService(sessionmaker)
    try:
        project_id = await svc.create_project("agents-proj", "Agents")
        owner_inv = await svc.invite_user("owner@example.com", role="admin")
        owner_id = await svc.accept_invitation(owner_inv.token, "owner-password-123")
        agent_id = await svc.create_agent(
            project_id, owner_id, "ingestor-bot", allowed_topics=("finance",)
        )
        agent_pat = await svc.issue_agent_pat(agent_id, name="svc")

        scope = await resolve_scope(sessionmaker, agent_pat.token)
        assert scope is not None
        assert scope.principal_type is PrincipalType.AGENT
        assert scope.principal_id == agent_id  # its own identity, never the owner's
        assert scope.principal_id != owner_id

        await svc.deactivate_agent(agent_id)
        assert await resolve_scope(sessionmaker, agent_pat.token) is None
    finally:
        await engine.dispose()


async def test_default_project_is_not_deletable(migrated_dsn: str) -> None:
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    svc = IdentityService(sessionmaker)
    try:
        await svc.ensure_default_project()
        with pytest.raises(ValueError, match="default"):
            await svc.delete_project("default")
    finally:
        await engine.dispose()


async def test_project_identities_are_reachable_without_the_creation_output(
    migrated_dsn: str,
) -> None:
    """AUDIT-113: every taxonomy and membership command takes `--project-id`.

    Before this, only `projects create` ever printed one — so an operator who lost that line, or
    whose project was created by `brain init` (which prints no id), could not administer the project
    from the CLI again. The listing has to carry the identity the other commands require.
    """
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    svc = IdentityService(sessionmaker)
    try:
        project_id = await svc.create_project("reachable", "Reachable")

        identities = await svc.list_project_identities()

        assert {"slug": "reachable", "id": project_id} in identities
        slugs = [entry["slug"] for entry in identities]
        assert slugs == sorted(slugs), "ordered by slug so an operator can find a project by name"
    finally:
        await engine.dispose()
