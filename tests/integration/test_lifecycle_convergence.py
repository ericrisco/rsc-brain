"""Review, hunting and document-lifecycle convergence (AUDIT-019/042/043/048 — R25, R26, R28, R31, R55).

Every fixture here is produced by the service that produces it in production. That is not a style
preference: R25 exists precisely BECAUSE the existing queue tests hand-wrote their merge proposals, so
nobody noticed that the producer writes ``status="needs_review"`` while the queue and the resolver both
look for ``"pending"``. A hand-made row agrees with whatever the test believes, which is why R55 asks
for the fixtures to be reachable — a fixture in an impossible state proves the code can read a row no
running system will ever contain.

The same discipline applies to what the checks assert: an observable a user or an operator could see —
does the item appear in the queue, does the link resolve, does the second writer lose — never the shape
of a row.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Callable, Sequence
from pathlib import Path

import pytest
from sqlalchemy import func, select

from rsc_brain.config.models import KnowledgeConfig
from rsc_brain.knowledge.entity_merge import DeterministicMergeProposer, EntityMergeService
from rsc_brain.review.queue import list_review_queue
from rsc_brain.review.resolve import resolve_chunk, resolve_merge
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.entity_store import EntityStore

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("hr", 0)]

# A GFM table whose header repeats a label: `has_clear_header` is false, so FR-1.5 parks the whole
# table as one needs_review chunk. This is how an ambiguous table actually reaches the queue.
AMBIGUOUS_TABLE = b"""# Rota

