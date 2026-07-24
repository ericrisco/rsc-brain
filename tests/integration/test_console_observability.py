"""Console read-observability auth + isolation (SPEC-14, FR-12.5 applied to the console).

A console session reaches observability for a project it is authorized for; a project-admin of one
project cannot reach another (denied ≡ absent), via the endpoint and the scope helper directly.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import httpx
import pytest

from rsc_brain.api.admin import _console_scope_for
from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.identity.service import IdentityService
from rsc_brain.identity.sessions import login

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

PASSWORD = "correct horse battery staple"


def _client(harness: Harness, tmp_path: Path) -> httpx.AsyncClient:
    app = create_app(
        deps=ApiDeps(sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path))
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _member(harness: Harness, project_id: str, *, role: str = "member") -> tuple[str, str]:
    identity = IdentityService(harness.sm)
    email = f"{unique_slug('obs')}@example.com"
    invited = await identity.invite_user(email, role=role)
    user_id = await identity.accept_invitation(invited.token, PASSWORD)
    await identity.add_membership(user_id, project_id, allowed_topics=("general",))
    return email, user_id


async def test_console_scope_helper_enforces_membership(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    a_slug, b_slug = unique_slug("acme"), unique_slug("globex")
    a = await harness.setup_project(a_slug, [("general", 0)])
    await harness.setup_project(b_slug, [("general", 0)])
    _, member_of_a = await _member(harness, a)

    # A plain member of A → scoped to A only; B is denied (no membership) — FR-12.5.
    scope_a = await _console_scope_for(harness.sm, member_of_a, "member", a_slug)
    assert scope_a is not None and scope_a.project_id == a
    assert await _console_scope_for(harness.sm, member_of_a, "member", b_slug) is None
    # A global owner reaches any project.
    owner_scope = await _console_scope_for(harness.sm, member_of_a, "owner", b_slug)
    assert owner_scope is not None


async def test_project_admin_session_cannot_observe_another_project(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    harness = build_harness()
    a_slug, b_slug = unique_slug("acme"), unique_slug("globex")
    await harness.setup_project(a_slug, [("general", 0)])
    await harness.setup_project(b_slug, [("general", 0)])
    email, _ = await _member(harness, await _pid(harness, a_slug))  # member of A only
    session = await login(harness.sm, email, PASSWORD)
    assert session is not None
    auth = {"Authorization": f"Bearer {session}"}

    async with _client(harness, tmp_path) as client:
        ok = await client.get(
            f"/api/v1/admin/observability/activity?project={a_slug}", headers=auth
        )
        assert ok.status_code == 200
        assert "recalls" in ok.json()
        # The other project is denied and indistinguishable from absent (FR-4.3/12.5).
        cross = await client.get(
            f"/api/v1/admin/observability/activity?project={b_slug}", headers=auth
        )
        assert cross.status_code == 404
        # No project param at all → also 404 (never leak that projects exist).
        assert (
            await client.get("/api/v1/admin/observability/activity", headers=auth)
        ).status_code == 404


async def _pid(harness: Harness, slug: str) -> str:
    from sqlalchemy import select

    from rsc_brain.stores.relational import models

    async with harness.sm() as session:
        return str(
            await session.scalar(select(models.Project.id).where(models.Project.slug == slug))
        )
