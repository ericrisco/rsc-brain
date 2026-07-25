"""AUDIT-020 console management authority — R01/R02/R04 (T001, RED half of strict TDD).

R01 (critical) — topic-limited console reads, counters, pages, and exports must disclose ONLY
authorized topics, with aggregates/counts/pagination computed AFTER topic filtering. Today
``_obs_scope`` and the underlying stores filter by **project only**
(``api/admin.py:180-190``, ``stores/relational/knowledge_store.py:415-470``,
``review/queue.py:63-87``): a topic-restricted principal sees every topic in the project.

R02 (critical) — document decisions (approve/reject/retag) require an explicit document-lifecycle
capability PLUS topic scope, at BOTH the session and the token entry point
(``api/app.py:238-264``, ``api/admin.py:863-896``). A session-path slice of this is already
committed in ``tests/integration/test_console_observability.py`` (topic-mismatch-on-retag and
global-owner-with-no-membership, via a console session) — this file does NOT repeat those two
cases. It covers what that commit does not: the base (non-admin) API's PAT-only entry point, the
admin API's **token** entry point, and the **reject** operation (never tested anywhere before).

R04 (high) — every console mutation must apply the explicit server-side operation x role matrix
(corrections/logging/docs/gaps/ontology). Today those mutations are gated by ``_obs_scope`` alone
(``api/admin.py:345-382,768-778,863-896,1011-1019,1052-1071``), which for a **session** grants any
existing membership regardless of project role, and for a **token** grants any ``can_curate``
principal regardless of project role or topic. A viewer session can therefore mutate; a
project-admin token (the ratified least role) is instead wrongly locked out.

Ratified matrix (AUDIT-020 clarifications, 2026-07-24 — see the addendum, not re-derived here):
``can_curate`` only ever authorizes explicitly assigned knowledge-review decisions within the
principal's own project+topics; it grants no project/ontology/logging/gap/export/document-lifecycle/
platform authority. A project-admin manages only its own project. A viewer never mutates. Empty
topic authority never means all topics. Revocation must take effect on the very next operation.

This file's design for the still-undefined "least role the ratified matrix admits" for a console
mutation (since no named capability model exists yet — a later task adds it, per the T001 addendum):
a **project-admin membership with topic overlap over the target resource** is the least role that
must be admitted; a plain member, a viewer, and a curator with NO topic overlap must all be denied
regardless of ``can_curate``. This is documented so a reviewer can challenge the choice; it does not
invent any capability object that doesn't exist in ``rsc_brain.scope`` today.

Known gap (documented, not silently dropped): ``POST /admin/corrections/{id}/revert`` has its own
bespoke ``is_admin or is_owner`` gate distinct from the uniform ``_obs_scope`` pattern the other
mutations share, so it does not fit this file's uniform role matrix and is left for the corrections
cluster's own test coverage; the corrections **read** surface (R01) is still covered below.
"""

from __future__ import annotations

import csv
import io
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest
from sqlalchemy import select

from rsc_brain.api.app import ApiDeps, create_app
from rsc_brain.identity.service import IdentityService
from rsc_brain.identity.sessions import login, logout
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.store import PgRelationalStore
from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("general", 0), ("hidden", 0), ("engineering", 0), ("unrelated", 0)]
_PASSWORD = "correct horse battery staple"  # test fixture credential, never real


# --------------------------------------------------------------------------- #
# Shared plumbing (local to this file — no shared fixtures are touched)
# --------------------------------------------------------------------------- #


def _client(harness: Harness, tmp_path: Path) -> httpx.AsyncClient:
    app = create_app(
        deps=ApiDeps(sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path))
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _create_user(harness: Harness, *, platform_role: str = "member") -> str:
    user = (
        await PgRelationalStore(harness.sm)
        .users()
        .create_user(email=f"{unique_slug('u')}@example.com", status="active", role=platform_role)
    )
    return user.user_id


async def _add_membership(
    harness: Harness,
    user_id: str,
    project_id: str,
    *,
    role: str,
    topics: tuple[str, ...],
    can_curate: bool,
) -> str:
    return await IdentityService(harness.sm).add_membership(
        user_id, project_id, role=role, allowed_topics=topics, can_curate=can_curate
    )


