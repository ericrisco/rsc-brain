"""MCP tool logic + output schemas (SPEC-06 §5.8), separated from the FastMCP wrappers so the
behaviour is testable against a resolved scope without the HTTP transport.

Output schemas match PRD §5.8 exactly. Fragments carry ``content_type: "untrusted_data"`` (FR-14.8)
so agent builders treat retrieved text as data, never instructions. The brain never redacts and
never dumps the graph; every tool audits to ``audit_log`` (query text is never stored — only a
hash).
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Sequence
from typing import Literal, cast

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain import audit
from rsc_brain.recall.gaps import query_hash
from rsc_brain.recall.interfaces import Fragment, RecallResult
from rsc_brain.recall.permissions import chunk_visibility_clause, sensitive_tags
from rsc_brain.recall.retriever import PgRetriever
from rsc_brain.scope import ProjectScope
from rsc_brain.stores.relational import models

FeedbackSignal = Literal["helpful", "wrong", "outdated"]

UNTRUSTED = "untrusted_data"


class RecallFragment(BaseModel):
    """A fragment with provenance (§5.8). ``content_type`` marks it untrusted (FR-14.8)."""

    model_config = ConfigDict(extra="forbid")

    text: str
    claim_ids: list[str] = Field(default_factory=list)
    document: str
    page: int | None = None
    credibility: float
    tags: list[str] = Field(default_factory=list)
    content_type: str = UNTRUSTED
    # Temporal metadata (SPEC-13, FR-16.5) so a client never presents stale knowledge as current.
    valid_from: str | None = None
    valid_to: str | None = None
    is_current: bool = True


class RecallOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    found: bool
    fragments: list[RecallFragment] = Field(default_factory=list)
    gap_registered: bool = False


class GetDocumentOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str
    page_text: str
    metadata: dict[str, object] = Field(default_factory=dict)


class ReportFeedbackOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ok: bool


class SubmitKnowledgeOutput(BaseModel):
    """`submit_knowledge` output (§5.8, FR-14.4)."""

    model_config = ConfigDict(extra="forbid")

    ok: bool
    status: str  # quarantined | active | rejected
    claim_ids: list[str] = Field(default_factory=list)


class CorrectKnowledgeOutput(BaseModel):
    """`correct_knowledge` output (§3.5)."""

    model_config = ConfigDict(extra="forbid")

    status: (
        str  # applied | pending_confirmation | routed_to_owner | needs_disambiguation | rejected
    )
    explanation: str
    candidates: list[dict[str, str]] = Field(default_factory=list)
    correction_id: str | None = None
    reverted_hint: str | None = None


def _fragment_from_provenance(fragment: Fragment, credibility_fallback: float) -> RecallFragment:
    prov = cast("dict[str, object]", fragment.provenance)
    return RecallFragment(
        text=fragment.text,
        claim_ids=[str(c) for c in cast("list[object]", prov.get("claim_ids", []))],
        document=str(prov.get("document", "")),
        page=cast("int | None", prov.get("page")),
        credibility=float(cast("float", prov.get("credibility", credibility_fallback))),
        tags=[str(t) for t in cast("list[object]", prov.get("tags", []))],
        valid_from=fragment.valid_from.isoformat() if fragment.valid_from else None,
        valid_to=fragment.valid_to.isoformat() if fragment.valid_to else None,
        is_current=fragment.is_current,
    )


def to_recall_output(result: RecallResult) -> RecallOutput:
    fragments = [_fragment_from_provenance(f, 0.5) for f in result.fragments]
    return RecallOutput(
        found=result.found, fragments=fragments, gap_registered=result.gap_registered
    )


async def do_recall(
    retriever: PgRetriever,
    sessionmaker: async_sessionmaker[AsyncSession],
    scope: ProjectScope,
    *,
    query: str,
    top_k: int = 8,
    topics_hint: Sequence[str] | None = None,
    as_of: str | None = None,
    include_historical: bool = False,
    include_superseded: bool = False,
) -> RecallOutput:
    # Temporal params (SPEC-13, FR-16.7): as_of is an ISO date; include_superseded is honoured only
    # for an admin (the retriever gates it on scope.can_curate, scope-from-token).
    as_of_date = dt.date.fromisoformat(as_of) if as_of else None
    result = await retriever.recall(
        scope,
        query,
        top_k=top_k,
        topics_hint=topics_hint,
        as_of=as_of_date,
        include_historical=include_historical,
        include_superseded=include_superseded,
    )
    output = to_recall_output(result)
    await audit.record_audit(
        sessionmaker,
        scope,
        action="recall",
        tool="recall",
        query_hash=query_hash(query),
        topics_used=sorted(scope.allowed_topics),
        result_count=len(output.fragments),
        denied=not output.found,
    )
    return output


async def do_get_document(
    sessionmaker: async_sessionmaker[AsyncSession],
    scope: ProjectScope,
    *,
    document_id: str,
    page: int | None = None,
) -> GetDocumentOutput:
    """Return a document's visible page text + metadata (§5.8). Denied ≡ absent: a document in
    another project, or with no visible chunks, yields an empty result (FR-4.3)."""
    forbidden = await sensitive_tags(sessionmaker, scope.project_id)
    async with sessionmaker() as session:
        doc = await session.get(models.Document, uuid.UUID(document_id))
        if doc is None or str(doc.project_id) != scope.project_id:
            await _audit_get_document(sessionmaker, scope, 0)
            return GetDocumentOutput(title="", page_text="", metadata={})
        conditions = [
            chunk_visibility_clause(scope, forbidden),
            models.Chunk.document_id == doc.id,
            models.Chunk.needs_review.is_(False),
        ]
        if page is not None:
            conditions.append(models.Chunk.page == page)
        rows = await session.execute(
            select(models.Chunk.text)
            .where(*conditions)
            .order_by(models.Chunk.page, models.Chunk.id)
        )
        texts = [text for (text,) in rows.all()]
        title = doc.title or str(doc.id)
        metadata: dict[str, object] = {"status": doc.status, "tags": list(doc.doc_tags)}
    await _audit_get_document(sessionmaker, scope, len(texts))
    return GetDocumentOutput(title=title, page_text="\n".join(texts), metadata=metadata)


async def _audit_get_document(
    sessionmaker: async_sessionmaker[AsyncSession], scope: ProjectScope, count: int
) -> None:
    await audit.record_audit(
        sessionmaker,
        scope,
        action="get_document",
        tool="get_document",
        result_count=count,
        denied=count == 0,
    )


async def do_report_feedback(
    sessionmaker: async_sessionmaker[AsyncSession],
    scope: ProjectScope,
    *,
    claim_ids: Sequence[str],
    signal: FeedbackSignal,
    note: str | None = None,
) -> ReportFeedbackOutput:
    """Real feedback (SPEC-08, FR-5.4): nudge each claim's credibility by alpha (human 0.1 / agent
    0.03), capped per (principal, claim) per day; a human negative signal below threshold disputes.
    Agent feedback never disputes. Every call is audited."""
    from rsc_brain.knowledge.feedback import apply_report_feedback
    from rsc_brain.stores.relational.knowledge_store import KnowledgeStore

    result = await apply_report_feedback(
        KnowledgeStore(sessionmaker), scope, claim_ids=claim_ids, signal=signal
    )
    await audit.record_audit(
        sessionmaker,
        scope,
        action=f"report_feedback:{signal}",
        tool="report_feedback",
        result_count=result.applied,
    )
    return ReportFeedbackOutput(ok=True)


async def do_submit_knowledge(
    sessionmaker: async_sessionmaker[AsyncSession],
    gateway: object,
    scope: ProjectScope,
    *,
    text: str,
    idempotency_key: str,
    entities: Sequence[str] | None = None,
    tags: Sequence[str] | None = None,
) -> SubmitKnowledgeOutput:
    """Agent/human knowledge write (SPEC-11 FR-14.4). `idempotency_key` is required; the project's
    `agent_writes` policy decides quarantine/direct/off. Audited (agent + on_behalf_of via scope)."""
    from rsc_brain.gateway.model_gateway import ModelGateway
    from rsc_brain.knowledge.agent_writes import AgentWriteService

    assert isinstance(gateway, ModelGateway)
    if not idempotency_key:
        # Writes require an idempotency key (retries must not duplicate) — reject without one.
        return SubmitKnowledgeOutput(ok=False, status="rejected", claim_ids=[])
    result = await AgentWriteService(sessionmaker, gateway).submit(
        scope,
        text=text,
        idempotency_key=idempotency_key,
        entities=list(entities) if entities else None,
        tags=list(tags) if tags else None,
    )
    await audit.record_audit(
        sessionmaker,
        scope,
        action=f"submit_knowledge:{result.status}",
        tool="submit_knowledge",
        result_count=len(result.claim_ids),
        denied=result.status == "rejected",
    )
    return SubmitKnowledgeOutput(
        ok=result.status != "rejected", status=result.status, claim_ids=result.claim_ids
    )


async def do_correct_knowledge(
    sessionmaker: async_sessionmaker[AsyncSession],
    graph: object,
    gateway: object,
    scope: ProjectScope,
    *,
    claim_id: str | None,
    topic: str | None,
    statement: str | None,
    correction: str,
    reason: str | None = None,
    on_behalf_of: str | None = None,
    dry_run: bool = False,
) -> CorrectKnowledgeOutput:
    """Owner-authority correction (SPEC-08 §3.5). Delegates to the CorrectionService; audits."""
    from rsc_brain.knowledge.corrections import CorrectionService
    from rsc_brain.stores.age_graph_store import AgeGraphStore
    from rsc_brain.stores.relational.knowledge_store import KnowledgeStore

    assert isinstance(graph, AgeGraphStore)
    from rsc_brain.gateway.model_gateway import ModelGateway

    assert isinstance(gateway, ModelGateway)
    service = CorrectionService(store=KnowledgeStore(sessionmaker), graph=graph, gateway=gateway)
    outcome = await service.correct(
        scope,
        claim_id=claim_id,
        topic=topic,
        statement=statement,
        correction=correction,
        reason=reason,
        on_behalf_of=on_behalf_of,
        dry_run=dry_run,
    )
    await audit.record_audit(
        sessionmaker,
        scope,
        action=f"correct_knowledge:{outcome.status}",
        tool="correct_knowledge",
        result_count=1 if outcome.new_claim_id else 0,
    )
    hint = (
        f"use corrections revert {outcome.correction_id}"
        if outcome.status in {"applied", "pending_confirmation"} and outcome.correction_id
        else None
    )
    return CorrectKnowledgeOutput(
        status=outcome.status,
        explanation=outcome.explanation,
        candidates=outcome.candidates,
        correction_id=outcome.correction_id,
        reverted_hint=hint,
    )
