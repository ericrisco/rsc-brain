"""Learning Layer correct_knowledge (SPEC-08 §3.5/3.6, AC 2-6/10) against the real container."""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid
from collections.abc import Callable

import pytest
from sqlalchemy import func, select

from rsc_brain.config.models import RecallConfig
from rsc_brain.export.okf import export_okf_bundle
from rsc_brain.knowledge.corrections import CorrectionService
from rsc_brain.recall.retriever import PgRetriever
from rsc_brain.recall.timeline import build_timeline
from rsc_brain.scope import Principal, PrincipalType, ProjectScope
from rsc_brain.skills.frontmatter import SkillFrontmatter
from rsc_brain.skills.store import SkillStore
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.graph_store import GraphEdge, GraphNode
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.knowledge_store import KnowledgeStore
from rsc_brain.stores.relational.store import PgRelationalStore
from tests.integration.conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("general", 0), ("pricing", 0), ("hr", 3)]


async def _make_user(harness: Harness) -> str:
    user = (
        await PgRelationalStore(harness.sm)
        .users()
        .create_user(email=f"{unique_slug('owner')}@example.com", status="active")
    )
    return user.user_id


async def _make_person(harness: Harness, project: str, user_id: str, topics: list[str]) -> None:
    async with harness.sm() as session:
        session.add(
            models.Person(
                project_id=uuid.UUID(project),
                user_id=uuid.UUID(user_id),
                name="Owner",
                topics=topics,
            )
        )
        await session.commit()


async def _insert_claim(
    harness: Harness,
    project: str,
    *,
    text: str,
    tags: list[str],
    credibility: float,
    valid_from: dt.datetime | None = None,
    valid_to: dt.datetime | None = None,
    chunk_id: uuid.UUID | None = None,
    source_document_id: uuid.UUID | None = None,
    embedding: list[float] | None = None,
    subject_entity_key: str | None = None,
    predicate: str | None = None,
    object_entity_key: str | None = None,
) -> str:
    async with harness.sm() as session:
        claim = models.Claim(
            project_id=uuid.UUID(project),
            chunk_id=chunk_id,
            text=text,
            subject="Acme pricing",
            credibility=credibility,
            tags=tags,
            valid_from=valid_from,
            valid_to=valid_to,
            source_document_id=source_document_id,
            embedding=embedding,
            subject_entity_key=uuid.UUID(subject_entity_key) if subject_entity_key else None,
            predicate=predicate,
            object_entity_key=uuid.UUID(object_entity_key) if object_entity_key else None,
        )
        session.add(claim)
        await session.flush()
        cid = str(claim.id)
        await session.commit()
    return cid


def _scope(
    project: str,
    user_id: str,
    principal_type: PrincipalType = PrincipalType.HUMAN,
    *,
    topics: tuple[str, ...] = ("pricing", "hr"),
) -> ProjectScope:
    """A caller with topic authority over this file's claims.

    A claim outside the caller's topic visibility is neither readable nor mutable and answers exactly
    like a nonexistent one (AUDIT-036 / R06), so a scope with no topic authority would exercise that
    refusal instead of the correction behaviour under test.
    """
    return Principal(id=user_id, type=principal_type, allowed_topics=frozenset(topics)).scope_for(
        project
    )


def _service(harness: Harness) -> CorrectionService:
    return CorrectionService(
        store=KnowledgeStore(harness.sm), graph=AgeGraphStore(harness.sm), gateway=harness.gateway
    )


