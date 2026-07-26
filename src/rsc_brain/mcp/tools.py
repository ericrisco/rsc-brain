"""MCP tool logic + output schemas (SPEC-06 §5.8), separated from the FastMCP wrappers so the
behaviour is testable against a resolved scope without the HTTP transport.

Output schemas match PRD §5.8 exactly. Fragments carry ``content_type: "untrusted_data"`` (FR-14.8)
so agent builders treat retrieved text as data, never instructions. The brain never redacts and
never dumps the graph; every tool audits to ``audit_log`` (query text is never stored — only a
hash).
"""

from __future__ import annotations

import datetime as dt
import time
import uuid
from collections.abc import Sequence
from typing import TYPE_CHECKING, Literal, cast

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain import audit
from rsc_brain.recall.gaps import query_hash
from rsc_brain.recall.interfaces import Fragment, RecallResult
from rsc_brain.recall.permissions import chunk_visibility_clause, sensitive_tags
from rsc_brain.recall.retriever import PgRetriever
from rsc_brain.recall.timeline import build_timeline
from rsc_brain.scope import ProjectScope
from rsc_brain.skills.store import SkillStore
from rsc_brain.stores.relational import models

if TYPE_CHECKING:
    from rsc_brain.gateway.model_gateway import ModelGateway
    from rsc_brain.hunting.service import HuntService
    from rsc_brain.recall.guardrail import TopicClassifier
    from rsc_brain.stores.age_graph_store import AgeGraphStore

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


class TimelineEntry(BaseModel):
    """One point in a topic/entity's evolution (SPEC-17, FR-16.6). Carries the FR-16.5 temporal
    metadata and is marked untrusted like any served fragment (FR-14.8)."""

    model_config = ConfigDict(extra="forbid")

    claim_id: str
    text: str
    subject: str | None = None
    predicate: str | None = None
    object: str | None = None
    credibility: float
    tags: list[str] = Field(default_factory=list)
    content_type: str = UNTRUSTED
    valid_from: str | None = None
    valid_to: str | None = None
    is_current: bool = True
    document: str | None = None


class TimelineOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    found: bool
    topic: str | None = None
    entity: str | None = None
    entries: list[TimelineEntry] = Field(default_factory=list)


class SkillSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    slug: str
    title: str
    when_to_use: str | None = None
    stale: bool = False


class ListSkillsOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    skills: list[SkillSummary] = Field(default_factory=list)


class RunSkillOutput(BaseModel):
    """`run_skill` output (§5.8): the markdown instructions + supporting fragments (like recall)."""

    model_config = ConfigDict(extra="forbid")

    found: bool
    instructions: str = ""
    context_fragments: list[RecallFragment] = Field(default_factory=list)


class GetDocumentOutput(BaseModel):
    """A document read (§5.8). Marked untrusted with provenance, exactly like a recall fragment.

    R08: this used to be title + text + status/tags, with no trust marker anywhere — so the same
    characters were untrusted when recalled and ordinary when fetched, and an agent that fetched
    instead of recalling received a document's embedded instructions as trusted input. ``content_type``
    and the provenance fields are what make the two paths equivalent (FR-14.8).
    """

    model_config = ConfigDict(extra="forbid")

    title: str
    page_text: str
    content_type: str = UNTRUSTED
    document_id: str = ""
    project_id: str = ""
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
    started = time.monotonic()
    result = await retriever.recall(
        scope,
        query,
        top_k=top_k,
        topics_hint=topics_hint,
        as_of=as_of_date,
        include_historical=include_historical,
        include_superseded=include_superseded,
    )
    duration_ms = int((time.monotonic() - started) * 1000)
    output = to_recall_output(result)
    # Store the raw text only when the project opts in (FR-13.9); otherwise just the hash.
    log_text = await audit.query_text_logging_enabled(sessionmaker, scope.project_id)
    await audit.record_audit(
        sessionmaker,
        scope,
        action="recall",
        tool="recall",
        query_hash=query_hash(query),
        query_text=query if log_text else None,
        duration_ms=duration_ms,
        topics_used=sorted(scope.allowed_topics),
        result_count=len(output.fragments),
        denied=not output.found,
    )
    return output


