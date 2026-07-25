"""Concurrency and multi-store integrity (AUDIT-021/014/036/040/032/039 — R29, R30, R32-R35).

Every check here runs the SAME operation twice at once against the real container, or interrupts it
between its stores, because that is the only way these findings are observable: each one is a
read-then-write, a ``max+1``, or a sequence of commits that is correct whenever it happens to run alone.

A barrier test that merely calls twice in a row proves nothing — the second call sees the first one's
committed effect and behaves. These use ``asyncio.gather`` over separate sessions so both callers read
the same state before either writes, which is what a second worker process does.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid
from collections.abc import Callable
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select

from rsc_brain.config.models import CapabilitiesConfig, CapabilityConfig
from rsc_brain.stores.relational import models

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("hr", 0)]


def _capabilities(**overrides: CapabilityConfig) -> CapabilitiesConfig:
    """A complete capabilities config — all five are required — with the one under test overridden."""
    base = {
        name: CapabilityConfig(provider="test", model="m")
        for name in ("extractor", "judge", "topicalizer", "reranker")
    }
    base["embedder"] = CapabilityConfig(provider="test", model="bge-m3")
    base.update(overrides)
    return CapabilitiesConfig(**base)


def _barrier_after(monkeypatch: pytest.MonkeyPatch, owner: type, method: str, parties: int) -> None:
    """Make every caller of ``owner.method`` finish reading before any of them may continue.

    Without this, `asyncio.gather` is not a race: both coroutines run on one thread and the first one
    usually commits before the second one reads, so a read-then-write bug behaves. The barrier holds
    each caller at the point where it has READ and not yet WRITTEN — which is exactly the interleaving a
    second worker process produces, and the only state in which these findings are observable.
    """
    original = getattr(owner, method)
    barrier = asyncio.Barrier(parties)

    async def wrapped(*args: object, **kwargs: object) -> object:
        result = await original(*args, **kwargs)
        await barrier.wait()
        return result

    monkeypatch.setattr(owner, method, wrapped)


async def _seed_claim(harness: Harness, project: str, text: str, credibility: float = 0.9) -> str:
    async with harness.sm() as session:
        claim = models.Claim(
            project_id=uuid.UUID(project),
            text=text,
            tags=["hr"],
            credibility=credibility,
        )
        session.add(claim)
        await session.flush()
        claim_id = str(claim.id)
        await session.commit()
    return claim_id


# --------------------------------------------------------------------------- #
# R30 — admission and version allocation under a race
# --------------------------------------------------------------------------- #


async def test_two_concurrent_ingests_of_the_same_bytes_return_one_document(
    build_harness: Callable[..., Harness],
) -> None:
    """``ingest_bytes`` reads by checksum, decides, then inserts — in that order, not atomically.

    Two callers uploading the same file therefore both see "not present" and both insert. The unique
    constraint stops the duplicate row, so the loser gets a raw ``IntegrityError`` out of the ingest
    API — a 500 on a request whose correct answer is "you already have this document" — and the blob it
    wrote stays on disk with no row referencing it.
    """
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["hr"])
    await harness.repo.create_source(
        scope, name="manual", type_="folder", policy="manual", default_tags=["hr"]
    )
    payload = b"# Handbook\n\nThe SLA is 48 hours.\n"

    results = await asyncio.gather(
        harness.service.ingest_bytes(scope, payload, filename="hb.md", source="manual", run=False),
        harness.service.ingest_bytes(scope, payload, filename="hb.md", source="manual", run=False),
        return_exceptions=True,
    )

    failures = [r for r in results if isinstance(r, BaseException)]
    assert not failures, f"a concurrent duplicate upload raised instead of answering: {failures}"
    ids = {r.document_id for r in results if not isinstance(r, BaseException)}
    assert len(ids) == 1, f"the same bytes produced {len(ids)} documents: {ids}"
    assert any(getattr(r, "duplicate", False) for r in results), (
        "neither caller was told the document already existed"
    )


async def test_two_concurrent_versions_of_one_logical_document_get_distinct_versions(
    build_harness: Callable[..., Harness], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The version is chosen with ``max(version) + 1`` read outside the insert.

    Two different revisions of the same logical document uploaded at once therefore both read the same
    maximum and both claim it. Nothing in the schema forbids it, so the corpus ends up with two rows
    that are each "version 2" and the version stops ordering anything — including which prior version
    the next ingest supersedes.
    """
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["hr"])
    await harness.repo.create_source(
        scope, name="manual", type_="folder", policy="manual", default_tags=["hr"]
    )
    await harness.service.ingest_bytes(
        scope, b"v1", filename="handbook.md", source="manual", run=False
    )
    from rsc_brain.stores.relational.ingest_repository import IngestRepository

    _barrier_after(monkeypatch, IngestRepository, "latest_version_for_logical_id", 2)

    await asyncio.gather(
        harness.service.ingest_bytes(
            scope, b"v2-a", filename="handbook.md", source="manual", run=False
        ),
        harness.service.ingest_bytes(
            scope, b"v2-b", filename="handbook.md", source="manual", run=False
        ),
        return_exceptions=True,
    )

    async with harness.sm() as session:
        versions = (
            await session.scalars(
                select(models.Document.version).where(
                    models.Document.project_id == uuid.UUID(project),
                    models.Document.logical_id == "handbook",
                )
            )
        ).all()
    assert len(versions) == len(set(versions)), (
        f"two versions of one logical document collided: {sorted(versions)}"
    )


