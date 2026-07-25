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

from sqlalchemy import ColumnElement, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.knowledge.agent_writes import AGENT_SUBMISSION_LOGICAL_ID
from rsc_brain.review.states import PROPOSAL_OPEN
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational import models
from rsc_brain.visibility import forbidden_topics, topic_clause

#: Re-exported for callers that used to import it from here; the vocabulary lives in
#: :mod:`rsc_brain.review.states` (R25).
MERGE_PENDING = PROPOSAL_OPEN


@dataclass(frozen=True, slots=True)
class ReviewItem:
    source: str  # ambiguous_table | guardrail | agent_submission | entity_merge | agent_correction
    id: str
    preview: str
    detail: dict[str, object]


def _pid(scope: ProjectScope) -> uuid.UUID:
    return uuid.UUID(scope.project_id)


def _merge_visible(scope: ProjectScope, forbidden: frozenset[str]) -> ColumnElement[bool]:
    """A merge proposal is visible when a claim the caller may see mentions either identity.

    Applying a merge rewrites entity identity, so the queue must not even announce a proposal over
    identities the caller cannot see. A proposal whose identities carry no claims at all discloses
    nothing and stays visible to an authorized reviewer.
    """
    entity_names = select(models.Entity.name).where(
        models.Entity.project_id == models.EntityMergeProposal.project_id,
        models.Entity.id.in_(
            [
                models.EntityMergeProposal.canonical_entity_id,
                models.EntityMergeProposal.duplicate_entity_id,
            ]
        ),
    )
    any_claim = select(models.Claim.id).where(
        models.Claim.project_id == models.EntityMergeProposal.project_id,
        or_(
            models.Claim.subject.in_(entity_names),
            models.Claim.object.in_(entity_names),
        ),
    )
    return or_(
        ~any_claim.exists(),
        any_claim.where(topic_clause(models.Claim.tags, scope, forbidden)).exists(),
    )


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
    """The four sources, unified, topic-filtered and (optionally) narrowed by ``source``.

    R01: the queue and the per-source counters the console renders from it must describe only the
    caller's authorized topics. The filter is therefore in each collector's query — a count taken
    over the unfiltered queue is a disclosure even when the list itself is filtered.
    """
    items: list[ReviewItem] = []
    forbidden = await forbidden_topics(sessionmaker, scope)
    async with sessionmaker() as session:
        await _collect_chunks(session, scope, forbidden, items, limit)
        await _collect_merges(session, scope, forbidden, items, limit)
        await _collect_corrections(session, scope, forbidden, items, limit)
    if source is not None:
        items = [i for i in items if i.source == source]
    return items


async def _collect_chunks(
    session: AsyncSession,
    scope: ProjectScope,
    forbidden: frozenset[str],
    items: list[ReviewItem],
    limit: int,
) -> None:
    rows = (
        await session.execute(
            select(models.Chunk, models.Document.logical_id)
            .join(models.Document, models.Chunk.document_id == models.Document.id)
            .where(
                models.Chunk.project_id == _pid(scope),
                models.Chunk.needs_review.is_(True),
                # A chunk held back for review carries the review sentinel instead of tags: it has
                # no topic dimension yet, so it is visible to any authorized reviewer. Once it does
                # carry topics, those topics decide.
                topic_clause(models.Chunk.tags, scope, forbidden, allow_untagged=True),
            )
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
    session: AsyncSession,
    scope: ProjectScope,
    forbidden: frozenset[str],
    items: list[ReviewItem],
    limit: int,
) -> None:
    rows = await session.scalars(
        select(models.EntityMergeProposal)
        .where(
            models.EntityMergeProposal.project_id == _pid(scope),
            models.EntityMergeProposal.status == MERGE_PENDING,
            # A proposal has no tags: it is visible when the caller can see a claim about either
            # identity, or when neither identity is claimed about at all (nothing to disclose).
            _merge_visible(scope, forbidden),
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
    session: AsyncSession,
    scope: ProjectScope,
    forbidden: frozenset[str],
    items: list[ReviewItem],
    limit: int,
) -> None:
    rows = await session.scalars(
        select(models.Correction)
        .join(models.Claim, models.Claim.id == models.Correction.target_claim)
        .where(
            models.Correction.project_id == _pid(scope),
            models.Correction.role_applied == "agent_suggestion",
            models.Correction.status == "routed_to_owner",
            # A correction inherits the visibility of the claim it targets (R01).
            topic_clause(models.Claim.tags, scope, forbidden),
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