async def _pat_for(
    harness: Harness,
    project_id: str,
    *,
    role: str,
    topics: tuple[str, ...],
    can_curate: bool,
    platform_role: str = "member",
) -> str:
    """Mint a PAT for a principal with an explicit PROJECT role (project-admin|member|viewer) and
    an explicit PLATFORM role — never conflating the two (AUDIT-020's core distinction)."""
    user_id = await _create_user(harness, platform_role=platform_role)
    membership_id = await _add_membership(
        harness, user_id, project_id, role=role, topics=topics, can_curate=can_curate
    )
    return (await IdentityService(harness.sm).issue_pat(membership_id)).token


async def _session_for(
    harness: Harness,
    project_id: str,
    *,
    role: str,
    topics: tuple[str, ...],
    can_curate: bool,
    platform_role: str = "member",
) -> str:
    """Mint a real console session (invite → accept → login), never a synthetic token."""
    identity = IdentityService(harness.sm)
    email = f"{unique_slug('console')}@example.com"
    issued = await identity.invite_user(email, role=platform_role)
    user_id = await identity.accept_invitation(issued.token, _PASSWORD)
    await _add_membership(
        harness, user_id, project_id, role=role, topics=topics, can_curate=can_curate
    )
    token = await login(harness.sm, email, _PASSWORD)
    assert token is not None
    return token


async def _topic_scoped_pat(harness: Harness, project_id: str, *, topics: tuple[str, ...]) -> str:
    """A curator-member restricted to ``topics`` — the R01 principal: capable enough to pass the
    token-path admin gate, but authorized for only a subset of the project's topics."""
    return await _pat_for(harness, project_id, role="member", topics=topics, can_curate=True)


async def _setup_pending_document(
    harness: Harness, project_id: str, *, topics: tuple[str, ...] = ("general",)
) -> str:
    """A REAL pending document via the actual ingestion pipeline (parse+chunk+topicalize), not a
    synthetic row — ``approve``/``reject`` parse the stored blob, so a hand-built ``Document`` row
    with no blob would 500 for the wrong reason. Mirrors the pattern already proven in
    ``tests/integration/test_console_observability.py``."""
    scope = harness.scope(project_id, allowed_topics=topics)
    source_name = unique_slug("src")
    await harness.repo.create_source(
        scope, name=source_name, type_="folder", policy="manual", default_tags=list(topics)
    )
    outcome = await harness.service.ingest_bytes(
        scope,
        b"# Doc\n\nBody text for the authority matrix.\n",
        filename=f"{unique_slug('doc')}.md",
        source=source_name,
    )
    return outcome.document_id


async def _setup_gap(
    harness: Harness, project_id: str, *, topics: tuple[str, ...] = ("general",)
) -> str:
    pid = uuid.UUID(project_id)
    gap_id = uuid.uuid4()
    async with harness.sm() as session:
        session.add(
            models.Gap(
                id=gap_id,
                project_id=pid,
                query_hash=f"gap-{gap_id}",
                query_text="who owns this?",
                topics=list(topics),
                status="open",
            )
        )
        await session.commit()
    return str(gap_id)


async def _setup_none(_harness: Harness, _project_id: str, *, topics: tuple[str, ...] = ()) -> str:
    return ""


async def _insert(harness: Harness, *rows: object) -> None:
    async with harness.sm() as session:
        session.add_all(rows)
        await session.commit()


# =========================================================================== #
# R01 — topic-limited reads, counts, pages, and exports (critical)
# =========================================================================== #


@dataclass(frozen=True)
class TopicSurface:
    name: str
    seed: Callable[[Harness, str], Awaitable[tuple[str, str]]]  # -> (authorized_id, hidden_id)
    fetch: Callable[[httpx.AsyncClient, dict[str, str]], Awaitable[httpx.Response]]
    ids: Callable[[dict[str, object]], set[str]]


async def _seed_pending_previews(harness: Harness, project_id: str) -> tuple[str, str]:
    pid = uuid.UUID(project_id)
    general_id, hidden_id = uuid.uuid4(), uuid.uuid4()
    await _insert(
        harness,
        models.Document(
            id=general_id,
            project_id=pid,
            logical_id=f"doc-{general_id}",
            checksum=f"c-{general_id}",
            status="pending_approval",
            doc_tags=["general"],
            title="general-doc",
        ),
        models.Document(
            id=hidden_id,
            project_id=pid,
            logical_id=f"doc-{hidden_id}",
            checksum=f"c-{hidden_id}",
            status="pending_approval",
            doc_tags=["hidden"],
            title="hidden-doc",
        ),
    )
    return str(general_id), str(hidden_id)


async def _fetch_pending_previews(
    client: httpx.AsyncClient, headers: dict[str, str]
) -> httpx.Response:
    return await client.get("/api/v1/admin/documents/pending/preview", headers=headers)


