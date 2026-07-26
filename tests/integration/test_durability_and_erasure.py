"""Blob durability and complete erasure (AUDIT-045/043/023/026 — R39, R42, R43, R44).

Two of this batch's six findings — the backup manifest (R40) and fail-closed restore (R41) — can only
be observed where the PostgreSQL client tools exist, so their evidence lives in the CI-gated round trip
in ``test_backup_restore.py``. The four here are observable anywhere: what is on disk, what a deletion
leaves behind, and whether the two delete routes do the same thing.

Erasure is asserted through what a reader can still SEE — recall, export, the graph — never through row
counts, because the finding is precisely that the rows went away and the content did not.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

import pytest
import yaml
from sqlalchemy import func, select

from rsc_brain.stores.relational import models

from .conftest import Harness, unique_slug

pytestmark = pytest.mark.integration

TOPICS = [("hr", 0)]
REPO_ROOT = Path(__file__).resolve().parents[2]
COMPOSE = REPO_ROOT / "deploy" / "docker-compose.prod.yml"

#: Where the application writes original documents, relative to its data dir (`IngestService`). The
#: harness points the service at the test's own ``tmp_path``, so that is the data dir here.
BLOB_SUBDIR = "blobs"


def _mounts(service: Mapping[str, Any]) -> list[str]:
    volumes = service.get("volumes") or []
    return [str(v) for v in volumes]


# --------------------------------------------------------------------------- #
# R39 — the original documents survive a container being replaced
# --------------------------------------------------------------------------- #


def test_the_api_and_worker_persist_the_data_directory() -> None:
    """Blobs are written under the data dir and nothing mounts it.

    So every original document lives in the container's writable layer: replacing a container — a
    deploy, a restart policy, an image bump — destroys every file the product ingested, while the
    database keeps rows pointing at paths that no longer exist. The `inbox` volume is declared in the
    same file and mounted by nobody, which is the same defect one line away.
    """
    compose = yaml.safe_load(COMPOSE.read_text())
    services = compose["services"]

    for name in ("api", "worker"):
        mounts = _mounts(services[name])
        assert any("app_data" in mount for mount in mounts), (
            f"service {name!r} does not mount a persistent volume for its data directory, so the "
            f"documents it writes are lost when the container is replaced; mounts={mounts}"
        )

    # The PaaS targets are OVERLAYS on this file (`-f prod -f coolify`), so they inherit these mounts —
    # unless they replace them. R45-R48 recorded the cost of fixing one target and leaving three:
    # `volumes` is a list, and a list in an override REPLACES rather than merges.
    for overlay in ("coolify", "dokploy"):
        doc = yaml.safe_load((REPO_ROOT / "deploy" / f"docker-compose.{overlay}.yml").read_text())
        for name in ("api", "worker"):
            service = (doc.get("services") or {}).get(name) or {}
            overridden = _mounts(service)
            assert not overridden or any("app_data" in mount for mount in overridden), (
                f"the {overlay} overlay replaces {name}'s volumes without the data directory, so that "
                f"target loses every stored document on redeploy; mounts={overridden}"
            )

    declared = set(compose.get("volumes") or {})
    mounted = {
        mount.split(":")[0]
        for service in services.values()
        for mount in _mounts(service)
        if not mount.startswith((".", "/"))
    }
    assert declared <= mounted, (
        f"volumes declared and mounted by nobody: {sorted(declared - mounted)} — a persistent volume "
        "that no service mounts is storage the operator believes they have"
    )


# --------------------------------------------------------------------------- #
# R42 — forgetting a document removes the document
# --------------------------------------------------------------------------- #


async def test_forgetting_a_document_deletes_its_stored_file(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """``hard_delete_document`` deletes the row and ignores ``Document.path``.

    The original file therefore stays on disk after a deletion the operator was told succeeded — the
    one thing "forget this document" has to mean. A GDPR erasure that leaves the source PDF in place
    has not erased anything.
    """
    from rsc_brain.knowledge.gdpr import forget_document

    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["hr"])
    await harness.repo.create_source(
        scope, name="auto", type_="folder", policy="source_tags", default_tags=["hr"]
    )
    outcome = await harness.service.ingest_bytes(
        scope, b"# Handbook\n\nThe SLA is 48 hours.\n", filename="hb.md", source="auto"
    )
    async with harness.sm() as session:
        document = await session.get(models.Document, uuid.UUID(outcome.document_id))
    assert document is not None and document.path
    blob = Path(document.path)
    assert blob.exists(), "the ingest did not store a file, so this check would be vacuous"

    await forget_document(harness.sm, scope, outcome.document_id, data_dir=str(tmp_path))

    assert not blob.exists(), f"the stored document {blob} is still on disk after it was forgotten"


# --------------------------------------------------------------------------- #
# R43 — erasing an entity stops serving what mentions it
# --------------------------------------------------------------------------- #


async def test_erasing_an_entity_stops_serving_the_claims_that_name_it(
    build_harness: Callable[..., Harness],
) -> None:
    """``forget_entity`` deletes the entity row, its aliases and its graph node — and nothing else.

    The claims keep the erased name in ``text``, ``subject`` and ``object``, with live embeddings, so
    recall still answers with it and an export still contains it. The row is gone and the person is
    not: exactly the outcome a subject-access erasure exists to prevent.
    """
    from rsc_brain.knowledge.gdpr import forget_entity
    from rsc_brain.recall.retriever import PgRetriever
    from rsc_brain.stores.age_graph_store import AgeGraphStore

    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["hr"])
    text = "Ana Ruiz owns payroll approvals."
    embedding = list((await harness.gateway.embed([text]))[0])
    # A document with an embedded chunk plus a claim on it — the shape recall actually serves from. A
    # bare claim with an embedding is not recallable, so seeding one would make this check vacuous.
    async with harness.sm() as session:
        document = models.Document(
            project_id=uuid.UUID(project),
            logical_id=unique_slug("doc"),
            checksum=unique_slug("sum"),
            status="processed",
            doc_tags=["hr"],
        )
        session.add(document)
        await session.flush()
        chunk = models.Chunk(
            project_id=uuid.UUID(project),
            document_id=document.id,
            kind="prose",
            text=text,
            tags=["hr"],
            embedding=embedding,
            needs_review=False,
        )
        session.add(chunk)
        session.add(
            models.Entity(
                project_id=uuid.UUID(project),
                name="Ana Ruiz",
                normalized_name="ana ruiz",
                type="person",
            )
        )
        await session.flush()
        session.add(
            models.Claim(
                project_id=uuid.UUID(project),
                chunk_id=chunk.id,
                text=text,
                subject="Ana Ruiz",
                predicate="owns",
                object="payroll approvals",
                tags=["hr"],
                credibility=0.9,
                embedding=embedding,
                source_document_id=document.id,
            )
        )
        await session.commit()

    retriever = PgRetriever(
        sessionmaker=harness.sm, gateway=harness.gateway, graph_store=AgeGraphStore(harness.sm)
    )
    before = await retriever.recall(scope, text, topics_hint=["hr"])
    # The control: without it, "recall no longer serves the name" is also what an empty index looks
    # like, and the check below would pass while proving nothing.
    assert any("Ana Ruiz" in fragment.text for fragment in before.fragments), (
        "recall did not serve this claim even before the erasure, so this check would be vacuous"
    )

    await forget_entity(harness.sm, scope, name="Ana Ruiz")

    after = await retriever.recall(scope, text, topics_hint=["hr"])
    served = " ".join(fragment.text for fragment in after.fragments)
    assert "Ana Ruiz" not in served, (
        "recall still serves the erased entity's name, so the erasure removed the row and left the "
        f"person: {served[:200]}"
    )

    async with harness.sm() as session:
        remaining = await session.scalar(
            select(func.count())
            .select_from(models.Claim)
            .where(
                models.Claim.project_id == uuid.UUID(project),
                models.Claim.text.ilike("%Ana Ruiz%"),
            )
        )
    assert remaining == 0, f"{remaining} claim(s) still contain the erased name verbatim"


async def test_erasure_does_not_reach_another_project_with_the_same_entity(
    build_harness: Callable[..., Harness],
) -> None:
    """Graph node identity is a deterministic uuid5 of (type, name), so two projects share it.

    An erasure that suppressed nodes by id without scoping would therefore erase the other tenant's
    entity too — the worst possible direction for this feature to fail in.
    """
    from rsc_brain.knowledge.gdpr import forget_entity

    harness = build_harness()
    keeper = await harness.setup_project(unique_slug("keeper"), TOPICS)
    eraser = await harness.setup_project(unique_slug("eraser"), TOPICS)
    for project in (keeper, eraser):
        async with harness.sm() as session:
            session.add(
                models.Entity(
                    project_id=uuid.UUID(project),
                    name="Ana Ruiz",
                    normalized_name="ana ruiz",
                    type="person",
                )
            )
            session.add(
                models.Claim(
                    project_id=uuid.UUID(project),
                    text="Ana Ruiz owns payroll approvals.",
                    subject="Ana Ruiz",
                    tags=["hr"],
                    credibility=0.9,
                )
            )
            await session.commit()

    await forget_entity(harness.sm, harness.scope(eraser, allowed_topics=["hr"]), name="Ana Ruiz")

    async with harness.sm() as session:
        kept_entities = await session.scalar(
            select(func.count())
            .select_from(models.Entity)
            .where(models.Entity.project_id == uuid.UUID(keeper))
        )
        kept_claims = await session.scalar(
            select(func.count())
            .select_from(models.Claim)
            .where(models.Claim.project_id == uuid.UUID(keeper))
        )
    assert kept_entities == 1, "erasing one project's entity removed another project's"
    assert kept_claims == 1, "erasing one project's entity removed another project's claims"


async def test_a_later_ingest_does_not_silently_revive_an_erased_entity(
    build_harness: Callable[..., Harness], make_completion: Callable[..., object]
) -> None:
    """Erasure must not auto-revive (SPEC AUDIT-023, ratified).

    Nothing records that a name was erased, so the next document naming the same person recreates the
    entity as if it had never been erased — with no audit, no decision, and no way for the operator who
    performed the erasure to know it came back.
    """
    from rsc_brain.knowledge.gdpr import forget_entity

    harness = build_harness(
        completion=make_completion(
            entities=[{"name": "Ana Ruiz", "type": "person"}],
            claims=[{"text": "Ana Ruiz owns payroll.", "subject": "Ana Ruiz"}],
            tags=["hr"],
        )
    )
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["hr"])
    await harness.repo.create_source(
        scope, name="auto", type_="folder", policy="source_tags", default_tags=["hr"]
    )
    async with harness.sm() as session:
        session.add(
            models.Entity(
                project_id=uuid.UUID(project),
                name="Ana Ruiz",
                normalized_name="ana ruiz",
                type="person",
            )
        )
        await session.commit()

    await forget_entity(harness.sm, scope, name="Ana Ruiz")

    await harness.service.ingest_bytes(
        scope, b"# Handbook\n\nAna Ruiz owns payroll.\n", filename="hb2.md", source="auto"
    )

    async with harness.sm() as session:
        revived = await session.scalar(
            select(func.count())
            .select_from(models.Entity)
            .where(
                models.Entity.project_id == uuid.UUID(project),
                models.Entity.normalized_name == "ana ruiz",
            )
        )
    assert revived == 0, "a later ingest silently recreated an erased entity"


# --------------------------------------------------------------------------- #
# R44 — one project-deletion orchestrator, used by every route
# --------------------------------------------------------------------------- #


async def test_deleting_a_project_removes_its_blobs_and_is_idempotent(
    build_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """Project deletion drops the graph and cascades the relational rows — and leaves the files.

    The blobs of a deleted project stay on disk indefinitely: the tenant is gone from every table and
    its documents are still readable by anyone with filesystem access. There are also two delete routes
    (the CLI's own and the GDPR path) with different completeness, so what "delete this project"
    destroys depends on which one the operator reached for.
    """
    from rsc_brain.knowledge.gdpr import hard_delete_project

    harness = build_harness()
    project = await harness.setup_project(unique_slug("acme"), TOPICS)
    scope = harness.scope(project, allowed_topics=["hr"])
    await harness.repo.create_source(
        scope, name="auto", type_="folder", policy="source_tags", default_tags=["hr"]
    )
    await harness.service.ingest_bytes(
        scope, b"# Handbook\n\nThe SLA is 48 hours.\n", filename="hb.md", source="auto"
    )
    blobs = tmp_path / BLOB_SUBDIR / project
    assert list(blobs.glob("*")), "no blob was stored, so this check would be vacuous"

    await hard_delete_project(harness.sm, scope, data_dir=str(tmp_path))

    assert not blobs.exists() or not list(blobs.glob("*")), (
        f"the deleted project's files are still on disk at {blobs}"
    )
    # A second run must be a no-op rather than an error: deletion is exactly the operation an operator
    # retries after a timeout.
    await hard_delete_project(harness.sm, scope, data_dir=str(tmp_path))
