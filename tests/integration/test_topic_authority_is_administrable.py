"""Integration (AUDIT-073): topic authority can be granted to and withdrawn from another principal.

The unit tests assert the surfaces exist. These assert they do the right thing against a real
Postgres+AGE+pgvector, including the two refusals SPEC-04 §3.2 names.
"""

from __future__ import annotations

import pytest

from rsc_brain.identity.resolve import resolve_scope
from rsc_brain.identity.service import IdentityService
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker

pytestmark = pytest.mark.integration


async def test_authority_can_be_granted_and_withdrawn_for_another_principal(
    migrated_dsn: str,
) -> None:
    """Before this, the only principal whose authority could change was whoever created the topic."""
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    svc = IdentityService(sessionmaker)
    try:
        # A project of this test's own: the integration database is shared for the whole session, so
        # `default` plus a common topic slug is a collision waiting for the next test that wants the
        # same name — which is precisely what happened when the membership tests landed.
        project = await svc.create_project("authority-grants", "Authority Grants")
        await svc.create_topic(project, "engineering", "Engineering", sensitivity=0)
        await svc.create_topic(project, "payroll", "Payroll", sensitivity=4)

        invitation = await svc.invite_user("colleague@example.com", role="member")
        user = await svc.accept_invitation(invitation.token, "s3cret-password-abc")
        membership = await svc.add_membership(user, project, role="member")
        pat = await svc.issue_pat(membership, name="colleague")

        # A member starts with nothing: empty authority is never all topics (AUDIT-020).
        scope = await resolve_scope(sessionmaker, pat.token)
        assert scope is not None
        assert scope.allowed_topics == frozenset()

        granted = await svc.grant_topics(user, project, ["engineering"])
        assert "engineering" in granted
        scope = await resolve_scope(sessionmaker, pat.token)
        assert scope is not None and "engineering" in scope.allowed_topics

        # Granting twice is idempotent, not a duplicate.
        assert await svc.grant_topics(user, project, ["engineering"]) == granted

        # A sensitive topic is grantable to someone other than its creator — the case that was
        # impossible, and the reason a company could not use the permission model at all.
        await svc.grant_topics(user, project, ["payroll"])
        scope = await resolve_scope(sessionmaker, pat.token)
        assert scope is not None and "payroll" in scope.allowed_topics

        remaining = await svc.revoke_topics(user, project, ["payroll"])
        assert "payroll" not in remaining and "engineering" in remaining
        scope = await resolve_scope(sessionmaker, pat.token)
        assert scope is not None
        assert "payroll" not in scope.allowed_topics, (
            "a revoked topic still resolved into the scope"
        )

        # Revoking what nobody holds is cleanup, not an error.
        assert await svc.revoke_topics(user, project, ["payroll"]) == remaining
    finally:
        await engine.dispose()


async def test_a_topic_from_another_project_cannot_be_granted(migrated_dsn: str) -> None:
    """SPEC-04 §3.2's acceptance check, which had no implementation to check: `grant_topics` merged
    whatever string it was given, so authority accepted unvalidated writes."""
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    svc = IdentityService(sessionmaker)
    try:
        home = await svc.create_project("authority-home", "Authority Home")
        elsewhere = await svc.create_project("authority-neighbour", "Authority Neighbour")
        await svc.create_topic(elsewhere, "their-secrets", "Their Secrets", sensitivity=4)

        invitation = await svc.invite_user("stranger@example.com", role="member")
        user = await svc.accept_invitation(invitation.token, "s3cret-password-abc")
        await svc.add_membership(user, home, role="member")

        with pytest.raises(ValueError):
            await svc.grant_topics(user, home, ["their-secrets"])
        with pytest.raises(ValueError):
            await svc.grant_topics(user, home, ["not-a-topic-at-all"])

        assert await svc.membership_topics(user, home) == ()
    finally:
        await engine.dispose()


async def test_a_missing_membership_is_distinguishable_from_empty_authority(
    migrated_dsn: str,
) -> None:
    """The operator surfaces need this to refuse loudly instead of reporting an empty success."""
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    svc = IdentityService(sessionmaker)
    try:
        project = await svc.create_project("authority-outsider", "Authority Outsider")
        invitation = await svc.invite_user("outsider@example.com", role="member")
        user = await svc.accept_invitation(invitation.token, "s3cret-password-abc")

        assert await svc.membership_topics(user, project) is None, (
            "a non-member is indistinguishable from a member holding nothing"
        )
        await svc.add_membership(user, project, role="member")
        assert await svc.membership_topics(user, project) == ()
    finally:
        await engine.dispose()