def _ids_pending_previews(body: dict[str, Any]) -> set[str]:
    return {d["document_id"] for d in body["documents"]}


async def _seed_corrections(harness: Harness, project_id: str) -> tuple[str, str]:
    pid = uuid.UUID(project_id)
    claim_general, claim_hidden = uuid.uuid4(), uuid.uuid4()
    corr_general, corr_hidden = uuid.uuid4(), uuid.uuid4()
    await _insert(
        harness,
        models.Claim(id=claim_general, project_id=pid, text="general claim", tags=["general"]),
        models.Claim(id=claim_hidden, project_id=pid, text="hidden claim", tags=["hidden"]),
    )
    await _insert(
        harness,
        models.Correction(
            id=corr_general,
            project_id=pid,
            target_claim=claim_general,
            status="applied",
            before_text="b",
            after_text="a",
        ),
        models.Correction(
            id=corr_hidden,
            project_id=pid,
            target_claim=claim_hidden,
            status="applied",
            before_text="b",
            after_text="a",
        ),
    )
    return str(corr_general), str(corr_hidden)


async def _fetch_corrections(client: httpx.AsyncClient, headers: dict[str, str]) -> httpx.Response:
    return await client.get("/api/v1/admin/corrections", headers=headers)


def _ids_corrections(body: dict[str, Any]) -> set[str]:
    return {c["id"] for c in body["corrections"]}


async def _seed_disputed_claims(harness: Harness, project_id: str) -> tuple[str, str]:
    pid = uuid.UUID(project_id)
    general_id, hidden_id = uuid.uuid4(), uuid.uuid4()
    await _insert(
        harness,
        models.Claim(
            id=general_id, project_id=pid, text="general disputed", tags=["general"], disputed=True
        ),
        models.Claim(
            id=hidden_id, project_id=pid, text="hidden disputed", tags=["hidden"], disputed=True
        ),
    )
    return str(general_id), str(hidden_id)


async def _fetch_disputed_claims(
    client: httpx.AsyncClient, headers: dict[str, str]
) -> httpx.Response:
    return await client.get("/api/v1/admin/claims/disputed", headers=headers)


def _ids_disputed_claims(body: dict[str, Any]) -> set[str]:
    return {c["id"] for c in body["claims"]}


async def _seed_review_items(harness: Harness, project_id: str) -> tuple[str, str]:
    pid = uuid.UUID(project_id)
    doc_id = uuid.uuid4()
    general_id, hidden_id = uuid.uuid4(), uuid.uuid4()
    await _insert(
        harness,
        models.Document(
            id=doc_id,
            project_id=pid,
            logical_id=f"doc-{doc_id}",
            checksum=f"c-{doc_id}",
            status="processed",
        ),
    )
    await _insert(
        harness,
        models.Chunk(
            id=general_id,
            project_id=pid,
            document_id=doc_id,
            kind="prose",
            text="general needs-review chunk",
            tags=["general"],
            needs_review=True,
        ),
        models.Chunk(
            id=hidden_id,
            project_id=pid,
            document_id=doc_id,
            kind="prose",
            text="hidden needs-review chunk",
            tags=["hidden"],
            needs_review=True,
        ),
    )
    return str(general_id), str(hidden_id)


async def _fetch_review_items(client: httpx.AsyncClient, headers: dict[str, str]) -> httpx.Response:
    return await client.get("/api/v1/admin/review-queue", headers=headers)


def _ids_review_items(body: dict[str, Any]) -> set[str]:
    return {i["id"] for i in body["items"]}


async def _seed_gaps(harness: Harness, project_id: str) -> tuple[str, str]:
    general_id = await _setup_gap(harness, project_id, topics=("general",))
    hidden_id = await _setup_gap(harness, project_id, topics=("hidden",))
    return general_id, hidden_id


async def _fetch_gaps(client: httpx.AsyncClient, headers: dict[str, str]) -> httpx.Response:
    return await client.get("/api/v1/admin/gaps", headers=headers)


def _ids_gaps(body: dict[str, Any]) -> set[str]:
    return {g["id"] for g in body["gaps"]}


