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
from pathlib import Path

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
    valid_from: dt.datetime | None = None,
    valid_to: dt.datetime | None = None,
    chunk_id: uuid.UUID | None = None,
    document_id: uuid.UUID | None = None,
    embed: bool = True,
    embed_as: str | None = None,
    subject_entity_key: str | None = None,
    predicate: str | None = None,
    object_entity_key: str | None = None,
) -> str:
    """One claim. ``embed_as`` embeds the claim under a different anchor text.

    The harness's embedder is a hash of the text, so two near-identical sentences come out nearly
    orthogonal — the opposite of what a real embedder does, and contradiction pairing is driven by
    similarity. Anchoring both sides of a contradiction on the same text is what makes the fixture
    behave like production instead of like the fake.
    """
    embedding = list((await harness.gateway.embed([embed_as or text]))[0]) if embed else None
    async with harness.sm() as session:
        claim = models.Claim(
            project_id=uuid.UUID(project),
            chunk_id=chunk_id,
            text=text,
            subject=subject,
            tags=list(tags),
            credibility=credibility,
            disputed=disputed,
            valid_from=valid_from,
            valid_to=valid_to,
            source_document_id=document_id,
            embedding=embedding,
            predicate=predicate,
            subject_entity_key=uuid.UUID(subject_entity_key) if subject_entity_key else None,
            object_entity_key=uuid.UUID(object_entity_key) if object_entity_key else None,
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
    build_harness: Callable[..., Harness],
    make_completion: Callable[..., object],
    tmp_path: Path,
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
    # Anchored on the exact text the extraction below yields: the fake embedder is a hash, so a
    # trailing period is as distant as an unrelated sentence. The production embedder would pair these
    # on meaning; here the anchor stands in for that similarity.
    await _claim(harness, project, text="The SLA is 24 hours.", embed_as="The SLA is 48 hours")

    # Built through `ApiDeps.service()` — the composition the API actually uses — rather than through
    # the harness's own pipeline, which is exactly the difference the finding is about: the harness
    # injects what it needs, production injected nothing.
    from rsc_brain.api.app import ApiDeps

    service, _ = ApiDeps(
        sessionmaker=harness.sm, gateway=harness.gateway, data_dir=str(tmp_path)
    ).service()
    outcome = await service.ingest_bytes(
        scope, b"# Handbook\n\nThe SLA is 48 hours.\n", filename="hb.md", source="manual"
    )
    if outcome.status == "pending_approval":
        await service.approve(scope, outcome.document_id, approver=scope.principal_id)

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
    await _claim(
        harness, project, text="The SLA is 24 hours.", document_id=old_doc, embed_as="the SLA"
    )
    await _claim(
        harness, project, text="The SLA is 48 hours.", document_id=new_doc, embed_as="the SLA"
    )

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


async def test_temporal_active_candidate_contradiction_and_relation_readers(
    build_harness: Callable[..., Harness],
) -> None:
    """Every active-claim reader shares the half-open contract, not ``valid_to IS NULL``."""
    from rsc_brain.stores.relational.knowledge_store import KnowledgeStore

    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["general"])
    bounded_doc, _ = await _document_with_chunk(harness, project, text="bounded")
    future_doc, _ = await _document_with_chunk(harness, project, text="future")
    expired_doc, _ = await _document_with_chunk(harness, project, text="expired")
    subject, obj = str(uuid.uuid4()), str(uuid.uuid4())
    now = dt.datetime.now(dt.UTC)
    bounded = await _claim(
        harness,
        project,
        text="Bounded fact remains active",
        document_id=bounded_doc,
        valid_from=now - dt.timedelta(days=1),
        valid_to=now + dt.timedelta(days=1),
        subject_entity_key=subject,
        predicate="is",
        object_entity_key=obj,
    )
    future = await _claim(
        harness,
        project,
        text="Future fact is not active yet",
        document_id=future_doc,
        valid_from=now + dt.timedelta(days=1),
        subject_entity_key=subject,
        predicate="is",
        object_entity_key=obj,
    )
    expired = await _claim(
        harness,
        project,
        text="Expired fact is no longer active",
        document_id=expired_doc,
        valid_from=now - dt.timedelta(days=2),
        valid_to=now - dt.timedelta(days=1),
        subject_entity_key=subject,
        predicate="is",
        object_entity_key=obj,
    )
    store = KnowledgeStore(harness.sm)

    by_id = await store.claims_by_ids(scope, [bounded, future, expired])
    assert [claim.id for claim in by_id] == [bounded]
    own = await store.claims_for_document(scope, str(bounded_doc))
    assert [claim.id for claim in own] == [bounded]
    candidates = await store.contradiction_candidates(scope, str(bounded_doc))
    assert [claim.id for claim in candidates] == [bounded]
    nearest = await store.find_candidate_claims(
        scope, (await harness.gateway.embed(["Bounded fact remains active"]))[0]
    )
    assert [claim.id for claim in nearest] == [bounded]
    key = (subject, "is", obj)
    assert await store.live_relation_keys(scope, [key]) == {key}


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
        # An `llm`-policy source publishes itself (D13); a `manual` one waits for a decision. Approve
        # only what is actually waiting, so the comparison is between the two POLICIES rather than
        # between two lifecycles.
        if outcome.status == "pending_approval":
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
        if outcome.status == "pending_approval":
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