async def do_timeline(
    sessionmaker: async_sessionmaker[AsyncSession],
    scope: ProjectScope,
    *,
    topic: str | None = None,
    entity: str | None = None,
    as_of: str | None = None,
    top_k: int = 50,
) -> TimelineOutput:
    """The ordered evolution of claims for a topic or entity (SPEC-17, FR-16.6). Permission +
    project filters run in the query; a topic the caller can't see returns empty (FR-4.3)."""
    as_of_date = dt.date.fromisoformat(as_of) if as_of else None
    started = time.monotonic()
    entries = await build_timeline(
        sessionmaker, scope, topic=topic, entity=entity, as_of=as_of_date, limit=top_k
    )
    duration_ms = int((time.monotonic() - started) * 1000)
    output = TimelineOutput(
        found=bool(entries),
        topic=topic,
        entity=entity,
        entries=[
            TimelineEntry(
                claim_id=e.claim_id,
                text=e.text,
                subject=e.subject,
                predicate=e.predicate,
                object=e.object,
                credibility=e.credibility,
                tags=list(e.tags),
                valid_from=e.valid_from.isoformat() if e.valid_from else None,
                valid_to=e.valid_to.isoformat() if e.valid_to else None,
                is_current=e.is_current,
                document=e.document_id,
            )
            for e in entries
        ],
    )
    await audit.record_audit(
        sessionmaker,
        scope,
        action="timeline",
        tool="timeline",
        query_hash=query_hash(f"timeline:{topic or ''}:{entity or ''}:{as_of or ''}"),
        duration_ms=duration_ms,
        topics_used=sorted(scope.allowed_topics),
        result_count=len(entries),
        denied=not entries,
    )
    return output


async def do_list_skills(
    sessionmaker: async_sessionmaker[AsyncSession], scope: ProjectScope
) -> ListSkillsOutput:
    """Active skills whose tags the caller may see (SPEC-20, FR-7.1). Audited."""
    forbidden = await sensitive_tags(sessionmaker, scope.project_id)
    skills = await SkillStore(sessionmaker).list_visible(scope, forbidden)
    await audit.record_audit(
        sessionmaker, scope, action="list_skills", tool="list_skills", result_count=len(skills)
    )
    return ListSkillsOutput(
        skills=[
            SkillSummary(slug=s.slug, title=s.title, when_to_use=s.when_to_use, stale=s.stale)
            for s in skills
        ]
    )


async def do_run_skill(
    retriever: PgRetriever,
    sessionmaker: async_sessionmaker[AsyncSession],
    scope: ProjectScope,
    *,
    slug: str,
    args: dict[str, object] | None = None,
    classifier: TopicClassifier | None = None,
) -> RunSkillOutput:
    """Return a skill's instructions + its supporting fragments (built with the SPEC-06 retriever
    over the skill's tags — 'like recall', same in-query permission filter). A skill the caller
    can't see is indistinguishable from nonexistent (FR-4.3). Every call is audited (FR-4.5). When a
    ``classifier`` is supplied, the FR-4.4 secondary guardrail screens the final context."""
    del args  # v0.4 skills are not yet parameterized (FR-7.3); accepted for forward-compat
    started = time.monotonic()
    forbidden = await sensitive_tags(sessionmaker, scope.project_id)
    visible = {s.slug: s for s in await SkillStore(sessionmaker).list_visible(scope, forbidden)}
    skill = visible.get(slug)
    if skill is None:
        await audit.record_audit(
            sessionmaker, scope, action="run_skill", tool="run_skill", denied=True, result_count=0
        )
        return RunSkillOutput(found=False)
    query = " ".join(filter(None, [skill.title, skill.when_to_use])) or skill.slug
    result = await retriever.recall(scope, query, top_k=8, topics_hint=list(skill.tags))
    fragments = to_recall_output(result).fragments
    if classifier is not None:
        fragments = await _apply_guardrail(sessionmaker, scope, fragments, classifier)
    duration_ms = int((time.monotonic() - started) * 1000)
    await audit.record_audit(
        sessionmaker,
        scope,
        action="run_skill",
        tool="run_skill",
        query_hash=query_hash(f"skill:{slug}"),
        duration_ms=duration_ms,
        topics_used=sorted(scope.allowed_topics),
        result_count=len(fragments),
    )
    return RunSkillOutput(found=True, instructions=skill.body or "", context_fragments=fragments)