# --------------------------------------------------------------------------- #
# R32 — the ledger owns the side effects
# --------------------------------------------------------------------------- #


async def test_one_idempotency_key_writes_one_claim_under_a_race(
    build_harness: Callable[..., Harness], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The idempotency row is written AFTER the claim, so it cannot claim the key.

    Two retries of the same submission (a client that did not get its answer, or two workers draining
    one queue) both find no prior row, both do the work, and the corpus gets the same fact twice with
    two ids — which then corroborate each other, raising the credibility of a single assertion.
    """
    from rsc_brain.knowledge.agent_writes import AgentWriteService

    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["hr"])
    service = AgentWriteService(harness.sm, gateway=harness.gateway)
    key = f"key-{uuid.uuid4().hex[:8]}"
    # `_policy` is awaited immediately after the prior-ledger lookup and before anything is written,
    # so holding both callers there is precisely "both have read, neither has written".
    _barrier_after(monkeypatch, AgentWriteService, "_policy", 2)

    results = await asyncio.gather(
        service.submit(scope, text="The SLA is 48 hours.", tags=["hr"], idempotency_key=key),
        service.submit(scope, text="The SLA is 48 hours.", tags=["hr"], idempotency_key=key),
        return_exceptions=True,
    )

    async with harness.sm() as session:
        claims = await session.scalar(
            select(func.count())
            .select_from(models.Claim)
            .where(
                models.Claim.project_id == uuid.UUID(project),
                models.Claim.text == "The SLA is 48 hours.",
            )
        )
    failures = [r for r in results if isinstance(r, BaseException)]
    # Asserted first: without it this check passes whenever the losing retry simply crashed, which is
    # its own bug (a raw IntegrityError out of a retry-safe API) and hides the duplicate it was meant
    # to catch.
    assert not failures, f"a retry with the same idempotency key raised: {failures}"
    assert claims == 1, f"one idempotency key produced {claims} claims"
    ids = {tuple(r.claim_ids) for r in results if not isinstance(r, BaseException)}
    assert len(ids) == 1, f"the two retries returned different claim ids: {ids}"


# --------------------------------------------------------------------------- #
# R33 — the feedback cap is consumed atomically
# --------------------------------------------------------------------------- #


async def test_concurrent_feedback_cannot_exceed_the_daily_cap(
    build_harness: Callable[..., Harness], monkeypatch: pytest.MonkeyPatch
) -> None:
    """``feedback_budget_remaining`` and ``apply_feedback`` are separate transactions.

    So N sessions synchronised on the same remaining budget each apply a full delta, and the daily cap
    — the guard that stops an agent from grinding a claim's credibility down — is exceeded by a factor
    of N. The cap exists precisely for a caller that repeats.
    """
    from rsc_brain.config.models import KnowledgeConfig
    from rsc_brain.knowledge.feedback import apply_report_feedback
    from rsc_brain.stores.relational.knowledge_store import KnowledgeStore

    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["hr"])
    claim_id = await _seed_claim(harness, project, "The SLA is 48 hours.")
    store = KnowledgeStore(harness.sm)
    config = KnowledgeConfig()
    day = dt.date(2026, 3, 1)
    _barrier_after(monkeypatch, KnowledgeStore, "feedback_budget_remaining", 6)

    await asyncio.gather(
        *(
            apply_report_feedback(
                store, scope, claim_ids=[claim_id], signal="wrong", config=config, day=day
            )
            for _ in range(6)
        ),
        return_exceptions=True,
    )

    async with harness.sm() as session:
        impact = await session.scalar(
            select(models.FeedbackDailyImpact.impact).where(
                models.FeedbackDailyImpact.project_id == uuid.UUID(project),
                models.FeedbackDailyImpact.claim_id == uuid.UUID(claim_id),
                models.FeedbackDailyImpact.day == day,
            )
        )
    assert impact is not None
    assert float(impact) <= config.feedback_daily_cap + 1e-9, (
        f"six concurrent signals consumed {float(impact)} of a {config.feedback_daily_cap} daily cap"
    )


# --------------------------------------------------------------------------- #
# R34 — ontology versions are unique and exactly one is active
# --------------------------------------------------------------------------- #


async def test_concurrent_ontology_uploads_leave_one_active_version(
    build_harness: Callable[..., Harness], monkeypatch: pytest.MonkeyPatch
) -> None:
    """``max(version) + 1`` again, plus no unique index and no "one active" constraint.

    Two uploads of the same ontology name at once therefore produce two rows with the same version,
    both active — and which one the recall path anchors entities against becomes whichever the planner
    returns first.
    """
    from rsc_brain.ontology.store import OntologyStore

    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["hr"])
    store = OntologyStore(harness.sm)
    turtle_a = "@prefix ex: <http://example.test/> .\nex:A a ex:Thing .\n"
    turtle_b = "@prefix ex: <http://example.test/> .\nex:B a ex:Thing .\n"

    await asyncio.gather(
        store.add(scope, name="core", content=turtle_a, fmt="turtle"),
        store.add(scope, name="core", content=turtle_b, fmt="turtle"),
        return_exceptions=True,
    )

    async with harness.sm() as session:
        rows = (
            await session.execute(
                select(models.Ontology.version, models.Ontology.active).where(
                    models.Ontology.project_id == uuid.UUID(project),
                    models.Ontology.name == "core",
                )
            )
        ).all()
    versions = [r[0] for r in rows]
    active = [r for r in rows if r[1]]
    assert len(versions) == len(set(versions)), f"two ontologies share a version: {versions}"
    assert len(active) == 1, f"{len(active)} ontology versions are active at once"


# --------------------------------------------------------------------------- #
# R35 — no visible partial state across the two stores
# --------------------------------------------------------------------------- #


async def test_a_failure_writing_the_graph_leaves_no_committed_claims(
    build_harness: Callable[..., Harness],
    make_completion: Callable[..., object],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Publish commits the relational work, then writes the graph in separate transactions.

    A failure in between — a lost connection, a restarted pod, an AGE error — leaves claims live in
    Postgres with no relations in the graph. Both stores are readable, they disagree, nothing records
    which half happened, and recall and graph expansion answer differently about that document forever.

    The control ingest comes first: without it, "no claims were committed" is also what an ingest that
    produced no claims at all looks like, and the check would pass while proving nothing.
    """
    from rsc_brain.stores.age_graph_store import AgeGraphStore

    harness = build_harness(
        completion=make_completion(
            claims=[
                {
                    "text": "Ana Ruiz owns payroll approvals.",
                    "subject": "Ana Ruiz",
                    "predicate": "owns",
                    "object": "payroll approvals",
                }
            ],
            tags=["hr"],
        )
    )
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["hr"])
    await harness.repo.create_source(
        scope, name="auto", type_="folder", policy="source_tags", default_tags=["hr"]
    )
    body = b"# Handbook\n\nAna Ruiz owns payroll approvals at Acme.\n"

    control = await harness.service.ingest_bytes(scope, body, filename="control.md", source="auto")
    async with harness.sm() as session:
        produced = await session.scalar(
            select(func.count())
            .select_from(models.Claim)
            .where(models.Claim.source_document_id == uuid.UUID(control.document_id))
        )
    assert produced, "this document produces no claims, so the check below would be vacuous"

    async def explode(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("the graph connection died between the two stores")

    # `create_graph` is on every publish path, so the interruption does not depend on what the
    # extraction happened to return.
    monkeypatch.setattr(AgeGraphStore, "create_graph", explode)
    interrupted = await harness.service.ingest_bytes(
        scope, body + b"\nSecond revision.\n", filename="interrupted.md", source="auto", run=False
    )
    with pytest.raises(RuntimeError):
        await harness.pipeline.process(scope, interrupted.document_id)

    async with harness.sm() as session:
        claims = await session.scalar(
            select(func.count())
            .select_from(models.Claim)
            .where(models.Claim.source_document_id == uuid.UUID(interrupted.document_id))
        )
        document = await session.get(models.Document, uuid.UUID(interrupted.document_id))
    assert document is not None
    assert claims == 0, (
        f"{claims} claims are committed for a document whose graph write failed, so the two stores "
        "disagree with nothing recording which half happened"
    )
    assert document.status != "processed", (
        "the document is marked published even though its graph half never happened"
    )


async def test_a_merge_that_fails_in_the_graph_does_not_half_merge(
    build_harness: Callable[..., Harness], monkeypatch: pytest.MonkeyPatch
) -> None:
    """``_apply`` merges relationally, re-points graph edges, then resolves the proposal.

    A failure at the graph step leaves the duplicate entity tombstoned in Postgres, its edges still on
    the duplicate node in AGE, and the proposal still open — so a curator is asked again to decide a
    merge that has already half happened.
    """
    from rsc_brain.config.models import KnowledgeConfig
    from rsc_brain.knowledge.entity_merge import DeterministicMergeProposer, EntityMergeService
    from rsc_brain.stores.age_graph_store import AgeGraphStore
    from rsc_brain.stores.relational.entity_store import EntityStore

    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["hr"])
    async with harness.sm() as session:
        for name in ("Acme Corporation", "Acme Corporaton"):
            session.add(
                models.Entity(
                    project_id=uuid.UUID(project),
                    name=name,
                    normalized_name=name.casefold(),
                    type="org",
                )
            )
        await session.commit()
    service = EntityMergeService(
        store=EntityStore(harness.sm),
        graph=AgeGraphStore(harness.sm),
        proposer=DeterministicMergeProposer(min_similarity=0.82),
        sessionmaker=harness.sm,
        config=KnowledgeConfig(merge_auto_apply_confidence=1.0),
    )
    summary = await service.propose(scope)
    assert summary.queued

    async def explode(*_args: object, **_kwargs: object) -> int:
        raise RuntimeError("the graph connection died mid-merge")

    monkeypatch.setattr(AgeGraphStore, "merge_nodes", explode)
    with pytest.raises(RuntimeError):
        await service.confirm(scope, summary.queued[0])

    async with harness.sm() as session:
        merged = await session.scalar(
            select(func.count())
            .select_from(models.Entity)
            .where(
                models.Entity.project_id == uuid.UUID(project),
                models.Entity.merged_into.is_not(None),
            )
        )
    assert merged == 0, (
        "an entity is tombstoned as merged in Postgres while its graph identity was never merged"
    )


