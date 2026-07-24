"""Resolve a needs_review item (SPEC-21, FR-13.6 §3.3) — transactional, idempotent.

Each resolution is an operation of the owning service, never frontend logic:

* **chunk** (ambiguous table / guardrail / agent quarantine): approve ⇒ embed the text + apply the
  curator's tags + clear ``needs_review`` so it becomes recallable (agent-quarantine credibility is
  already capped at ingest); reject ⇒ it stays out of the active graph, tagged ``__rejected__``.
* **entity_merge** (FR-1.9): approve ⇒ apply the merge (SPEC-09) + mark the proposal confirmed;
  reject ⇒ the entities stay separate, the proposal is rejected. Idempotent.

Agent correction suggestions (FR-15.10) resolve through the existing correction endpoints (SPEC-08/
15) — the queue links to them.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession as _Session
from sqlalchemy.ext.asyncio import async_sessionmaker

from rsc_brain.gateway.model_gateway import ModelGateway
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope
from rsc_brain.stores.relational.entity_store import EntityStore

REJECTED_TAG = "__rejected__"


def _pid(scope: ProjectScope) -> uuid.UUID:
    return uuid.UUID(scope.project_id)


async def resolve_chunk(
    sessionmaker: async_sessionmaker[_Session],
    scope: ProjectScope,
    chunk_id: str,
    *,
    approve: bool,
    gateway: ModelGateway,
    tags: list[str] | None = None,
) -> str:
    """Approve (embed + curator tags + recallable) or reject a ``needs_review`` chunk. Returns the
    outcome (``approved`` | ``rejected`` | ``already_resolved``)."""
    async with session_scope(sessionmaker) as session:
        chunk = await session.get(models.Chunk, uuid.UUID(chunk_id))
        if chunk is None or chunk.project_id != _pid(scope):
            return "not_found"
        if not chunk.needs_review:
            return "already_resolved"  # idempotent: another admin/CLI already handled it
        if not approve:
            chunk.needs_review = True  # stays parked
            chunk.tags = [REJECTED_TAG]
            return "rejected"
        embedding = (await gateway.embed([chunk.text]))[0]
        chunk.embedding = embedding
        chunk.needs_review = False
        if tags is not None:
            chunk.tags = tags  # curator-corrected header/tags (FR-1.5)
    return "approved"


async def resolve_merge(
    sessionmaker: async_sessionmaker[_Session],
    scope: ProjectScope,
    proposal_id: str,
    *,
    approve: bool,
    resolved_by: str | None = None,
) -> str:
    """Approve (apply the merge) or reject an entity-merge proposal (FR-1.9). Idempotent."""
    store = EntityStore(sessionmaker)
    async with sessionmaker() as session:
        proposal = await session.scalar(
            select(models.EntityMergeProposal).where(
                models.EntityMergeProposal.id == uuid.UUID(proposal_id),
                models.EntityMergeProposal.project_id == _pid(scope),
            )
        )
        if proposal is None:
            return "not_found"
        if proposal.status != "pending":
            return "already_resolved"
        canonical, duplicate, confidence = (
            str(proposal.canonical_entity_id),
            str(proposal.duplicate_entity_id),
            float(proposal.confidence),
        )
    if approve:
        await store.apply_merge(
            scope, canonical_id=canonical, duplicate_id=duplicate, confidence=confidence
        )
        await store.set_proposal_status(
            scope, proposal_id, status="confirmed", resolved_by=resolved_by
        )
        return "approved"
    await store.set_proposal_status(scope, proposal_id, status="rejected", resolved_by=resolved_by)
    return "rejected"


async def mark_needs_review(
    sessionmaker: async_sessionmaker[_Session], scope: ProjectScope, chunk_ids: list[str]
) -> None:
    """Test helper / internal: flip chunks to needs_review (used where a source doesn't yet)."""
    if not chunk_ids:
        return
    async with session_scope(sessionmaker) as session:
        await session.execute(
            update(models.Chunk)
            .where(
                models.Chunk.id.in_([uuid.UUID(i) for i in chunk_ids]),
                models.Chunk.project_id == _pid(scope),
            )
            .values(needs_review=True)
        )
