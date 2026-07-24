"""Aggregate the unified needs_review queue (SPEC-21, FR-13.6) — read side.

One typed list over the four sources: ``ambiguous_table`` (FR-1.5), ``guardrail`` (FR-4.4) and
``agent_submission`` (FR-14.4) are all ``needs_review`` chunks (distinguished by the owning document
+ chunk kind); ``entity_merge`` (FR-1.9) is a pending merge proposal; ``agent_correction``
(FR-15.10) is a correction an agent suggested (``routed_to_owner``). Everything is project-scoped
in-query (FR-12.5).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.knowledge.agent_writes import AGENT_SUBMISSION_LOGICAL_ID
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational import models

MERGE_PENDING = "pending"


@dataclass(frozen=True, slots=True)
class ReviewItem:
    source: str  # ambiguous_table | guardrail | agent_submission | entity_merge | agent_correction
    id: str
    preview: str
    detail: dict[str, object]


def _pid(scope: ProjectScope) -> uuid.UUID:
    return uuid.UUID(scope.project_id)


def _chunk_source(logical_id: str | None, kind: str) -> str:
    if logical_id == AGENT_SUBMISSION_LOGICAL_ID:
        return "agent_submission"  # FR-14.4 quarantine
    if kind == "table_row":
        return "ambiguous_table"  # FR-1.5
    return "guardrail"  # FR-4.4 (mislabeled, dropped from context)


async def list_review_queue(
    sessionmaker: async_sessionmaker[AsyncSession],
    scope: ProjectScope,
    *,
    source: str | None = None,
    limit: int = 200,
) -> list[ReviewItem]:
    """The four sources, unified and (optionally) filtered by ``source``."""
    items: list[ReviewItem] = []
    async with sessionmaker() as session:
        await _collect_chunks(session, scope, items, limit)
        await _collect_merges(session, scope, items, limit)
        await _collect_corrections(session, scope, items, limit)
    if source is not None:
        items = [i for i in items if i.source == source]
    return items


async def _collect_chunks(
    session: AsyncSession, scope: ProjectScope, items: list[ReviewItem], limit: int
) -> None:
    rows = (
        await session.execute(
            select(models.Chunk, models.Document.logical_id)
            .join(models.Document, models.Chunk.document_id == models.Document.id)
            .where(models.Chunk.project_id == _pid(scope), models.Chunk.needs_review.is_(True))
            .order_by(models.Chunk.id)
            .limit(limit)
        )
    ).all()
    for chunk, logical_id in rows:
        items.append(
            ReviewItem(
                source=_chunk_source(logical_id, chunk.kind),
                id=str(chunk.id),
                preview=(chunk.text or "")[:280],
                detail={
                    "kind": chunk.kind,
                    "document_id": str(chunk.document_id),
                    "tags": list(chunk.tags),
                },
            )
        )


async def _collect_merges(
    session: AsyncSession, scope: ProjectScope, items: list[ReviewItem], limit: int
) -> None:
    rows = await session.scalars(
        select(models.EntityMergeProposal)
        .where(
            models.EntityMergeProposal.project_id == _pid(scope),
            models.EntityMergeProposal.status == MERGE_PENDING,
        )
        .limit(limit)
    )
    for proposal in rows:
        items.append(
            ReviewItem(
                source="entity_merge",
                id=str(proposal.id),
                preview=f"merge {proposal.duplicate_entity_id} → {proposal.canonical_entity_id}",
                detail={
                    "canonical_entity_id": str(proposal.canonical_entity_id),
                    "duplicate_entity_id": str(proposal.duplicate_entity_id),
                    "confidence": float(proposal.confidence),
                },
            )
        )


async def _collect_corrections(
    session: AsyncSession, scope: ProjectScope, items: list[ReviewItem], limit: int
) -> None:
    rows = await session.scalars(
        select(models.Correction)
        .where(
            models.Correction.project_id == _pid(scope),
            models.Correction.role_applied == "agent_suggestion",
            models.Correction.status == "routed_to_owner",
        )
        .limit(limit)
    )
    for correction in rows:
        items.append(
            ReviewItem(
                source="agent_correction",
                id=str(correction.id),
                preview=f"{correction.before_text or ''} → {correction.after_text or ''}",
                detail={"target_claim": str(correction.target_claim)},
            )
        )