# --------------------------------------------------------------------------- #
# R29 — every attempt is reserved and reconciled
# --------------------------------------------------------------------------- #


async def test_a_daily_token_budget_is_not_exceeded_by_concurrent_attempts(
    build_harness: Callable[..., Harness],
) -> None:
    """The budget was checked, then the call happened, then the spend was recorded.

    Every concurrent attempt therefore passed the same check and spent anyway, so the ceiling could be
    crossed by as many attempts as happened to be in flight. A budget that only holds when requests
    arrive one at a time is not a budget — the busy case is the one it exists for.

    The four attempts genuinely overlap: the fake provider yields for a moment, so all four are inside
    their call before any returns, which is what makes this a race rather than four sequential calls. A
    barrier would be tighter and would also deadlock — a refused attempt never reaches the provider, so
    the survivors would wait forever for parties that are never coming.
    """
    from rsc_brain.config.models import Capability
    from rsc_brain.gateway.model_gateway import ModelGateway
    from rsc_brain.gateway.usage import BudgetExceededError, PgUsageRecorder

    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    capability = Capability.TOPICALIZER
    caps = _capabilities(
        topicalizer=CapabilityConfig(provider="test", model="m", daily_token_budget=100)
    )

    def _response(tokens: int) -> SimpleNamespace:
        """Shaped like a LiteLLM response: attribute access plus a usage block reporting tokens."""
        message = SimpleNamespace(content="ok")
        return SimpleNamespace(
            choices=[SimpleNamespace(message=message)], usage={"total_tokens": tokens}
        )

    async def completion(**_kwargs: object) -> object:
        await asyncio.sleep(0.05)  # long enough that all four hold their budget at once
        return _response(60)

    gateway = ModelGateway(
        caps, completion_fn=completion, usage_recorder=PgUsageRecorder(harness.sm, caps)
    ).for_project(project)

    async def attempt() -> str:
        return await gateway.complete(capability, [{"role": "user", "content": "hi"}])

    outcomes = await asyncio.gather(*(attempt() for _ in range(4)), return_exceptions=True)
    refused = [o for o in outcomes if isinstance(o, BudgetExceededError)]

    async with harness.sm() as session:
        spent = await session.scalar(
            select(func.sum(models.TokenUsage.tokens)).where(
                models.TokenUsage.project_id == uuid.UUID(project),
                models.TokenUsage.capability == str(capability),
            )
        )
    assert refused, "four overlapping attempts all passed one budget check"
    assert int(spent or 0) <= 100 + 60, (
        f"{int(spent or 0)} tokens were spent against a 100-token daily budget"
    )