async def test_recall_expansion_retired_relation_cannot_surface_its_neighbour(
    build_harness: Callable[..., Harness],
) -> None:
    """The product recall path must not cross the retired relation that k_hop already rejects.

    Vector retrieval can see only the expired seed. The current answer can enter the candidate set
    only through graph expansion, so returning it proves ``PgRetriever._neighbor_documents`` crossed
    the retired edge.
    """
    from rsc_brain.stores.graph_store import GraphEdge, GraphNode

    harness = build_harness()
    project = await harness.setup_project(unique_slug("age-retired"), TOPICS)
    scope = harness.scope(project, allowed_topics=["general"])
    graph = AgeGraphStore(harness.sm)

    query = "graph expansion seed"
    seed_doc, seed_chunk = await _document_with_chunk(harness, project, text=query)
    await _claim(
        harness,
        project,
        text="This seed is expired.",
        chunk_id=seed_chunk,
        document_id=seed_doc,
        valid_to=dt.datetime.now(dt.UTC) - dt.timedelta(days=1),
    )
    answer_doc, answer_chunk = await _document_with_chunk(
        harness, project, text="The expansion-only answer is cobalt."
    )
    await _claim(
        harness,
        project,
        text="The expansion-only answer is cobalt.",
        chunk_id=answer_chunk,
        document_id=answer_doc,
    )

    source, target = str(uuid.uuid4()), str(uuid.uuid4())
    edge = GraphEdge(source_id=source, target_id=target, type="RELATED_TO")
    await graph.create_graph(scope)
    await graph.upsert_nodes(
        scope,
        [
            GraphNode(id=source, properties={"source_document_id": str(seed_doc)}),
            GraphNode(id=target, properties={"source_document_id": str(answer_doc)}),
        ],
    )
    await graph.upsert_edges(scope, [edge])
    await graph.set_relations_retired(scope, [edge], retired=True)

    result = await _retriever(
        harness,
        k_hop=1,
        temporal_refill_factor=1,
        hybrid_enabled=False,
    ).recall(scope, query, top_k=1)

    assert result.found is False
    assert result.fragments == ()

    await graph.set_relations_retired(scope, [edge], retired=False)
    live = await _retriever(
        harness,
        k_hop=1,
        temporal_refill_factor=1,
        hybrid_enabled=False,
    ).recall(scope, query, top_k=1)

    assert live.found is True
    assert [fragment.text for fragment in live.fragments] == [
        "The expansion-only answer is cobalt."
    ]


