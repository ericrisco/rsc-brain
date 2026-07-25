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
from rsc_brain.review.states import PROPOSAL_APPLIED, PROPOSAL_OPEN, PROPOSAL_REJECTED
from rsc_brain.scope import NON_TOPIC_TAGS, ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope
from rsc_brain.stores.relational.entity_store import EntityStore

#: A chunk a curator refused. Never a topic (see ``NON_TOPIC_TAGS``): it records a decision,
#: and the publish phase skips anything carrying it so a redo cannot resurrect the content.
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
            # R26: this used to set `needs_review = True` — the value it already had — so the item
            # stayed in the queue and the next curator was asked the same question, with nothing
            # recording that anyone had answered. Clearing the flag is what makes the decision
            # terminal; the chunk stays out of the active graph because it keeps NO embedding, and
            # `REJECTED_TAG` is the durable marker that says so even after a publish redo.
            chunk.needs_review = False
            chunk.embedding = None
            chunk.tags = [*(t for t in chunk.tags if t not in NON_TOPIC_TAGS), REJECTED_TAG]
            return "rejected"
        embedding = (await gateway.for_project(scope.project_id).embed([chunk.text]))[0]
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
    """Approve (apply the merge) or reject an entity-merge proposal (FR-1.9). Idempotent.

    Delegates to :class:`~rsc_brain.knowledge.entity_merge.EntityMergeService` — the same operation the
    CLI performs — rather than re-implementing it (R25). The re-implementation here read a status no
    producer writes, so it could never resolve anything; and when it did resolve, it merged only the
    RELATIONAL identity: it called ``apply_merge`` and never re-pointed the duplicate's AGE edges, so a
    console approval left the graph answering under the identity the product had just merged away.

    One operation, one place, both surfaces.
    """
    from rsc_brain.knowledge.entity_merge import EntityMergeService
    from rsc_brain.stores.age_graph_store import AgeGraphStore

    service = EntityMergeService(
        store=EntityStore(sessionmaker),
        graph=AgeGraphStore(sessionmaker),
        sessionmaker=sessionmaker,
    )
    async with sessionmaker() as session:
        proposal = await session.scalar(
            select(models.EntityMergeProposal).where(
                models.EntityMergeProposal.id == uuid.UUID(proposal_id),
                models.EntityMergeProposal.project_id == _pid(scope),
            )
        )
        if proposal is None:
            return "not_found"
        if proposal.status != PROPOSAL_OPEN:
            return "already_resolved"
    outcome = (
        await service.confirm(scope, proposal_id, resolved_by=resolved_by)
        if approve
        else await service.reject(scope, proposal_id, resolved_by=resolved_by)
    )
    if outcome.status == PROPOSAL_APPLIED:
        return "approved"
    if outcome.status == PROPOSAL_REJECTED and not approve:
        return "rejected"
    # The service refused (it re-checks the status inside its own transaction, which is what makes
    # two concurrent resolutions safe). Report it as already resolved rather than as a rejection.
    return "already_resolved"


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
