"""The bootstrapped first admin can actually administer its project (AUDIT-020 regression).

`brain init` creates the first owner plus a default-project membership. That membership was written
with ``role="admin"`` — a value that is not one of the documented project roles
(``project-admin|member|viewer``), which nothing noticed while the old gate accepted ``can_curate``
as administration. The named-capability matrix does not: an undocumented role holds nothing, so a
fresh install's only human is locked out of its own management surface.

The plan's risk register names this exact failure mode ("admin lockout") as the thing an
authorization repair must not cause, so it gets a test of its own rather than a fixed line of code.
"""

from __future__ import annotations

from collections.abc import Callable

import pytest
from sqlalchemy import select

from rsc_brain.authorization import Allow, Capability, decide
from rsc_brain.deploy.bootstrap import ensure_first_admin
from rsc_brain.identity.resolve import resolve_scope
from rsc_brain.identity.service import IdentityService
from rsc_brain.scope import PROJECT_ROLE_ADMIN, ProjectScope
from rsc_brain.stores.relational import models

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

#: What the first admin must be able to do in its own project — the management surface it is the
#: only human on a fresh install able to reach.
FIRST_ADMIN_CAPABILITIES = (
    Capability.PROJECT_MANAGE_READ,
    Capability.PROJECT_CONFIG_WRITE,
    Capability.PROJECT_SETTINGS_WRITE,
    Capability.DOCUMENT_DECIDE,
    Capability.GAP_PROMOTE,
    Capability.HUNT_MANAGE,
    Capability.KNOWLEDGE_REVIEW_DECIDE,
)


async def _bootstrapped_scope(harness: Harness) -> ProjectScope:
    """Bootstrap a first admin and resolve the scope a real request would carry."""
    email = f"{unique_slug('first')}@rsc-brain.local"
    result = await ensure_first_admin(harness.sm, email=email)
    assert result.created
    identity = IdentityService(harness.sm)
    async with harness.sm() as session:
        user_id = await session.scalar(select(models.User.id).where(models.User.email == email))
        membership_id = await session.scalar(
            select(models.ProjectMembership.id).where(models.ProjectMembership.user_id == user_id)
        )
    assert membership_id is not None
    token = (await identity.issue_pat(str(membership_id))).token
    scope = await resolve_scope(harness.sm, token)
    assert scope is not None
    return scope


async def test_the_first_admin_holds_the_project_administrator_role(
    build_harness: Callable[..., Harness],
) -> None:
    """The membership role must be one the matrix recognizes, not an undocumented string."""
    harness = build_harness()
    scope = await _bootstrapped_scope(harness)
    assert scope.role == PROJECT_ROLE_ADMIN, (
        f"the first admin's project role is {scope.role!r}, which no capability admits — a fresh "
        "install's only human cannot administer its own project"
    )


@pytest.mark.parametrize("capability", FIRST_ADMIN_CAPABILITIES)
async def test_the_first_admin_can_administer_its_project(
    capability: Capability, build_harness: Callable[..., Harness]
) -> None:
    harness = build_harness()
    scope = await _bootstrapped_scope(harness)
    assert isinstance(decide(scope, capability), Allow), (
        f"the bootstrapped first admin cannot {capability.value} in its own project"
    )


async def test_the_first_admin_still_holds_platform_authority(
    build_harness: Callable[..., Harness],
) -> None:
    """The two authorities are separate, and bootstrap must grant both: owner on the platform,
    administrator in the default project."""
    harness = build_harness()
    scope = await _bootstrapped_scope(harness)
    assert isinstance(decide(scope, Capability.PLATFORM_PROJECT_CREATE), Allow)
    assert isinstance(decide(scope, Capability.PLATFORM_USER_INVITE), Allow)


async def test_creating_a_topic_grants_its_author_explicit_authority(
    build_harness: Callable[..., Harness], tmp_path: object
) -> None:
    """A fresh install has no topics, so the first admin's authority starts empty — correctly, since
    empty authority is never all topics. Defining a topic therefore has to record the author's
    authority over it, or the person who created it could not act on anything tagged with it and the
    only way out would be a direct database write.
    """
    from pathlib import Path

    import httpx

    from rsc_brain.api.app import ApiDeps, create_app

    harness = build_harness()
    scope = await _bootstrapped_scope(harness)
    assert scope.allowed_topics == frozenset(), "a fresh install has no topics to hold yet"

    identity = IdentityService(harness.sm)
    async with harness.sm() as session:
        membership_id = await session.scalar(
            select(models.ProjectMembership.id).where(
                models.ProjectMembership.user_id == uuid_of(scope.principal_id)
            )
        )
    token = (await identity.issue_pat(str(membership_id))).token

    app = create_app(
        deps=ApiDeps(
            sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(Path(str(tmp_path)))
        )
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        created = await client.post(
            "/api/v1/admin/topics",
            json={"slug": "operations", "name": "Operations", "sensitivity": 0},
            headers={"Authorization": f"Bearer {token}"},
        )
    assert created.status_code == 201, created.text
    assert "operations" in created.json()["granted_topics"]

    # The authority is durable and visible on the membership, not implied at decision time.
    after = await resolve_scope(harness.sm, token)
    assert after is not None and "operations" in after.allowed_topics


def uuid_of(value: str) -> object:
    import uuid

    return uuid.UUID(value)