async def test_recall_expansion_retired_second_hop_blocks_the_whole_path(
    build_harness: Callable[..., Harness],
) -> None:
    """A live first hop cannot carry recall across a retired second hop."""
    from rsc_brain.stores.graph_store import GraphEdge, GraphNode

    harness = build_harness()
    project = await harness.setup_project(unique_slug("age-two-hop"), TOPICS)
    scope = harness.scope(project, allowed_topics=["general"])
    graph = AgeGraphStore(harness.sm)

    query = "two hop graph seed"
    seed_doc, seed_chunk = await _document_with_chunk(harness, project, text=query)
    middle_doc, middle_chunk = await _document_with_chunk(
        harness, project, text="Expired middle document."
    )
    answer_doc, answer_chunk = await _document_with_chunk(
        harness, project, text="The two-hop expansion answer is amber."
    )
    expired = dt.datetime.now(dt.UTC) - dt.timedelta(days=1)
    await _claim(
        harness,
        project,
        text="This seed is expired.",
        chunk_id=seed_chunk,
        document_id=seed_doc,
        valid_to=expired,
    )
    await _claim(
        harness,
        project,
        text="This middle claim is expired.",
        chunk_id=middle_chunk,
        document_id=middle_doc,
        valid_to=expired,
    )
    await _claim(
        harness,
        project,
        text="The two-hop expansion answer is amber.",
        chunk_id=answer_chunk,
        document_id=answer_doc,
    )

    source, middle, target = (str(uuid.uuid4()) for _ in range(3))
    first = GraphEdge(source_id=source, target_id=middle, type="RELATED_TO")
    second = GraphEdge(source_id=middle, target_id=target, type="RELATED_TO")
    await graph.create_graph(scope)
    await graph.upsert_nodes(
        scope,
        [
            GraphNode(id=source, properties={"source_document_id": str(seed_doc)}),
            GraphNode(id=middle, properties={"source_document_id": str(middle_doc)}),
            GraphNode(id=target, properties={"source_document_id": str(answer_doc)}),
        ],
    )
    await graph.upsert_edges(scope, [first, second])
    await graph.set_relations_retired(scope, [second], retired=True)

    retriever = _retriever(
        harness,
        k_hop=2,
        temporal_refill_factor=1,
        hybrid_enabled=False,
    )
    blocked = await retriever.recall(scope, query, top_k=1)
    assert blocked.found is False
    assert blocked.fragments == ()

    await graph.set_relations_retired(scope, [second], retired=False)
    live = await retriever.recall(scope, query, top_k=1)
    assert live.found is True
    assert [fragment.text for fragment in live.fragments] == [
        "The two-hop expansion answer is amber."
    ]


