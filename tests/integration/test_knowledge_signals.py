"""Knowledge signals must be authoritative (AUDIT-040/041/014 / R18-R24, R27, T011 RED).

Six defects that share one shape: a signal the product presents as knowledge is actually derived from
something else, or not derived at all.

**R18 — contradiction detection is off in production.** ``IngestionPipeline`` takes an optional
resolver and ``_detect_contradictions_on_ingest`` returns immediately when it is ``None``. No
composition root passes one, so every production ingest silently skips contradiction detection while
the tests that inject a resolver pass.

**R19 — candidates come from one document.** ``resolve_document`` loads
``claims_for_document(document_id)``, so a new document is only ever compared against ITSELF. A fact
that contradicts last quarter's handbook is never noticed, which is the entire point of the feature.

**R20 — credibility is guessed from chunk shape.** ``_claim_credibility`` reads
``row.kind``: a table row is authoritative, a scanned page is not. The document's real ``Source`` — its
policy, its curators, whether a human approved it — does not participate, so an unvetted upload and a
curated source produce the same number.

**R21 — corroboration is hardcoded.** Every claim is written with ``n_independent_sources=1``,
whatever else the corpus says, so agreement between independent sources never raises credibility.

**R22/R23/R24 — recall renders the wrong text and hides dispute.** Temporal selection picks claim
ids and then renders ``Chunk.text``, so a chunk containing both a current and a superseded sentence
returns the stale one; the relevance cut-off runs before the temporal filter, so an eligible claim can
be dropped by an ineligible sibling ranking above it; and neither the aggregate nor the provenance
carries ``Claim.disputed``, so a consumer cannot tell a contested fact from a settled one.

**R27 — superseded relations stay current in the graph.** A correction supersedes in Postgres, and the
AGE edge from the old claim is left as-is, so the graph keeps answering with a fact the relational
store has retired.
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable

import pytest
from sqlalchemy import func, select

from rsc_brain.config.models import RecallConfig
from rsc_brain.recall.retriever import PgRetriever
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational import models

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("general", 0)]


async def _claim(
    harness: Harness,
    project: str,
    *,
    text: str,
    subject: str = "SLA",
    tags: tuple[str, ...] = ("general",),
    credibility: float = 0.5,
    disputed: bool = False,
    valid_to: dt.datetime | None = None,
    chunk_id: uuid.UUID | None = None,
    document_id: uuid.UUID | None = None,
    embed: bool = True,
) -> str:
    embedding = list((await harness.gateway.embed([text]))[0]) if embed else None
    async with harness.sm() as session:
        claim = models.Claim(
            project_id=uuid.UUID(project),
            chunk_id=chunk_id,
            text=text,
            subject=subject,
            tags=list(tags),
            credibility=credibility,
            disputed=disputed,
            valid_to=valid_to,
            source_document_id=document_id,
            embedding=embedding,
        )
        session.add(claim)
        await session.flush()
        claim_id = str(claim.id)
        await session.commit()
    return claim_id


async def _document_with_chunk(
    harness: Harness, project: str, *, text: str, tags: tuple[str, ...] = ("general",)
) -> tuple[uuid.UUID, uuid.UUID]:
    """A published document plus one embedded chunk — the shape recall serves from."""
    embedding = list((await harness.gateway.embed([text]))[0])
    async with harness.sm() as session:
        doc = models.Document(
            project_id=uuid.UUID(project),
            logical_id=unique_slug("doc"),
            checksum=unique_slug("sum"),
            status="processed",
            doc_tags=list(tags),
        )
        session.add(doc)
        await session.flush()
        chunk = models.Chunk(
            project_id=uuid.UUID(project),
            document_id=doc.id,
            kind="prose",
            text=text,
            tags=list(tags),
            embedding=embedding,
            needs_review=False,
        )
        session.add(chunk)
        await session.flush()
        ids = (doc.id, chunk.id)
        await session.commit()
    return ids


def _retriever(harness: Harness, **overrides: object) -> PgRetriever:
    return PgRetriever(
        sessionmaker=harness.sm,
        gateway=harness.gateway,
        graph_store=AgeGraphStore(harness.sm),
        config=RecallConfig(**overrides),
    )


# --------------------------------------------------------------------------- #
# R18 — the resolver is wired in every production composition
# --------------------------------------------------------------------------- #


async def test_a_production_shaped_ingest_detects_a_contradiction(
    build_harness: Callable[..., Harness], make_completion: Callable[..., object]
) -> None:
    """A feature that is off in production is not a feature.

    ``_detect_contradictions_on_ingest`` returns immediately when no resolver was injected, and no
    composition root injects one — so detection runs in tests that pass a resolver and nowhere else.
    Asserted on the OBSERVABLE (does a verdict row exist after an ingest built the way production
    builds it?) rather than on a builder's name, so it stays true whatever the wiring ends up called.
    """
    harness = build_harness(
        completion=make_completion(
            claims=[
                {
                    "text": "The SLA is 48 hours",
                    "subject": "SLA",
                    "predicate": "is",
                    "object": "48h",
                }
            ],
            tags=["general"],
        )
    )
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["general"])
    await harness.repo.create_source(
        scope, name="manual", type_="folder", policy="manual", default_tags=["general"]
    )
    await _claim(harness, project, text="The SLA is 24 hours.")

    outcome = await harness.service.ingest_bytes(
        scope, b"# Handbook\n\nThe SLA is 48 hours.\n", filename="hb.md", source="manual"
    )
    await harness.service.approve(scope, outcome.document_id, approver=scope.principal_id)

    async with harness.sm() as session:
        verdicts = await session.scalar(
            select(func.count())
            .select_from(models.ClaimPairVerdict)
            .where(models.ClaimPairVerdict.project_id == uuid.UUID(project))
        )
    assert verdicts, (
        "ingesting a contradicting document produced no contradiction verdict at all — detection is "
        "opt-in and nothing in production opts in"
    )


# --------------------------------------------------------------------------- #
# R19 — candidates include eligible prior documents
# --------------------------------------------------------------------------- #


async def test_contradiction_candidates_span_documents(
    build_harness: Callable[..., Harness],
) -> None:
    """A new document must be compared against the corpus, not only against itself."""
    from rsc_brain.stores.relational.knowledge_store import KnowledgeStore

    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    old_doc, _ = await _document_with_chunk(harness, project, text="The SLA is 24 hours.")
    new_doc, _ = await _document_with_chunk(harness, project, text="The SLA is 48 hours.")
    await _claim(harness, project, text="The SLA is 24 hours.", document_id=old_doc)
    await _claim(harness, project, text="The SLA is 48 hours.", document_id=new_doc)

    from rsc_brain.knowledge.contradictions import ContradictionResolver
    from rsc_brain.knowledge.judge import LlmJudge

    store = KnowledgeStore(harness.sm)
    scope = harness.scope(project, allowed_topics=["general"])

    compared: list[tuple[str, str]] = []

    real_judge = LlmJudge(harness.gateway)

    class _RecordingJudge:
        """Wraps the real judge and records which pairs it is asked about."""

        @property
        def version(self) -> str:
            return real_judge.version

        async def judge(self, a: str, b: str) -> object:
            compared.append((a, b))
            return await real_judge.judge(a, b)

    resolver = ContradictionResolver(
        store=store,
        graph=AgeGraphStore(harness.sm),
        judge=_RecordingJudge(),  # type: ignore[arg-type]
    )
    await resolver.resolve_document(scope, str(new_doc))

    pairs = {frozenset(pair) for pair in compared}
    assert any(
        "The SLA is 24 hours." in pair and "The SLA is 48 hours." in pair for pair in pairs
    ), (
        "the new document was only ever compared against its own claims, so a fact contradicting an "
        f"earlier document is never noticed: {compared}"
    )


# --------------------------------------------------------------------------- #
# R20 / R21 — credibility comes from provenance, corroboration is counted
# --------------------------------------------------------------------------- #


async def test_credibility_reflects_the_source_policy_not_the_chunk_shape(
    build_harness: Callable[..., Harness], make_completion: Callable[..., object]
) -> None:
    """An unvetted upload and a curated source must not produce the same number.

    ``_claim_credibility`` reads only ``row.kind``, so authority is a guess about layout — the
    document's real ``Source`` (its policy, its curators, whether a human approved it) never
    participates. Asserted end to end: the SAME text through two sources of different policy, then
    compare what was stored.
    """
    claims = [{"text": "The SLA is 24 hours", "subject": "SLA", "predicate": "is", "object": "24h"}]
    harness = build_harness(completion=make_completion(claims=claims, tags=["general"]))
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["general"])
    await harness.repo.create_source(
        scope, name="curated", type_="folder", policy="manual", default_tags=["general"]
    )
    await harness.repo.create_source(
        scope, name="automatic", type_="folder", policy="llm", default_tags=["general"]
    )

    stored: dict[str, float] = {}
    for source in ("curated", "automatic"):
        outcome = await harness.service.ingest_bytes(
            scope,
            f"# Handbook via {source}\n\nThe SLA is 24 hours.\n".encode(),
            filename=f"{source}.md",
            source=source,
        )
        await harness.service.approve(scope, outcome.document_id, approver=scope.principal_id)
        async with harness.sm() as session:
            value = await session.scalar(
                select(models.Claim.credibility)
                .where(models.Claim.source_document_id == uuid.UUID(outcome.document_id))
                .limit(1)
            )
        stored[source] = float(value or 0)

    assert stored["curated"] > stored["automatic"], (
        f"a manually curated source produced credibility {stored['curated']} and an automatically "
        f"tagged one {stored['automatic']} — authority is derived from chunk shape, not provenance"
    )


async def test_a_second_independent_source_raises_credibility(
    build_harness: Callable[..., Harness], make_completion: Callable[..., object]
) -> None:
    """Agreement between independent sources must count for something.

    Every claim is written with ``n_independent_sources=1`` whatever the corpus says, so a fact two
    documents assert independently is no more credible than one nobody corroborates.
    """
    claims = [{"text": "The SLA is 24 hours", "subject": "SLA", "predicate": "is", "object": "24h"}]
    harness = build_harness(completion=make_completion(claims=claims, tags=["general"]))
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["general"])
    await harness.repo.create_source(
        scope, name="manual", type_="folder", policy="manual", default_tags=["general"]
    )

    credibility: list[float] = []
    for index in (1, 2):
        outcome = await harness.service.ingest_bytes(
            scope,
            f"# Source {index}\n\nThe SLA is 24 hours.\n".encode(),
            filename=f"source-{index}.md",
            source="manual",
        )
        await harness.service.approve(scope, outcome.document_id, approver=scope.principal_id)
        async with harness.sm() as session:
            value = await session.scalar(
                select(models.Claim.credibility)
                .where(models.Claim.source_document_id == uuid.UUID(outcome.document_id))
                .limit(1)
            )
        credibility.append(float(value or 0))

    assert credibility[1] > credibility[0], (
        f"the first source produced {credibility[0]} and a second independent one {credibility[1]} — "
        "corroboration is hardcoded to a single source, so agreement never raises credibility"
    )


# --------------------------------------------------------------------------- #
# R22 / R23 / R24 — recall renders claim-aligned text and carries dispute
# --------------------------------------------------------------------------- #


async def test_recall_does_not_render_a_superseded_sibling_sentence(
    build_harness: Callable[..., Harness],
) -> None:
    """Temporal selection picks CLAIMS; rendering returns the whole CHUNK.

    So a chunk holding both the current and the retired sentence answers with the retired one — the
    product states an obsolete fact while its own store knows better.
    """
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    mixed = "The SLA was 72 hours until March. The SLA is 24 hours."
    document_id, chunk_id = await _document_with_chunk(harness, project, text=mixed)
    await _claim(
        harness,
        project,
        text="The SLA was 72 hours until March.",
        chunk_id=chunk_id,
        document_id=document_id,
        valid_to=dt.datetime(2026, 3, 1, tzinfo=dt.UTC),
    )
    await _claim(
        harness,
        project,
        text="The SLA is 24 hours.",
        chunk_id=chunk_id,
        document_id=document_id,
    )

    scope = harness.scope(project, allowed_topics=["general"])
    result = await _retriever(harness).recall(scope, "what is the SLA", top_k=5)

    assert result.found, "nothing was recalled, so the rendering is untested"
    rendered = " ".join(fragment.text for fragment in result.fragments)
    assert "72 hours" not in rendered, (
        f"recall rendered the superseded sentence alongside the current one: {rendered!r}"
    )
    assert "24 hours" in rendered


async def test_an_eligible_claim_is_not_dropped_by_an_ineligible_sibling(
    build_harness: Callable[..., Harness],
) -> None:
    """The relevance cut-off runs BEFORE the temporal filter, so a stale-but-similar chunk can occupy
    the whole page and starve the eligible answer."""
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    for index in range(4):
        stale_doc, stale_chunk = await _document_with_chunk(
            harness, project, text=f"The SLA is 72 hours (retired note {index})."
        )
        await _claim(
            harness,
            project,
            text=f"The SLA is 72 hours (retired note {index}).",
            chunk_id=stale_chunk,
            document_id=stale_doc,
            valid_to=dt.datetime(2026, 3, 1, tzinfo=dt.UTC),
        )
    current_doc, current_chunk = await _document_with_chunk(
        harness, project, text="The SLA is 24 hours."
    )
    await _claim(
        harness,
        project,
        text="The SLA is 24 hours.",
        chunk_id=current_chunk,
        document_id=current_doc,
    )

    scope = harness.scope(project, allowed_topics=["general"])
    result = await _retriever(harness).recall(scope, "The SLA is", top_k=2)

    rendered = " ".join(fragment.text for fragment in result.fragments)
    assert "24 hours" in rendered, (
        f"the only temporally eligible claim was cut before the temporal filter ran: {rendered!r}"
    )


async def test_recall_carries_the_disputed_state(build_harness: Callable[..., Harness]) -> None:
    """A consumer must be able to tell a contested fact from a settled one.

    Neither the aggregate nor the provenance carries ``Claim.disputed`` today, so a disputed claim is
    served as ordinary knowledge.
    """
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    document_id, chunk_id = await _document_with_chunk(
        harness, project, text="The SLA is 24 hours."
    )
    await _claim(
        harness,
        project,
        text="The SLA is 24 hours.",
        chunk_id=chunk_id,
        document_id=document_id,
        disputed=True,
    )

    scope = harness.scope(project, allowed_topics=["general"])
    result = await _retriever(harness).recall(scope, "what is the SLA", top_k=5)

    assert result.found, "nothing was recalled, so the dispute flag is untested"
    payload = str([(fragment.text, dict(fragment.provenance)) for fragment in result.fragments])
    assert "disput" in payload.lower(), (
        f"a disputed claim is served with no indication that it is contested: {payload}"
    )


# --------------------------------------------------------------------------- #
# R27 — superseding a claim retires its graph relation too
# --------------------------------------------------------------------------- #


async def test_superseding_a_claim_retires_its_graph_relation(
    build_harness: Callable[..., Harness],
) -> None:
    """A correction supersedes in Postgres; the AGE edge is left current.

    The graph then keeps answering with a fact the relational store has retired, and the two stores
    disagree with no way for a reader to tell which is right.
    """
    from rsc_brain.stores.graph_store import GraphEdge, GraphNode

    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["general"])
    graph = AgeGraphStore(harness.sm)

    old_claim = await _claim(harness, project, text="The SLA is 72 hours.")
    await graph.create_graph(scope)
    await graph.upsert_nodes(
        scope,
        [
            GraphNode(id=old_claim, labels=frozenset({"Claim"}), properties={"kind": "claim"}),
            GraphNode(id="sla-node", labels=frozenset({"Entity"}), properties={"name": "SLA"}),
        ],
    )
    await graph.upsert_edges(
        scope, [GraphEdge(source_id=old_claim, target_id="sla-node", type="ABOUT")]
    )

    async with harness.sm() as session:
        claim = await session.get(models.Claim, uuid.UUID(old_claim))
        assert claim is not None
        claim.valid_to = dt.datetime.now(dt.UTC)
        await session.commit()

    rows = await graph.run_cypher(
        scope,
        "MATCH (c)-[r]->(e) WHERE c.id = $id AND r.superseded IS NULL RETURN count(r) AS live",
        {"id": old_claim},
    )
    live = rows[0]["live"] if rows else 0
    assert live == 0, (
        f"{live} graph relation(s) of a superseded claim are still current, so the graph answers with "
        "a fact the relational store has retired"
    )
