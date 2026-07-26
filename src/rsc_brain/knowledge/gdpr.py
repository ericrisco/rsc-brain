"""GDPR erasure + retention (SPEC-22, FR-4.6). Project-scoped, symmetric to forget --document.

``forget_entity`` hard-deletes an entity (and its aliases) and **tombstones its graph node**, so
recall/k-hop return no trace and re-resolving the same ``uuid5`` never silently revives it.
``purge_audit`` drops audit rows older than the configured retention (default 365 days).
"""

from __future__ import annotations

import datetime as dt
import logging
import uuid
from pathlib import Path
from typing import Any, cast

from sqlalchemy import CursorResult, delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.ingest.entity_resolution import entity_id, normalize_name
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope
from rsc_brain.stores.relational.store import PgRelationalStore

_log = logging.getLogger(__name__)

DEFAULT_AUDIT_RETENTION_DAYS = 365


async def forget_entity(
    sessionmaker: async_sessionmaker[AsyncSession], scope: ProjectScope, name: str
) -> dict[str, int]:
    """Erase every entity in the project matching ``name`` (by surface or normalized name).

    R43: this used to delete the entity row, its aliases and its graph node, and nothing else — so the
    CLAIMS kept the erased name in ``text``, ``subject`` and ``object``, with live embeddings, and
    recall still answered with it. The row was gone and the person was not, which is the one outcome a
    subject-access erasure exists to prevent.

    The ratified policy (AUDIT-023): active serving of every affected claim stops immediately, and a
    claim is only retained when NO erased content remains in it. Nothing here can decide that a
    sentence naming the person is safe to keep, so an affected claim is deleted, along with the chunk
    whose text carries the same sentence — a chunk is what recall serves from, so leaving it would
    erase the claim and keep the disclosure.

    Erasure also records an anti-revival tombstone: without one the next document naming the same
    person recreates the entity as if nothing had happened, with no decision and no audit. Retiring a
    tombstone is an explicit, audited owner action (``allow_entity_again``).
    """
    pid = uuid.UUID(scope.project_id)
    normalized = normalize_name(name)
    async with sessionmaker() as session:
        rows = list(
            await session.scalars(
                select(models.Entity).where(
                    models.Entity.project_id == pid,
                    or_(
                        models.Entity.name == name,
                        models.Entity.normalized_name == normalized,
                    ),
                )
            )
        )
        entity_ids = [e.id for e in rows]
        node_ids = [str(entity_id(e.type, e.name)) for e in rows]

    surfaces = {name, *(e.name for e in rows)}
    tombstoned = await AgeGraphStore(sessionmaker).tombstone_nodes(scope, node_ids)

    async with session_scope(sessionmaker) as session:
        if entity_ids:
            await session.execute(
                delete(models.EntityAlias).where(
                    models.EntityAlias.project_id == pid,
                    models.EntityAlias.entity_id.in_(entity_ids),
                )
            )
            await session.execute(
                delete(models.Entity).where(
                    models.Entity.project_id == pid, models.Entity.id.in_(entity_ids)
                )
            )
        erased_claims = await _erase_claims_naming(session, pid, surfaces)
        session.add(
            models.ErasureTombstone(
                project_id=pid,
                normalized_name=normalized,
                entity_type=rows[0].type if rows else None,
                erased_by=scope.principal_id if _is_uuid(scope.principal_id) else None,
            )
        )
        session.add(
            models.AuditLog(
                project_id=pid,
                action="forget_entity",
                tool="cli",
                principal_type="human",
                principal_id=scope.principal_id if _is_uuid(scope.principal_id) else None,
                denied=False,
            )
        )
    return {
        "deleted_entities": len(entity_ids),
        "tombstoned": tombstoned,
        "erased_claims": erased_claims,
    }