async def test_superseding_a_claim_retires_its_graph_relation(
    build_harness: Callable[..., Harness],
) -> None:
    """A correction supersedes the claim in Postgres; the graph keeps serving the old fact.

    Driven through ``CorrectionService`` and asserted through ``k_hop`` — the real supersede path and a
    real graph read — because the finding is about the two stores disagreeing in production, not about
    a column. A test that set ``valid_to`` by hand would prove nothing: it bypasses every place a fix
    could live.
    """
    from rsc_brain.knowledge.corrections import CorrectionService
    from rsc_brain.stores.graph_store import GraphEdge, GraphNode
    from rsc_brain.stores.relational.knowledge_store import KnowledgeStore

    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["general"])
    graph = AgeGraphStore(harness.sm)

    # The relation as ingest writes it: entity → entity, typed by the predicate, with the claim
    # carrying the same endpoint identities (R16's entity_key).
    sla, hours72 = str(uuid.uuid4()), str(uuid.uuid4())
    old_claim = await _claim(
        harness,
        project,
        text="The SLA is 72 hours.",
        subject_entity_key=sla,
        predicate="is",
        object_entity_key=hours72,
    )
    await graph.create_graph(scope)
    await graph.upsert_nodes(
        scope,
        [
            GraphNode(id=sla, labels=frozenset({"Entity"}), properties={"name": "SLA"}),
            GraphNode(id=hours72, labels=frozenset({"Entity"}), properties={"name": "72 hours"}),
        ],
    )
    await graph.upsert_edges(scope, [GraphEdge(source_id=sla, target_id=hours72, type="is")])

    # An owner corrects it, which supersedes the claim relationally. Ownership is a Person who is
    # RESPONSIBLE_FOR the claim's topic — the same condition `person_owns_any_tag` checks.
    async with harness.sm() as session:
        session.add(
            models.User(
                id=uuid.UUID(scope.principal_id),
                email=f"{unique_slug('o')}@example.test",
                status="active",
                role="member",
            )
        )
        await session.flush()
        session.add(
            models.Person(
                project_id=uuid.UUID(project),
                user_id=uuid.UUID(scope.principal_id),
                name="owner",
                topics=["general"],
            )
        )
        await session.commit()
    service = CorrectionService(
        store=KnowledgeStore(harness.sm), graph=graph, gateway=harness.gateway
    )
    outcome = await service.correct(
        scope, claim_id=old_claim, correction="The SLA is 48 hours.", reason="renegotiated"
    )
    assert outcome.status == "applied", outcome.explanation

    reachable = [node.id for node in await graph.k_hop(scope, [sla], k=1)]
    assert hours72 not in reachable, (
        "the superseded claim's relation is still traversable, so the graph answers with a fact the "
        "relational store has retired and neither store can tell you which is right"
    )

    reverted = await service.revert(scope, outcome.correction_id or "")
    assert reverted.status == "reverted"
    reachable = [node.id for node in await graph.k_hop(scope, [sla], k=1)]
    assert hours72 in reachable, "an open-ended restored claim did not reactivate its relation"


async def test_reverting_an_expired_source_claim_does_not_reactivate_its_relation(
    build_harness: Callable[..., Harness],
) -> None:
    from rsc_brain.knowledge.corrections import CorrectionService
    from rsc_brain.stores.graph_store import GraphEdge, GraphNode
    from rsc_brain.stores.relational.knowledge_store import KnowledgeStore

    harness = build_harness()
    project = await harness.setup_project(unique_slug("bounded"), TOPICS)
    scope = harness.scope(project, allowed_topics=["general"])
    graph = AgeGraphStore(harness.sm)
    source_start = dt.datetime(2023, 1, 1, tzinfo=dt.UTC)
    source_end = dt.datetime(2024, 1, 1, tzinfo=dt.UTC)
    sla, hours72 = str(uuid.uuid4()), str(uuid.uuid4())
    old_claim = await _claim(
        harness,
        project,
        text="The 2023 SLA was 72 hours.",
        valid_from=source_start,
        valid_to=source_end,
        subject_entity_key=sla,
        predicate="is",
        object_entity_key=hours72,
    )
    await graph.create_graph(scope)
    await graph.upsert_nodes(
        scope,
        [
            GraphNode(id=sla, labels=frozenset({"Entity"})),
            GraphNode(id=hours72, labels=frozenset({"Entity"})),
        ],
    )
    await graph.upsert_edges(scope, [GraphEdge(source_id=sla, target_id=hours72, type="is")])
    async with harness.sm() as session:
        principal_id = uuid.UUID(scope.principal_id)
        if await session.get(models.User, principal_id) is None:
            session.add(
                models.User(
                    id=principal_id,
                    email=f"{unique_slug('o')}@example.test",
                    status="active",
                    role="member",
                )
            )
        await session.flush()
        session.add(
            models.Person(
                project_id=uuid.UUID(project),
                user_id=uuid.UUID(scope.principal_id),
                name="owner",
                topics=["general"],
            )
        )
        await session.commit()
    service = CorrectionService(
        store=KnowledgeStore(harness.sm), graph=graph, gateway=harness.gateway
    )

    outcome = await service.correct(
        scope, claim_id=old_claim, correction="The corrected 2023 SLA was 48 hours."
    )
    assert outcome.status == "applied"
    assert hours72 not in [node.id for node in await graph.k_hop(scope, [sla], k=1)]

    reverted = await service.revert(scope, outcome.correction_id or "")

    assert reverted.status == "reverted"
    assert hours72 not in [node.id for node in await graph.k_hop(scope, [sla], k=1)]
    async with harness.sm() as session:
        restored = await session.get(models.Claim, uuid.UUID(old_claim))
        assert restored is not None
        assert restored.valid_from == source_start
        assert restored.valid_to == source_end


