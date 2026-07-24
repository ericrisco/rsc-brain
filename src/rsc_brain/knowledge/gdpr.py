"""GDPR erasure + retention (SPEC-22, FR-4.6). Project-scoped, symmetric to forget --document.

``forget_entity`` hard-deletes an entity (and its aliases) and **tombstones its graph node**, so
recall/k-hop return no trace and re-resolving the same ``uuid5`` never silently revives it.
``purge_audit`` drops audit rows older than the configured retention (default 365 days).
"""

from __future__ import annotations

import datetime as dt
import uuid

from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.ingest.entity_resolution import entity_id, normalize_name
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.age_graph_store import AgeGraphStore
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope

DEFAULT_AUDIT_RETENTION_DAYS = 365


async def forget_entity(
    sessionmaker: async_sessionmaker[AsyncSession], scope: ProjectScope, name: str
) -> dict[str, int]:
    """Erase every entity in the project matching ``name`` (by surface or normalized name): delete
    its aliases + row, tombstone its graph node. Returns counts. Audited."""
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
    return {"deleted_entities": len(entity_ids), "tombstoned": tombstoned}


async def hard_delete_project(
    sessionmaker: async_sessionmaker[AsyncSession], scope: ProjectScope
) -> None:
    """Hard-delete an entire project (SPEC-22, FR-12.7): drop its AGE graph, then delete the
    ``projects`` row — every project-scoped table cascades (``ondelete=CASCADE``). The caller
    enforces the double-confirmation; the ``default`` project is protected there."""
    await AgeGraphStore(sessionmaker).drop_graph(scope)
    async with session_scope(sessionmaker) as session:
        await session.execute(
            delete(models.Project).where(models.Project.id == uuid.UUID(scope.project_id))
        )


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