async def _erase_claims_naming(
    session: AsyncSession, project_id: uuid.UUID, surfaces: set[str]
) -> int:
    """Delete every claim (and the chunk it came from) whose text or endpoints name an erased entity.

    Matching is on the SURFACE forms, case-insensitively: the stored text is what a reader sees, and a
    normalized comparison would miss "ANA RUIZ" in a sentence. Chunks go too — a chunk is what recall
    serves, so deleting the claim alone would erase the assertion and keep the disclosure.
    """
    predicates = []
    for surface in sorted(s for s in surfaces if s and s.strip()):
        pattern = f"%{surface}%"
        predicates.extend(
            [
                models.Claim.text.ilike(pattern),
                models.Claim.subject.ilike(pattern),
                models.Claim.object.ilike(pattern),
            ]
        )
    if not predicates:
        return 0
    rows = (
        await session.execute(
            select(models.Claim.id, models.Claim.chunk_id).where(
                models.Claim.project_id == project_id, or_(*predicates)
            )
        )
    ).all()
    claim_ids = [r[0] for r in rows]
    chunk_ids = [r[1] for r in rows if r[1] is not None]
    if claim_ids:
        await session.execute(
            delete(models.Claim).where(
                models.Claim.project_id == project_id, models.Claim.id.in_(claim_ids)
            )
        )
    if chunk_ids:
        # The chunk carries the same sentence and is what the vector index serves from.
        await session.execute(
            delete(models.Chunk).where(
                models.Chunk.project_id == project_id, models.Chunk.id.in_(chunk_ids)
            )
        )
    return len(claim_ids)


async def entity_is_erased(
    sessionmaker: async_sessionmaker[AsyncSession], scope: ProjectScope, name: str
) -> bool:
    """Whether this project has erased ``name`` and not authorized it back (R43).

    Consulted by ingestion: erasure never auto-revives, so a document naming an erased entity must not
    recreate it silently.
    """
    async with sessionmaker() as session:
        found = await session.scalar(
            select(models.ErasureTombstone.id).where(
                models.ErasureTombstone.project_id == uuid.UUID(scope.project_id),
                models.ErasureTombstone.normalized_name == normalize_name(name),
                models.ErasureTombstone.retired_at.is_(None),
            )
        )
    return found is not None


async def erased_names(
    sessionmaker: async_sessionmaker[AsyncSession], scope: ProjectScope
) -> frozenset[str]:
    """Every normalized name this project has erased and not authorized back."""
    async with sessionmaker() as session:
        rows = await session.scalars(
            select(models.ErasureTombstone.normalized_name).where(
                models.ErasureTombstone.project_id == uuid.UUID(scope.project_id),
                models.ErasureTombstone.retired_at.is_(None),
            )
        )
        return frozenset(rows)


async def allow_entity_again(
    sessionmaker: async_sessionmaker[AsyncSession], scope: ProjectScope, name: str
) -> bool:
    """Retire an anti-revival tombstone — an explicit, audited owner decision (AUDIT-023).

    Erasure never auto-revives; this is the only way back, and it is recorded as its own action so the
    operator who erased can see that someone chose to allow the name again.
    """
    async with session_scope(sessionmaker) as session:
        result = await session.execute(
            update(models.ErasureTombstone)
            .where(
                models.ErasureTombstone.project_id == uuid.UUID(scope.project_id),
                models.ErasureTombstone.normalized_name == normalize_name(name),
                models.ErasureTombstone.retired_at.is_(None),
            )
            .values(retired_at=func.now())
        )
        retired = bool(cast("CursorResult[Any]", result).rowcount)
        if retired:
            session.add(
                models.AuditLog(
                    project_id=uuid.UUID(scope.project_id),
                    action="allow_entity_again",
                    tool="cli",
                    principal_type="human",
                    principal_id=scope.principal_id if _is_uuid(scope.principal_id) else None,
                    denied=False,
                )
            )
    return retired


async def forget_document(
    sessionmaker: async_sessionmaker[AsyncSession],
    scope: ProjectScope,
    document_id: str,
    *,
    data_dir: str | None = None,
) -> dict[str, int]:
    """Hard-delete a document: its rows, its graph nodes AND the stored original (R42).

    Deleting the row used to be all of it, so the file at ``Document.path`` stayed on disk after a
    deletion the operator was told had succeeded. "Forget this document" has to mean the document.

    The blob is removed LAST: if it fails, the rows are already gone and a retry still finds the path
    recorded in the audit trail — the reverse order would leave a live document with no content.
    """
    path = await _document_path(sessionmaker, scope, document_id)
    deleted = (
        await PgRelationalStore(sessionmaker).knowledge().hard_delete_document(scope, document_id)
    )
    tombstoned = await AgeGraphStore(sessionmaker).tombstone_document(scope, document_id)
    removed = _remove_blob(path, data_dir=data_dir)
    async with session_scope(sessionmaker) as session:
        session.add(
            models.AuditLog(
                project_id=uuid.UUID(scope.project_id),
                action="forget_document",
                tool="cli",
                principal_type="human",
                principal_id=scope.principal_id if _is_uuid(scope.principal_id) else None,
                denied=False,
            )
        )
    return {"deleted": deleted, "tombstoned": tombstoned, "blobs_removed": int(removed)}


