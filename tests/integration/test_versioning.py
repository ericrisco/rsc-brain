"""Document versioning + chunk-level claim diff against the real container (SPEC-09 D6).

Covers the AC set: a re-upload with the same logical id + new checksum becomes a new version
(history kept); an unchanged chunk's claims are re-asserted WITHOUT re-extraction (0 LLM calls);
the prior version's claims are superseded (valid_to); a changed/new chunk is extracted fresh; a
byte-identical re-upload is a no-op. Reused claims keep the prior credibility (continuity).
"""

from __future__ import annotations

import uuid
from collections.abc import Callable

import pytest
from sqlalchemy import select, update

from rsc_brain.ingest.types import DocStatus
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational import models

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
    extracted: list[str] = []
    original = harness.pipeline._extractor.extract

    async def _spy(text: str) -> object:
        extracted.append(text)
        return await original(text)

    harness.pipeline._extractor.extract = _spy  # type: ignore[method-assign,assignment]

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
