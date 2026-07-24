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

    # R03/R54 — a GLOBAL owner is not thereby a content reader. Ratified 2026-07-24 (AUDIT-020):
    # a global administrator may perform platform/project lifecycle operations, but project
    # content access still requires explicit project/topic authority or an audited break-glass
    # grant. This helper is the content-observability grant, so with no membership in B it must
    # deny, indistinguishably from absence. The previous assertion here was `is not None` and so
    # canonized the escalation.
    assert await _console_scope_for(harness.sm, member_of_a, "owner", b_slug) is None
    assert await _console_scope_for(harness.sm, member_of_a, "admin", b_slug) is None

    # …and the same global owner still gets no silent topic authority where it IS a member:
    # empty topic authority never means all topics (plan §0).
    owner_in_a = await _console_scope_for(harness.sm, member_of_a, "owner", a_slug)
    assert owner_in_a is not None
    assert owner_in_a.allowed_topics == frozenset({"general"}), (
        "a global role must not widen topic authority beyond the membership"
    )


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

    # R02 — the approver needs EXPLICIT project membership and topic authority covering both the
    # document's topics and the corrected tag. A bare global role is not content authority
    # (AUDIT-020, ratified 2026-07-24); this fixture previously relied on exactly that escalation.
    identity = IdentityService(harness.sm)
    email = f"{unique_slug('own')}@example.com"
    invited = await identity.invite_user(email, role="owner")
    approver_id = await identity.accept_invitation(invited.token, PASSWORD)
    await identity.add_membership(
        approver_id,
        project_id,
        role="project-admin",
        allowed_topics=("engineering", "finance"),
    )
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


async def test_document_decisions_require_explicit_topic_authority(
    build_harness: Callable[..., Harness], make_completion: Callable[..., object], tmp_path: Path
) -> None:
    """R02 — approve/retag needs the document-lifecycle capability AND topic scope.

    Two adverse principals: a global owner with no membership in the project, and a member whose
    topic authority does not cover the tag it is trying to apply. Neither may decide the document,
    and neither attempt may leave a side effect.
    """
    from sqlalchemy import select

    from rsc_brain.stores.relational import models

    harness = build_harness(
        completion=make_completion(
            entities=[],
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
    outcome = await harness.service.ingest_bytes(
        scope,
        b"# Handbook\n\nThe standard support SLA is 24 hours.\n",
        filename="hb.md",
        source="manual",
    )
    approve_path = f"/api/v1/admin/documents/{outcome.document_id}/approve?project={slug}"

    identity = IdentityService(harness.sm)

    async def _session(role: str, topics: tuple[str, ...] | None) -> dict[str, str]:
        email = f"{unique_slug('p')}@example.com"
        invited = await identity.invite_user(email, role=role)
        user_id = await identity.accept_invitation(invited.token, PASSWORD)
        if topics is not None:
            await identity.add_membership(
                user_id, project_id, role="project-admin", allowed_topics=topics
            )
        token = await login(harness.sm, email, PASSWORD)
        assert token is not None
        return {"Authorization": f"Bearer {token}"}

    outsider = await _session("owner", None)  # global owner, NO membership
    narrow = await _session("member", ("engineering",))  # cannot reach `finance`

    async with _client(harness, tmp_path) as client:
        # A global role alone is not content authority: denied ≡ absent (FR-4.3).
        blocked = await client.post(approve_path, json={"tags": ["finance"]}, headers=outsider)
        assert blocked.status_code == 404, blocked.text
        # Retagging into a topic outside the caller's authority is refused, not silently dropped.
        widened = await client.post(approve_path, json={"tags": ["finance"]}, headers=narrow)
        assert widened.status_code == 403, widened.text

    # No side effect from either refusal: nothing was published and no `finance` tag exists.
    async with harness.sm() as db:
        published = await db.scalar(
            select(models.Chunk.id)
            .where(models.Chunk.document_id == uuid_of(outcome.document_id))
            .where(models.Chunk.needs_review.is_(False))
            .limit(1)
        )
        assert published is None, "a refused decision published the document"
        tag_rows = await db.execute(
            select(models.Chunk.tags).where(
                models.Chunk.document_id == uuid_of(outcome.document_id)
            )
        )
        assert "finance" not in {t for (tags,) in tag_rows.all() for t in tags}


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
