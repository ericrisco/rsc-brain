"""Project-scoped persistence for the ingestion pipeline (SPEC-05).

Every method takes a :class:`~rsc_brain.scope.ProjectScope` first and filters by
``scope.project_id`` in the query (FR-12.4 / AUDIT-003). Stage-oriented writers bundle their
data writes and the run checkpoint into a **single transaction**, so a worker that dies
mid-stage rolls back cleanly and re-runs without duplicating work (FR-1.10, NFR-4). Re-runnable
stages are additionally idempotent (delete-then-insert for chunks/claims; ON CONFLICT for
entities), so even a redo of an uncheckpointed stage cannot create duplicates.
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, cast

from sqlalchemy import CursorResult, delete, func, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.ingest.entity_resolution import normalize_name
from rsc_brain.ingest.types import (
    DocStatus,
    PipelineStage,
    ProposedChunk,
    RunStatus,
    TopicRule,
)
from rsc_brain.scope import NON_TOPIC_TAGS, ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import maybe_session_scope, session_scope
from rsc_brain.temporal import active_at_clause
from rsc_brain.visibility import forbidden_topics, topic_clause

NEEDS_REVIEW_TAG = next(iter(NON_TOPIC_TAGS))
DEFAULT_SOURCE_NAME = "default"


def _pid(scope: ProjectScope) -> uuid.UUID:
    return uuid.UUID(scope.project_id)


def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


@dataclass(frozen=True, slots=True)
class SourceRow:
    id: str
    name: str
    type: str
    policy: str
    default_tags: tuple[str, ...]
    review_if_sensitive: bool
    curators: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class DocRow:
    id: str
    project_id: str
    source_id: str | None
    logical_id: str
    checksum: str
    title: str | None
    path: str | None
    lang: str | None
    status: str
    doc_tags: tuple[str, ...]
    version: int = 1


@dataclass(frozen=True, slots=True)
class ChunkRow:
    id: str
    kind: str
    text: str
    tags: tuple[str, ...]
    needs_review: bool
    extraction_confidence: float | None
    ordinal: int = 0


@dataclass(frozen=True, slots=True)
class ClaimSpec:
    chunk_id: str
    text: str
    subject: str | None = None
    predicate: str | None = None
    object: str | None = None
    valid_from: dt.datetime | None = None
    valid_to: dt.datetime | None = None
    # Deterministic entity identity of each endpoint (AUDIT-035 / R16); None when the endpoint was
    # not resolved to a typed entity.
    subject_entity_key: str | None = None
    object_entity_key: str | None = None
    tags: tuple[str, ...] = ()
    extraction_confidence: float | None = None
    credibility: float | None = None  # cred0 (SPEC-08 FR-5.1); None → DDL default
    # R18: contradiction candidates are paired by cosine similarity between CLAIM vectors, so a claim
    # written without one can never be paired — detection was unreachable for every ingested claim
    # even once a resolver was wired in. The pipeline embeds claim texts at publish and fills this.
    embedding: tuple[float, ...] | None = None
    # Allocated before the final publish transaction when a durable draft is used. None keeps the
    # legacy call sites source-compatible and lets PostgreSQL provide the UUID.
    id: str | None = None


@dataclass(frozen=True, slots=True)
class ClaimIdentityRow:
    id: str
    chunk_id: str
    text: str
    subject: str | None
    predicate: str | None
    object: str | None


@dataclass(frozen=True, slots=True)
class EntitySpec:
    name: str
    type: str
    aliases: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class Counters:
    chunks_created: int = 0
    claims_generated: int = 0
    tables_converted: int = 0
    tables_needs_review: int = 0
    discarded_chunks: int = 0


@dataclass(frozen=True, slots=True)
class IngestErrorSpec:
    chunk_ref: str | None
    stage: str
    error: str


#: Decisions nothing in the pipeline may undo. `rejected` is the only one today: `processed` is the
#: pipeline's own end state and a redo must be able to reach it again (publish is idempotent).
_TERMINAL_STATUSES = ("rejected",)


class IngestRepository:
    """Ingestion persistence. Concrete, project-scoped, transaction-atomic per stage."""

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sm = sessionmaker

    @property
    def sessionmaker(self) -> async_sessionmaker[AsyncSession]:
        """The repository's sessionmaker, so a collaborator can be built from the same connection.

        Exposed so the pipeline can construct its graph-retirement helper itself instead of taking it
        as an optional injection — R18 is what optional injections do: the feature exists and no
        composition root turns it on.
        """
        return self._sm

    # --- sources -------------------------------------------------------------

    async def create_source(
        self,
        scope: ProjectScope,
        *,
        name: str,
        type_: str,
        policy: str,
        default_tags: Sequence[str] = (),
        review_if_sensitive: bool = True,
        curators: Sequence[str] = (),
    ) -> str:
        async with session_scope(self._sm) as session:
            source = models.Source(
                project_id=_pid(scope),
                name=name,
                type=type_,
                policy=policy,
                default_tags=list(default_tags),
                review_if_sensitive=review_if_sensitive,
                curators=[uuid.UUID(c) for c in curators],
            )
            session.add(source)
            await session.flush()
            return str(source.id)

    async def get_source(self, scope: ProjectScope, source_id: str) -> SourceRow | None:
        async with self._sm() as session:
            source = await session.get(models.Source, uuid.UUID(source_id))
            if source is None or source.project_id != _pid(scope):
                return None
            return _source_row(source)

    async def get_source_by_name(self, scope: ProjectScope, name: str) -> SourceRow | None:
        async with self._sm() as session:
            source = await session.scalar(
                select(models.Source).where(
                    models.Source.project_id == _pid(scope), models.Source.name == name
                )
            )
            return _source_row(source) if source else None

    async def list_sources(self, scope: ProjectScope) -> list[SourceRow]:
        async with self._sm() as session:
            rows = await session.scalars(
                select(models.Source)
                .where(models.Source.project_id == _pid(scope))
                .order_by(models.Source.name)
            )
            return [_source_row(s) for s in rows]

    async def ensure_default_source(self, scope: ProjectScope) -> SourceRow:
        """Return the project's ``default`` source, creating it (folder + llm policy) if absent.

        The default policy is ``llm`` with ``review_if_sensitive=true`` (D13): publish
        automatically unless the LLM proposes a sensitive tag, in which case it holds for review.
        """
        existing = await self.get_source_by_name(scope, DEFAULT_SOURCE_NAME)
        if existing is not None:
            return existing
        source_id = await self.create_source(
            scope,
            name=DEFAULT_SOURCE_NAME,
            type_="folder",
            policy="llm",
            review_if_sensitive=True,
        )
        row = await self.get_source(scope, source_id)
        if row is None:  # pragma: no cover - created within this scope moments ago
            raise RuntimeError("the default source vanished immediately after being created")
        return row

    # --- documents -----------------------------------------------------------

    async def find_document_by_checksum(self, scope: ProjectScope, checksum: str) -> DocRow | None:
        async with self._sm() as session:
            doc = await session.scalar(
                select(models.Document).where(
                    models.Document.project_id == _pid(scope),
                    models.Document.checksum == checksum,
                )
            )
            return _doc_row(doc) if doc else None

    async def admit_document(
        self,
        scope: ProjectScope,
        *,
        logical_id: str,
        checksum: str,
        source_id: str | None,
        title: str | None,
        path: str,
        lang: str | None = None,
        pages: int | None = None,
        status: str = "received",
        doc_tags: Sequence[str] = (),
    ) -> tuple[str, bool, int]:
        """Admit a document atomically. Returns ``(document_id, is_duplicate, version)``.

        A transaction advisory lock serializes both identities admission must protect: project +
        checksum (one canonical upload even under different filenames) and project + logical id
        (strictly monotonic revisions). Locks are acquired in sorted key order to avoid deadlocks.
        """
        pid = _pid(scope)
        lock_names = sorted(
            (
                f"claim-version:checksum:{pid}:{checksum}",
                f"claim-version:logical:{pid}:{logical_id}",
            )
        )
        async with session_scope(self._sm) as session:
            for lock_name in lock_names:
                await session.execute(
                    text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
                    {"key": lock_name},
                )
            existing = await session.scalar(
                select(models.Document).where(
                    models.Document.project_id == pid, models.Document.checksum == checksum
                )
            )
            if existing is not None:
                return str(existing.id), True, existing.version
            latest = await session.scalar(
                select(func.max(models.Document.version)).where(
                    models.Document.project_id == pid,
                    models.Document.logical_id == logical_id,
                )
            )
            document = models.Document(
                project_id=pid,
                source_id=uuid.UUID(source_id) if source_id else None,
                logical_id=logical_id,
                checksum=checksum,
                title=title,
                path=path,
                lang=lang,
                pages=pages,
                status=status,
                doc_tags=list(doc_tags),
                version=int(latest or 0) + 1,
            )
            session.add(document)
            await session.flush()
            return str(document.id), False, document.version

    async def create_document(
        self,
        scope: ProjectScope,
        *,
        logical_id: str,
        checksum: str,
        source_id: str | None,
        title: str | None = None,
        path: str | None = None,
        lang: str | None = None,
        pages: int | None = None,
        status: str = "received",
        doc_tags: Sequence[str] = (),
        version: int = 1,
    ) -> str:
        async with session_scope(self._sm) as session:
            doc = models.Document(
                project_id=_pid(scope),
                source_id=uuid.UUID(source_id) if source_id else None,
                logical_id=logical_id,
                checksum=checksum,
                title=title,
                path=path,
                lang=lang,
                pages=pages,
                status=status,
                doc_tags=list(doc_tags),
                version=version,
            )
            session.add(doc)
            await session.flush()
            return str(doc.id)

    async def latest_version_for_logical_id(self, scope: ProjectScope, logical_id: str) -> int:
        """Highest existing version for a logical id in this project (0 if none).

        Read-only reporting. Allocation happens inside :meth:`admit_document`, because `max + 1` read
        here and used there is precisely the race R30 records.
        """
        async with self._sm() as session:
            latest = await session.scalar(
                select(func.max(models.Document.version)).where(
                    models.Document.project_id == _pid(scope),
                    models.Document.logical_id == logical_id,
                )
            )
            return int(latest or 0)

    async def latest_prior_published_document(
        self, scope: ProjectScope, logical_id: str, version: int
    ) -> DocRow | None:
        """The highest-version *processed* document of ``logical_id`` older than ``version`` — the
        baseline a new version diffs against."""
        async with self._sm() as session:
            doc = await session.scalar(
                select(models.Document)
                .where(
                    models.Document.project_id == _pid(scope),
                    models.Document.logical_id == logical_id,
                    models.Document.version < version,
                    models.Document.status == "processed",
                )
                .order_by(models.Document.version.desc())
                .limit(1)
            )
            return _doc_row(doc) if doc else None

    async def immediate_prior_document(
        self, scope: ProjectScope, logical_id: str, version: int
    ) -> DocRow | None:
        """The exact preceding revision, irrespective of lifecycle status."""

        if version <= 1:
            return None
        async with self._sm() as session:
            document = await session.scalar(
                select(models.Document).where(
                    models.Document.project_id == _pid(scope),
                    models.Document.logical_id == logical_id,
                    models.Document.version == version - 1,
                )
            )
            return _doc_row(document) if document else None

    async def supersede_prior_version(
        self, scope: ProjectScope, prior_document_id: str, current_texts: set[str]
    ) -> list[str]:
        """Supersede a prior version against the new one's chunk texts (SPEC-09 D6, AC#3).

        A prior chunk whose text is **absent** from the new version (changed or removed content)
        has its embedding nulled (stops being vector-recallable) and its active claims closed
        (``valid_to=now``). A prior chunk whose text is **unchanged** (present in the new version)
        is left completely untouched, so its claims keep their id + credibility across versions
        (AC#2). Nothing is deleted (FR-5.5). Idempotent (only touches still-live rows). Returns the
        ids of the claims closed, so the caller can retire their graph relations too (R27).

        The active-at predicate chooses which facts to retire; assigning ``valid_to=now`` is the
        existing operational lifecycle mutation, not a source-validity redesign.
        """
        async with session_scope(self._sm) as session:
            now = _now()
            prior_chunks = (
                await session.scalars(
                    select(models.Chunk).where(
                        models.Chunk.document_id == uuid.UUID(prior_document_id),
                        models.Chunk.project_id == _pid(scope),
                    )
                )
            ).all()
            superseded = [c.id for c in prior_chunks if c.text not in current_texts]
            if not superseded:
                return []
            await session.execute(
                update(models.Chunk).where(models.Chunk.id.in_(superseded)).values(embedding=None)
            )
            claim_ids = (
                await session.scalars(
                    select(models.Claim.id).where(
                        models.Claim.project_id == _pid(scope),
                        models.Claim.chunk_id.in_(superseded),
                        active_at_clause(models.Claim.valid_from, models.Claim.valid_to, now),
                    )
                )
            ).all()
            if claim_ids:
                await session.execute(
                    update(models.Claim).where(models.Claim.id.in_(claim_ids)).values(valid_to=now)
                )
                from rsc_brain.skills.staleness import mark_claims_stale_in_session

                await mark_claims_stale_in_session(
                    session,
                    scope,
                    claim_ids,
                    reason="document version superseded knowledge",
                )
            return [str(cid) for cid in claim_ids]

    async def get_document(self, scope: ProjectScope, document_id: str) -> DocRow | None:
        async with self._sm() as session:
            doc = await session.get(models.Document, uuid.UUID(document_id))
            if doc is None or doc.project_id != _pid(scope):
                return None
            return _doc_row(doc)

    async def count_independent_sources(self, scope: ProjectScope, document_id: str) -> int:
        """How many INDEPENDENT documents in this project already carry active claims (R21).

        Independence is counted per source DOCUMENT, not per claim: a document repeating itself is one
        source, which is exactly the distinction corroboration is supposed to make. The document being
        published counts as one, so a first ingest gets 1 and a second independent one gets 2.

        Credibility was previously written with ``n_independent_sources=1`` for every claim, so
        agreement between independent documents never raised it.
        """
        now = _now()
        async with self._sm() as session:
            others = await session.scalar(
                select(func.count(func.distinct(models.Claim.source_document_id))).where(
                    models.Claim.project_id == _pid(scope),
                    models.Claim.source_document_id.is_not(None),
                    models.Claim.source_document_id != uuid.UUID(document_id),
                    active_at_clause(models.Claim.valid_from, models.Claim.valid_to, now),
                )
            )
        return 1 + int(others or 0)

    async def list_documents_by_status(self, scope: ProjectScope, status: str) -> list[DocRow]:
        """Documents in ``status`` that this caller may see.

        R01: the approval queue is topic-scoped content — its titles and proposed tags describe the
        document — so the caller's topic authority filters it in-query. A document with no proposed
        tags yet has no topic dimension and stays visible to an authorized reviewer.
        """
        forbidden = await forbidden_topics(self._sm, scope)
        async with self._sm() as session:
            rows = await session.scalars(
                select(models.Document)
                .where(
                    models.Document.project_id == _pid(scope),
                    models.Document.status == status,
                    topic_clause(models.Document.doc_tags, scope, forbidden, allow_untagged=True),
                )
                .order_by(models.Document.ingested_at)
            )
            return [_doc_row(d) for d in rows]

    async def set_status(
        self,
        scope: ProjectScope,
        document_id: str,
        status: str,
        *,
        approved_by: str | None = None,
        reject_reason: str | None = None,
        doc_tags: Sequence[str] | None = None,
    ) -> None:
        values = self._status_values(
            status, approved_by=approved_by, reject_reason=reject_reason, doc_tags=doc_tags
        )
        async with session_scope(self._sm) as session:
            await session.execute(
                update(models.Document)
                .where(
                    models.Document.id == uuid.UUID(document_id),
                    models.Document.project_id == _pid(scope),
                )
                .values(**values)
            )
            await self._touch_run_phase(session, scope, document_id, status)

    @staticmethod
    def _status_values(
        status: str,
        *,
        approved_by: str | None,
        reject_reason: str | None,
        doc_tags: Sequence[str] | None,
    ) -> dict[str, Any]:
        values: dict[str, Any] = {"status": status}
        if approved_by is not None:
            values["approved_at"] = _now()
            # A real user id is stored; a system/CLI label (not a UUID) records the approval time
            # without a user reference.
            try:
                values["approved_by"] = uuid.UUID(approved_by)
            except ValueError:
                values["approved_by"] = None
        if reject_reason is not None:
            values["reject_reason"] = reject_reason
        if doc_tags is not None:
            values["doc_tags"] = list(doc_tags)
        return values

    async def transition_status(
        self,
        scope: ProjectScope,
        document_id: str,
        *,
        expected: Sequence[str],
        status: str,
        approved_by: str | None = None,
        reject_reason: str | None = None,
        doc_tags: Sequence[str] | None = None,
    ) -> bool:
        """Move the document to ``status`` only if it is currently in one of ``expected``.

        Returns whether this caller made the transition. R31: approve and reject each used to READ the
        status, decide, and then WRITE in a separate transaction, so racing them produced two winners —
        a document could end up rejected with its claims already published, or approved with an audit
        trail saying it was refused. The condition lives in the UPDATE, so exactly one caller can win
        and the loser learns it lost instead of overwriting.
        """
        values = self._status_values(
            status, approved_by=approved_by, reject_reason=reject_reason, doc_tags=doc_tags
        )
        async with session_scope(self._sm) as session:
            # `CursorResult.rowcount` is how "did I win?" is answered; the typed `Result` protocol
            # does not expose it, hence the narrowing cast rather than a second SELECT (which would
            # reintroduce exactly the read-then-write gap this method exists to close).
            result = cast(
                CursorResult[Any],
                await session.execute(
                    update(models.Document)
                    .where(
                        models.Document.id == uuid.UUID(document_id),
                        models.Document.project_id == _pid(scope),
                        models.Document.status.in_(list(expected)),
                    )
                    .values(**values)
                ),
            )
            if not result.rowcount:
                return False
            await self._touch_run_phase(session, scope, document_id, status)
        return True

    # --- runs & checkpoints --------------------------------------------------

    async def ensure_run(self, scope: ProjectScope, document_id: str, *, phase: str) -> None:
        async with session_scope(self._sm) as session:
            statement = (
                pg_insert(models.IngestRun)
                .values(project_id=_pid(scope), document_id=uuid.UUID(document_id), phase=phase)
                .on_conflict_do_nothing(index_elements=["document_id"])
            )
            await session.execute(statement)
            # AUDIT-071: AUDIT-068 made a failure durable so an operator could read it, and nothing
            # cleared it. A document that failed and was then retried (AUDIT-069) finished as
            # `phase: processed` with all seven stages and 2 claims, still carrying the
            # `ConversionError` from the attempt before — observed on the host. The AUDIT-065 note has
            # a clearing rule, but it matches only its own text. The error field describes the LATEST
            # attempt, so a new attempt starts with a clean one. This is the single choke point every
            # attempt passes through (the service's admit and `pipeline.process` both call it), which
            # is why the reset lives here and not in one caller.
            run = await self._get_run(session, scope, document_id)
            if run is not None and run.error is not None:
                run.error = None
                run.updated_at = _now()

    async def _get_run(
        self, session: AsyncSession, scope: ProjectScope, document_id: str
    ) -> models.IngestRun | None:
        run: models.IngestRun | None = await session.scalar(
            select(models.IngestRun).where(
                models.IngestRun.project_id == _pid(scope),
                models.IngestRun.document_id == uuid.UUID(document_id),
            )
        )
        return run

    async def is_stage_complete(
        self, scope: ProjectScope, document_id: str, stage: PipelineStage
    ) -> bool:
        async with self._sm() as session:
            run = await self._get_run(session, scope, document_id)
            return bool(run and stage.value in run.completed_stages)

    async def get_run_status(self, scope: ProjectScope, document_id: str) -> RunStatus | None:
        async with self._sm() as session:
            run = await self._get_run(session, scope, document_id)
            return _run_status(run) if run else None

    async def get_publish_draft(
        self, scope: ProjectScope, document_id: str
    ) -> dict[str, object] | None:
        """Return the durable publish material left by a prior attempt, if any."""

        async with self._sm() as session:
            run = await self._get_run(session, scope, document_id)
            return dict(run.publish_draft) if run and run.publish_draft is not None else None

    async def save_publish_draft(
        self, scope: ProjectScope, document_id: str, draft: Mapping[str, object]
    ) -> dict[str, object]:
        """Durably freeze and return the one canonical draft under concurrent workers."""

        async with session_scope(self._sm) as session:
            run = await self._get_run(session, scope, document_id)
            if run is None:
                run = models.IngestRun(
                    project_id=_pid(scope),
                    document_id=uuid.UUID(document_id),
                    phase=DocStatus.APPROVED.value,
                )
                session.add(run)
                await session.flush()
            canonical = await session.scalar(
                update(models.IngestRun)
                .where(
                    models.IngestRun.id == run.id,
                    models.IngestRun.project_id == _pid(scope),
                    models.IngestRun.publish_draft.is_(None),
                )
                .values(publish_draft=dict(draft), updated_at=_now())
                .returning(models.IngestRun.publish_draft)
            )
            if canonical is None:
                await session.refresh(run)
                canonical = run.publish_draft
            if canonical is None:  # pragma: no cover - guarded insert/update invariant
                raise RuntimeError("publish draft was not persisted")
            return dict(canonical)

    async def finalize_publish(
        self,
        session: AsyncSession,
        scope: ProjectScope,
        document_id: str,
    ) -> None:
        """Checkpoint PERSIST, mark processed and consume the draft in the caller's transaction."""

        await self._mark_stages(
            session,
            scope,
            document_id,
            [PipelineStage.PERSIST],
            phase=DocStatus.PROCESSED.value,
            counters=None,
        )
        await session.execute(
            update(models.Document)
            .where(
                models.Document.id == uuid.UUID(document_id),
                models.Document.project_id == _pid(scope),
            )
            .values(status=DocStatus.PROCESSED.value)
        )
        run = await self._get_run(session, scope, document_id)
        if run is not None:
            run.publish_draft = None
            run.error = None
            run.updated_at = _now()

    async def list_run_statuses(self, scope: ProjectScope) -> list[RunStatus]:
        async with self._sm() as session:
            rows = await session.scalars(
                select(models.IngestRun)
                .where(models.IngestRun.project_id == _pid(scope))
                .order_by(models.IngestRun.started_at)
            )
            return [_run_status(r) for r in rows]

    async def _mark_stages(
        self,
        session: AsyncSession,
        scope: ProjectScope,
        document_id: str,
        stages: Sequence[PipelineStage],
        *,
        phase: str | None,
        counters: Counters | None,
    ) -> None:
        run = await self._get_run(session, scope, document_id)
        if run is None:
            run = models.IngestRun(
                project_id=_pid(scope), document_id=uuid.UUID(document_id), phase=phase or "parsed"
            )
            session.add(run)
            await session.flush()
        completed = list(run.completed_stages)
        for stage in stages:
            if stage.value not in completed:
                completed.append(stage.value)
        run.completed_stages = completed
        if phase is not None:
            run.phase = phase
        if counters is not None:
            run.chunks_created += counters.chunks_created
            run.claims_generated += counters.claims_generated
            run.tables_converted += counters.tables_converted
            run.tables_needs_review += counters.tables_needs_review
            run.discarded_chunks += counters.discarded_chunks
            # AUDIT-065: a document whose every chunk was discarded used to finish as
            # `phase: processed` with `error: null` — zero knowledge published, and the only signal
            # a counter in a separate status call. An operator read "processed" and believed it
            # worked. Discarding is correct (FR-1.8: never garbage to the graph); reporting it as
            # unqualified success is not, so the run says what happened. Computed from the run's
            # ACCUMULATED totals, because one stage's delta cannot see the whole document.
            if (
                run.chunks_created > 0
                and run.claims_generated == 0
                and run.discarded_chunks >= run.chunks_created
            ):
                run.error = (
                    f"no knowledge published: all {run.discarded_chunks} of "
                    f"{run.chunks_created} chunk(s) were discarded by extraction. The document was "
                    "parsed and stored, but produced no claims — check that the extractor "
                    "capability is reachable and that its model returns the expected structure."
                )
            elif run.claims_generated > 0 and run.error and "no knowledge published" in run.error:
                run.error = None  # a later stage produced claims; the note no longer holds
        run.updated_at = _now()

    async def record_run_error(self, scope: ProjectScope, document_id: str, error: str) -> None:
        """Record why an ingestion stopped, where `brain status` reads it (AUDIT-068).

        A failure that only reaches the caller's stderr is invisible to the console, to a
        worker-driven ingest, and to anyone looking a week later. The run is the durable place that
        answers "what happened to my document".
        """
        async with session_scope(self._sm) as session:
            run = await self._get_run(session, scope, document_id)
            if run is None:
                run = models.IngestRun(
                    project_id=_pid(scope),
                    document_id=uuid.UUID(document_id),
                    phase=DocStatus.RECEIVED.value,
                )
                session.add(run)
                await session.flush()
            run.error = error
            run.updated_at = _now()

    async def _touch_run_phase(
        self, session: AsyncSession, scope: ProjectScope, document_id: str, phase: str
    ) -> None:
        run = await self._get_run(session, scope, document_id)
        if run is not None:
            run.phase = phase
            run.updated_at = _now()

    async def mark_stage(
        self,
        scope: ProjectScope,
        document_id: str,
        stage: PipelineStage,
        *,
        phase: str | None = None,
        counters: Counters | None = None,
    ) -> None:
        async with session_scope(self._sm) as session:
            await self._mark_stages(
                session, scope, document_id, [stage], phase=phase, counters=counters
            )

    async def set_run_error(self, scope: ProjectScope, document_id: str, error: str) -> None:
        async with session_scope(self._sm) as session:
            run = await self._get_run(session, scope, document_id)
            if run is not None:
                run.error = error
                run.updated_at = _now()

    # --- chunk persistence (parse phase) -------------------------------------

    async def persist_chunks(
        self,
        scope: ProjectScope,
        document_id: str,
        specs: Sequence[ProposedChunk],
        *,
        counters: Counters,
    ) -> list[ChunkRow]:
        """Idempotently replace a document's chunks and checkpoint PARSE/TABLES/CHUNK (one tx).

        No embeddings are written here: nothing is vector-recallable until publish (D13). A
        ``needs_review`` chunk gets the reserved tag and stays embedding-less forever."""
        async with session_scope(self._sm) as session:
            await session.execute(
                delete(models.Chunk).where(
                    models.Chunk.document_id == uuid.UUID(document_id),
                    models.Chunk.project_id == _pid(scope),
                )
            )
            rows: list[ChunkRow] = []
            for ordinal, spec in enumerate(specs):
                tags = (NEEDS_REVIEW_TAG,) if spec.needs_review else spec.tags
                chunk = models.Chunk(
                    project_id=_pid(scope),
                    document_id=uuid.UUID(document_id),
                    ordinal=ordinal,
                    page=spec.page,
                    bbox=spec.bbox,
                    kind=spec.kind.value,
                    cut_type=spec.cut_type,
                    text=spec.text,
                    tags=list(tags),
                    extraction_confidence=spec.extraction_confidence,
                    needs_review=spec.needs_review,
                )
                session.add(chunk)
                await session.flush()
                rows.append(
                    ChunkRow(
                        id=str(chunk.id),
                        kind=chunk.kind,
                        text=chunk.text,
                        tags=tuple(tags),
                        needs_review=spec.needs_review,
                        extraction_confidence=spec.extraction_confidence,
                        ordinal=ordinal,
                    )
                )
            await self._mark_stages(
                session,
                scope,
                document_id,
                [PipelineStage.PARSE, PipelineStage.TABLES, PipelineStage.CHUNK],
                phase="parsed",
                counters=counters,
            )
            return rows

    async def load_chunks(self, scope: ProjectScope, document_id: str) -> list[ChunkRow]:
        async with self._sm() as session:
            rows = await session.scalars(
                select(models.Chunk)
                .where(
                    models.Chunk.document_id == uuid.UUID(document_id),
                    models.Chunk.project_id == _pid(scope),
                )
                .order_by(models.Chunk.ordinal, models.Chunk.id)
            )
            return [
                ChunkRow(
                    id=str(c.id),
                    kind=c.kind,
                    text=c.text,
                    tags=tuple(c.tags),
                    needs_review=c.needs_review,
                    extraction_confidence=(
                        float(c.extraction_confidence)
                        if c.extraction_confidence is not None
                        else None
                    ),
                    ordinal=c.ordinal,
                )
                for c in rows
            ]

    async def claim_ids_by_chunk(
        self, scope: ProjectScope, document_id: str
    ) -> dict[str, tuple[str, ...]]:
        """Active claim identities asserted by each concrete chunk occurrence in one version."""

        async with self._sm() as session:
            rows = (
                await session.execute(
                    select(models.ClaimOccurrence.chunk_id, models.ClaimOccurrence.claim_id)
                    .join(
                        models.Claim,
                        (models.Claim.project_id == models.ClaimOccurrence.project_id)
                        & (models.Claim.id == models.ClaimOccurrence.claim_id),
                    )
                    .where(
                        models.ClaimOccurrence.project_id == _pid(scope),
                        models.ClaimOccurrence.document_id == uuid.UUID(document_id),
                        models.Claim.valid_to.is_(None),
                    )
                    .order_by(models.ClaimOccurrence.chunk_id, models.ClaimOccurrence.claim_id)
                )
            ).all()
        grouped: dict[str, list[str]] = {}
        for chunk_id, claim_id in rows:
            grouped.setdefault(str(chunk_id), []).append(str(claim_id))
        return {chunk_id: tuple(claim_ids) for chunk_id, claim_ids in grouped.items()}

    async def active_claims_by_chunk(
        self, scope: ProjectScope, document_id: str
    ) -> dict[str, tuple[ClaimIdentityRow, ...]]:
        """Full active claim identity material for each occurrence in a document version."""

        async with self._sm() as session:
            rows = (
                await session.execute(
                    select(
                        models.ClaimOccurrence.chunk_id,
                        models.Claim.id,
                        models.Claim.text,
                        models.Claim.subject,
                        models.Claim.predicate,
                        models.Claim.object,
                    )
                    .join(
                        models.Claim,
                        (models.Claim.project_id == models.ClaimOccurrence.project_id)
                        & (models.Claim.id == models.ClaimOccurrence.claim_id),
                    )
                    .where(
                        models.ClaimOccurrence.project_id == _pid(scope),
                        models.ClaimOccurrence.document_id == uuid.UUID(document_id),
                        models.Claim.valid_to.is_(None),
                    )
                    .order_by(models.ClaimOccurrence.chunk_id, models.Claim.id)
                )
            ).all()
        grouped: dict[str, list[ClaimIdentityRow]] = {}
        for chunk_id, claim_id, claim_text, subject, predicate, object_ in rows:
            grouped.setdefault(str(chunk_id), []).append(
                ClaimIdentityRow(
                    id=str(claim_id),
                    chunk_id=str(chunk_id),
                    text=str(claim_text),
                    subject=subject,
                    predicate=predicate,
                    object=object_,
                )
            )
        return {chunk_id: tuple(claims) for chunk_id, claims in grouped.items()}

    async def apply_topics(
        self,
        scope: ProjectScope,
        document_id: str,
        *,
        chunk_tags: Mapping[str, Sequence[str]],
        doc_tags: Sequence[str],
        status: str,
        review_chunk_ids: Sequence[str] = (),
    ) -> None:
        """Write tags, new review quarantines and document policy state, then checkpoint
        TOPICALIZE in the same transaction."""
        async with session_scope(self._sm) as session:
            # AUDIT-066b: the topicalizer writes tags, but nothing created a `topics` row for them —
            # so knowledge could carry a name that exists nowhere in the taxonomy. The permission
            # filter cuts on exactly those names, so no administrator could SEE what needed
            # granting, which made the knowledge unreachable and the reason undiscoverable.
            # Granting stays an administrator's decision; discovering what to grant cannot.
            # Idempotent by necessity: the same tag arrives with every document.
            assigned = {tag for tags in chunk_tags.values() for tag in tags} | set(doc_tags)
            if assigned:
                await session.execute(
                    pg_insert(models.Topic)
                    .values(
                        [
                            {"project_id": _pid(scope), "slug": tag, "name": tag, "sensitivity": 0}
                            for tag in sorted(assigned)
                        ]
                    )
                    .on_conflict_do_nothing(index_elements=["project_id", "slug"])
                )
            review_ids = set(review_chunk_ids)
            for chunk_id, tags in chunk_tags.items():
                values: dict[str, Any] = {"tags": list(tags)}
                if chunk_id in review_ids:
                    values["needs_review"] = True
                await session.execute(
                    update(models.Chunk)
                    .where(
                        models.Chunk.id == uuid.UUID(chunk_id),
                        models.Chunk.project_id == _pid(scope),
                    )
                    .values(**values)
                )
            await session.execute(
                update(models.Document)
                .where(
                    models.Document.id == uuid.UUID(document_id),
                    models.Document.project_id == _pid(scope),
                    # T022 re-audit: the parse phase used to write the policy's status unconditionally,
                    # so a document REJECTED while its job sat in the queue was moved back to
                    # `auto_approved` and then published. A terminal decision is not the parse phase's to
                    # revisit; the tags are still recorded either way.
                    models.Document.status.not_in(_TERMINAL_STATUSES),
                )
                .values(doc_tags=list(doc_tags), status=status)
            )
            await self._mark_stages(
                session, scope, document_id, [PipelineStage.TOPICALIZE], phase=status, counters=None
            )

    async def propagate_doc_tags(self, scope: ProjectScope, document_id: str) -> None:
        """Union the document's tags into every non-needs_review chunk (FR-1.15 inheritance);
        the chunk keeps its own finer tags. Used on approve and on re-categorize."""
        async with session_scope(self._sm) as session:
            doc = await session.get(models.Document, uuid.UUID(document_id))
            if doc is None or doc.project_id != _pid(scope):
                return
            chunks = await session.scalars(
                select(models.Chunk).where(
                    models.Chunk.document_id == uuid.UUID(document_id),
                    models.Chunk.project_id == _pid(scope),
                    models.Chunk.needs_review.is_(False),
                )
            )
            for chunk in chunks:
                merged = list(dict.fromkeys([*chunk.tags, *doc.doc_tags]))
                chunk.tags = merged

    # --- publish (post-approval) ---------------------------------------------

    async def record_publish(
        self,
        scope: ProjectScope,
        document_id: str,
        *,
        embeddings: Mapping[str, Sequence[float]],
        claims: Sequence[ClaimSpec],
        entities: Sequence[EntitySpec],
        errors: Sequence[IngestErrorSpec],
        counters: Counters,
        reused_occurrences: Mapping[str, Sequence[str]] | None = None,
        superseded_claim_ids: Sequence[str] = (),
        superseded_chunk_ids: Sequence[str] = (),
        supersessions: Sequence[tuple[str, str]] = (),
        publish_at: dt.datetime | None = None,
        session: AsyncSession | None = None,
    ) -> dict[str, str]:
        """Persist the publish phase relationally: chunk embeddings, claims (replacing any prior),
        entities/aliases (idempotent), ingest_errors, and the EXTRACT/RESOLVE checkpoints. Returns a
        map of ``normalized_name|type`` → entity id.

        R35: takes an optional ``session`` so the caller can commit this and the GRAPH half together.
        They used to be separate transactions, so an interruption between them left claims live in
        Postgres with no relations in AGE — two readable stores disagreeing, with nothing recording
        which half happened.
        """
        async with maybe_session_scope(self._sm, session) as session:
            closed_at = publish_at or _now()
            # Replace this document's claims so a redo cannot duplicate them.
            chunk_ids = (
                await session.scalars(
                    select(models.Chunk.id).where(
                        models.Chunk.document_id == uuid.UUID(document_id),
                        models.Chunk.project_id == _pid(scope),
                    )
                )
            ).all()
            if chunk_ids:
                await session.execute(
                    delete(models.Claim).where(
                        models.Claim.project_id == _pid(scope),
                        models.Claim.chunk_id.in_(chunk_ids),
                    )
                )
            for chunk_id, vector in embeddings.items():
                await session.execute(
                    update(models.Chunk)
                    .where(
                        models.Chunk.id == uuid.UUID(chunk_id),
                        models.Chunk.project_id == _pid(scope),
                    )
                    .values(embedding=list(vector))
                )
            if superseded_chunk_ids:
                await session.execute(
                    update(models.Chunk)
                    .where(
                        models.Chunk.project_id == _pid(scope),
                        models.Chunk.id.in_([uuid.UUID(value) for value in superseded_chunk_ids]),
                    )
                    .values(embedding=None)
                )
            if superseded_claim_ids:
                await session.execute(
                    update(models.Claim)
                    .where(
                        models.Claim.project_id == _pid(scope),
                        models.Claim.id.in_([uuid.UUID(value) for value in superseded_claim_ids]),
                        models.Claim.valid_to.is_(None),
                    )
                    .values(valid_to=closed_at)
                )
            for claim in claims:
                row = models.Claim(
                    **({} if claim.id is None else {"id": uuid.UUID(claim.id)}),
                    project_id=_pid(scope),
                    chunk_id=uuid.UUID(claim.chunk_id),
                    text=claim.text,
                    subject=claim.subject,
                    predicate=claim.predicate,
                    object=claim.object,
                    valid_from=claim.valid_from,
                    valid_to=claim.valid_to,
                    subject_entity_key=(
                        uuid.UUID(claim.subject_entity_key) if claim.subject_entity_key else None
                    ),
                    object_entity_key=(
                        uuid.UUID(claim.object_entity_key) if claim.object_entity_key else None
                    ),
                    tags=list(claim.tags),
                    extraction_confidence=claim.extraction_confidence,
                    source_document_id=uuid.UUID(document_id),
                    embedding=(None if claim.embedding is None else list(claim.embedding)),
                    **({} if claim.credibility is None else {"credibility": claim.credibility}),
                )
                session.add(row)
                await session.flush()
                session.add(
                    models.ClaimOccurrence(
                        project_id=_pid(scope),
                        claim_id=row.id,
                        document_id=uuid.UUID(document_id),
                        chunk_id=uuid.UUID(claim.chunk_id),
                    )
                )
            for chunk_id, claim_ids in (reused_occurrences or {}).items():
                if not claim_ids:
                    continue
                await session.execute(
                    pg_insert(models.ClaimOccurrence)
                    .values(
                        [
                            {
                                "project_id": _pid(scope),
                                "claim_id": uuid.UUID(claim_id),
                                "document_id": uuid.UUID(document_id),
                                "chunk_id": uuid.UUID(chunk_id),
                            }
                            for claim_id in claim_ids
                        ]
                    )
                    .on_conflict_do_nothing(constraint="uq_claim_occurrence_claim_doc_chunk")
                )
            if supersessions:
                await session.execute(
                    pg_insert(models.ClaimSupersession)
                    .values(
                        [
                            {
                                "project_id": _pid(scope),
                                "previous_claim_id": uuid.UUID(previous),
                                "replacement_claim_id": uuid.UUID(replacement),
                            }
                            for previous, replacement in supersessions
                        ]
                    )
                    .on_conflict_do_nothing(constraint="uq_claim_supersession_previous")
                )
            entity_ids = await self._upsert_entities(session, scope, entities)
            from rsc_brain.skills.staleness import mark_tags_and_entities_stale_in_session

            await mark_tags_and_entities_stale_in_session(
                session,
                scope,
                tags=[tag for claim in claims for tag in claim.tags],
                entity_ids=[uuid.UUID(value) for value in entity_ids.values()],
                reason="ingestion published knowledge",
            )
            for err in errors:
                session.add(
                    models.IngestError(
                        project_id=_pid(scope),
                        document_id=uuid.UUID(document_id),
                        chunk_ref=err.chunk_ref,
                        stage=err.stage,
                        error=err.error,
                    )
                )
            await self._mark_stages(
                session,
                scope,
                document_id,
                [PipelineStage.EXTRACT, PipelineStage.RESOLVE],
                phase="approved",
                counters=counters,
            )
            return entity_ids

    async def _upsert_entities(
        self, session: AsyncSession, scope: ProjectScope, entities: Sequence[EntitySpec]
    ) -> dict[str, str]:
        """Create or reuse each entity — except one this project has erased (R43).

        Erasure never auto-revives (AUDIT-023, ratified). Without this check the next document naming an
        erased person recreated the entity as if nothing had happened: no decision, no audit, and no way
        for the operator who performed the erasure to know it came back. Allowing the name again is an
        explicit owner action that retires the tombstone.
        """
        erased = await self._erased_names(session, scope)
        ids: dict[str, str] = {}
        for entity in entities:
            norm = normalize_name(entity.name)
            key = f"{norm}|{entity.type}"
            if key in ids:
                continue
            if norm in erased:
                continue  # tombstoned: the extraction still ran, the identity is simply not recreated
            statement = (
                pg_insert(models.Entity)
                .values(
                    project_id=_pid(scope),
                    name=entity.name,
                    normalized_name=norm,
                    type=entity.type,
                )
                .on_conflict_do_nothing(index_elements=["project_id", "normalized_name", "type"])
            )
            await session.execute(statement)
            entity_id = await session.scalar(
                select(models.Entity.id).where(
                    models.Entity.project_id == _pid(scope),
                    models.Entity.normalized_name == norm,
                    models.Entity.type == entity.type,
                )
            )
            if entity_id is None:
                continue
            ids[key] = str(entity_id)
            await self._insert_new_aliases(session, scope, str(entity_id), entity.aliases)
        return ids

    @staticmethod
    async def _erased_names(session: AsyncSession, scope: ProjectScope) -> frozenset[str]:
        """Normalized names this project has erased and not authorized back (R43)."""
        rows = await session.scalars(
            select(models.ErasureTombstone.normalized_name).where(
                models.ErasureTombstone.project_id == _pid(scope),
                models.ErasureTombstone.retired_at.is_(None),
            )
        )
        return frozenset(rows)

    async def _insert_new_aliases(
        self,
        session: AsyncSession,
        scope: ProjectScope,
        entity_id: str,
        aliases: Sequence[str],
    ) -> None:
        if not aliases:
            return
        existing = set(
            (
                await session.scalars(
                    select(models.EntityAlias.alias).where(
                        models.EntityAlias.entity_id == uuid.UUID(entity_id),
                        models.EntityAlias.project_id == _pid(scope),
                    )
                )
            ).all()
        )
        for alias in dict.fromkeys(aliases):
            if alias and alias not in existing:
                session.add(
                    models.EntityAlias(
                        project_id=_pid(scope),
                        entity_id=uuid.UUID(entity_id),
                        alias=alias,
                    )
                )

    async def count_claims(self, scope: ProjectScope, document_id: str) -> int:
        async with self._sm() as session:
            total = await session.scalar(
                select(func.count())
                .select_from(models.Claim)
                .join(models.Chunk, models.Claim.chunk_id == models.Chunk.id)
                .where(
                    models.Chunk.document_id == uuid.UUID(document_id),
                    models.Claim.project_id == _pid(scope),
                )
            )
            return int(total or 0)

    async def list_topics(self, scope: ProjectScope) -> list[tuple[str, int]]:
        """The project's taxonomy: ``(slug, sensitivity)`` pairs (SPEC-02/04 topics)."""
        async with self._sm() as session:
            rows = await session.execute(
                select(models.Topic.slug, models.Topic.sensitivity).where(
                    models.Topic.project_id == _pid(scope)
                )
            )
            return [(slug, int(sens)) for slug, sens in rows.all()]

    async def get_topic_rules(self, scope: ProjectScope) -> list[TopicRule]:
        """Admin regex/keyword topic rules from ``projects.settings['topic_rules']`` (FR-1.7).

        Each rule is ``{"pattern": <regex>, "tag": <slug>}``; malformed entries are skipped."""
        async with self._sm() as session:
            settings = await session.scalar(
                select(models.Project.settings).where(models.Project.id == _pid(scope))
            )
        raw = (settings or {}).get("topic_rules", [])
        rules: list[TopicRule] = []
        if isinstance(raw, list):
            for entry in raw:
                if isinstance(entry, Mapping) and "pattern" in entry and "tag" in entry:
                    rules.append(TopicRule(pattern=str(entry["pattern"]), tag=str(entry["tag"])))
        return rules

    async def list_ingest_errors(
        self, scope: ProjectScope, document_id: str
    ) -> list[IngestErrorSpec]:
        async with self._sm() as session:
            rows = await session.scalars(
                select(models.IngestError).where(
                    models.IngestError.project_id == _pid(scope),
                    models.IngestError.document_id == uuid.UUID(document_id),
                )
            )
            return [
                IngestErrorSpec(chunk_ref=e.chunk_ref, stage=e.stage, error=e.error) for e in rows
            ]


def _source_row(source: models.Source) -> SourceRow:
    return SourceRow(
        id=str(source.id),
        name=source.name,
        type=source.type,
        policy=source.policy,
        default_tags=tuple(source.default_tags),
        review_if_sensitive=source.review_if_sensitive,
        curators=tuple(str(c) for c in source.curators),
    )


def _doc_row(doc: models.Document) -> DocRow:
    return DocRow(
        id=str(doc.id),
        project_id=str(doc.project_id),
        source_id=str(doc.source_id) if doc.source_id else None,
        logical_id=doc.logical_id,
        checksum=doc.checksum,
        title=doc.title,
        path=doc.path,
        lang=doc.lang,
        status=doc.status,
        doc_tags=tuple(doc.doc_tags),
        version=doc.version,
    )


def _run_status(run: models.IngestRun) -> RunStatus:
    return RunStatus(
        document_id=str(run.document_id),
        project_id=str(run.project_id),
        phase=run.phase,
        completed_stages=tuple(run.completed_stages),
        chunks_created=run.chunks_created,
        claims_generated=run.claims_generated,
        tables_converted=run.tables_converted,
        tables_needs_review=run.tables_needs_review,
        discarded_chunks=run.discarded_chunks,
        error=run.error,
        updated_at=run.updated_at,
    )