async def test_a_structured_completion_records_the_tokens_it_actually_spent(
    build_harness: Callable[..., Harness],
) -> None:
    """Structured completions record ``tokens=0``.

    That is most of the product's model traffic — every extraction, topicalization and judge call — so
    the budget those capabilities are configured with can never be reached, and a usage report shows a
    busy project spending nothing. A repair round and a fallback attempt are invisible for the same
    reason: only the successful call is counted, and it is counted as zero.
    """
    from pydantic import BaseModel

    from rsc_brain.config.models import Capability
    from rsc_brain.gateway.model_gateway import ModelGateway
    from rsc_brain.gateway.usage import PgUsageRecorder

    class Shape(BaseModel):
        value: str

    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    capability = Capability.TOPICALIZER
    caps = _capabilities()

    async def completion(**_kwargs: object) -> object:
        message = SimpleNamespace(content='{"value": "ok"}')
        return SimpleNamespace(
            choices=[SimpleNamespace(message=message)], usage={"total_tokens": 77}
        )

    gateway = ModelGateway(
        caps,
        completion_fn=completion,
        usage_recorder=PgUsageRecorder(harness.sm, caps),
    ).for_project(project)

    await gateway.complete_structured(capability, [{"role": "user", "content": "hi"}], Shape)

    async with harness.sm() as session:
        spent = await session.scalar(
            select(func.sum(models.TokenUsage.tokens)).where(
                models.TokenUsage.project_id == uuid.UUID(project),
                models.TokenUsage.capability == str(capability),
            )
        )
    assert int(spent or 0) == 77, (
        f"a structured completion that spent 77 tokens was recorded as {int(spent or 0)}"
    )