| Shift | Shift |
| --- | --- |
| morning | Ana |
| evening | Bruno |
"""


async def _needs_review_chunk_via_ingest(
    harness: Harness, scope: ProjectScope, *, source: str
) -> str:
    """A needs_review chunk, created by ingesting a document that has an ambiguous table."""
    outcome = await harness.service.ingest_bytes(
        scope, AMBIGUOUS_TABLE, filename=f"{unique_slug('rota')}.md", source=source
    )
    if outcome.status == "pending_approval":
        await harness.service.approve(scope, outcome.document_id, approver=scope.principal_id)
    async with harness.sm() as session:
        chunk_id = await session.scalar(
            select(models.Chunk.id).where(
                models.Chunk.project_id == uuid.UUID(scope.project_id),
                models.Chunk.document_id == uuid.UUID(outcome.document_id),
                models.Chunk.needs_review.is_(True),
            )
        )
    assert chunk_id is not None, "ingesting an ambiguous table produced no needs_review chunk"
    return str(chunk_id)


async def _entity(
    harness: Harness, scope: ProjectScope, name: str, *, aliases: Sequence[str] = ()
) -> str:
    async with harness.sm() as session:
        entity = models.Entity(
            project_id=uuid.UUID(scope.project_id),
            name=name,
            normalized_name=name.casefold(),
            type="person",
        )
        session.add(entity)
        await session.flush()
        for alias in aliases:
            session.add(
                models.EntityAlias(
                    project_id=uuid.UUID(scope.project_id),
                    entity_id=entity.id,
                    alias=alias,
                    approved=True,
                )
            )
        entity_id = str(entity.id)
        await session.commit()
    return entity_id


async def _hunt_manager_pat(harness: Harness, project_id: str) -> str:
    """A principal that holds `hunt.manage` over the topic — minted the way the product mints one."""
    from rsc_brain.identity.service import IdentityService
    from rsc_brain.stores.relational.store import PgRelationalStore

    user = (
        await PgRelationalStore(harness.sm)
        .users()
        .create_user(email=f"{unique_slug('hunter')}@example.test", status="active", role="member")
    )
    membership = await IdentityService(harness.sm).add_membership(
        user.user_id, project_id, role="project-admin", allowed_topics=("hr",), can_curate=False
    )
    return (await IdentityService(harness.sm).issue_pat(membership)).token


def _merge_service(harness: Harness) -> EntityMergeService:
    """The service as the CLI and the console build it (never auto-applying, so it must queue)."""
    return EntityMergeService(
        store=EntityStore(harness.sm),
        graph=AgeGraphStore(harness.sm),
        proposer=DeterministicMergeProposer(min_similarity=0.82),
        sessionmaker=harness.sm,
        config=KnowledgeConfig(merge_auto_apply_confidence=1.0),
    )


async def _queue_a_merge(harness: Harness, scope: ProjectScope) -> str:
    await _entity(harness, scope, "Acme Corporation", aliases=["ACME"])
    await _entity(harness, scope, "Acme Corporaton")  # typo, ~0.98 similar
    summary = await _merge_service(harness).propose(scope)
    assert summary.queued, "the proposer queued nothing, so this check cannot say anything"
    return summary.queued[0]


# --------------------------------------------------------------------------- #
# R25 / R55 — a proposal the real producer creates must reach the real queue
# --------------------------------------------------------------------------- #


async def test_a_merge_proposal_created_by_the_real_service_reaches_the_review_queue(
    build_harness: Callable[..., Harness],
) -> None:
    """The producer and the queue disagree about the word for "waiting for a human".

    ``EntityMergeService.propose`` writes ``needs_review``; ``list_review_queue`` selects ``pending``.
    A proposal a curator is supposed to decide is therefore invisible in the console forever — and the
    existing queue tests never caught it because they hand-wrote their proposals with the status the
    query wanted (R55).
    """
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["hr"])

    proposal_id = await _queue_a_merge(harness, scope)

    queue = await list_review_queue(harness.sm, scope, source="entity_merge")
    assert [item.id for item in queue] == [proposal_id], (
        "a merge proposal created through the real service is absent from the real review queue: "
        "the producer writes one status and the queue reads another"
    )


async def test_a_queued_merge_can_be_resolved_from_the_console_path(
    build_harness: Callable[..., Harness],
) -> None:
    """Two resolution paths exist for one object and only one of them can see it.

    The console resolves through ``review.resolve.resolve_merge`` (which requires ``pending``); the CLI
    resolves through ``EntityMergeService.confirm`` (which requires ``needs_review``). Whichever wrote
    the row decides who may act on it, which is not a policy anyone chose.
    """
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["hr"])

    proposal_id = await _queue_a_merge(harness, scope)

    outcome = await resolve_merge(
        harness.sm, scope, proposal_id, approve=True, resolved_by=scope.principal_id
    )
    assert outcome == "approved", (
        f"the console path answered {outcome!r} for a proposal the CLI path had just queued"
    )


# --------------------------------------------------------------------------- #
# R26 / R55 — rejected is terminal
# --------------------------------------------------------------------------- #


async def test_a_rejected_chunk_leaves_the_review_queue_for_good(
    build_harness: Callable[..., Harness],
) -> None:
    """Rejecting sets ``needs_review = True`` — the value it already had.

    So the item stays in the queue, and the next curator is asked the same question again, with no
    record in the queue that anyone answered it. Reject is not terminal; it is a no-op with a tag.
    """
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["hr"])
    await harness.repo.create_source(
        scope, name="manual", type_="folder", policy="manual", default_tags=["hr"]
    )
    chunk_id = await _needs_review_chunk_via_ingest(harness, scope, source="manual")
    assert chunk_id in [item.id for item in await list_review_queue(harness.sm, scope)]

    assert (
        await resolve_chunk(harness.sm, scope, chunk_id, approve=False, gateway=harness.gateway)
        == "rejected"
    )

    async with harness.sm() as session:
        chunk = await session.get(models.Chunk, uuid.UUID(chunk_id))
    assert chunk is not None
    # Asserted FIRST on purpose: reject currently replaces the tag list with `["__rejected__"]`, and a
    # chunk with no topic drops out of the topic-filtered queue by accident. Without this line the
    # queue check below passes for the wrong reason and would start failing the moment the tag erasure
    # is fixed.
    assert "hr" in chunk.tags, (
        f"rejecting erased the chunk's topics (tags={chunk.tags!r}), so it leaves the queue only "
        "because no topic predicate can place it any more"
    )
    assert chunk.needs_review is False, (
        "a rejected chunk is still flagged needs_review, so reject is a no-op with a tag"
    )

    remaining = [item.id for item in await list_review_queue(harness.sm, scope)]
    assert chunk_id not in remaining, (
        "a rejected item is still in the review queue, so the same decision is asked again forever"
    )


async def test_rejecting_a_chunk_keeps_its_topic_so_it_stays_filterable(
    build_harness: Callable[..., Harness],
) -> None:
    """Reject replaces the tag list with ``["__rejected__"]``, dropping the topic tags.

    A row with no topic is a row the topic predicate cannot place, and every visibility decision in
    the product is made from those tags. Rejecting should record a decision, not erase the dimension
    the decision is authorized against.
    """
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["hr"])
    await harness.repo.create_source(
        scope, name="manual", type_="folder", policy="manual", default_tags=["hr"]
    )
    chunk_id = await _needs_review_chunk_via_ingest(harness, scope, source="manual")

    await resolve_chunk(harness.sm, scope, chunk_id, approve=False, gateway=harness.gateway)

    async with harness.sm() as session:
        chunk = await session.get(models.Chunk, uuid.UUID(chunk_id))
    assert chunk is not None
    assert "hr" in chunk.tags, (
        f"rejecting the chunk erased its topics (tags={chunk.tags!r}), so no topic predicate can "
        "place it any more"
    )


# --------------------------------------------------------------------------- #
# R31 — the document decision has exactly one winner
# --------------------------------------------------------------------------- #


async def test_rejecting_an_already_published_document_is_refused(
    build_harness: Callable[..., Harness],
) -> None:
    """``reject`` is unconditional: it does not look at the document's status.

    So a published document can be "rejected" while its claims stay live and recallable — the record
    says the content was refused and the knowledge says it was accepted, with nothing to reconcile
    them.
    """
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["hr"])
    await harness.repo.create_source(
        scope, name="auto", type_="folder", policy="source_tags", default_tags=["hr"]
    )
    outcome = await harness.service.ingest_bytes(
        scope, b"# Handbook\n\nThe SLA is 48 hours.\n", filename="hb.md", source="auto"
    )
    assert outcome.status == "processed", outcome.status

    with pytest.raises(ValueError):
        await harness.service.reject(scope, outcome.document_id, reason="changed my mind")


async def test_approve_and_reject_racing_leave_one_winner(
    build_harness: Callable[..., Harness],
) -> None:
    """Both decisions read, then write, in separate transactions.

    Racing them therefore lets both "succeed": the document ends rejected while publish has already
    written claims, or ends approved while the audit says refused. A decision needs a conditional
    winner, not a last-writer.
    """
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["hr"])
    await harness.repo.create_source(
        scope, name="manual", type_="folder", policy="manual", default_tags=["hr"]
    )
    outcome = await harness.service.ingest_bytes(
        scope, b"# Handbook\n\nThe SLA is 48 hours.\n", filename="hb.md", source="manual"
    )
    assert outcome.status == "pending_approval"

    results = await asyncio.gather(
        harness.service.approve(scope, outcome.document_id, approver=scope.principal_id),
        harness.service.reject(scope, outcome.document_id, reason="raced"),
        return_exceptions=True,
    )
    winners = [r for r in results if not isinstance(r, BaseException)]

    async with harness.sm() as session:
        document = await session.get(models.Document, uuid.UUID(outcome.document_id))
        claims = await session.scalar(
            select(func.count())
            .select_from(models.Claim)
            .where(models.Claim.source_document_id == uuid.UUID(outcome.document_id))
        )
    assert document is not None
    assert len(winners) == 1, (
        f"both decisions succeeded on the same document ({len(winners)} winners), so which one holds "
        "is decided by scheduling"
    )
    if document.status == "rejected":
        assert not claims, "a rejected document published claims anyway"


# --------------------------------------------------------------------------- #
# R28 — hunting is operational: delivered, answerable, and reachable
# --------------------------------------------------------------------------- #


async def test_the_hunt_magic_link_is_served_by_the_application(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """A hunt's entire reply path is a magic link, and no route serves it.

    ``HuntService.answer_via_magic_link`` exists and nothing HTTP reaches it, so the link in the
    message points at a path the app does not route — on a host (``https://brain.local``) that does not
    exist, because the factory passes no base URL either. The person asked cannot answer, so the
    feature meant to stop the product from guessing never completes a single loop.
    """
    import httpx

    from rsc_brain.api.app import ApiDeps, create_app

    harness = build_harness()
    app = create_app(
        deps=ApiDeps(sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path))
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/hunt/some-unknown-token")

    # An unknown token may answer 404 for the TOKEN; what may not happen is 404 because the path
    # itself is unrouted. Asserted through a request rather than the route table because the admin
    # surface is mounted, so its paths are not top-level routes.
    assert response.status_code != 404 or "token" in response.text.lower(), (
        f"the hunt magic link resolves to nothing ({response.status_code}), so every hunt the product "
        "sends is unanswerable"
    )


async def test_an_unconfigured_install_does_not_claim_the_owner_was_asked(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """Asking a hunt on an install with no delivery channel reports ``awaiting_answer``.

    Nothing was delivered: the production factory builds ``HuntService(sessionmaker)``, whose default
    channel records the message and sends it nowhere. So the operator sees hunts going out, the owner
    is never asked, and the gap stays open behind a record saying somebody was contacted. An
    unconfigured install has to be distinguishable from a working one.
    """
    import httpx

    from rsc_brain.api.app import ApiDeps, create_app

    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    async with harness.sm() as session:
        session.add(
            models.Person(
                project_id=uuid.UUID(project),
                name="Ana",
                topics=["hr"],
                channels={"email": "ana@example.test"},
            )
        )
        await session.commit()

    token = await _hunt_manager_pat(harness, project)
    app = create_app(
        deps=ApiDeps(sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path))
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/api/v1/admin/hunts/ask",
            json={"question": "What is the SLA?", "topics": ["hr"]},
            headers={"Authorization": f"Bearer {token}"},
        )

    if response.status_code == 201:
        assert response.json()["state"].lower() not in {"awaiting_answer", "routed"}, (
            "the API reports the owner is awaiting an answer on an install that has no channel "
            f"configured and delivered nothing: {response.json()}"
        )
    else:  # the route refused before routing — acceptable only if it says why
        assert response.status_code in {409, 503}, (
            f"unexpected refusal {response.status_code}: {response.text[:200]}"
        )