async def test_owner_correction_supersedes_and_can_revert(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    owner = await _make_user(harness)
    await _make_person(harness, project, owner, ["pricing"])
    claim = await _insert_claim(
        harness, project, text="The price is 100 EUR", tags=["pricing"], credibility=0.6
    )
    store = KnowledgeStore(harness.sm)
    scope = _scope(project, owner)
    async with harness.sm() as session:
        topic_id = await session.scalar(
            select(models.Topic.id).where(
                models.Topic.project_id == uuid.UUID(project), models.Topic.slug == "pricing"
            )
        )
    assert topic_id is not None
    await SkillStore(harness.sm).create(
        scope,
        SkillFrontmatter(
            slug="correction-hook",
            title="Correction hook",
            tags=["pricing"],
            depends_on=[str(topic_id)],
            state="active",
        ),
        "body",
    )

    outcome = await _service(harness).correct(
        scope, claim_id=claim, correction="The price is 120 EUR"
    )
    assert outcome.status == "applied"
    old = await store.get_claim(scope, claim)
    new = await store.get_claim(scope, outcome.new_claim_id or "")
    assert old is not None and old.valid_to is not None and old.credibility == pytest.approx(0.1)
    assert new is not None and new.credibility == pytest.approx(0.9) and "pricing" in new.tags
    assert (await SkillStore(harness.sm).get(scope, "correction-hook")).stale is True  # type: ignore[union-attr]
    async with harness.sm() as session:
        recorded = await session.get(models.Correction, uuid.UUID(outcome.correction_id or ""))
        assert recorded is not None
        assert recorded.target_valid_from_before is None
        assert recorded.target_valid_to_before is None
        assert recorded.validity_snapshot_captured_at is not None

    # Revert restores the old claim (active again, credibility back to 0.6).
    revert = await _service(harness).revert(scope, outcome.correction_id or "")
    assert revert.status == "reverted"
    restored = await store.get_claim(scope, claim)
    assert restored is not None and restored.valid_to is None
    assert restored.credibility == pytest.approx(0.6)


async def test_bounded_source_validity_survives_correction_revert(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("bounded"), TOPICS)
    owner = await _make_user(harness)
    await _make_person(harness, project, owner, ["pricing"])
    source_start = dt.datetime(2023, 1, 1, tzinfo=dt.UTC)
    source_end = dt.datetime(2024, 1, 1, tzinfo=dt.UTC)
    question = "What was the 2023 price?"
    embedding = list((await harness.gateway.embed([question]))[0])
    async with harness.sm() as session:
        document = models.Document(
            project_id=uuid.UUID(project),
            logical_id=unique_slug("bounded-doc"),
            checksum=unique_slug("bounded-sum"),
            status="processed",
            doc_tags=["pricing"],
        )
        session.add(document)
        await session.flush()
        chunk = models.Chunk(
            project_id=uuid.UUID(project),
            document_id=document.id,
            kind="prose",
            text="The 2023 price was 100 EUR",
            tags=["pricing"],
            embedding=embedding,
            needs_review=False,
        )
        session.add(chunk)
        await session.flush()
        document_id, chunk_id = document.id, chunk.id
        await session.commit()
    claim = await _insert_claim(
        harness,
        project,
        text="The 2023 price was 100 EUR",
        tags=["pricing"],
        credibility=0.6,
        valid_from=source_start,
        valid_to=source_end,
        chunk_id=chunk_id,
        source_document_id=document_id,
        embedding=embedding,
    )
    scope = _scope(project, owner)
    service = _service(harness)

    outcome = await service.correct(
        scope,
        claim_id=claim,
        correction="The corrected 2023 price was 120 EUR",
    )
    assert outcome.status == "applied"
    async with harness.sm() as session:
        applied = await session.get(models.Correction, uuid.UUID(outcome.correction_id or ""))
        closed_source = await session.get(models.Claim, uuid.UUID(claim))
        replacement = await session.get(models.Claim, uuid.UUID(outcome.new_claim_id or ""))
        assert applied is not None
        assert closed_source is not None
        assert replacement is not None
        assert applied.target_valid_from_before == source_start
        assert applied.target_valid_to_before == source_end
        assert applied.validity_snapshot_captured_at is not None
        assert applied.lifecycle_error is None
        assert closed_source.valid_to == source_end
        assert replacement.valid_from == applied.validity_snapshot_captured_at
    applied_as_of_2025 = await build_timeline(
        harness.sm, scope, topic="pricing", as_of=dt.date(2025, 1, 1)
    )
    applied_ids = {entry.claim_id for entry in applied_as_of_2025}
    assert claim not in applied_ids
    assert (outcome.new_claim_id or "") not in applied_ids
    retried_new_claim = await KnowledgeStore(harness.sm).apply_owner_correction(
        scope,
        correction_id=outcome.correction_id or "",
        old_claim_id=claim,
        new_text="The corrected 2023 price was 120 EUR",
        new_tags=["pricing"],
        cred_old=0.1,
        cred_new=0.9,
        pending=False,
        final_status="applied",
    )
    assert retried_new_claim == outcome.new_claim_id
    revert = await service.revert(scope, outcome.correction_id or "")

    assert revert.status == "reverted"
    repeated = await service.revert(scope, outcome.correction_id or "")
    assert repeated.status == "reverted"
    async with harness.sm() as session:
        restored = await session.get(models.Claim, uuid.UUID(claim))
        replacement = await session.get(models.Claim, uuid.UUID(outcome.new_claim_id or ""))
        correction = await session.get(models.Correction, uuid.UUID(outcome.correction_id or ""))
        assert restored is not None
        assert replacement is not None
        assert correction is not None
        assert restored.valid_from == source_start
        assert restored.valid_to == source_end
        assert replacement.valid_to is not None
        assert correction.status == "reverted"
        assert str(correction.reverted_by) == owner
        correction_count = await session.scalar(
            select(func.count())
            .select_from(models.Correction)
            .where(models.Correction.project_id == uuid.UUID(project))
        )
        claim_count = await session.scalar(
            select(func.count())
            .select_from(models.Claim)
            .where(models.Claim.project_id == uuid.UUID(project))
        )
        assert correction_count == 1
        assert claim_count == 2

    timeline = await build_timeline(harness.sm, scope, topic="pricing")
    restored_entry = next(entry for entry in timeline if entry.claim_id == claim)
    assert restored_entry.valid_from == source_start.date()
    assert restored_entry.valid_to == source_end.date()
    assert restored_entry.is_current is False

    bundle = await export_okf_bundle(harness.sm, scope)
    claim_entries = bundle["rsc_brain_claims"]
    assert isinstance(claim_entries, list)
    exported = {
        str(entry["rsc_brain_claim_id"])
        for entry in claim_entries
        if isinstance(entry, dict) and "rsc_brain_claim_id" in entry
    }
    assert claim not in exported
    assert (outcome.new_claim_id or "") not in exported

    recall = await PgRetriever(
        sessionmaker=harness.sm,
        gateway=harness.gateway,
        graph_store=AgeGraphStore(harness.sm),
        config=RecallConfig(hybrid_enabled=False, temporal_refill_factor=1),
    ).recall(scope, question, top_k=1)
    assert recall.found is False


@pytest.mark.parametrize("corrupt", ["missing", "inverted"])
async def test_revert_fails_closed_when_validity_snapshot_is_not_restorable(
    build_harness: Callable[..., Harness], corrupt: str
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("corrupt"), TOPICS)
    owner = await _make_user(harness)
    await _make_person(harness, project, owner, ["pricing"])
    subject_key, object_key = str(uuid.uuid4()), str(uuid.uuid4())
    claim = await _insert_claim(
        harness,
        project,
        text="The bounded price was 100 EUR",
        tags=["pricing"],
        credibility=0.6,
        valid_from=dt.datetime(2023, 1, 1, tzinfo=dt.UTC),
        valid_to=dt.datetime(2024, 1, 1, tzinfo=dt.UTC),
        subject_entity_key=subject_key,
        predicate="is",
        object_entity_key=object_key,
    )
    scope = _scope(project, owner)
    graph = AgeGraphStore(harness.sm)
    await graph.create_graph(scope)
    await graph.upsert_nodes(
        scope,
        [
            GraphNode(id=subject_key, labels=frozenset({"Entity"})),
            GraphNode(id=object_key, labels=frozenset({"Entity"})),
        ],
    )
    await graph.upsert_edges(
        scope, [GraphEdge(source_id=subject_key, target_id=object_key, type="is")]
    )
    service = _service(harness)
    outcome = await service.correct(scope, claim_id=claim, correction="Corrected price")
    assert outcome.status == "applied"
    assert object_key not in [node.id for node in await graph.k_hop(scope, [subject_key], k=1)]

    async with harness.sm() as session:
        correction = await session.get(models.Correction, uuid.UUID(outcome.correction_id or ""))
        assert correction is not None
        if corrupt == "missing":
            correction.validity_snapshot_captured_at = None
        else:
            correction.target_valid_from_before = dt.datetime(2025, 1, 1, tzinfo=dt.UTC)
            correction.target_valid_to_before = dt.datetime(2024, 1, 1, tzinfo=dt.UTC)
        await session.commit()

    async with harness.sm() as session:
        old_before = await session.get(models.Claim, uuid.UUID(claim))
        new_before = await session.get(models.Claim, uuid.UUID(outcome.new_claim_id or ""))
        assert old_before is not None and new_before is not None
        old_state = (old_before.valid_from, old_before.valid_to, float(old_before.credibility))
        new_state = (new_before.valid_from, new_before.valid_to, new_before.pending_confirmation)

    reverted = await service.revert(scope, outcome.correction_id or "")

    assert reverted.status == "rejected"
    assert reverted.explanation == "Correction cannot be safely reverted."
    async with harness.sm() as session:
        old_after = await session.get(models.Claim, uuid.UUID(claim))
        new_after = await session.get(models.Claim, uuid.UUID(outcome.new_claim_id or ""))
        failed = await session.get(models.Correction, uuid.UUID(outcome.correction_id or ""))
        assert old_after is not None and new_after is not None and failed is not None
        assert (old_after.valid_from, old_after.valid_to, float(old_after.credibility)) == old_state
        assert (
            new_after.valid_from,
            new_after.valid_to,
            new_after.pending_confirmation,
        ) == new_state
        assert failed.status == "revert_failed"
        assert failed.lifecycle_error == f"invalid_validity_snapshot:{corrupt}"
    feed = await KnowledgeStore(harness.sm).list_corrections(scope, target_claim=claim)
    assert feed[0]["lifecycle_error"] == f"invalid_validity_snapshot:{corrupt}"
    assert object_key not in [node.id for node in await graph.k_hop(scope, [subject_key], k=1)]


async def test_concurrent_identical_corrections_share_one_live_replacement(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("concurrent"), TOPICS)
    owner = await _make_user(harness)
    await _make_person(harness, project, owner, ["pricing"])
    claim = await _insert_claim(
        harness, project, text="The price is 100 EUR", tags=["pricing"], credibility=0.6
    )
    scope = _scope(project, owner)
    service = _service(harness)

    first, second = await asyncio.gather(
        service.correct(scope, claim_id=claim, correction="The price is 120 EUR"),
        service.correct(scope, claim_id=claim, correction="The price is 120 EUR"),
    )

    assert first.status == second.status == "applied"
    assert first.correction_id == second.correction_id
    assert first.new_claim_id == second.new_claim_id
    async with harness.sm() as session:
        claims = list(
            await session.scalars(
                select(models.Claim).where(models.Claim.project_id == uuid.UUID(project))
            )
        )
        corrections = list(
            await session.scalars(
                select(models.Correction).where(models.Correction.project_id == uuid.UUID(project))
            )
        )
    assert len(claims) == 2
    assert sum(claim_row.valid_to is None for claim_row in claims) == 1
    assert sorted(correction.status for correction in corrections) == ["applied", "duplicate"]
    duplicate = next(correction for correction in corrections if correction.status == "duplicate")
    assert duplicate.lifecycle_error == f"active_correction:{first.correction_id}"


async def test_future_source_claim_is_not_closed_into_an_inverted_interval(
    build_harness: Callable[..., Harness],
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("future"), TOPICS)
    owner = await _make_user(harness)
    await _make_person(harness, project, owner, ["pricing"])
    starts_later = dt.datetime.now(dt.UTC) + dt.timedelta(days=1)
    claim = await _insert_claim(
        harness,
        project,
        text="The future price is 100 EUR",
        tags=["pricing"],
        credibility=0.6,
        valid_from=starts_later,
    )
    scope = _scope(project, owner)

    outcome = await _service(harness).correct(
        scope, claim_id=claim, correction="The future price is 120 EUR"
    )

    assert outcome.status == "rejected"
    assert outcome.explanation == "Claim cannot be corrected in its current lifecycle state."
    async with harness.sm() as session:
        unchanged = await session.get(models.Claim, uuid.UUID(claim))
        refused = await session.get(models.Correction, uuid.UUID(outcome.correction_id or ""))
        claim_count = await session.scalar(
            select(func.count())
            .select_from(models.Claim)
            .where(models.Claim.project_id == uuid.UUID(project))
        )
        assert unchanged is not None and refused is not None
        assert unchanged.valid_from == starts_later
        assert unchanged.valid_to is None
        assert refused.status == "apply_failed"
        assert refused.lifecycle_error == "target_validity:not_yet_effective"
        assert claim_count == 1


async def test_retry_after_graph_failure_converges_the_committed_correction(
    build_harness: Callable[..., Harness], monkeypatch: pytest.MonkeyPatch
) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("graph-retry"), TOPICS)
    owner = await _make_user(harness)
    await _make_person(harness, project, owner, ["pricing"])
    claim = await _insert_claim(
        harness, project, text="The price is 100 EUR", tags=["pricing"], credibility=0.6
    )
    scope = _scope(project, owner)
    service = _service(harness)
    write_edges = service._write_correction_edges

    async def unavailable_graph(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("AGE unavailable after relational commit")

    monkeypatch.setattr(service, "_write_correction_edges", unavailable_graph)
    with pytest.raises(RuntimeError, match="AGE unavailable"):
        await service.correct(scope, claim_id=claim, correction="The price is 120 EUR")

    async with harness.sm() as session:
        committed = await session.scalar(
            select(models.Correction).where(
                models.Correction.project_id == uuid.UUID(project),
                models.Correction.status == "applied",
            )
        )
        assert committed is not None and committed.new_claim is not None
        committed_id, replacement_id = str(committed.id), str(committed.new_claim)

    monkeypatch.setattr(service, "_write_correction_edges", write_edges)
    retried = await service.correct(scope, claim_id=claim, correction="The price is 120 EUR")

    assert retried.status == "applied"
    assert retried.correction_id == committed_id
    assert retried.new_claim_id == replacement_id
    async with harness.sm() as session:
        claims = list(
            await session.scalars(
                select(models.Claim).where(models.Claim.project_id == uuid.UUID(project))
            )
        )
        corrections = list(
            await session.scalars(
                select(models.Correction).where(models.Correction.project_id == uuid.UUID(project))
            )
        )
    assert len(claims) == 2
    assert sum(claim_row.valid_to is None for claim_row in claims) == 1
    assert sorted(correction.status for correction in corrections) == ["applied", "duplicate"]


async def test_non_owner_is_routed(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    stranger = await _make_user(harness)  # no Person → owns nothing
    claim = await _insert_claim(
        harness, project, text="The price is 100 EUR", tags=["pricing"], credibility=0.6
    )
    scope = _scope(project, stranger)
    outcome = await _service(harness).correct(scope, claim_id=claim, correction="wrong")
    assert outcome.status == "routed_to_owner"
    # Nothing changed.
    unchanged = await KnowledgeStore(harness.sm).get_claim(scope, claim)
    assert unchanged is not None and unchanged.valid_to is None and unchanged.credibility == 0.6


async def test_agent_never_corrects(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    owner = await _make_user(harness)
    await _make_person(harness, project, owner, ["pricing"])  # even a would-be owner agent
    claim = await _insert_claim(
        harness, project, text="The price is 100 EUR", tags=["pricing"], credibility=0.6
    )
    agent_scope = _scope(project, owner, PrincipalType.AGENT)
    outcome = await _service(harness).correct(agent_scope, claim_id=claim, correction="x")
    assert outcome.status == "routed_to_owner"
    unchanged = await KnowledgeStore(harness.sm).get_claim(agent_scope, claim)
    assert unchanged is not None and unchanged.valid_to is None


async def test_sensitive_correction_pends(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    owner = await _make_user(harness)
    await _make_person(harness, project, owner, ["hr"])
    claim = await _insert_claim(
        harness, project, text="Salary band is B", tags=["hr"], credibility=0.6
    )
    scope = _scope(project, owner)
    outcome = await _service(harness).correct(scope, claim_id=claim, correction="Salary band is C")
    assert outcome.status == "pending_confirmation"
    # The old (sensitive) claim is NOT superseded until a second owner confirms.
    old = await KnowledgeStore(harness.sm).get_claim(scope, claim)
    assert old is not None and old.valid_to is None
    async with harness.sm() as session:
        new = await session.get(models.Claim, uuid.UUID(outcome.new_claim_id or ""))
        assert new is not None and new.pending_confirmation is True


async def test_dry_run_mutates_nothing(build_harness: Callable[..., Harness]) -> None:
    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    owner = await _make_user(harness)
    await _make_person(harness, project, owner, ["pricing"])
    claim = await _insert_claim(
        harness, project, text="The price is 100 EUR", tags=["pricing"], credibility=0.6
    )
    scope = _scope(project, owner)
    outcome = await _service(harness).correct(
        scope, claim_id=claim, correction="The price is 120 EUR", dry_run=True
    )
    assert outcome.status == "applied" and "dry-run" in outcome.explanation
    unchanged = await KnowledgeStore(harness.sm).get_claim(scope, claim)
    assert unchanged is not None and unchanged.valid_to is None and unchanged.credibility == 0.6
