"""Document versioning + chunk-level claim diff against the real container (SPEC-09 D6).

Covers the AC set: a re-upload with the same logical id + new checksum becomes a new version
(history kept); an unchanged chunk's claims are re-asserted WITHOUT re-extraction (0 LLM calls);
the prior version's claims are superseded (valid_to); a changed/new chunk is extracted fresh; a
byte-identical re-upload is a no-op. Reused claims keep the prior credibility (continuity).
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from typing import Any, cast

import pytest
from sqlalchemy import select, text, update

from rsc_brain.ingest.extractor import CascadeExtractor
from rsc_brain.ingest.pipeline import PriorVersionNotProcessedError
from rsc_brain.ingest.types import DocStatus
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational import models
from tests.conftest import completion_response

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("general", 0)]
# Each section is its own chunk (the chunker groups by heading). Between versions: Alpha is
# unchanged (reused, id+cred preserved), Beta's body changes (old superseded, new extracted),
# and Gamma is added (new). This exercises reuse + supersede + fresh-extract in one document.
V1 = (
    b"# Alpha\n\nAlpha section defines the alpha policy.\n\n"
    b"# Beta\n\nBeta section defines the original beta policy.\n"
)
V2 = (
    b"# Alpha\n\nAlpha section defines the alpha policy.\n\n"
    b"# Beta\n\nBeta section defines the REVISED beta policy.\n\n"
    b"# Gamma\n\nGamma section defines the gamma policy.\n"
)
MIXED_V1 = b"# Policy\n\nThe SLA is 24 hours. Escalation is owned by Ana. Keep audit logs.\n"
MIXED_V2 = (
    b"# Policy\n\nThe SLA is 48 hours. Escalation is owned by Ana. Keep audit logs. Notify Luis.\n"
)


def _completion(make_completion: Callable[..., object]) -> object:
    return make_completion(
        entities=[{"name": "Acme", "type": "org", "aliases": []}],
        claims=[{"text": "fact", "subject": "Acme", "predicate": "is", "object": "x"}],
        tags=["general"],
    )


async def _claims(harness: Harness, project_id: str) -> list[dict[str, object]]:
    """Every claim in the project with its chunk text, credibility and active flag."""
    async with harness.sm() as session:
        rows = await session.execute(
            select(
                models.Claim.id,
                models.Chunk.text,
                models.Claim.credibility,
                models.Claim.valid_to,
                models.Claim.source_document_id,
            )
            .join(models.Chunk, models.Claim.chunk_id == models.Chunk.id)
            .where(models.Claim.project_id == uuid.UUID(project_id))
        )
        return [
            {
                "id": str(cid),
                "text": text,
                "cred": float(cred),
                "active": valid_to is None,
                "doc": str(doc),
            }
            for cid, text, cred, valid_to, doc in rows
        ]


async def _ingest_and_approve(harness: Harness, scope: ProjectScope, data: bytes) -> str:
    outcome = await harness.service.ingest_bytes(
        scope, data, filename="policy.md", source="manual-src"
    )
    if outcome.status != DocStatus.PROCESSED.value:
        await harness.service.approve(scope, outcome.document_id, approver="cli")
    return outcome.document_id


async def test_new_version_reuses_unchanged_chunks_without_re_extraction(
    build_harness: Callable[..., Harness],
    make_completion: Callable[..., object],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    harness = build_harness(completion=_completion(make_completion))
    project = await harness.setup_project(unique_slug("ver"), TOPICS)
    scope = harness.scope(project, allowed_topics=["general"])
    await harness.repo.create_source(scope, name="manual-src", type_="folder", policy="manual")

    v1_doc = await _ingest_and_approve(harness, scope, V1)
    v1 = await harness.repo.get_document(scope, v1_doc)
    assert v1 is not None and v1.version == 1

    # Give the v1 claims a distinctive credibility so we can prove the unchanged one is preserved.
    async with harness.sm() as session:
        await session.execute(
            update(models.Claim)
            .where(models.Claim.source_document_id == uuid.UUID(v1_doc))
            .values(credibility=0.77)
        )
        await session.commit()
    before = await _claims(harness, project)
    alpha_v1 = next(c for c in before if "alpha policy" in str(c["text"]))

    # Spy on the extractor from here on: only v2's changed/new sections should reach it.
    #
    # Patched on the CLASS, not on a pipeline attribute: the pipeline builds its extractor per stage
    # so that each one carries a gateway whose token accounting is bound to the project it is running
    # for (AUDIT-021 / R12), so there is no long-lived instance to attach a spy to.
    extracted: list[str] = []
    original = CascadeExtractor.extract

    async def _spy(self: CascadeExtractor, text: str) -> object:
        extracted.append(text)
        return await original(self, text)

    monkeypatch.setattr(CascadeExtractor, "extract", _spy)

    v2_doc = await _ingest_and_approve(harness, scope, V2)
    assert v2_doc != v1_doc
    v2 = await harness.repo.get_document(scope, v2_doc)
    assert v2 is not None and v2.version == 2

    # AC#1 — the v1 document (history) is untouched and still present.
    assert (await harness.repo.get_document(scope, v1_doc)) is not None

    # AC#2 — the unchanged Alpha section was NOT re-extracted; the changed Beta + new Gamma were.
    assert not any("alpha policy" in t for t in extracted)
    assert any("REVISED beta policy" in t for t in extracted)
    assert any("gamma policy" in t for t in extracted)

    after = await _claims(harness, project)
    by_id = {c["id"]: c for c in after}

    # AC#2 — the unchanged Alpha claim is the SAME row: id + credibility (0.77) preserved, still
    # active and still attributed to v1.
    alpha_now = by_id[alpha_v1["id"]]
    assert alpha_now["active"] is True
    assert alpha_now["cred"] == 0.77
    assert alpha_now["doc"] == v1_doc

    # AUDIT-014: identity and provenance are different concepts. The same Alpha claim is one row,
    # but it occurs in both document versions and each occurrence points at that version's concrete
    # chunk. Chunk ordinals make this association deterministic even when text is duplicated.
    async with harness.sm() as session:
        occurrences = (
            await session.execute(
                text(
                    "SELECT document_id::text, chunk_id::text FROM claim_occurrences "
                    "WHERE project_id = :project AND claim_id = :claim ORDER BY document_id"
                ),
                {"project": project, "claim": alpha_v1["id"]},
            )
        ).all()
        ordinals = (
            await session.execute(
                text(
                    "SELECT document_id::text, ordinal FROM chunks "
                    "WHERE document_id IN (:v1, :v2) ORDER BY document_id, ordinal"
                ),
                {"v1": v1_doc, "v2": v2_doc},
            )
        ).all()
    assert {row[0] for row in occurrences} == {v1_doc, v2_doc}
    # The canned extractor returns the same canonical triple for every section, so that one identity
    # also has Beta's concrete occurrence. What matters here is that the v2 Alpha occurrence was
    # added without another claim row, not that this artificial triple appears nowhere else.
    assert len({row[1] for row in occurrences}) >= 2
    assert [row[1] for row in ordinals if row[0] == v1_doc] == [0, 1]
    assert [row[1] for row in ordinals if row[0] == v2_doc] == [0, 1, 2]

    # AC#3 — the old Beta claim (changed content) is superseded (valid_to set); the revised Beta +
    # Gamma claims are freshly extracted on v2 (active, default cred0 — not the 0.77 marker).
    beta_v1 = next(c for c in before if "original beta policy" in str(c["text"]))
    assert by_id[beta_v1["id"]]["active"] is False
    active_v2 = [c for c in after if c["doc"] == v2_doc and c["active"]]
    assert len(active_v2) >= 2  # revised Beta + Gamma
    assert all(c["cred"] != 0.77 for c in active_v2)


async def test_reupload_of_identical_bytes_is_a_noop(
    build_harness: Callable[..., Harness],
    make_completion: Callable[..., object],
) -> None:
    harness = build_harness(completion=_completion(make_completion))
    project = await harness.setup_project(unique_slug("ver"), TOPICS)
    scope = harness.scope(project, allowed_topics=["general"])
    await harness.repo.create_source(scope, name="manual-src", type_="folder", policy="manual")

    first = await _ingest_and_approve(harness, scope, V1)
    again = await harness.service.ingest_bytes(scope, V1, filename="policy.md", source="manual-src")
    assert again.duplicate is True
    assert again.document_id == first
    doc = await harness.repo.get_document(scope, first)
    assert doc is not None and doc.version == 1  # no phantom version bump


async def test_changed_chunk_reuses_unchanged_claims_and_extracts_only_sentence_delta(
    build_harness: Callable[..., Harness],
) -> None:
    extraction_inputs: list[str] = []

    async def completion(**kwargs: object) -> object:
        schema = kwargs.get("response_format")
        name = getattr(schema, "__name__", "")
        messages = cast(list[dict[str, object]], kwargs.get("messages", []))
        conversation = " ".join(str(message.get("content", "")) for message in messages)
        if name == "TopicAssignment":
            return completion_response(json.dumps({"tags": ["general"]}))
        if name == "EntityExtraction":
            return completion_response(json.dumps({"entities": []}))
        if name == "RelationExtraction":
            return completion_response(json.dumps({"relations": []}))
        if name == "ClaimExtraction":
            extraction_inputs.append(conversation)
            if "48 hours" in conversation:
                claims = [
                    {
                        "text": "The SLA is 48 hours.",
                        "subject": "SLA",
                        "predicate": "duration",
                        "object": "48 hours",
                    },
                    {
                        "text": "Notify Luis.",
                        "subject": "Policy",
                        "predicate": "notifies",
                        "object": "Luis",
                    },
                ]
            else:
                claims = [
                    {
                        "text": "The SLA is 24 hours.",
                        "subject": "SLA",
                        "predicate": "duration",
                        "object": "24 hours",
                    },
                    {
                        "text": "Escalation is owned by Ana.",
                        "subject": "Escalation",
                        "predicate": "owner",
                        "object": "Ana",
                    },
                    {
                        "text": "Keep audit logs.",
                        "subject": "Policy",
                        "predicate": "keeps",
                        "object": "audit logs",
                    },
                ]
            return completion_response(json.dumps({"claims": claims}))
        return completion_response("{}")

    harness = build_harness(completion=completion)
    project = await harness.setup_project(unique_slug("mixed"), TOPICS)
    scope = harness.scope(project, allowed_topics=["general"])
    await harness.repo.create_source(scope, name="manual-src", type_="folder", policy="manual")

    v1_doc = await _ingest_and_approve(harness, scope, MIXED_V1)
    async with harness.sm() as session:
        stable = await session.scalar(
            select(models.Claim).where(
                models.Claim.source_document_id == uuid.UUID(v1_doc),
                models.Claim.text == "Escalation is owned by Ana.",
            )
        )
        assert stable is not None
        stable.credibility = 0.83
        stable_id = str(stable.id)
        old_sla_id = str(
            await session.scalar(
                select(models.Claim.id).where(
                    models.Claim.source_document_id == uuid.UUID(v1_doc),
                    models.Claim.text == "The SLA is 24 hours.",
                )
            )
        )
        await session.commit()

    extraction_inputs.clear()
    v2_doc = await _ingest_and_approve(harness, scope, MIXED_V2)

    assert len(extraction_inputs) == 1
    assert "48 hours" in extraction_inputs[0] and "Notify Luis" in extraction_inputs[0]
    assert "Escalation is owned by Ana" not in extraction_inputs[0]
    assert "Keep audit logs" not in extraction_inputs[0]

    async with harness.sm() as session:
        stable_after = await session.get(models.Claim, uuid.UUID(stable_id))
        active_v2 = (
            await session.scalars(
                select(models.Claim).where(
                    models.Claim.project_id == uuid.UUID(project),
                    models.Claim.valid_to.is_(None),
                )
            )
        ).all()
        occurrence_docs = set(
            await session.scalars(
                select(models.ClaimOccurrence.document_id).where(
                    models.ClaimOccurrence.claim_id == uuid.UUID(stable_id)
                )
            )
        )
        lineage = (
            await session.execute(
                select(
                    models.ClaimSupersession.previous_claim_id,
                    models.ClaimSupersession.replacement_claim_id,
                ).where(models.ClaimSupersession.previous_claim_id == uuid.UUID(old_sla_id))
            )
        ).all()

    assert stable_after is not None and float(stable_after.credibility) == 0.83
    assert occurrence_docs == {uuid.UUID(v1_doc), uuid.UUID(v2_doc)}
    assert {claim.text for claim in active_v2} >= {
        "The SLA is 48 hours.",
        "Escalation is owned by Ana.",
        "Keep audit logs.",
        "Notify Luis.",
    }
    assert len(lineage) == 1
    replacement = next(claim for claim in active_v2 if claim.text == "The SLA is 48 hours.")
    assert lineage[0] == (uuid.UUID(old_sla_id), replacement.id)


async def test_a_revision_cannot_publish_before_its_immediate_predecessor(
    build_harness: Callable[..., Harness], make_completion: Callable[..., object]
) -> None:
    harness = build_harness(completion=_completion(make_completion))
    project = await harness.setup_project(unique_slug("ordered"), TOPICS)
    scope = harness.scope(project, allowed_topics=["general"])
    await harness.repo.create_source(scope, name="manual-src", type_="folder", policy="manual")

    v1 = await harness.service.ingest_bytes(
        scope, V1, filename="policy.md", source="manual-src", run=False
    )
    v2 = await harness.service.ingest_bytes(
        scope, V2, filename="policy.md", source="manual-src", run=False
    )
    await harness.pipeline.process(scope, v2.document_id)

    with pytest.raises(PriorVersionNotProcessedError, match="version 1 is processed"):
        await harness.service.approve(scope, v2.document_id, approver="cli")

    await harness.pipeline.process(scope, v1.document_id)
    await harness.service.approve(scope, v1.document_id, approver="cli")
    status = await harness.pipeline.process(scope, v2.document_id)

    assert status.phase == DocStatus.PROCESSED.value


async def test_failed_publish_replays_durable_draft_without_model_calls_or_new_ids(
    build_harness: Callable[..., Harness],
    make_completion: Callable[..., object],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model_claim_calls = 0
    base_completion = make_completion(
        entities=[
            {"name": "Acme", "type": "org", "aliases": []},
            {"name": "Portal", "type": "system", "aliases": []},
        ],
        relations=[{"subject": "Acme", "predicate": "uses", "object": "Portal"}],
        claims=[
            {
                "text": "Acme uses Portal.",
                "subject": "Acme",
                "predicate": "uses",
                "object": "Portal",
            }
        ],
        tags=["general"],
    )

    async def counting_completion(**kwargs: object) -> object:
        nonlocal model_claim_calls
        if getattr(kwargs.get("response_format"), "__name__", "") == "ClaimExtraction":
            model_claim_calls += 1
        return await base_completion(**kwargs)  # type: ignore[operator]

    harness = build_harness(completion=counting_completion)
    project = await harness.setup_project(unique_slug("replay"), TOPICS)
    scope = harness.scope(project, allowed_topics=["general"])
    await harness.repo.create_source(scope, name="manual-src", type_="folder", policy="manual")
    outcome = await harness.service.ingest_bytes(
        scope, V1, filename="policy.md", source="manual-src"
    )

    original = AgeGraphStore.upsert_edges
    fail_once = True

    async def fail_after_graph_write(self: AgeGraphStore, *args: object, **kwargs: object) -> None:
        nonlocal fail_once
        await original(self, *args, **kwargs)  # type: ignore[arg-type]
        if fail_once:
            fail_once = False
            raise RuntimeError("injected after graph write")

    monkeypatch.setattr(AgeGraphStore, "upsert_edges", fail_after_graph_write)
    with pytest.raises(RuntimeError, match="injected after graph write"):
        await harness.service.approve(scope, outcome.document_id, approver="cli")

    async with harness.sm() as session:
        run = await session.scalar(
            select(models.IngestRun).where(
                models.IngestRun.document_id == uuid.UUID(outcome.document_id)
            )
        )
        claim_count_after_rollback = await session.scalar(
            select(models.Claim.id).where(
                models.Claim.source_document_id == uuid.UUID(outcome.document_id)
            )
        )
        assert run is not None and run.publish_draft is not None
        drafted_claims = cast(list[dict[str, Any]], run.publish_draft["claims"])
        drafted_ids = {claim["id"] for claim in drafted_claims}
    assert claim_count_after_rollback is None
    calls_after_failure = model_claim_calls

    status = await harness.pipeline.process(scope, outcome.document_id)

    async with harness.sm() as session:
        persisted_ids = {
            str(value)
            for value in await session.scalars(
                select(models.Claim.id).where(
                    models.Claim.source_document_id == uuid.UUID(outcome.document_id)
                )
            )
        }
        run = await session.scalar(
            select(models.IngestRun).where(
                models.IngestRun.document_id == uuid.UUID(outcome.document_id)
            )
        )
    assert status.phase == DocStatus.PROCESSED.value
    assert model_claim_calls == calls_after_failure
    assert persisted_ids == drafted_ids
    assert run is not None and run.publish_draft is None
    assert run.claims_generated == len(persisted_ids)
    assert run.completed_stages.count("persist") == 1


async def test_duplicate_chunk_claim_has_one_identity_and_two_occurrences(
    build_harness: Callable[..., Harness], make_completion: Callable[..., object]
) -> None:
    harness = build_harness(
        completion=make_completion(
            claims=[
                {
                    "text": "Acme uses Portal.",
                    "subject": "Acme",
                    "predicate": "uses",
                    "object": "Portal",
                }
            ],
            tags=["general"],
        )
    )
    project = await harness.setup_project(unique_slug("duplicate-occurrence"), TOPICS)
    scope = harness.scope(project, allowed_topics=["general"])
    await harness.repo.create_source(scope, name="manual-src", type_="folder", policy="manual")
    document_id = await _ingest_and_approve(
        harness,
        scope,
        b"# First\n\nAcme uses Portal.\n\n# Second\n\nAcme uses Portal.\n",
    )

    async with harness.sm() as session:
        claim_ids = (
            await session.scalars(
                select(models.Claim.id).where(
                    models.Claim.source_document_id == uuid.UUID(document_id),
                    models.Claim.text == "Acme uses Portal.",
                )
            )
        ).all()
        occurrences = (
            await session.scalars(
                select(models.ClaimOccurrence.chunk_id).where(
                    models.ClaimOccurrence.document_id == uuid.UUID(document_id)
                )
            )
        ).all()

    assert len(claim_ids) == 1
    assert len(occurrences) == 2
    assert len(set(occurrences)) == 2
