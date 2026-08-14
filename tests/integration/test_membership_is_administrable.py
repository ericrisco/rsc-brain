"""Integration (AUDIT-074): a second user can be made a member, and unmade.

The unit tests assert the surfaces exist. These assert the behaviour that matters against a real
Postgres+AGE+pgvector — including that detaching a membership stops its credentials resolving, which
is the half of access control that runs when someone leaves a team.
"""

from __future__ import annotations

import pytest
from sqlalchemy.exc import IntegrityError

from rsc_brain.identity.resolve import resolve_scope
from rsc_brain.identity.service import IdentityService
from rsc_brain.stores.relational.database import make_engine, make_sessionmaker

pytestmark = pytest.mark.integration


async def test_an_invited_user_becomes_able_to_act_only_once_made_a_member(
    migrated_dsn: str,
) -> None:
    """The full chain a company walks, entirely through service calls the surfaces now expose."""
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    svc = IdentityService(sessionmaker)
    try:
        project = await svc.ensure_default_project()
        await svc.create_topic(project, "engineering", "Engineering", sensitivity=0)

        invitation = await svc.invite_user("newcomer@example.com", role="member")
        user = await svc.accept_invitation(invitation.token, "s3cret-password-abc")

        # This was the dead end: a user existed and belonged nowhere, with no surface to change it.
        assert await svc.membership_topics(user, project) is None
        assert await svc.list_memberships(project) == [] or all(
            row["user_id"] != user for row in await svc.list_memberships(project)
        )

        membership = await svc.add_membership(user, project, role="member")
        listed = await svc.list_memberships(project)
        mine = [row for row in listed if row["user_id"] == user]
        assert len(mine) == 1, f"the new member is not listed: {listed}"
        assert mine[0]["email"] == "newcomer@example.com"
        assert mine[0]["role"] == "member"
        assert mine[0]["allowed_topics"] == [], (
            "a fresh membership must carry no authority: empty authority is never all topics"
        )

        # Now the AUDIT-073 grant has a precondition it can act on.
        await svc.grant_topics(user, project, ["engineering"])
        pat = await svc.issue_pat(membership, name="newcomer")
        scope = await resolve_scope(sessionmaker, pat.token)
        assert scope is not None and "engineering" in scope.allowed_topics

        # Detaching revokes the credentials issued under the membership (FK cascade), so revocation
        # is not a second step someone can forget.
        assert await svc.remove_membership(user, project) is True
        assert await resolve_scope(sessionmaker, pat.token) is None, (
            "a token issued under a removed membership still resolved"
        )
        assert await svc.membership_topics(user, project) is None
        assert await svc.remove_membership(user, project) is False
    finally:
        await engine.dispose()


async def test_a_membership_is_unique_per_user_and_project(migrated_dsn: str) -> None:
    """SPEC-04 §3.1: "única por (usuario, proyecto)". The surfaces refuse a duplicate rather than
    letting a second row decide someone's authority by accident."""
    engine = make_engine(migrated_dsn)
    sessionmaker = make_sessionmaker(engine)
    svc = IdentityService(sessionmaker)
    try:
        project = await svc.ensure_default_project()
        invitation = await svc.invite_user("twice@example.com", role="member")
        user = await svc.accept_invitation(invitation.token, "s3cret-password-abc")
        await svc.add_membership(user, project, role="member")
        # Named precisely: a blind `Exception` would also pass on a typo in this test.
        with pytest.raises(IntegrityError):
            await svc.add_membership(user, project, role="viewer")
    finally:
        await engine.dispose()
