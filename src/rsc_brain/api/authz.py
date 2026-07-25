"""HTTP-side glue for capability decisions, shared by every API surface.

The policy itself lives in :mod:`rsc_brain.authorization`. This module only does the two things an
HTTP route needs around it: fetch the *object's* topics so a topic-scoped decision is possible, and
turn a refusal into the right status code — 403 when the object's existence is not sensitive, 404
when it is, so denied and absent stay indistinguishable (FR-4.3).

It exists as its own module because both API surfaces need the same helpers: the console admin API
and the base ingestion API decide the *same* document-lifecycle operation, and R02 happened because
they each did it their own way (one of them not at all).
"""

from __future__ import annotations

import uuid
from collections.abc import Collection, Sequence
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.authorization import Allow, Capability, Decision, NotFoundEquivalent, decide
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational import models


def enforce(decision: Decision) -> Allow:
    """Return the authorized decision, or raise the HTTP outcome its refusal maps to."""
    if isinstance(decision, Allow):
        return decision
    if isinstance(decision, NotFoundEquivalent):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=decision.reason)


def decide_object(
    scope: ProjectScope,
    capability: Capability,
    topics: Collection[str] | None,
    *,
    object_owner: bool = False,
) -> Allow:
    """Decide ``capability`` against a known object's topics, mapping the refusal to HTTP."""
    return enforce(decide(scope, capability, object_topics=topics, object_owner=object_owner))


async def object_topics(
    sessionmaker: async_sessionmaker[AsyncSession],
    scope: ProjectScope,
    model: Any,
    column: Any,
    object_id: str,
    *,
    topics_attr: str,
) -> Sequence[str] | None:
    """The topics of one project-owned row, or ``None`` when it is absent for this scope.

    The scope's project is part of the query, so an object belonging to another tenant is reported
    exactly like one that does not exist.
    """
    try:
        object_uuid, project_uuid = uuid.UUID(object_id), uuid.UUID(scope.project_id)
    except ValueError:
        return None  # a malformed identifier is absent, not an error that confirms the route
    async with sessionmaker() as session:
        row = await session.scalar(
            select(model).where(column == object_uuid, model.project_id == project_uuid)
        )
    if row is None:
        return None
    topics: Sequence[str] = list(getattr(row, topics_attr) or [])
    return topics


async def decide_document(
    sessionmaker: async_sessionmaker[AsyncSession],
    scope: ProjectScope,
    document_id: str,
    *,
    extra_tags: Sequence[str] | None = None,
) -> Allow:
    """Decide a document-lifecycle operation over the document's own topics (R02).

    ``extra_tags`` are the tags the decision would APPLY (a corrected tag on approve): the caller
    must hold the topics it publishes into as well as the ones it publishes from.
    """
    topics = await object_topics(
        sessionmaker,
        scope,
        models.Document,
        models.Document.id,
        document_id,
        topics_attr="doc_tags",
    )
    if topics is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    return decide_object(scope, Capability.DOCUMENT_DECIDE, [*topics, *(extra_tags or [])])


async def merge_proposal_topics(
    sessionmaker: async_sessionmaker[AsyncSession], scope: ProjectScope, proposal_id: str
) -> Sequence[str] | None:
    """The topics an entity-merge decision would affect: every topic claimed about either entity.

    Applying a merge rewrites entity identity, so it touches every topic that says anything about
    the two identities — partial topic authority is not authority over the merge.
    """
    try:
        pid, oid = uuid.UUID(scope.project_id), uuid.UUID(proposal_id)
    except ValueError:
        return None
    async with sessionmaker() as session:
        proposal = await session.scalar(
            select(models.EntityMergeProposal).where(
                models.EntityMergeProposal.id == oid,
                models.EntityMergeProposal.project_id == pid,
            )
        )
        if proposal is None:
            return None
        names = list(
            await session.scalars(
                select(models.Entity.name).where(
                    models.Entity.project_id == pid,
                    models.Entity.id.in_(
                        [proposal.canonical_entity_id, proposal.duplicate_entity_id]
                    ),
                )
            )
        )
        if not names:
            return []
        tags = await session.scalars(
            select(func.unnest(models.Claim.tags)).where(
                models.Claim.project_id == pid,
                (models.Claim.subject.in_(names)) | (models.Claim.object.in_(names)),
            )
        )
        return sorted({t for t in tags if t})