async def _apply_guardrail(
    sessionmaker: async_sessionmaker[AsyncSession],
    scope: ProjectScope,
    fragments: list[RecallFragment],
    classifier: TopicClassifier,
) -> list[RecallFragment]:
    """FR-4.4: drop mislabeled fragments, mark their chunks needs_review, alert the admin."""
    from rsc_brain.recall.guardrail import screen_fragments
    from rsc_brain.stores.relational.knowledge_store import KnowledgeStore

    async with sessionmaker() as session:
        topics = list(
            await session.scalars(
                select(models.Topic.slug).where(
                    models.Topic.project_id == uuid.UUID(scope.project_id)
                )
            )
        )
    result = await screen_fragments(
        fragments,
        allowed_topics=scope.allowed_topics,
        project_topics=topics,
        classifier=classifier,
    )
    if result.dropped:
        await KnowledgeStore(sessionmaker).flag_claims_needs_review(scope, result.flagged_claim_ids)
        await audit.record_audit(
            sessionmaker,
            scope,
            action="guardrail:dropped_mislabeled",
            tool="guardrail",
            result_count=len(result.dropped),
            denied=True,
        )
    return result.kept


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
            # Absent and forbidden are the same answer, and it carries no provenance to compare
            # against (FR-4.3).
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
    return GetDocumentOutput(
        title=title,
        page_text="\n".join(texts),
        document_id=document_id,
        project_id=scope.project_id,
        metadata=metadata,
    )


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
    from rsc_brain.knowledge.agent_writes import AgentWriteService

    gateway = _as_gateway(gateway)
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
    # R28: the install's configured hunt service. None builds one from configuration, so a CLI or a
    # test that has not wired it still works — and gets an install that reports what it can deliver.
    hunts: object | None = None,
) -> CorrectKnowledgeOutput:
    """Owner-authority correction (SPEC-08 §3.5). Delegates to the CorrectionService; audits."""
    from rsc_brain.knowledge.corrections import CorrectionService
    from rsc_brain.stores.relational.knowledge_store import KnowledgeStore

    graph = _as_graph(graph)

    gateway = _as_gateway(gateway)
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
    # Non-owner route (FR-15.3b/15.6): the correction is parked as `routed_hunt`; open a
    # CORRECTION_REVIEW hunt to the tag owner (NO_OWNER + admin alert if the tag is unowned).
    if outcome.correction_id:
        correction_row = await KnowledgeStore(sessionmaker).get_correction(
            scope, outcome.correction_id
        )
        if correction_row is not None and correction_row.status == "routed_hunt":
            from rsc_brain.hunting.corrections_review import CorrectionReviewService

            # R28: this used to build `HuntService(sessionmaker)` here — no channel, no origin — so an
            # agent's correction was routed to an owner who was never actually contacted. The caller
            # passes the install's configured service.
            await CorrectionReviewService(
                sessionmaker, hunts=_hunt_service(hunts, sessionmaker, gateway)
            ).open_review(scope, outcome.correction_id)
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


def _hunt_service(
    provided: object | None, sessionmaker: async_sessionmaker[AsyncSession], gateway: object
) -> HuntService:
    """The configured hunt service, or one built from configuration when the caller passed none."""
    from rsc_brain.hunting.factory import build_hunt_service_from_settings
    from rsc_brain.hunting.service import HuntService as _HuntService

    if provided is not None:
        if not isinstance(provided, _HuntService):  # pragma: no cover - a composition error
            raise TypeError("this tool needs a HuntService")
        return provided
    return build_hunt_service_from_settings(sessionmaker, gateway=gateway)


def _as_gateway(candidate: object) -> ModelGateway:
    """Narrow the loosely-typed collaborator the MCP server hands in.

    An explicit check rather than an `assert`: asserts are stripped under `python -O`, so a wiring
    mistake would surface later as an AttributeError inside a tool call instead of at the boundary.
    """
    from rsc_brain.gateway.model_gateway import ModelGateway as _Gateway

    if not isinstance(candidate, _Gateway):  # pragma: no cover - a composition error, not input
        raise TypeError("this tool needs a ModelGateway")
    return candidate


def _as_graph(candidate: object) -> AgeGraphStore:
    from rsc_brain.stores.age_graph_store import AgeGraphStore as _Graph

    if not isinstance(candidate, _Graph):  # pragma: no cover - a composition error, not input
        raise TypeError("this tool needs an AgeGraphStore")
    return candidate