async def test_a_relation_two_documents_assert_survives_one_being_superseded(
    build_harness: Callable[..., Harness],
) -> None:
    """Retirement is per-fact, not per-claim.

    Two documents can assert the same relation. Retiring the edge because one of their claims was
    superseded would retract a fact the corpus still holds — the opposite failure, and the reason
    retirement asks whether any live claim still asserts the triple.
    """
    from rsc_brain.knowledge.graph_sync import GraphSync
    from rsc_brain.stores.graph_store import GraphEdge, GraphNode
    from rsc_brain.stores.relational.knowledge_store import KnowledgeStore

    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["general"])
    graph = AgeGraphStore(harness.sm)

    sla, hours48 = str(uuid.uuid4()), str(uuid.uuid4())
    closed = await _claim(
        harness,
        project,
        text="The SLA is 48 hours.",
        valid_to=dt.datetime.now(dt.UTC),
        subject_entity_key=sla,
        predicate="is",
        object_entity_key=hours48,
    )
    await _claim(
        harness,
        project,
        text="The SLA is 48 hours (handbook).",
        subject_entity_key=sla,
        predicate="is",
        object_entity_key=hours48,
    )

    await graph.create_graph(scope)
    await graph.upsert_nodes(
        scope,
        [
            GraphNode(id=sla, labels=frozenset({"Entity"})),
            GraphNode(id=hours48, labels=frozenset({"Entity"})),
        ],
    )
    await graph.upsert_edges(scope, [GraphEdge(source_id=sla, target_id=hours48, type="is")])

    retired = await GraphSync(store=KnowledgeStore(harness.sm), graph=graph).retire_claims(
        scope, [closed]
    )

    assert retired == 0, "retired a relation another live claim still asserts"
    assert hours48 in [node.id for node in await graph.k_hop(scope, [sla], k=1)]


async def test_merging_a_duplicate_does_not_revive_its_retired_relations(
    build_harness: Callable[..., Harness],
) -> None:
    """Merging relinks a duplicate's edges onto the canonical node — retired ones must stay retired.

    Found while reviewing the retirement path rather than in the audit: the relink copied every edge
    the duplicate had, so a superseded fact came back live under a new source id and retirement could
    be undone by an unrelated entity merge.
    """
    from rsc_brain.stores.graph_store import GraphEdge, GraphNode

    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["general"])
    graph = AgeGraphStore(harness.sm)

    canonical, duplicate, target = (str(uuid.uuid4()) for _ in range(3))
    await graph.create_graph(scope)
    await graph.upsert_nodes(
        scope,
        [
            GraphNode(id=canonical, labels=frozenset({"Entity"})),
            GraphNode(id=duplicate, labels=frozenset({"Entity"})),
            GraphNode(id=target, labels=frozenset({"Entity"})),
        ],
    )
    await graph.upsert_edges(scope, [GraphEdge(source_id=duplicate, target_id=target, type="is")])
    await graph.set_relations_retired(
        scope, [GraphEdge(source_id=duplicate, target_id=target, type="is")], retired=True
    )

    await graph.merge_nodes(scope, canonical_id=canonical, duplicate_id=duplicate)

    reachable = [node.id for node in await graph.k_hop(scope, [canonical], k=1)]
    assert target not in reachable, "a merge relinked a retired relation back into the live graph"