async def _document_path(
    sessionmaker: async_sessionmaker[AsyncSession], scope: ProjectScope, document_id: str
) -> str | None:
    async with sessionmaker() as session:
        return await session.scalar(
            select(models.Document.path).where(
                models.Document.id == uuid.UUID(document_id),
                models.Document.project_id == uuid.UUID(scope.project_id),
            )
        )


def _remove_blob(path: str | None, *, data_dir: str | None) -> bool:
    """Delete a stored original. Refuses a path outside the configured data directory.

    A recorded path is data, and data decides which file to unlink here — so it is checked against the
    directory the install owns rather than trusted. A path that escapes is left alone and reported.
    """
    if not path:
        return False
    target = Path(path)
    if data_dir is not None:
        root = Path(data_dir).resolve()
        try:
            resolved = target.resolve()
            resolved.relative_to(root)
        except (ValueError, OSError):
            _log.warning("blob_outside_data_dir", extra={"path": str(target)})
            return False
        target = resolved
    try:
        target.unlink(missing_ok=True)
    except OSError:  # a directory, a permission problem — reported, never fatal for the erasure
        _log.warning("blob_unlink_failed", extra={"path": str(target)})
        return False
    return True


async def hard_delete_project(
    sessionmaker: async_sessionmaker[AsyncSession],
    scope: ProjectScope,
    *,
    data_dir: str | None = None,
) -> dict[str, int]:
    """Hard-delete an entire project across EVERY store (SPEC-22, FR-12.7 / R44).

    Dropping the AGE graph and deleting the ``projects`` row (everything cascades) left the project's
    stored documents on disk indefinitely: the tenant was gone from every table and its files were
    still readable by anyone with filesystem access. And there were two delete routes — the CLI's own
    and this one — with different completeness, so what "delete this project" destroyed depended on
    which one the operator reached for. This is the single orchestrator; every route calls it.

    Idempotent: deletion is exactly the operation an operator retries after a timeout, so a second run
    is a no-op rather than an error.
    """
    await AgeGraphStore(sessionmaker).drop_graph(scope)
    async with session_scope(sessionmaker) as session:
        result = await session.execute(
            delete(models.Project).where(models.Project.id == uuid.UUID(scope.project_id))
        )
        deleted = int(cast("CursorResult[Any]", result).rowcount or 0)
    removed = _remove_project_blobs(scope, data_dir=data_dir)
    return {"deleted_projects": deleted, "blobs_removed": removed}


def _remove_project_blobs(scope: ProjectScope, *, data_dir: str | None) -> int:
    """Remove the project's blob directory. Returns the number of files removed."""
    if data_dir is None:
        return 0
    directory = Path(data_dir) / "blobs" / scope.project_id
    if not directory.exists():
        return 0
    removed = 0
    for child in sorted(directory.rglob("*"), reverse=True):
        try:
            if child.is_file() or child.is_symlink():
                child.unlink(missing_ok=True)
                removed += 1
            else:
                child.rmdir()
        except OSError:
            _log.warning("blob_cleanup_failed", extra={"path": str(child)})
    try:
        directory.rmdir()
    except OSError:
        _log.warning("blob_cleanup_failed", extra={"path": str(directory)})
    return removed


async def purge_audit(
    sessionmaker: async_sessionmaker[AsyncSession],
    *,
    retention_days: int = DEFAULT_AUDIT_RETENTION_DAYS,
) -> int:
    """Delete audit rows older than the retention window (FR-4.6). Returns the count deleted."""
    cutoff = dt.datetime.now(dt.UTC) - dt.timedelta(days=retention_days)
    async with session_scope(sessionmaker) as session:
        result = await session.execute(delete(models.AuditLog).where(models.AuditLog.ts < cutoff))
        return int(getattr(result, "rowcount", 0) or 0)


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True