async def _seed_hunts(harness: Harness, project_id: str) -> tuple[str, str]:
    pid = uuid.UUID(project_id)
    gap_general = await _setup_gap(harness, project_id, topics=("general",))
    gap_hidden = await _setup_gap(harness, project_id, topics=("hidden",))
    hunt_general, hunt_hidden = uuid.uuid4(), uuid.uuid4()
    await _insert(
        harness,
        models.Hunt(
            id=hunt_general,
            project_id=pid,
            gap_id=uuid.UUID(gap_general),
            state="AWAITING_ANSWER",
            question="general question?",
        ),
        models.Hunt(
            id=hunt_hidden,
            project_id=pid,
            gap_id=uuid.UUID(gap_hidden),
            state="AWAITING_ANSWER",
            question="hidden question?",
        ),
    )
    return str(hunt_general), str(hunt_hidden)


async def _fetch_hunts(client: httpx.AsyncClient, headers: dict[str, str]) -> httpx.Response:
    return await client.get("/api/v1/admin/hunts", headers=headers)


def _ids_hunts(body: dict[str, Any]) -> set[str]:
    return {h["id"] for h in body["hunts"]}


async def _seed_audit(harness: Harness, project_id: str) -> tuple[str, str]:
    pid = uuid.UUID(project_id)
    general = models.AuditLog(
        project_id=pid,
        principal_type="human",
        principal_id="seed",
        action="recall",
        topics_used=["general"],
        denied=False,
    )
    hidden = models.AuditLog(
        project_id=pid,
        principal_type="human",
        principal_id="seed",
        action="recall",
        topics_used=["hidden"],
        denied=False,
    )
    async with harness.sm() as session:
        session.add_all([general, hidden])
        await session.commit()
        await session.refresh(general)
        await session.refresh(hidden)
    return str(general.id), str(hidden.id)


async def _fetch_audit(client: httpx.AsyncClient, headers: dict[str, str]) -> httpx.Response:
    return await client.get("/api/v1/admin/audit", headers=headers)


def _ids_audit(body: dict[str, Any]) -> set[str]:
    return {str(a["id"]) for a in body["audit"]}


SURFACES = [
    TopicSurface(
        "pending_previews", _seed_pending_previews, _fetch_pending_previews, _ids_pending_previews
    ),
    TopicSurface("corrections", _seed_corrections, _fetch_corrections, _ids_corrections),
    TopicSurface(
        "disputed_claims", _seed_disputed_claims, _fetch_disputed_claims, _ids_disputed_claims
    ),
    TopicSurface("review_items", _seed_review_items, _fetch_review_items, _ids_review_items),
    TopicSurface("gaps", _seed_gaps, _fetch_gaps, _ids_gaps),
    TopicSurface("hunts", _seed_hunts, _fetch_hunts, _ids_hunts),
    TopicSurface("audit", _seed_audit, _fetch_audit, _ids_audit),
]


