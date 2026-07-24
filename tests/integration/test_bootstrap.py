"""First-admin bootstrap for `brain init` (SPEC-18, FR-18.x) against the real container.

`ensure_first_admin` creates exactly one login-capable owner + a default-project membership, and is
idempotent (re-run never resets an existing admin). A generated password is returned once and works.
"""

from __future__ import annotations

from collections.abc import Callable

import pytest
from sqlalchemy import select

from rsc_brain.deploy.bootstrap import DEFAULT_ADMIN_EMAIL, ensure_first_admin
from rsc_brain.identity import sessions
from rsc_brain.identity.service import DEFAULT_PROJECT_SLUG
from rsc_brain.stores.relational import models

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration


async def test_creates_a_login_capable_owner_with_given_password(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    email = f"{unique_slug('admin')}@example.com"

    result = await ensure_first_admin(harness.sm, email=email, password="a-strong-password")
    assert result.created is True and result.generated_password is None

    # The admin is an active owner and can log into the console with that password.
    token = await sessions.login(harness.sm, email, "a-strong-password")
    assert token is not None and token.startswith("cks_")
    async with harness.sm() as session:
        user = await session.scalar(select(models.User).where(models.User.email == email))
        assert user is not None and user.role == "owner" and user.status == "active"


async def test_is_idempotent(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    email = f"{unique_slug('admin')}@example.com"
    first = await ensure_first_admin(harness.sm, email=email, password="pw-one")
    assert first.created is True

    # A second run does nothing — the existing admin (and its password) is left untouched.
    second = await ensure_first_admin(harness.sm, email=email, password="pw-two-ignored")
    assert second.created is False and second.generated_password is None
    assert await sessions.login(harness.sm, email, "pw-one") is not None
    assert await sessions.login(harness.sm, email, "pw-two-ignored") is None  # never reset


async def test_generates_a_working_password_when_omitted(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    email = f"{unique_slug('admin')}@example.com"
    result = await ensure_first_admin(harness.sm, email=email)  # no password → generated
    assert result.created is True and result.generated_password
    assert await sessions.login(harness.sm, email, result.generated_password) is not None


async def test_bootstraps_the_default_project_membership(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    email = f"{unique_slug('admin')}@example.com"
    await ensure_first_admin(harness.sm, email=email, password="pw")
    async with harness.sm() as session:
        user_id = await session.scalar(select(models.User.id).where(models.User.email == email))
        project_id = await session.scalar(
            select(models.Project.id).where(models.Project.slug == DEFAULT_PROJECT_SLUG)
        )
        membership = await session.scalar(
            select(models.ProjectMembership).where(
                models.ProjectMembership.user_id == user_id,
                models.ProjectMembership.project_id == project_id,
            )
        )
        assert membership is not None and membership.can_curate is True


def test_default_admin_email_is_stable() -> None:
    assert DEFAULT_ADMIN_EMAIL == "admin@rsc-brain.local"
