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


async def test_approve_from_console_applies_corrected_tags(
    build_harness: Callable[..., Harness], make_completion: Callable[..., object], tmp_path: Path
) -> None:
    """AC#3: approving a pending doc from the console with corrected tags publishes with the
    doc→chunk tag inheritance (FR-1.15) — the console only invokes the API."""
    from sqlalchemy import select

    from rsc_brain.stores.relational import models

    harness = build_harness(
        completion=make_completion(
            entities=[{"name": "Acme", "type": "org", "aliases": []}],
            claims=[{"text": "SLA is 24h", "subject": "Acme", "predicate": "sla", "object": "24h"}],
            tags=["engineering"],
        )
    )
    slug = unique_slug("acme")
    project_id = await harness.setup_project(slug, [("engineering", 0), ("finance", 0)])
    scope = harness.scope(project_id, allowed_topics=["engineering", "finance"])
    await harness.repo.create_source(
        scope, name="manual", type_="folder", policy="manual", default_tags=["engineering"]
    )
    doc = b"# Handbook\n\nThe standard support SLA is 24 hours for all customers.\n"
    outcome = await harness.service.ingest_bytes(scope, doc, filename="hb.md", source="manual")

    identity = IdentityService(harness.sm)
    email = f"{unique_slug('own')}@example.com"
    invited = await identity.invite_user(email, role="owner")
    await identity.accept_invitation(invited.token, PASSWORD)
    session = await login(harness.sm, email, PASSWORD)
    assert session is not None
    auth = {"Authorization": f"Bearer {session}"}

    async with _client(harness, tmp_path) as client:
        resp = await client.post(
            f"/api/v1/admin/documents/{outcome.document_id}/approve?project={slug}",
            json={"tags": ["finance"]},
            headers=auth,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["phase"] == "processed"

    # The corrected tag inherited to the published chunks (FR-1.15).
    async with harness.sm() as db:
        tag_rows = await db.execute(
            select(models.Chunk.tags).where(
                models.Chunk.document_id == uuid_of(outcome.document_id),
                models.Chunk.needs_review.is_(False),
            )
        )
        all_tags = {t for (tags,) in tag_rows.all() for t in tags}
    assert "finance" in all_tags


def uuid_of(value: str) -> object:
    import uuid

    return uuid.UUID(value)


async def _pid(harness: Harness, slug: str) -> str:
    from sqlalchemy import select

    from rsc_brain.stores.relational import models

    async with harness.sm() as session:
        return str(
            await session.scalar(select(models.Project.id).where(models.Project.slug == slug))
        )