@pytest.mark.parametrize("surface", SURFACES, ids=[s.name for s in SURFACES])
async def test_r01_topic_scoped_read_hides_the_other_topic(
    surface: TopicSurface, build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """For every topic-derived read, a principal authorized for only 'general' must never see a
    'hidden'-tagged item in the SAME project, and the total must equal exactly the authorized
    count (one) — never inflated by the hidden item (the side-channel this R01 row forbids)."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    authorized_id, hidden_id = await surface.seed(harness, project)
    token = await _topic_scoped_pat(harness, project, topics=("general",))
    headers = {"Authorization": f"Bearer {token}"}

    async with _client(harness, tmp_path) as client:
        response = await surface.fetch(client, headers)

    assert response.status_code == 200, f"{surface.name}: {response.text}"
    visible = surface.ids(response.json())
    assert hidden_id not in visible, f"{surface.name}: a hidden-topic item leaked — {visible}"
    assert visible == {authorized_id}, (
        f"{surface.name}: expected exactly the one authorized item, got {visible}"
    )


@pytest.mark.parametrize("surface", SURFACES, ids=[s.name for s in SURFACES])
async def test_r01_zero_authorized_topics_yields_a_clean_empty_state(
    surface: TopicSurface, build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """A principal with NO overlapping topic authority must reach a clean empty state (200, empty
    list) — never an error, and never the project's unrelated content."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    await surface.seed(harness, project)  # authorized + hidden content both exist in the project
    token = await _topic_scoped_pat(harness, project, topics=("unrelated",))
    headers = {"Authorization": f"Bearer {token}"}

    async with _client(harness, tmp_path) as client:
        response = await surface.fetch(client, headers)

    assert response.status_code == 200, f"{surface.name}: {response.text}"
    visible = surface.ids(response.json())
    assert visible == set(), (
        f"{surface.name}: a principal with no authorized topic saw {visible} instead of the empty state"
    )


async def test_r01_multiple_authorized_items_are_returned_exactly_once(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """Several authorized items alongside a hidden one: every authorized item appears exactly
    once (no duplication, no drop) and the hidden one never appears — the pagination-equivalent
    invariant for a surface with no real cursor."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    authorized_ids = {
        await _setup_gap(harness, project, topics=("general",)),
        await _setup_gap(harness, project, topics=("general",)),
        await _setup_gap(harness, project, topics=("general",)),
    }
    hidden_id = await _setup_gap(harness, project, topics=("hidden",))
    token = await _topic_scoped_pat(harness, project, topics=("general",))
    headers = {"Authorization": f"Bearer {token}"}

    async with _client(harness, tmp_path) as client:
        response = await client.get("/api/v1/admin/gaps", headers=headers)

    assert response.status_code == 200, response.text
    ids = [g["id"] for g in response.json()["gaps"]]
    assert hidden_id not in ids
    assert sorted(ids) == sorted(authorized_ids), (
        f"expected each of the 3 authorized gaps exactly once, got {ids}"
    )


async def test_r01_aggregate_activity_excludes_hidden_topic_recalls(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """The activity dashboard aggregate (an 'aggregate card') must count only recalls within the
    caller's authorized topics — today it counts every recall in the project (side-channel)."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    await _seed_audit(harness, project)  # one 'general' + one 'hidden' recall row
    token = await _topic_scoped_pat(harness, project, topics=("general",))
    headers = {"Authorization": f"Bearer {token}"}

    async with _client(harness, tmp_path) as client:
        response = await client.get("/api/v1/admin/observability/activity", headers=headers)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["recalls"] == 1, (
        f"activity aggregate counted a recall outside the caller's authorized topics: {body}"
    )


async def test_r01_audit_export_matches_the_authorized_topic_only(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """The CSV export must contain exactly the caller's authorized rows — never the hidden one."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    authorized_id, hidden_id = await _seed_audit(harness, project)
    token = await _topic_scoped_pat(harness, project, topics=("general",))
    headers = {"Authorization": f"Bearer {token}"}

    async with _client(harness, tmp_path) as client:
        response = await client.get("/api/v1/admin/audit/export", headers=headers)

    assert response.status_code == 200, response.text
    rows = list(csv.DictReader(io.StringIO(response.text)))
    exported_ids = {row["id"] for row in rows}
    assert authorized_id in exported_ids
    assert hidden_id not in exported_ids, f"export leaked a hidden-topic audit row: {exported_ids}"


async def test_r01_review_queue_counts_are_computed_after_topic_filtering(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """The review-queue's per-source ``counts`` (an aggregate) must reflect only authorized items —
    the aggregate is a side channel just like a total or a page."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    await _seed_review_items(harness, project)  # one 'general' + one 'hidden' needs-review chunk
    token = await _topic_scoped_pat(harness, project, topics=("general",))
    headers = {"Authorization": f"Bearer {token}"}

    async with _client(harness, tmp_path) as client:
        response = await client.get("/api/v1/admin/review-queue", headers=headers)

    assert response.status_code == 200, response.text
    counts = response.json()["counts"]
    assert sum(counts.values()) == 1, (
        f"review-queue counts include an item outside the caller's authorized topics: {counts}"
    )


# =========================================================================== #
# R02 — document-lifecycle capability + topic scope, session AND token (critical)
# =========================================================================== #


async def test_r02_base_documents_route_has_no_capability_check_at_all(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """The base (non-admin) approve route (``api/app.py:238-264``) is gated by nothing but a valid
    project token: a plain member with no curation capability approves a document it has no
    document-lifecycle authority over."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    document_id = await _setup_pending_document(harness, project, topics=("general",))
    token = await _pat_for(harness, project, role="member", topics=("general",), can_curate=False)
    headers = {"Authorization": f"Bearer {token}"}

    async with _client(harness, tmp_path) as client:
        response = await client.post(f"/api/v1/documents/{document_id}/approve", headers=headers)

    assert response.status_code == 403, (
        "a plain member with no document-lifecycle capability approved a document through the "
        f"base API (api/app.py:238-264): {response.status_code} {response.text}"
    )


async def test_r02_base_documents_route_ignores_topic_scope_even_with_curation(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """Even WITH curation capability, the base route must still respect topic scope — it currently
    checks neither."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    document_id = await _setup_pending_document(harness, project, topics=("hidden",))
    token = await _pat_for(harness, project, role="member", topics=("general",), can_curate=True)
    headers = {"Authorization": f"Bearer {token}"}

    async with _client(harness, tmp_path) as client:
        response = await client.post(f"/api/v1/documents/{document_id}/approve", headers=headers)

    assert response.status_code == 403, (
        "a curator approved a document outside its topic authority through the base API "
        f"(api/app.py:238-264): {response.status_code} {response.text}"
    )


async def test_r02_base_documents_reject_has_no_capability_check(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """The reject sibling of the base route is exactly as unguarded as approve."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    document_id = await _setup_pending_document(harness, project, topics=("general",))
    token = await _pat_for(harness, project, role="member", topics=("general",), can_curate=False)
    headers = {"Authorization": f"Bearer {token}"}

    async with _client(harness, tmp_path) as client:
        response = await client.post(
            f"/api/v1/documents/{document_id}/reject", data={"reason": "no"}, headers=headers
        )

    assert response.status_code == 403, (
        "a plain member with no document-lifecycle capability rejected a document through the "
        f"base API: {response.status_code} {response.text}"
    )


async def test_r02_admin_token_topic_mismatch_on_retag_is_denied(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """The TOKEN-path sibling of the already-committed session test: a curator PAT retags a
    document into a topic outside its own authority — must be refused, with no side effect.
    (The session-path version of this scenario is already covered by
    ``tests/integration/test_console_observability.py::test_document_decisions_require_explicit_topic_authority``;
    this is its PAT counterpart, which that file does not test.)"""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    document_id = await _setup_pending_document(harness, project, topics=("engineering",))
    token = await _pat_for(
        harness, project, role="member", topics=("engineering",), can_curate=True
    )
    headers = {"Authorization": f"Bearer {token}"}

    async with _client(harness, tmp_path) as client:
        response = await client.post(
            f"/api/v1/admin/documents/{document_id}/approve",
            json={"tags": ["hidden"]},
            headers=headers,
        )

    assert response.status_code == 403, (
        "a PAT retagged a document into a topic outside its own authority "
        f"(api/admin.py:863-896): {response.status_code} {response.text}"
    )
    async with harness.sm() as session:
        doc_tags = await session.scalar(
            select(models.Document.doc_tags).where(models.Document.id == uuid.UUID(document_id))
        )
    assert doc_tags == ["engineering"], (
        f"a denied retag still mutated the document's tags: {doc_tags}"
    )


async def test_r02_admin_token_cross_project_document_is_absent_not_denied(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """A curator PAT for project B reaching for project A's document id gets an absence, never a
    same-project-shaped denial — the FR-4.3 indistinguishability rule."""
    harness = build_harness()
    project_a = await harness.setup_project(unique_slug("acme"), TOPICS)
    project_b = await harness.setup_project(unique_slug("globex"), TOPICS)
    document_id = await _setup_pending_document(harness, project_a, topics=("general",))
    token = await _pat_for(harness, project_b, role="member", topics=("general",), can_curate=True)
    headers = {"Authorization": f"Bearer {token}"}

    async with _client(harness, tmp_path) as client:
        response = await client.post(
            f"/api/v1/admin/documents/{document_id}/approve", json={}, headers=headers
        )

    assert response.status_code == 404, (
        f"a project-B curator reached project A's document: {response.status_code} {response.text}"
    )


async def test_r02_admin_session_reject_needs_document_lifecycle_capability(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """Reject is untested anywhere else: a plain member SESSION (no ``can_curate``, no
    project-admin role) rejects a document it has no document-lifecycle authority over. This is
    the R04-shaped defect (``_obs_scope``'s session branch admits any membership) applied
    specifically to the R02 reject operation."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    slug = await _project_slug(harness, project)
    document_id = await _setup_pending_document(harness, project, topics=("general",))
    token = await _session_for(
        harness, project, role="member", topics=("general",), can_curate=False
    )
    headers = {"Authorization": f"Bearer {token}"}

    async with _client(harness, tmp_path) as client:
        response = await client.post(
            f"/api/v1/admin/documents/{document_id}/reject?project={slug}",
            json={"reason": "no"},
            headers=headers,
        )

    assert response.status_code == 403, (
        "a plain member session rejected a document with no document-lifecycle capability "
        f"(api/admin.py:863-896): {response.status_code} {response.text}"
    )


async def test_r02_admin_token_reject_ignores_topic_scope(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """A curator PAT (capability but NO topic overlap) rejects a document outside its topic
    authority. Reject doesn't reveal tag content, but the ratified matrix still requires topic
    scope for ANY document decision — this is the part that's genuinely untested elsewhere."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    document_id = await _setup_pending_document(harness, project, topics=("hidden",))
    token = await _pat_for(harness, project, role="member", topics=("general",), can_curate=True)
    headers = {"Authorization": f"Bearer {token}"}

    async with _client(harness, tmp_path) as client:
        response = await client.post(
            f"/api/v1/admin/documents/{document_id}/reject",
            json={"reason": "no"},
            headers=headers,
        )

    assert response.status_code == 403, (
        "a curator PAT rejected a document outside its own topic authority "
        f"(api/admin.py:863-896): {response.status_code} {response.text}"
    )


async def _project_slug(harness: Harness, project_id: str) -> str:
    async with harness.sm() as session:
        return str(
            await session.scalar(
                select(models.Project.slug).where(models.Project.id == uuid.UUID(project_id))
            )
        )


# =========================================================================== #
# R04 — every console mutation applies the operation x role matrix (high)
# =========================================================================== #


@dataclass(frozen=True)
class MgmtOp:
    name: str
    category: str  # docs | logging | gaps | ontology
    setup: Callable[[Harness, str], Awaitable[str]]
    call: Callable[[httpx.AsyncClient, dict[str, str], str, str], Awaitable[httpx.Response]]


async def _do_approve_admin(
    client: httpx.AsyncClient, headers: dict[str, str], resource_id: str, slug: str
) -> httpx.Response:
    return await client.post(
        f"/api/v1/admin/documents/{resource_id}/approve?project={slug}", json={}, headers=headers
    )


async def _do_reject_admin(
    client: httpx.AsyncClient, headers: dict[str, str], resource_id: str, slug: str
) -> httpx.Response:
    return await client.post(
        f"/api/v1/admin/documents/{resource_id}/reject?project={slug}",
        json={"reason": "no"},
        headers=headers,
    )


async def _do_promote_gap(
    client: httpx.AsyncClient, headers: dict[str, str], resource_id: str, slug: str
) -> httpx.Response:
    return await client.post(
        f"/api/v1/admin/gaps/{resource_id}/promote?project={slug}", headers=headers
    )


async def _do_put_query_text_logging(
    client: httpx.AsyncClient, headers: dict[str, str], _resource_id: str, slug: str
) -> httpx.Response:
    return await client.put(
        f"/api/v1/admin/settings/query-text-logging?project={slug}",
        json={"enabled": True},
        headers=headers,
    )


async def _do_add_ontology(
    client: httpx.AsyncClient, headers: dict[str, str], _resource_id: str, slug: str
) -> httpx.Response:
    return await client.post(
        f"/api/v1/admin/ontologies?project={slug}",
        json={
            "name": unique_slug("onto"),
            "format": "turtle",
            "content": "@prefix ex: <http://example.org/> .\nex:a ex:b ex:c .",
        },
        headers=headers,
    )


OPS = [
    MgmtOp("approve_document", "docs", _setup_pending_document, _do_approve_admin),
    MgmtOp("reject_document", "docs", _setup_pending_document, _do_reject_admin),
    MgmtOp("toggle_query_text_logging", "logging", _setup_none, _do_put_query_text_logging),
    MgmtOp("promote_gap", "gaps", _setup_gap, _do_promote_gap),
    MgmtOp("add_ontology", "ontology", _setup_none, _do_add_ontology),
]


@dataclass(frozen=True)
class MgmtPrincipal:
    name: str
    role: str  # project role: project-admin | member | viewer
    can_curate: bool
    topics: tuple[str, ...]


# The least role the ratified matrix admits (this file's documented design choice, see module
# docstring): a project-admin with topic overlap over the resource.
PROJECT_ADMIN = MgmtPrincipal("project_admin", "project-admin", False, ("general", "engineering"))
# A plain member has no explicit capability at all.
MEMBER_NO_CAPABILITY = MgmtPrincipal(
    "member_no_capability", "member", False, ("general", "engineering")
)
# Curation capability, but the ratified matrix requires topic overlap regardless of capability.
CURATOR_NO_TOPIC_OVERLAP = MgmtPrincipal("curator_no_topic_overlap", "member", True, ("unrelated",))
# A viewer must never mutate, even with full topic authority.
VIEWER = MgmtPrincipal("viewer", "viewer", False, ("general", "engineering"))

MGMT_PRINCIPALS = [PROJECT_ADMIN, MEMBER_NO_CAPABILITY, CURATOR_NO_TOPIC_OVERLAP, VIEWER]
EXPECT_ALLOW: dict[str, bool] = {
    PROJECT_ADMIN.name: True,
    MEMBER_NO_CAPABILITY.name: False,
    CURATOR_NO_TOPIC_OVERLAP.name: False,
    VIEWER.name: False,
}

MGMT_ROWS = [
    (op, entry, principal)
    for op in OPS
    for entry in ("token", "session")
    for principal in MGMT_PRINCIPALS
]


@pytest.mark.parametrize(
    "op,entry,principal",
    MGMT_ROWS,
    ids=[f"{op.name}:{entry}:{principal.name}" for op, entry, principal in MGMT_ROWS],
)
async def test_r04_management_operation_role_matrix(
    op: MgmtOp,
    entry: str,
    principal: MgmtPrincipal,
    build_harness: Callable[..., Harness],
    tmp_path: Path,
) -> None:
    """Every console mutation (corrections/logging/docs/gaps/ontology, ``_obs_scope``-gated) must
    apply the SAME operationxrole matrix regardless of session vs token. The allow cells matter as
    much as the deny cells: locking the ratified project-admin out is as much a defect as
    admitting a viewer."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    slug = await _project_slug(harness, project)
    resource_id = await op.setup(harness, project, topics=("general",))  # type: ignore[call-arg]

    if entry == "token":
        token = await _pat_for(
            harness,
            project,
            role=principal.role,
            topics=principal.topics,
            can_curate=principal.can_curate,
        )
    else:
        token = await _session_for(
            harness,
            project,
            role=principal.role,
            topics=principal.topics,
            can_curate=principal.can_curate,
        )
    headers = {"Authorization": f"Bearer {token}"}

    async with _client(harness, tmp_path) as client:
        response = await op.call(client, headers, resource_id, slug)

    if EXPECT_ALLOW[principal.name]:
        assert response.status_code < 400, (
            f"{op.name}/{entry}/{principal.name}: the ratified least-role principal was denied — "
            f"{response.status_code} {response.text}"
        )
    else:
        assert response.status_code in (401, 403, 404), (
            f"{op.name}/{entry}/{principal.name}: a non-admitted principal mutated the console — "
            f"{response.status_code} {response.text}"
        )


async def test_r04_foreign_project_admin_cannot_reach_project_a(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """A project-admin of B (even with full topic authority in B) has zero authority over A's
    resources by any identifier."""
    harness = build_harness()
    project_a = await harness.setup_project(unique_slug("acme"), TOPICS)
    project_b = await harness.setup_project(unique_slug("globex"), TOPICS)
    gap_id = await _setup_gap(harness, project_a, topics=("general",))
    token = await _pat_for(
        harness, project_b, role="project-admin", topics=("general", "engineering"), can_curate=True
    )
    headers = {"Authorization": f"Bearer {token}"}

    async with _client(harness, tmp_path) as client:
        response = await client.post(f"/api/v1/admin/gaps/{gap_id}/promote", headers=headers)

    assert response.status_code == 404, (
        f"a project-B admin reached project A's gap: {response.status_code} {response.text}"
    )


async def test_r04_revoked_pat_stops_resolving_before_the_next_operation(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """A revoked PAT must not resolve to authority on the very next call (the ratified revocation
    window)."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    user_id = await _create_user(harness)
    membership_id = await _add_membership(
        harness,
        user_id,
        project,
        role="project-admin",
        topics=("general", "engineering"),
        can_curate=False,
    )
    issued = await IdentityService(harness.sm).issue_pat(membership_id)
    gap_id = await _setup_gap(harness, project, topics=("general",))
    await IdentityService(harness.sm).revoke_pat(issued.id)
    headers = {"Authorization": f"Bearer {issued.token}"}

    async with _client(harness, tmp_path) as client:
        response = await client.post(f"/api/v1/admin/gaps/{gap_id}/promote", headers=headers)

    assert response.status_code == 401, (
        f"a revoked PAT still resolved to authority: {response.status_code} {response.text}"
    )


async def test_r04_logged_out_session_stops_resolving_before_the_next_operation(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """A logged-out console session must not resolve to authority on the very next call."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    token = await _session_for(
        harness, project, role="project-admin", topics=("general", "engineering"), can_curate=False
    )
    gap_id = await _setup_gap(harness, project, topics=("general",))
    await logout(harness.sm, token)
    headers = {"Authorization": f"Bearer {token}"}

    async with _client(harness, tmp_path) as client:
        response = await client.post(f"/api/v1/admin/gaps/{gap_id}/promote", headers=headers)

    assert response.status_code in (401, 404), (
        f"a logged-out session still resolved to authority: {response.status_code} {response.text}"
    )