async def test_the_operator_can_ask_whether_the_two_stores_agree(
    build_harness: Callable[..., Harness], make_completion: Callable[..., object]
) -> None:
    """Atomic writes mean a divergence cannot be introduced; they do not mean there is none.

    An install upgraded from an earlier version, a manual repair, a partial restore or a future bug can
    all leave the stores saying different things, and until now nobody could ask. R17 established the
    pattern for the relational side; this is the two-store half.

    Asserted by introducing a divergence the way reality would — retiring the graph relation behind the
    store's back — and checking the report notices. A report that only ever says "fine" is not evidence.
    """
    from rsc_brain.stores.age_graph_store import AgeGraphStore
    from rsc_brain.stores.multistore_integrity import divergence_report

    harness = build_harness(
        completion=make_completion(
            claims=[
                {
                    "text": "Ana Ruiz owns payroll approvals.",
                    "subject": "Ana Ruiz",
                    "predicate": "owns",
                    "object": "payroll approvals",
                }
            ],
            entities=[
                {"name": "Ana Ruiz", "type": "person"},
                {"name": "payroll approvals", "type": "concept"},
            ],
            relations=[{"subject": "Ana Ruiz", "predicate": "owns", "object": "payroll approvals"}],
            tags=["hr"],
        )
    )
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["hr"])
    await harness.repo.create_source(
        scope, name="auto", type_="folder", policy="source_tags", default_tags=["hr"]
    )
    outcome = await harness.service.ingest_bytes(
        scope,
        b"# Handbook\n\nAna Ruiz owns payroll approvals at Acme.\n",
        filename="hb.md",
        source="auto",
    )
    assert outcome.status == "processed", outcome.status

    clean = await divergence_report(harness.sm, scope)
    assert not clean.diverged, clean.explain()

    # Introduce the divergence the way a partial restore or an older version would: the claim stays
    # live relationally and its relation stops being current in the graph.
    async with harness.sm() as session:
        keys = (
            await session.execute(
                select(
                    models.Claim.subject_entity_key,
                    models.Claim.predicate,
                    models.Claim.object_entity_key,
                ).where(
                    models.Claim.project_id == uuid.UUID(project),
                    models.Claim.subject_entity_key.is_not(None),
                )
            )
        ).all()
    assert keys, "this ingest wrote no relation-bearing claims, so the check below is vacuous"
    from rsc_brain.stores.age_graph_store import edge_type
    from rsc_brain.stores.graph_store import GraphEdge

    subject, predicate, obj = keys[0]
    await AgeGraphStore(harness.sm).set_relations_retired(
        scope,
        [GraphEdge(source_id=str(subject), target_id=str(obj), type=edge_type(str(predicate)))],
        retired=True,
    )

    diverged = await divergence_report(harness.sm, scope)
    assert diverged.claims_without_relations >= 1, diverged.explain()
    assert diverged.examples, "the report says the stores disagree without saying where"
