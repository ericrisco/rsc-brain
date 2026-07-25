"""Ingestion façade (SPEC-05): the entry point CLI/API/watcher share.

Deduplicates by SHA-256 per project (FR-1.2/12.6 — the same file in two projects is two
documents; the same file twice in one project is a registered no-op), stores the blob so parsing
is resumable, creates the document, and drives the pipeline. All access is through a
:class:`~rsc_brain.scope.ProjectScope`.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from rsc_brain.ingest.pipeline import IngestionPipeline
from rsc_brain.ingest.types import DocStatus, RunStatus
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational.ingest_repository import DocRow, IngestRepository, SourceRow


@dataclass(frozen=True, slots=True)
class IngestOutcome:
    document_id: str
    status: str
    duplicate: bool


class IngestQueueProtocol(Protocol):
    """The one thing this service needs from a queue: durable acceptance of one document."""

    async def enqueue(self, *, document_id: str, project_id: str, principal_id: str) -> None: ...


class IngestService:
    def __init__(
        self,
        repository: IngestRepository,
        pipeline: IngestionPipeline,
        *,
        data_dir: str | Path = "data",
        queue: IngestQueueProtocol | None = None,
    ) -> None:
        self._repo = repository
        self._pipeline = pipeline
        self._blobs = Path(data_dir) / "blobs"
        # R37: when a queue is configured, accepting a document ENQUEUES the heavy work instead of
        # doing it on the caller's thread. Without one the pipeline still runs inline, which is what
        # the CLI and the tests want — a synchronous ingest is a legitimate local operation, it is just
        # not what an accepted HTTP request should do.
        self._queue = queue

    async def ingest_bytes(
        self,
        scope: ProjectScope,
        data: bytes,
        *,
        filename: str,
        source: str | None = None,
        run: bool = True,
    ) -> IngestOutcome:
        """Ingest raw bytes. Returns a duplicate no-op if the checksum already exists in-project."""
        checksum = hashlib.sha256(data).hexdigest()
        existing = await self._repo.find_document_by_checksum(scope, checksum)
        if existing is not None:
            return IngestOutcome(existing.id, existing.status, duplicate=True)

        source_row = await self._resolve_source(scope, source)
        path = self._store_blob(scope, checksum, filename, data)
        logical_id = Path(filename).stem or checksum[:12]
        # Same logical id + new checksum ⇒ a new version (SPEC-09 D6, AC#1); the pipeline then
        # diffs unchanged chunks against the prior version so their claims aren't re-extracted.
        version = await self._repo.latest_version_for_logical_id(scope, logical_id) + 1
        document_id = await self._repo.create_document(
            scope,
            logical_id=logical_id,
            checksum=checksum,
            source_id=source_row.id,
            title=Path(filename).stem or None,
            path=str(path),
            version=version,
        )
        await self._repo.ensure_run(scope, document_id, phase=DocStatus.RECEIVED.value)
        if not run:
            return IngestOutcome(document_id, DocStatus.RECEIVED.value, duplicate=False)
        if self._queue is not None:
            # The durable record exists BEFORE the heavy work: the document row, its run checkpoint and
            # the queue entry are all persisted, so a process that dies here loses nothing and the
            # worker retries from the last checkpoint (the pipeline is idempotent, SPEC-05).
            await self._queue.enqueue(
                document_id=document_id,
                project_id=scope.project_id,
                principal_id=scope.principal_id,
            )
            return IngestOutcome(document_id, DocStatus.RECEIVED.value, duplicate=False)
        status = await self._pipeline.process(scope, document_id)
        return IngestOutcome(document_id, status.phase, duplicate=False)

    async def ingest_path(
        self, scope: ProjectScope, path: str | Path, *, source: str | None = None
    ) -> IngestOutcome:
        file_path = Path(path)
        return await self.ingest_bytes(
            scope, file_path.read_bytes(), filename=file_path.name, source=source
        )

    async def status(self, scope: ProjectScope) -> list[RunStatus]:
        return await self._repo.list_run_statuses(scope)

    async def run_status(self, scope: ProjectScope, document_id: str) -> RunStatus | None:
        return await self._repo.get_run_status(scope, document_id)

    async def review_queue(self, scope: ProjectScope) -> list[DocRow]:
        return await self._repo.list_documents_by_status(scope, DocStatus.PENDING_APPROVAL.value)

    async def approve(
        self,
        scope: ProjectScope,
        document_id: str,
        *,
        tags: list[str] | None = None,
        approver: str | None = None,
    ) -> RunStatus:
        return await self._pipeline.approve(scope, document_id, tags=tags, approver=approver)

    async def reject(self, scope: ProjectScope, document_id: str, *, reason: str) -> RunStatus:
        return await self._pipeline.reject(scope, document_id, reason=reason)

    async def _resolve_source(self, scope: ProjectScope, source: str | None) -> SourceRow:
        if source is not None:
            existing = await self._repo.get_source_by_name(scope, source)
            if existing is not None:
                return existing
        return await self._repo.ensure_default_source(scope)

    def _store_blob(self, scope: ProjectScope, checksum: str, filename: str, data: bytes) -> Path:
        directory = self._blobs / scope.project_id
        directory.mkdir(parents=True, exist_ok=True)
        destination = directory / f"{checksum}{Path(filename).suffix}"
        destination.write_bytes(data)  # content-addressed → writing twice is harmless
        return destination
